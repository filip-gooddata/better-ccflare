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
import {
	initUsageCollector,
	resetUsageCollectorForTests,
} from "../../usage-collector";
import { selectAccountsForRequest } from "../account-selector";
import {
	observeLimitHeaders,
	readingsBeforeHeaderMark,
	resetHeaderMarkOutForTests,
} from "../header-mark-out";
import { collectLimitBlockedAccounts } from "../limit-blocked";
import {
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
	getFamilyBlock,
} from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import {
	INTERNAL_PROBE_SECRET_HEADER,
	type ProxyContext,
} from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";
import { processProxyResponse } from "../response-processor";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const FIVE_HOUR_RESET = NOW + 2 * HOUR;
const SEVEN_DAY_RESET = NOW + 50 * HOUR;
const MODEL = "claude-opus-4-5";
const P = "anthropic-ratelimit-unified-";
const SECRET = "probe-secret";

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

function makeCtx(rows: Account[] = []) {
	const marks: Array<{ accountId: string; until: number; reason: string }> = [];
	const strategy: LoadBalancingStrategy = {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
	};
	const ctx = {
		provider: new AnthropicProvider(),
		strategy,
		dbOps: {
			getAllAccounts: async () => rows,
			getActiveComboForFamily: async () => null,
			markAccountRateLimited: async (
				accountId: string,
				until: number,
				reason: string,
			) => {
				marks.push({ accountId, until, reason });
				return { consecutiveRateLimits: 0, applied: true };
			},
			saveRequest: async () => {},
			updateAccountUsage: async () => {},
			updateAccountRateLimitMeta: async () => {},
			resetConsecutiveRateLimits: async () => {},
			getAdapter: () => ({ get: async () => null, run: async () => {} }),
		},
		runtime: { port: 8080, clientId: "test" },
		asyncWriter: {
			enqueue: (job: () => unknown) => {
				void Promise.resolve().then(job);
			},
		},
		config: {
			getModelScopedCapacityRouting: () => "off",
			getForceAccountModel: () => false,
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		},
		refreshInFlight: new Map(),
		internalProbeSecret: SECRET,
	} as unknown as ProxyContext;
	return { ctx, marks };
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

const secs = (ms: number) => String(Math.floor(ms / 1000));
const atSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/** A plain (overage off) usage snapshot with both windows well below 100 %. */
function seedUsage(id: string) {
	usageCache.set(id, {
		five_hour: {
			utilization: 40,
			resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
		},
		spend: { enabled: false },
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

/** The real upstream 429 shape (COMMON-BRIEF fixture), five-hour window spent. */
function real429Headers(): Headers {
	return new Headers({
		"content-type": "application/json",
		"retry-after": "7200",
		"x-should-retry": "true",
		[`${P}status`]: "rejected",
		[`${P}reset`]: secs(FIVE_HOUR_RESET),
		[`${P}representative-claim`]: "five_hour",
		[`${P}5h-status`]: "rejected",
		[`${P}5h-reset`]: secs(FIVE_HOUR_RESET),
		[`${P}5h-utilization`]: "1.0",
		[`${P}5h-surpassed-threshold`]: "1.0",
		[`${P}7d-status`]: "allowed_warning",
		[`${P}7d-reset`]: secs(SEVEN_DAY_RESET),
		[`${P}7d-utilization`]: "0.17",
		[`${P}7d-surpassed-threshold`]: "0.75",
		[`${P}fallback-percentage`]: "0.5",
		[`${P}overage-status`]: "rejected",
		[`${P}overage-disabled-reason`]: "org_spend_cap_reached",
		[`${P}upgrade-paths`]: "overage",
	});
}

function respond(h: Headers, status = 200, body: BodyInit = "{}") {
	return new Response(body, { status, headers: h });
}

/** Limits in force for a freshly loaded row (no cooldown persisted yet). */
function limitKinds(ctx: ProxyContext, id: string, now = NOW): string[] {
	const rows = collectLimitBlockedAccounts(
		[makeAccount(id)],
		ctx,
		meta(),
		MODEL,
		now,
	);
	return (rows[0]?.limits ?? []).map((l) => l.kind);
}

function cached(id: string) {
	return usageCache.get(id) as {
		five_hour: { utilization: number; resets_at: string };
		seven_day: { utilization: number; resets_at: string };
	};
}

const flush = async () => {
	for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

function requestBody() {
	return new TextEncoder().encode(
		JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 10,
		}),
	).buffer;
}

async function proxyOnce(ctx: ProxyContext, account: Account) {
	const body = requestBody();
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		meta(),
		body,
		() => undefined,
		0,
		ctx,
	);
}

let refreshSpy: ReturnType<typeof spyOn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	setSystemTime(new Date(NOW));
	resetHeaderMarkOutForTests();
	resetRateLimitProbeGatesForTests();
	originalFetch = globalThis.fetch;
	refreshSpy = spyOn(usageCache, "refreshNow").mockImplementation(
		async (id: string) => {
			await Promise.resolve();
			seedUsage(id);
			return true;
		},
	);
});

