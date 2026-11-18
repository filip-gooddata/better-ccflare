/**
 * Header marks and the overage bench hold until their reset or until a newer
 * usage reading shows the account recovered:
 * - a `seven_day_<family>` overage header blocks the family the account
 *   actually sends, in default routing and with capacity routing on;
 * - an `overage_in_use` bench is a hard admission block, forced routing
 *   included, and no later success (a sub-500 response, a scheduler probe)
 *   clears it;
 * - a header-only window mark survives a poll that predates it and the
 *   cache's ten-minute expiry.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { isAccountAvailable } from "@better-ccflare/core";
import { AnthropicProvider, usageCache } from "@better-ccflare/providers";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
} from "@better-ccflare/types";
import { resetAutoRefreshPromptPoolForTests } from "../../auto-refresh-prompt-pool";
import type { AutoRefreshScheduler } from "../../auto-refresh-scheduler";
import { selectAccountsForRequest } from "../account-selector";
import {
	observeLimitHeaders,
	resetHeaderMarkOutForTests,
} from "../header-mark-out";
import {
	collectLimitBlockedAccounts,
	getLocalLimitAnswer,
} from "../limit-blocked";
import {
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
	getFamilyBlock,
} from "../model-capacity";
import {
	INTERNAL_PROBE_SECRET_HEADER,
	type ProxyContext,
} from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";
import { processProxyResponse } from "../response-processor";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const FIVE_HOUR_RESET = NOW + 2 * HOUR;
const SEVEN_DAY_RESET = NOW + 50 * HOUR;
const P = "anthropic-ratelimit-unified-";
const SECRET = "probe-secret";
const OPUS = "claude-opus-4-5";
const SONNET = "claude-sonnet-4-5";
const FABLE = "claude-fable-5";

const secs = (ms: number) => String(Math.floor(ms / 1000));
const atSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: `acct-${id}`,
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW - 100 * HOUR,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

/** An accounts table with the cooldown columns the success clears touch. */
function makeSqlite() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE accounts (
		id TEXT PRIMARY KEY,
		rate_limited_until INTEGER,
		rate_limited_reason TEXT,
		rate_limited_at INTEGER,
		rate_limit_reset INTEGER,
		rate_limit_reset_at INTEGER,
		rate_limit_status TEXT,
		rate_limit_remaining INTEGER,
		consecutive_rate_limits INTEGER DEFAULT 0,
		paused INTEGER DEFAULT 0,
		pause_reason TEXT
	)`);
	const errors: string[] = [];
	const adapter = {
		run: async (sql: string, params: unknown[] = []) => {
			try {
				sqlite.query(sql).run(...(params as never[]));
			} catch (error) {
				errors.push(`${sql}: ${String(error)}`);
			}
		},
		get: async (sql: string, params: unknown[] = []) =>
			sqlite.query(sql).get(...(params as never[])),
		query: async (sql: string, params: unknown[] = []) =>
			sqlite.query(sql).all(...(params as never[])),
	};
	const insert = (
		id: string,
		until: number | null,
		reason: string | null,
	): void => {
		sqlite
			.query(
				"INSERT INTO accounts (id, rate_limited_until, rate_limited_reason, rate_limited_at) VALUES (?, ?, ?, ?)",
			)
			.run(id, until, reason, NOW);
	};
	const until = (id: string): number | null =>
		(
			sqlite
				.query("SELECT rate_limited_until AS u FROM accounts WHERE id = ?")
				.get(id) as { u: number | null }
		).u;
	return { sqlite, adapter, errors, insert, until };
}

function makeCtx(
	rows: Account[] = [],
	options: {
		capacityRouting?: string;
		adapter?: ReturnType<typeof makeSqlite>["adapter"];
	} = {},
) {
	const strategy: LoadBalancingStrategy = {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
	};
	const jobs: Promise<unknown>[] = [];
	const ctx = {
		provider: new AnthropicProvider(),
		strategy,
		dbOps: {
			getAllAccounts: async () => rows,
			getActiveComboForFamily: async () => null,
			markAccountRateLimited: async () => ({
				consecutiveRateLimits: 0,
				applied: true,
			}),
			saveRequest: async () => {},
			updateAccountUsage: async () => {},
			updateAccountRateLimitMeta: async () => {},
			resetConsecutiveRateLimits: async () => {},
			getAdapter: () =>
				options.adapter ?? { get: async () => null, run: async () => {} },
		},
		runtime: { port: 8080, clientId: "test" },
		asyncWriter: {
			enqueue: (job: () => unknown) => {
				jobs.push(Promise.resolve().then(job));
			},
		},
		config: {
			getModelScopedCapacityRouting: () => options.capacityRouting ?? "off",
			getForceAccountModel: () => false,
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		},
		refreshInFlight: new Map(),
		internalProbeSecret: SECRET,
	} as unknown as ProxyContext;
	return { ctx, settle: () => Promise.all(jobs) };
}

function meta(headers: Headers = new Headers()): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers,
		clientSessionId: null,
	};
}

function seedUsage(id: string, fivePercent = 40, sevenPercent = 20) {
	usageCache.set(id, {
		five_hour: {
			utilization: fivePercent,
			resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
		},
		seven_day: {
			utilization: sevenPercent,
			resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
		},
	} as never);
}

function allowedHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"content-type": "application/json",
		[`${P}status`]: "allowed",
		[`${P}reset`]: secs(FIVE_HOUR_RESET),
		[`${P}5h-status`]: "allowed",
		[`${P}5h-reset`]: secs(FIVE_HOUR_RESET),
		[`${P}5h-utilization`]: "0.42",
		[`${P}7d-status`]: "allowed",
		[`${P}7d-reset`]: secs(SEVEN_DAY_RESET),
		[`${P}7d-utilization`]: "0.21",
		...extra,
	});
}

function respond(h: Headers, status = 200) {
	return new Response("{}", { status, headers: h });
}

function usageBody(fivePercent: number) {
	return new Response(
		JSON.stringify({
			five_hour: {
				utilization: fivePercent,
				resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
			},
			seven_day: {
				utilization: 21,
				resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function limitKinds(ctx: ProxyContext, id: string, model = OPUS): string[] {
	const rows = collectLimitBlockedAccounts(
		[makeAccount(id)],
		ctx,
		meta(),
		model,
		Date.now(),
	);
	return (rows[0]?.limits ?? []).map((l) => l.kind);
}

const ids = (accounts: Account[]) => accounts.map((a) => a.id);

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	setSystemTime(new Date(NOW));
	resetHeaderMarkOutForTests();
	resetRateLimitProbeGatesForTests();
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	clearFamilyExhaustionCache();
	clearFamilyBlocks();
	globalThis.fetch = originalFetch;
	setSystemTime();
	usageCache.clear();
});

function familyOverage(extra: Record<string, string> = {}): Response {
	return respond(
		allowedHeaders({
			[`${P}overage-in-use`]: "true",
			[`${P}representative-claim`]: "seven_day_fable",
			[`${P}reset`]: secs(SEVEN_DAY_RESET),
			...extra,
		}),
	);
}

describe("a family overage header blocks the family the account sends", () => {
	let refreshSpy: ReturnType<typeof spyOn>;
	beforeEach(() => {
		refreshSpy = spyOn(usageCache, "refreshNow").mockImplementation(
			async () => false,
		);
	});
	afterEach(() => refreshSpy.mockRestore());

	// Account "a" sends Fable for Opus requests; "b" sends what it is asked.
	const mapped = () =>
		makeAccount("a", { model_mappings: JSON.stringify({ opus: [FABLE] }) });

	for (const mode of ["off", "exhausted"]) {
		it(`with capacity routing ${mode}: the mapped family is blocked, other families still served`, async () => {
			const rows = [mapped(), makeAccount("b")];
			const { ctx } = makeCtx(rows, { capacityRouting: mode });
			seedUsage("a");
			seedUsage("b");
			observeLimitHeaders(familyOverage(), rows[0]);

			expect(ids(await selectAccountsForRequest(meta(), ctx, OPUS))).toEqual([
				"b",
			]);
			expect(ids(await selectAccountsForRequest(meta(), ctx, FABLE))).toEqual([
				"b",
			]);
			expect(
				ids(await selectAccountsForRequest(meta(), ctx, SONNET)),
			).toContain("a");
			expect(getFamilyBlock("a", "fable")?.until).toBe(
				atSecond(SEVEN_DAY_RESET),
			);
			expect(limitKinds(ctx, "a", FABLE)).toContain("family");
		});
	}

	it("the block lifts at the reported reset", async () => {
		const rows = [makeAccount("a"), makeAccount("b")];
		const { ctx } = makeCtx(rows);
		seedUsage("a");
		seedUsage("b");
		observeLimitHeaders(familyOverage(), rows[0]);
		setSystemTime(new Date(SEVEN_DAY_RESET + 1000));
		seedUsage("a");
		seedUsage("b");
		expect(ids(await selectAccountsForRequest(meta(), ctx, FABLE))).toContain(
			"a",
		);
	});

	it("an unknown reset still blocks the family, falling back to the weekly reset", async () => {
		const rows = [makeAccount("a"), makeAccount("b")];
		const { ctx } = makeCtx(rows);
		seedUsage("a");
		seedUsage("b");
		const noReset = familyOverage();
		noReset.headers.delete(`${P}reset`);
		observeLimitHeaders(noReset, rows[0]);
		expect(getFamilyBlock("a", "fable")?.until).toBe(atSecond(SEVEN_DAY_RESET));

		const neither = familyOverage();
		neither.headers.delete(`${P}reset`);
		neither.headers.delete(`${P}7d-reset`);
		clearFamilyBlocks();
		observeLimitHeaders(neither, rows[0]);
		setSystemTime(new Date(NOW + 6 * HOUR));
		seedUsage("a");
		seedUsage("b");
		expect(ids(await selectAccountsForRequest(meta(), ctx, FABLE))).toEqual([
			"b",
		]);
	});
});

describe("an overage_in_use bench is a hard admission block", () => {
	const benched = () =>
		makeAccount("a", {
			rate_limited_until: FIVE_HOUR_RESET,
			rate_limited_reason: "overage_in_use",
		});

	it("a probe naming a benched account gets that account's local 429", async () => {
		const rows = [benched(), makeAccount("b")];
		const { ctx } = makeCtx(rows);
		seedUsage("a");
		seedUsage("b");
		for (const probeHeaders of [
			{
				"x-better-ccflare-account-id": "a",
				"x-better-ccflare-bypass-session": "true",
			},
			{
				"x-better-ccflare-account-id": "a",
				"x-better-ccflare-bypass-session": "true",
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
			},
		]) {
			const m = meta(new Headers(probeHeaders));
			expect(await selectAccountsForRequest(m, ctx, OPUS)).toEqual([]);
			const answer = getLocalLimitAnswer(m);
			expect(answer?.account.id).toBe("a");
			expect(answer?.cooldownResetMs).toBe(FIVE_HOUR_RESET);
		}
	});

	it("ordinary traffic naming a benched account falls back to normal selection", async () => {
		const rows = [benched(), makeAccount("b")];
		const { ctx } = makeCtx(rows);
		seedUsage("a");
		seedUsage("b");
		const m = meta(new Headers({ "x-better-ccflare-account-id": "a" }));
		expect(ids(await selectAccountsForRequest(m, ctx, OPUS))).toEqual(["b"]);
	});

	it("an ordinary cooldown keeps the refresh bypass as before", async () => {
		const rows = [
			makeAccount("a", {
				rate_limited_until: FIVE_HOUR_RESET,
				rate_limited_reason: "upstream_429_with_reset",
			}),
			makeAccount("b"),
		];
		const { ctx } = makeCtx(rows);
		seedUsage("a");
		seedUsage("b");
		const m = meta(
			new Headers({
				"x-better-ccflare-account-id": "a",
				"x-better-ccflare-bypass-session": "true",
			}),
		);
		expect(ids(await selectAccountsForRequest(m, ctx, OPUS))).toEqual(["a"]);
	});

	it("a sub-500 response does not clear the bench, in memory or in the database", async () => {
		const db = makeSqlite();
		db.insert("a", FIVE_HOUR_RESET, "overage_in_use");
		db.insert("c", FIVE_HOUR_RESET, "upstream_429_with_reset");
		const { ctx, settle } = makeCtx([], { adapter: db.adapter });
		const account = benched();
		await processProxyResponse(respond(allowedHeaders()), account, ctx);
		const other = makeAccount("c", { rate_limited_until: FIVE_HOUR_RESET });
		await processProxyResponse(respond(allowedHeaders()), other, ctx);
		await settle();

		expect(db.errors).toEqual([]);
		expect(account.rate_limited_until).toBe(FIVE_HOUR_RESET);
		expect(db.until("a")).toBe(FIVE_HOUR_RESET);
		expect(other.rate_limited_until).toBeNull();
		expect(db.until("c")).toBeNull();
	});

	it("an expired overage bench is cleared like any other", async () => {
		const db = makeSqlite();
		db.insert("a", NOW - MINUTE, "overage_in_use");
		const { ctx, settle } = makeCtx([], { adapter: db.adapter });
		const account = makeAccount("a", {
			rate_limited_until: NOW - MINUTE,
			rate_limited_reason: "overage_in_use",
		});
		await processProxyResponse(respond(allowedHeaders()), account, ctx);
		await settle();
		expect(account.rate_limited_until).toBeNull();
		expect(db.until("a")).toBeNull();
	});
});

type ProbeRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

type TestableScheduler = AutoRefreshScheduler & {
	sendDummyMessage(accountRow: ProbeRow): Promise<boolean>;
};

describe("a successful scheduler probe", () => {
	beforeEach(() => resetAutoRefreshPromptPoolForTests());

	async function probe(withResetHeader: boolean) {
		const db = makeSqlite();
		db.insert("a", FIVE_HOUR_RESET, "overage_in_use");
		db.insert("c", FIVE_HOUR_RESET, "upstream_429_with_reset");
		const { AutoRefreshScheduler } = await import(
			"../../auto-refresh-scheduler"
		);
		const scheduler = new AutoRefreshScheduler(
			db.adapter as never,
			{
				runtime: { port: 8080, clientId: "test-client" },
				refreshInFlight: new Map(),
				internalProbeSecret: SECRET,
			} as never,
		) as TestableScheduler;
		const headers = withResetHeader
			? allowedHeaders()
			: new Headers({ "content-type": "application/json" });
		globalThis.fetch = mock(async () =>
			respond(headers),
		) as unknown as typeof fetch;
		for (const id of ["a", "c"]) {
			await scheduler.sendDummyMessage({
				id,
				name: `acct-${id}`,
				provider: "anthropic",
				refresh_token: "rt",
				access_token: "at",
				expires_at: NOW + 3 * HOUR,
				rate_limit_reset: null,
				custom_endpoint: null,
				paused: 0,
				auto_pause_on_overage_enabled: 0,
				pause_reason: null,
			});
		}
		return db;
	}

	for (const withReset of [true, false]) {
		it(`does not clear an overage bench (${withReset ? "with" : "without"} a reset header), but clears an ordinary cooldown`, async () => {
			const db = await probe(withReset);
			expect(db.errors).toEqual([]);
			expect(db.until("a")).toBe(FIVE_HOUR_RESET);
			expect(db.until("c")).toBeNull();
		});
	}
});

describe("release on a newer recovering usage poll", () => {
	it("a poll newer than the bench showing both windows below 100 % releases it; a full one does not", async () => {
		const db = makeSqlite();
		db.insert("a", atSecond(FIVE_HOUR_RESET), "overage_in_use");
		const { ctx, settle } = makeCtx([], { adapter: db.adapter });
		let percent = 100;
		globalThis.fetch = mock(async () =>
			usageBody(percent),
		) as unknown as typeof fetch;
		usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
		const account = makeAccount("a");
		const overage = () =>
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" }));
		observeLimitHeaders(overage(), account);
		await processProxyResponse(overage(), account, ctx);
		expect(account.rate_limited_reason).toBe("overage_in_use");
		await flush();
		await settle();

		setSystemTime(new Date(NOW + MINUTE));
		await usageCache.refreshNow("a");
		await flush();
		await settle();
		expect(db.until("a")).toBe(atSecond(FIVE_HOUR_RESET));

		percent = 30;
		setSystemTime(new Date(NOW + 2 * MINUTE));
		await usageCache.refreshNow("a");
		await flush();
		await settle();
		expect(db.errors).toEqual([]);
		expect(db.until("a")).toBeNull();
	});
});

describe("header-only window marks are durable", () => {
	it("survive a poll that predates them and the cache expiry; a newer recovering poll releases them", async () => {
		const { ctx } = makeCtx();
		let releaseStale: (r: Response) => void = () => {};
		let call = 0;
		let nextPercent: number | null = null;
		globalThis.fetch = mock(() => {
			call++;
			if (call === 1) {
				return new Promise<Response>((resolve) => {
					releaseStale = resolve;
				});
			}
			if (nextPercent === null) {
				return Promise.resolve(new Response("down", { status: 500 }));
			}
			return Promise.resolve(usageBody(nextPercent));
		}) as unknown as typeof fetch;
		usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
		const stalePoll = usageCache.refreshNow("a");
		await flush();

		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" })),
			makeAccount("a"),
		);
		releaseStale(usageBody(40));
		await stalePoll;
		await flush();
		expect(limitKinds(ctx, "a")).toContain("five_hour");

		setSystemTime(new Date(NOW + 11 * MINUTE));
		expect(usageCache.get("a")).not.toBeNull();
		expect(limitKinds(ctx, "a")).toContain("five_hour");

		setSystemTime(new Date(NOW + 30 * MINUTE));
		nextPercent = 40;
		await usageCache.refreshNow("a");
		await flush();
		expect(limitKinds(ctx, "a")).not.toContain("five_hour");
	});

	it("the mark ends at its reset", async () => {
		const refreshSpy = spyOn(usageCache, "refreshNow").mockImplementation(
			async () => false,
		);
		try {
			const { ctx } = makeCtx();
			observeLimitHeaders(
				respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" })),
				makeAccount("a"),
			);
			setSystemTime(new Date(FIVE_HOUR_RESET - MINUTE));
			expect(limitKinds(ctx, "a")).toContain("five_hour");
			setSystemTime(new Date(FIVE_HOUR_RESET + MINUTE));
			expect(limitKinds(ctx, "a")).not.toContain("five_hour");
		} finally {
			refreshSpy.mockRestore();
		}
	});
});