afterEach(() => {
	resetUsageCollectorForTests();
	clearFamilyExhaustionCache();
	clearFamilyBlocks();
	refreshSpy.mockRestore();
	globalThis.fetch = originalFetch;
	setSystemTime();
	usageCache.clear();
});

describe("observeLimitHeaders", () => {
	it("5h utilization 1.0 writes the header numbers into the usage cache and re-reads usage once per burst", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		refreshSpy.mockImplementation(async () => true);
		const tipped = () =>
			respond(
				allowedHeaders({
					[`${P}5h-utilization`]: "1.0",
					[`${P}5h-status`]: "allowed_warning",
				}),
			);

		observeLimitHeaders(tipped(), makeAccount("a"));
		expect(cached("a").five_hour.utilization).toBe(100);
		expect(Date.parse(cached("a").five_hour.resets_at)).toBe(
			atSecond(FIVE_HOUR_RESET),
		);
		expect(cached("a").seven_day.utilization).toBe(21);
		expect(limitKinds(ctx, "a")).toContain("five_hour");

		observeLimitHeaders(tipped(), makeAccount("a"));
		observeLimitHeaders(tipped(), makeAccount("a"));
		await flush();
		// One re-read for the burst; it left the header mark in place (the
		// fake fetch did not install a reading), so exactly one follow-up.
		expect(refreshSpy).toHaveBeenCalledTimes(2);
		expect(refreshSpy).toHaveBeenCalledWith("a");
	});

	it("does not re-read twice when the first re-read installed a fresh reading", async () => {
		seedUsage("a");
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" })),
			makeAccount("a"),
		);
		await flush();
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("re-reads again once the throttle window has passed", async () => {
		seedUsage("a");
		const tipped = () =>
			respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" }));
		observeLimitHeaders(tipped(), makeAccount("a"));
		await flush();
		setSystemTime(new Date(NOW + 31_000));
		observeLimitHeaders(tipped(), makeAccount("a"));
		await flush();
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});

	it("7d utilization 1.0 marks the weekly window out", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}7d-utilization`]: "1.0" })),
			makeAccount("a"),
		);
		expect(limitKinds(ctx, "a")).toContain("weekly");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("a 5h status of rejected marks the account out even below 1.0", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}5h-status`]: "rejected",
					[`${P}5h-utilization`]: "0.99",
				}),
				429,
			),
			makeAccount("a"),
		);
		expect(cached("a").five_hour.utilization).toBe(100);
		expect(limitKinds(ctx, "a")).toContain("five_hour");
	});

	it("an overall status of rejected marks the window the claim names", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}status`]: "rejected",
					[`${P}representative-claim`]: "seven_day",
					[`${P}reset`]: secs(SEVEN_DAY_RESET),
				}),
				429,
			),
			makeAccount("a"),
		);
		expect(limitKinds(ctx, "a")).toEqual(["weekly"]);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("overage in use with an unrecognised claim marks the account out", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}overage-in-use`]: "true",
					[`${P}representative-claim`]: "seven_day_overage_included",
				}),
			),
			makeAccount("a"),
		);
		expect(limitKinds(ctx, "a")).toEqual(["five_hour"]);
		expect(cached("a").five_hour.resets_at).toBe(
			new Date(atSecond(FIVE_HOUR_RESET)).toISOString(),
		);
	});

	it("overage in use on one family blocks that family only, without a bench", async () => {
		const { ctx, marks } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		const familyOverage = () =>
			respond(
				allowedHeaders({
					[`${P}overage-in-use`]: "true",
					[`${P}representative-claim`]: "seven_day_opus",
					[`${P}reset`]: secs(SEVEN_DAY_RESET),
				}),
			);
		observeLimitHeaders(familyOverage(), account);
		await processProxyResponse(familyOverage(), account, ctx);
		await flush();

		expect(getFamilyBlock("a", "opus")?.source).toBe("header");
		expect(getFamilyBlock("a", "sonnet")).toBeNull();
		expect(limitKinds(ctx, "a")).toEqual(["family"]);
		expect(account.rate_limited_until).toBeNull();
		expect(marks).toEqual([]);
		setSystemTime(new Date(SEVEN_DAY_RESET + 1000));
		expect(getFamilyBlock("a", "opus")).toBeNull();
	});

	it("an overall rejection naming a family leaves the cache to the family classifier", () => {
		seedUsage("a");
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}status`]: "rejected",
					[`${P}representative-claim`]: "seven_day_opus",
				}),
				429,
			),
			makeAccount("a"),
		);
		expect(cached("a").five_hour.utilization).toBe(42);
		expect(cached("a").seven_day.utilization).toBe(21);
	});

	it("an overall rejection without a claim marks the fuller window out at once", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}status`]: "rejected" }), 429),
			makeAccount("a"),
		);
		expect(limitKinds(ctx, "a")).toEqual(["five_hour"]);
	});

	it("an unclaimed rejection with no readings at all still marks the account at once", () => {
		const { ctx } = makeCtx();
		for (const status of [200, 429]) {
			usageCache.clear();
			observeLimitHeaders(
				respond(allowedHeaders({ [`${P}status`]: "rejected" }), status),
				makeAccount("a"),
			);
			expect(limitKinds(ctx, "a")).toEqual(["five_hour"]);
			expect(readingsBeforeHeaderMark("a")).toBeNull();
		}
	});

	it("gives the refusal classifier the readings from before the mark until a real read lands", () => {
		seedUsage("a");
		const original = usageCache.get("a");
		const tipped = () =>
			respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" }));
		observeLimitHeaders(tipped(), makeAccount("a"));
		observeLimitHeaders(tipped(), makeAccount("a"));
		expect(cached("a").five_hour.utilization).toBe(100);
		expect(readingsBeforeHeaderMark("a")).toBe(original as never);

		seedUsage("a");
		expect(readingsBeforeHeaderMark("a")).toBe(usageCache.get("a") as never);
	});

	it("an unclaimed rejection leaves a spent family row to the family classifier", () => {
		usageCache.set("a", {
			five_hour: {
				utilization: 40,
				resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
			},
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
					scope: { model: { id: null, display_name: "Opus" }, surface: null },
				},
			],
		} as never);
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}status`]: "rejected" }), 429),
			makeAccount("a"),
		);
		expect(cached("a").five_hour.utilization).toBe(42);
		expect(cached("a").seven_day.utilization).toBe(21);
	});

	it("a poll already in flight cannot undo the mark, and a fresh read follows", async () => {
		refreshSpy.mockRestore();
		const usageBody = (percent: number) =>
			new Response(
				JSON.stringify({
					five_hour: {
						utilization: percent,
						resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
					},
					seven_day: {
						utilization: 21,
						resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		let releaseStale: (r: Response) => void = () => {};
		const fetchMock = mock((_url: unknown) =>
			fetchMock.mock.calls.length === 1
				? new Promise<Response>((resolve) => {
						releaseStale = resolve;
					})
				: Promise.resolve(usageBody(100)),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
		const stalePoll = usageCache.refreshNow("a");
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const { ctx } = makeCtx();
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}5h-utilization`]: "1.0" })),
			makeAccount("a"),
		);
		expect(limitKinds(ctx, "a")).toContain("five_hour");

		releaseStale(usageBody(40));
		await stalePoll;
		await flush();

		expect(limitKinds(ctx, "a")).toContain("five_hour");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(cached("a").five_hour.utilization).toBe(100);
	});

	it("below-threshold headers change nothing", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		const before = usageCache.get("a");
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}5h-utilization`]: "0.99",
					[`${P}5h-status`]: "allowed_warning",
					[`${P}overage-in-use`]: "false",
				}),
			),
			makeAccount("a"),
		);
		await flush();
		expect(usageCache.get("a")).toBe(before);
		expect(limitKinds(ctx, "a")).toEqual([]);
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("a keepalive burst refusal with no window evidence marks nothing", () => {
		seedUsage("a");
		const before = usageCache.get("a");
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}status`]: "rejected" }), 429),
			makeAccount("a"),
			{ keepalive: true },
		);
		expect(usageCache.get("a")).toBe(before);
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("a keepalive response with a spent window still marks it", () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		observeLimitHeaders(respond(real429Headers(), 429), makeAccount("a"), {
			keepalive: true,
		});
		expect(limitKinds(ctx, "a")).toContain("five_hour");
	});

	it("leaves non-Anthropic accounts alone", async () => {
		observeLimitHeaders(
			respond(
				allowedHeaders({
					[`${P}overage-in-use`]: "true",
					[`${P}5h-utilization`]: "1.0",
				}),
			),
			makeAccount("c", { provider: "openai-compatible" }),
		);
		await flush();
		expect(usageCache.get("c")).toBeNull();
		expect(refreshSpy).not.toHaveBeenCalled();
	});
});

describe("overage cooldown in processProxyResponse", () => {
	it("benches until the unified reset without pausing, streak or breaker", async () => {
		const { ctx, marks } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		const limited = await processProxyResponse(
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
			account,
			ctx,
		);
		expect(limited).toBe(false);
		expect(account.paused).toBe(false);
		expect(account.consecutive_rate_limits).toBe(0);
		expect(account.rate_limited_until).toBe(atSecond(FIVE_HOUR_RESET));
		expect(account.rate_limited_reason).toBe("overage_in_use");
		await flush();
		expect(marks).toEqual([
			{
				accountId: "a",
				until: atSecond(FIVE_HOUR_RESET),
				reason: "overage_in_use",
			},
		]);
	});

	it("holds until the reset even with explicit-reset honouring switched off", async () => {
		const previous = process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET;
		process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET = "false";
		try {
			const { ctx } = makeCtx();
			const account = makeAccount("a");
			await processProxyResponse(
				respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
				account,
				ctx,
			);
			expect(account.rate_limited_until).toBe(atSecond(FIVE_HOUR_RESET));
		} finally {
			if (previous === undefined) {
				delete process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET;
			} else {
				process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET = previous;
			}
		}
	});

	it("is not undone by the success clear of an older bench", async () => {
		const { ctx } = makeCtx();
		const account = makeAccount("a", { rate_limited_until: NOW + 60_000 });
		await processProxyResponse(
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
			account,
			ctx,
		);
		expect(account.rate_limited_until).toBe(atSecond(FIVE_HOUR_RESET));
	});

	it("does nothing without overage in use or for other providers", async () => {
		const { ctx, marks } = makeCtx();
		const plain = makeAccount("a");
		await processProxyResponse(respond(allowedHeaders()), plain, ctx);
		const other = makeAccount("c", { provider: "openai-compatible" });
		await processProxyResponse(
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
			other,
			ctx,
		);
		await flush();
		expect(plain.rate_limited_until).toBeNull();
		expect(other.rate_limited_until).toBeNull();
		expect(marks).toEqual([]);
	});

	it("the bench ends at the reported reset", async () => {
		const { ctx } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		observeLimitHeaders(
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
			account,
		);
		await processProxyResponse(
			respond(allowedHeaders({ [`${P}overage-in-use`]: "true" })),
			account,
			ctx,
		);
		const after = FIVE_HOUR_RESET + 1000;
		setSystemTime(new Date(after));
		const row = makeAccount("a", {
			rate_limited_until: account.rate_limited_until,
		});
		expect(
			collectLimitBlockedAccounts([row], ctx, meta(), MODEL, after),
		).toEqual([]);
		expect(isAccountAvailable(row, after)).toBe(true);
	});
});

describe("through proxyWithAccount (fake upstream)", () => {
	it("a real-shaped upstream 429 marks the account in the cache on every classifier path", async () => {
		refreshSpy.mockImplementation(async () => true);
		const { ctx } = makeCtx();
		seedUsage("a");
		globalThis.fetch = mock(async () =>
			respond(
				real429Headers(),
				429,
				'{"type":"error","error":{"type":"rate_limit_error","message":"x"}}',
			),
		) as unknown as typeof fetch;

		await proxyOnce(ctx, makeAccount("a"));

		expect(cached("a").five_hour.utilization).toBe(100);
		expect(cached("a").seven_day.utilization).toBe(17);
		expect(limitKinds(ctx, "a")).toContain("five_hour");
		await flush();
		expect(refreshSpy).toHaveBeenCalledWith("a");
	});

	it("serves an overage stream in full while the very next selection skips the account", async () => {
		const rows = [makeAccount("a"), makeAccount("b")];
		const { ctx } = makeCtx(rows);
		await initUsageCollector(
			() => false,
			() => {},
			{
				initializeAsync: async () => {},
				saveRequest: async () => {},
				updateRequestUsage: async () => {},
				getAdapter: () => ({ get: async () => null, run: async () => {} }),
			} as never,
		);
		refreshSpy.mockImplementation(async () => true);
		seedUsage("a");
		seedUsage("b");
		expect(
			(await selectAccountsForRequest(meta(), ctx, MODEL)).map((x) => x.id),
		).toEqual(["a", "b"]);

		const chunks = [
			"event: message_start\ndata: {}\n\n",
			'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n',
			"event: message_stop\ndata: {}\n\n",
		];
		globalThis.fetch = mock(async () => {
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
					controller.close();
				},
			});
			return respond(
				allowedHeaders({
					"content-type": "text/event-stream",
					[`${P}overage-in-use`]: "true",
				}),
				200,
				body,
			);
		}) as unknown as typeof fetch;

		const served = await proxyOnce(ctx, makeAccount("a"));

		expect(rows[0].rate_limited_until).toBeNull();
		expect(
			(await selectAccountsForRequest(meta(), ctx, MODEL)).map((x) => x.id),
		).toEqual(["b"]);
		expect(served).not.toBeNull();
		expect(await (served as Response).text()).toBe(chunks.join(""));
	});

	it("a keepalive replay refused without window evidence marks nothing", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		const before = usageCache.get("a");
		globalThis.fetch = mock(async () =>
			respond(allowedHeaders({ [`${P}status`]: "rejected" }), 429),
		) as unknown as typeof fetch;
		const body = requestBody();
		await proxyWithAccount(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body,
				headers: {
					"Content-Type": "application/json",
					[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
					"x-better-ccflare-keepalive": "true",
				},
			}),
			new URL("https://proxy.local/v1/messages"),
			makeAccount("a"),
			meta(),
			body,
			() => undefined,
			0,
			ctx,
		);
		expect(usageCache.get("a")).toBe(before);
	});
});
