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
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	LimitBlockedAccount,
	LoadBalancingStrategy,
} from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import {
	clearLimitRefusalCache,
	rememberLimitRefusal,
} from "../handlers/limit-response";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const MODEL = "claude-opus-4-5";
const originalFetch = globalThis.fetch;

/** Headers dropped on every proxied response because Bun's fetch has already
 * decoded the body (http-common/src/headers.ts withSanitizedProxyHeaders). */
const HOP_BY_HOP = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
]);

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: `rt-${id}`,
		access_token: `token-${id}`,
		expires_at: NOW + 24 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
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
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

const iso = (ms: number | null) =>
	ms === null ? null : new Date(ms).toISOString();
const win = (utilization: number, resetAt: number | null) => ({
	utilization,
	resets_at: iso(resetAt),
});

function usage(parts: {
	fiveHour?: { utilization: number; resets_at: string | null };
	sevenDay?: { utilization: number; resets_at: string | null };
	family?: Array<{ percent: number; resetAt: number }>;
}) {
	const data: Record<string, unknown> = {
		five_hour: parts.fiveHour ?? win(10, NOW + HOUR),
		seven_day: parts.sevenDay ?? win(10, NOW + 48 * HOUR),
		spend: { enabled: false },
	};
	if (parts.family) {
		data.limits = parts.family.map((row) => ({
			kind: "weekly_scoped",
			percent: row.percent,
			resets_at: iso(row.resetAt),
			scope: { model: { id: null, display_name: "Opus" }, surface: null },
		}));
	}
	return data as never;
}

/**
 * Anthropic's limit refusal, with header names taken from what this repo
 * parses: anthropic-ratelimit-unified-status/-reset/-remaining
 * (providers/src/providers/anthropic/provider.ts parseRateLimit), the per-window
 * -5h-* names (retryable-429.test.ts), retry-after, request-id. The status value
 * "rejected" follows retryable-429.test.ts; the body follows
 * proxy-operations-429-provider-reset.test.ts. Values are assumptions about the
 * live API, not captures of it.
 */
function limitHeaders(
	resetAt: number,
	account: string,
	retryAfter?: string,
): Record<string, string> {
	const resetSec = String(Math.floor(resetAt / 1000));
	return {
		"content-type": "application/json",
		"request-id": `req_upstream_${account}`,
		"retry-after":
			retryAfter ?? String(Math.ceil((resetAt - Date.now()) / 1000)),
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-reset": resetSec,
		"anthropic-ratelimit-unified-remaining": "0",
		"anthropic-ratelimit-unified-5h-status": "rejected",
		"anthropic-ratelimit-unified-5h-reset": resetSec,
		"anthropic-ratelimit-unified-5h-utilization": "1.0",
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"x-upstream-account": account,
	};
}

function limitBody(account: string): string {
	return JSON.stringify({
		type: "error",
		error: {
			type: "rate_limit_error",
			message: `quota exhausted (${account})`,
		},
	});
}

function limit429(
	resetAt: number,
	account: string,
	retryAfter?: string,
): Response {
	return new Response(limitBody(account), {
		status: 429,
		statusText: "Too Many Requests",
		headers: limitHeaders(resetAt, account, retryAfter),
	});
}

/** A retry-after that disagrees with the unified reset, as an aged refusal would. */
const STALE_RETRY_AFTER = "17";

/** Cache a real refusal for `account`, as an earlier upstream 429 would have. */
function rememberRefusal(account: string, resetAt: number) {
	rememberLimitRefusal(account, {
		status: 429,
		statusText: "Too Many Requests",
		headers: new Headers(limitHeaders(resetAt, account, STALE_RETRY_AFTER)),
		body: new TextEncoder().encode(limitBody(account)),
	});
}

function ok200(account: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: MODEL,
			content: [{ type: "text", text: `hi from ${account}` }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Which account a fake-fetch call was made for (from its bearer token). */
function accountOf(input: unknown, init?: RequestInit): string {
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	const auth = headers.get("authorization") ?? "";
	return auth.replace(/^Bearer token-/, "");
}

type Upstream = (account: string, callIndex: number) => Response;

function installUpstream(handler: Upstream) {
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const account = accountOf(input, init);
		calls.push(account);
		return handler(account, calls.length - 1);
	}) as unknown as typeof fetch;
	return calls;
}

/**
 * A database of account rows: every getAllAccounts call returns fresh copies,
 * and markAccountRateLimited writes the rows the way the repository does
 * (account.repository.ts: increment unconditionally, or a guarded write).
 */
function fakeDb(accounts: Account[]) {
	const rows = new Map(accounts.map((a) => [a.id, { ...a }]));
	const writes: Array<{ id: string; until: number; increment: boolean }> = [];
	const markAccountRateLimited = mock(
		async (id: string, until: number, _reason: string, increment = true) => {
			writes.push({ id, until, increment });
			const acc = rows.get(id);
			if (!acc) return { consecutiveRateLimits: 0, applied: false };
			if (increment) {
				acc.consecutive_rate_limits = (acc.consecutive_rate_limits ?? 0) + 1;
				acc.rate_limited_until = until;
				return {
					consecutiveRateLimits: acc.consecutive_rate_limits,
					applied: true,
				};
			}
			const applied =
				acc.rate_limited_until == null || acc.rate_limited_until <= until;
			if (applied) acc.rate_limited_until = until;
			return {
				consecutiveRateLimits: acc.consecutive_rate_limits ?? 0,
				applied,
			};
		},
	);
	const base: Record<string, unknown> = {
		getAllAccounts: mock(async () =>
			[...rows.values()].map((row) => ({ ...row })),
		),
		getActiveComboForFamily: mock(async () => null),
		markAccountRateLimited,
		saveRequest: mock(async () => {}),
		updateAccountUsage: mock(async () => {}),
		getAdapter: mock(() => ({
			run: mock(async () => {}),
			get: mock(async () => null),
		})),
	};
	const dbOps = new Proxy(base, {
		get: (target, prop: string) =>
			prop in target ? target[prop] : mock(async () => undefined),
	});
	const row = (id: string) => rows.get(id) as Account;
	return { dbOps, writes, markAccountRateLimited, row };
}

function makeCtx(
	accounts: Account[],
	strategy: LoadBalancingStrategy,
	opts: { capacityRouting?: boolean } = {},
) {
	const db = fakeDb(accounts);
	const ctx = {
		strategy,
		dbOps: db.dbOps,
		runtime: { port: 8080, clientId: "test" },
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () =>
				opts.capacityRouting ? "exhausted" : "off",
			getForceAccountModel: () => false,
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		},
		provider: { name: "anthropic", canHandle: () => true },
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		},
	} as unknown as ProxyContext;
	return { ctx, ...db };
}

function paceStrategy(): SessionPaceStrategy {
	const strategy = new SessionPaceStrategy({}, { timeZone: "Europe/Prague" });
	(strategy as unknown as { log: { info: () => void } }).log.info = () => {};
	return strategy;
}

/** Filters like the real strategies; keeps the given order. */
function plainStrategy(): LoadBalancingStrategy {
	return {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
	} as unknown as LoadBalancingStrategy;
}

/** plainStrategy plus an earliest-usable-again pick, with deterministic order. */
function earliestResetStrategy(): LoadBalancingStrategy & {
	picks: LimitBlockedAccount[][];
} {
	const picks: LimitBlockedAccount[][] = [];
	const usableAt = (entry: LimitBlockedAccount) =>
		Math.max(...entry.limits.map((l) => l.resetAt ?? Number.POSITIVE_INFINITY));
	return {
		...plainStrategy(),
		picks,
		selectWhenAllLimited: (blocked: LimitBlockedAccount[]) => {
			picks.push(blocked);
			const sorted = [...blocked].sort((x, y) => usableAt(x) - usableAt(y));
			return sorted[0]?.account ?? null;
		},
	} as never;
}

function makeRequest(
	opts: { stream?: boolean; session?: string | null } = {},
): Request {
	const body: Record<string, unknown> = {
		model: MODEL,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16,
	};
	if (opts.stream) body.stream = true;
	if (opts.session) body.metadata = { user_id: opts.session };
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function send(ctx: ProxyContext, request = makeRequest()) {
	try {
		return await handleProxy(request, new URL(request.url), ctx);
	} catch (error) {
		return error as Error;
	}
}

async function _expectUpstreamIdentity(
	received: Response | Error,
	expected: { status: number; headers: Record<string, string>; body: string },
) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(expected.status);
	for (const [name, value] of Object.entries(expected.headers)) {
		if (HOP_BY_HOP.has(name)) continue;
		expect([name, response.headers.get(name)]).toEqual([name, value]);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect(bytes).toEqual(new TextEncoder().encode(expected.body));
	const added = [...response.headers.keys()].filter(
		(name) => !(name in expected.headers),
	);
	return added;
}

/** Upstream requests per account token seen by the fake fetch. */
function perAccount(calls: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const account of calls) counts[account] = (counts[account] ?? 0) + 1;
	return counts;
}

const retryAfterFor = (resetAt: number) =>
	String(Math.max(1, Math.floor(resetAt / 1000 - NOW / 1000)));

/**
 * The local 429 built from readings: Anthropic's shape, unified reset at the
 * binding reset, retry-after counted from it, and no upstream headers.
 */
async function expectBuiltLimit429(
	received: Response | Error,
	expected: { resetAt: number; claim?: string; head?: boolean },
) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(429);
	expect(response.headers.get("content-type")).toContain("application/json");
	expect(response.headers.get("x-should-retry")).toBe("true");
	expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
		"rejected",
	);
	expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(
		String(Math.floor(expected.resetAt / 1000)),
	);
	expect(response.headers.get("retry-after")).toBe(
		retryAfterFor(expected.resetAt),
	);
	if (expected.claim) {
		expect(
			response.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe(expected.claim);
	}
	expect(response.headers.get("x-upstream-account")).toBeNull();
	if (expected.head) return;
	const body = (await response.json()) as {
		type: string;
		error: { type: string; message: unknown };
	};
	expect(body.type).toBe("error");
	expect(body.error.type).toBe("rate_limit_error");
	expect(typeof body.error.message).toBe("string");
}

/**
 * A replayed real refusal: body bytes as received, every upstream header kept
 * except retry-after (recounted from the unified reset) and date (now).
 */
async function expectReplayedRefusal(
	received: Response | Error,
	expected: { account: string; resetAt: number; body?: string },
) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(429);
	const upstream = limitHeaders(expected.resetAt, expected.account);
	for (const [name, value] of Object.entries(upstream)) {
		if (HOP_BY_HOP.has(name) || name === "retry-after") continue;
		expect([name, response.headers.get(name)]).toEqual([name, value]);
	}
	expect(response.headers.get("retry-after")).toBe(
		retryAfterFor(expected.resetAt),
	);
	expect(response.headers.get("date")).toBe(new Date(NOW).toUTCString());
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect(bytes).toEqual(
		new TextEncoder().encode(expected.body ?? limitBody(expected.account)),
	);
}

beforeEach(() => {
	setSystemTime(new Date(NOW));
	clearLimitRefusalCache();
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
});

afterEach(() => {
	setSystemTime();
	globalThis.fetch = originalFetch;
	usageCache.clear();
	clearLimitRefusalCache();
	clearFamilyExhaustionCache();
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	mock.restore();
});

describe("session-pace with every account out on limits", () => {
	for (const stream of [false, true]) {
		it(`answers the local 429 of the account that resets first and forwards nothing (stream=${stream})`, async () => {
			const weekly = makeAccount("weekly");
			const fiveHour = makeAccount("five");
			usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
			usageCache.set("five", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
			const calls = installUpstream((account) =>
				limit429(NOW + 2 * HOUR, account),
			);
			const { ctx } = makeCtx([weekly, fiveHour], paceStrategy());

			const response = await send(ctx, makeRequest({ stream }));

			expect(perAccount(calls)).toEqual({});
			await expectBuiltLimit429(response, {
				resetAt: NOW + 2 * HOUR,
				claim: "five_hour",
			});
		});

		it(`replays the cached real 429 of the account that resets first, rebased to now (stream=${stream})`, async () => {
			const weekly = makeAccount("weekly");
			const fiveHour = makeAccount("five");
			usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
			usageCache.set("five", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
			rememberRefusal("five", NOW + 2 * HOUR);
			const calls = installUpstream((account) =>
				limit429(NOW + 2 * HOUR, account),
			);
			const { ctx } = makeCtx([weekly, fiveHour], paceStrategy());

			const response = await send(ctx, makeRequest({ stream }));

			expect(perAccount(calls)).toEqual({});
			await expectReplayedRefusal(response, {
				account: "five",
				resetAt: NOW + 2 * HOUR,
			});
		});
	}

	it("answers the local 429 even when the account it names would have served", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
		usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([a, b], paceStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	it("takes the reset from the cooldown when the account it names is out only on a cooldown", async () => {
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(40, NOW + 4 * HOUR) }));
		usageCache.set("b", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([a, b], paceStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	it("answers a bypass-session request without a forced account with the local 429", async () => {
		// Cooldowns, not full windows: on this branch the usage-cap prefilter
		// still readmits a capped account for the bypass header (the gate
		// stream closes that).
		const a = makeAccount("a", { rate_limited_until: NOW + 3 * HOUR });
		const b = makeAccount("b", { rate_limited_until: NOW + HOUR });
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([a, b], paceStrategy());

		const response = await send(
			ctx,
			headerRequest({ "x-better-ccflare-bypass-session": "true" }),
		);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	for (const session of ["mapped-session", "new-session", null]) {
		it(`routes a request with session=${session} the same way`, async () => {
			const strategy = paceStrategy();
			const a = makeAccount("a");
			const b = makeAccount("b");
			const { ctx } = makeCtx([a, b], strategy);
			if (session === "mapped-session") {
				installUpstream((account) => ok200(account));
				await send(ctx, makeRequest({ session }));
			}
			usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
			usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
			const calls = installUpstream((account) => limit429(NOW + HOUR, account));

			const response = await send(ctx, makeRequest({ session }));

			expect(perAccount(calls)).toEqual({});
			await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
		});
	}

	it("answers a family-exhausted request with the family 429 of the account whose family limit resets first", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set(
			"a",
			usage({ family: [{ percent: 100, resetAt: NOW + 50 * HOUR }] }),
		);
		usageCache.set(
			"b",
			usage({ family: [{ percent: 100, resetAt: NOW + 20 * HOUR }] }),
		);
		const calls = installUpstream((account) =>
			limit429(NOW + 20 * HOUR, account),
		);
		const { ctx } = makeCtx([a, b], paceStrategy(), { capacityRouting: true });

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, {
			resetAt: NOW + 20 * HOUR,
			claim: "seven_day_opus",
		});
	});

	it("never describes a paused account, even one that resets first", async () => {
		const paused = makeAccount("paused", { paused: true });
		const b = makeAccount("b");
		usageCache.set("paused", usage({ fiveHour: win(100, NOW + HOUR) }));
		usageCache.set("b", usage({ fiveHour: win(100, NOW + 4 * HOUR) }));
		const calls = installUpstream((account) =>
			limit429(NOW + 4 * HOUR, account),
		);
		const { ctx } = makeCtx([paused, b], paceStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + 4 * HOUR });
	});

	it("keeps the proxy's own error when every account is paused", async () => {
		const a = makeAccount("a", { paused: true });
		const b = makeAccount("b", { paused: true });
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = makeCtx([a, b], paceStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual([]);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pool_exhausted");
	});
});

describe("other strategies keep today's local errors", () => {
	it("gives the local 503 when every account is in cooldown", async () => {
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const b = makeAccount("b", { rate_limited_until: NOW + 2 * HOUR });
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = makeCtx([a, b], plainStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual([]);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pool_exhausted");
	});

	it("keeps the local family 429", async () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({ family: [{ percent: 100, resetAt: NOW + 20 * HOUR }] }),
		);
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = makeCtx([a], plainStrategy(), { capacityRouting: true });

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual([]);
		expect(response.status).toBe(429);
		const body = (await response.json()) as {
			error: { type: string; code?: string };
		};
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.code).toBeUndefined();
		expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
			"rejected",
		);
	});

	it("still turns an upstream 429 on the last candidate into the local error", async () => {
		const a = makeAccount("a");
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = makeCtx([a], plainStrategy());

		const response = await send(ctx);

		expect(calls).toEqual(["a"]);
		const status =
			response instanceof Response
				? response.status
				: (response as { statusCode?: number }).statusCode;
		expect(status).toBe(503);
	});
});

describe("failover path C", () => {
	it("replays the held refusal, retry-after recounted from its unified reset, when the account that refused last resets first", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + 3 * HOUR, "a")
				: limit429(NOW + HOUR, "b", STALE_RETRY_AFTER),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "b",
			resetAt: NOW + HOUR,
		});
	});

	it("answers the local 429 of the earliest account when it is not the one held, with no further upstream request", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + HOUR, "a", STALE_RETRY_AFTER)
				: limit429(NOW + 3 * HOUR, "b"),
		);
		const strategy = earliestResetStrategy();
		const { ctx, row } = makeCtx([a, b], strategy);

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		expect(strategy.picks).toHaveLength(1);
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
		});
		expect(row("a").consecutive_rate_limits).toBe(1);
	});

	it("never asks the earliest account again, even when it would now serve", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account, index) =>
			index >= 2
				? ok200(account)
				: account === "a"
					? limit429(NOW + HOUR, "a")
					: limit429(NOW + 3 * HOUR, "b"),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
		});
	});

	it("replays the held refusal when the rule picks no account", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + HOUR, "a")
				: limit429(NOW + 3 * HOUR, "b", STALE_RETRY_AFTER),
		);
		const strategy = {
			...plainStrategy(),
			selectWhenAllLimited: () => null,
		} as unknown as LoadBalancingStrategy;
		const { ctx } = makeCtx([a, b], strategy);

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "b",
			resetAt: NOW + 3 * HOUR,
		});
	});

	it("leaves a strategy without the rule at today's local error", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = makeCtx([a, b], plainStrategy());

		const response = await send(ctx);

		expect(calls).toEqual(["a", "b"]);
		const status =
			response instanceof Response
				? response.status
				: (response as { statusCode?: number }).statusCode;
		expect(status).toBe(503);
	});

	it("sees this request's refusals while their cooldown writes are still queued", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + HOUR, "a")
				: limit429(NOW + 3 * HOUR, "b"),
		);
		const { ctx, writes } = makeCtx([a, b], earliestResetStrategy());
		const queued: Array<() => void | Promise<void>> = [];
		(
			ctx as unknown as {
				asyncWriter: { enqueue: (job: () => void | Promise<void>) => void };
			}
		).asyncWriter.enqueue = (job) => {
			queued.push(job);
		};

		const response = await send(ctx);

		expect(writes).toHaveLength(0);
		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
		});
	});

	it("answers with the held refusal even when a token looks old enough to need re-authentication", async () => {
		const a = makeAccount("a", { created_at: NOW - 400 * 24 * HOUR });
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + 3 * HOUR, "a")
				: limit429(NOW + HOUR, "b", STALE_RETRY_AFTER),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "b",
			resetAt: NOW + HOUR,
		});
	});
});

describe("refusals on the rule path (point 6)", () => {
	it("are answered locally, leave consecutive_rate_limits and the cooldown unchanged, and the account eligible once its reset passes", async () => {
		const a = makeAccount("a", { consecutive_rate_limits: 2 });
		const b = makeAccount("b");
		usageCache.set("b", usage({ sevenDay: win(100, NOW + 40 * HOUR) }));
		a.rate_limited_until = NOW + HOUR;
		a.rate_limited_reason = "upstream_429_with_reset";
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx, writes, row } = makeCtx([a, b], paceStrategy());

		for (let i = 0; i < 4; i++) {
			await expectBuiltLimit429(await send(ctx), { resetAt: NOW + HOUR });
		}

		expect(perAccount(calls)).toEqual({});
		expect(row("a").consecutive_rate_limits).toBe(2);
		expect(writes).toHaveLength(0);
		expect(row("a").rate_limited_until).toBe(NOW + HOUR);
		expect(row("a").paused).toBe(false);

		setSystemTime(new Date(NOW + HOUR + 1));
		expect(isAccountAvailable(row("a"), Date.now())).toBe(true);
		const okCalls = installUpstream((account) => ok200(account));
		const response = (await send(ctx)) as Response;
		expect(okCalls).toEqual(["a"]);
		expect(response.status).toBe(200);
	});
});

describe("end-to-end ordering", () => {
	it("describes the account out on its 5-hour window, not the one out for the week", async () => {
		const weekly = makeAccount("weekly", { priority: 0 });
		const five = makeAccount("five", { priority: 5 });
		usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 20 * HOUR) }));
		usageCache.set("five", usage({ fiveHour: win(100, NOW + 4 * HOUR) }));
		const calls = installUpstream((account) =>
			limit429(NOW + 4 * HOUR, account),
		);
		const { ctx } = makeCtx([weekly, five], paceStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, {
			resetAt: NOW + 4 * HOUR,
			claim: "five_hour",
		});
	});

	it("describes the cached refusal of the account it picks, not another account's", async () => {
		const weekly = makeAccount("weekly", { priority: 0 });
		const five = makeAccount("five", { priority: 5 });
		usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 20 * HOUR) }));
		usageCache.set("five", usage({ fiveHour: win(100, NOW + 4 * HOUR) }));
		rememberRefusal("weekly", NOW + 20 * HOUR);
		rememberRefusal("five", NOW + 4 * HOUR);
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([weekly, five], paceStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectReplayedRefusal(response, {
			account: "five",
			resetAt: NOW + 4 * HOUR,
		});
	});
});

function headerRequest(headers: Record<string, string>): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

async function summary(received: Response | Error) {
	if (!(received instanceof Response)) return { error: String(received) };
	return { status: received.status, body: await received.text() };
}

describe("requests that own their routing never reach failover path C", () => {
	const cases: Array<[string, Record<string, string>]> = [
		["a forced account", { "x-better-ccflare-account-id": "b" }],
		[
			"an auto-refresh or keepalive probe",
			{
				"x-better-ccflare-account-id": "b",
				"x-better-ccflare-bypass-session": "true",
			},
		],
		["a bypass-session request", { "x-better-ccflare-bypass-session": "true" }],
	];
	for (const [label, headers] of cases) {
		it(`answers ${label} that gets a 429 as today, with no second forward`, async () => {
			const run = async (strategy: LoadBalancingStrategy) => {
				// Each run starts from no readings: the 429 a run gets marks its account
				// in the usage cache, which would otherwise carry into the next run.
				usageCache.clear();
				const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
				const b = makeAccount("b");
				const calls = installUpstream((account) =>
					limit429(NOW + 3 * HOUR, account),
				);
				const { ctx } = makeCtx([a, b], strategy);
				const response = await send(ctx, headerRequest(headers));
				return { calls, result: await summary(response) };
			};

			const rule = await run(earliestResetStrategy());
			const today = await run(plainStrategy());

			expect(rule.calls).toEqual(today.calls);
			expect(rule.calls).not.toContain("a");
			expect(rule.result).toEqual(today.result);
		});
	}
});

/** A 429 whose body is larger than the held-refusal buffer, with a cancel probe. */
function bigLimit429(
	resetAt: number,
	account: string,
	retryAfter?: string,
	size = 100 * 1024,
) {
	const text = JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: "x".repeat(size) },
	});
	const bytes = new TextEncoder().encode(text);
	const state = { cancelled: false };
	const chunk = 8 * 1024;
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + chunk));
			offset += chunk;
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const response = new Response(body, {
		status: 429,
		statusText: "Too Many Requests",
		headers: limitHeaders(resetAt, account, retryAfter),
	});
	return { response, text, state };
}

describe("a limit refusal larger than the held-refusal buffer", () => {
	it("reaches the client whole, rebased to now, when it is the only answer", async () => {
		const a = makeAccount("a");
		const big = bigLimit429(NOW + HOUR, "a", STALE_RETRY_AFTER);
		const calls = installUpstream(() => big.response);
		const { ctx } = makeCtx([a], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1 });
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
			body: big.text,
		});
	});

	it("is released and its account answered locally when it resets first, after a later refusal", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const big = bigLimit429(NOW + HOUR, "a");
		const calls = installUpstream((account, index) =>
			index === 0 ? big.response : limit429(NOW + 3 * HOUR, account),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		expect(big.state.cancelled).toBe(true);
		// Too large to keep, so a's answer is built from its cooldown.
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	it("is released when a later refusal replaces it", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const big = bigLimit429(NOW + 3 * HOUR, "a");
		const calls = installUpstream((account) =>
			account === "a"
				? big.response
				: limit429(NOW + HOUR, "b", STALE_RETRY_AFTER),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		expect(big.state.cancelled).toBe(true);
		await expectReplayedRefusal(response, {
			account: "b",
			resetAt: NOW + HOUR,
		});
	});

	it("is released when the rule picks another account, and nothing more is asked upstream", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const big = bigLimit429(NOW + 3 * HOUR, "b");
		const calls = installUpstream((account) =>
			account === "a" ? limit429(NOW + HOUR, "a") : big.response,
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		expect(big.state.cancelled).toBe(true);
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
		});
	});

	it("is released when a later candidate succeeds", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const big = bigLimit429(NOW + HOUR, "a");
		installUpstream((account) => (account === "a" ? big.response : ok200("b")));
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = (await send(ctx)) as Response;

		expect(response.status).toBe(200);
		expect(big.state.cancelled).toBe(true);
	});
});

describe("a held limit refusal and an exception after it", () => {
	it("cancels the held upstream body when the request throws", async () => {
		const a = makeAccount("a");
		const big = bigLimit429(NOW + HOUR, "a");
		installUpstream(() => big.response);
		const { ctx } = makeCtx([a], earliestResetStrategy());
		spyOn(cacheBodyStore, "discardStaged").mockImplementation(() => {
			throw new Error("staging store failed");
		});

		const received = await send(ctx);

		expect(received).toBeInstanceOf(Error);
		expect((received as Error).message).toBe("staging store failed");
		expect(big.state.cancelled).toBe(true);
	});

	it("leaves the held body to the client when it is replayed", async () => {
		const a = makeAccount("a");
		const big = bigLimit429(NOW + HOUR, "a", STALE_RETRY_AFTER);
		const calls = installUpstream(() => big.response);
		const { ctx } = makeCtx([a], earliestResetStrategy());

		const response = await send(ctx);

		expect(big.state.cancelled).toBe(false);
		expect(perAccount(calls)).toEqual({ a: 1 });
		await expectReplayedRefusal(response, {
			account: "a",
			resetAt: NOW + HOUR,
			body: big.text,
		});
	});
});

describe("failover path C target discovery", () => {
	it("replays the held refusal, rebased to now, when reading the accounts fails", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + HOUR, "a")
				: limit429(NOW + 3 * HOUR, "b", STALE_RETRY_AFTER),
		);
		const { ctx, dbOps } = makeCtx([a, b], earliestResetStrategy());
		const ops = dbOps as unknown as Record<string, unknown>;
		const readRows = ops.getAllAccounts as () => Promise<Account[]>;
		ops.getAllAccounts = mock(async () => {
			if (calls.length >= 2) throw new Error("database is locked");
			return readRows();
		});

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({ a: 1, b: 1 });
		await expectReplayedRefusal(response, {
			account: "b",
			resetAt: NOW + 3 * HOUR,
		});
	});
});

/**
 * The deployed setting: MODEL_SCOPED_CAPACITY_ROUTING=exhausted. A request
 * with a model then runs the model-scoped capacity filter, and a strategy
 * that already left no candidate must still reach the all-limited rule
 * rather than end in the local pool_exhausted 503.
 */
describe("session-pace with every account out on limits and capacity routing on", () => {
	const routed = (accounts: Account[]) =>
		makeCtx(accounts, paceStrategy(), { capacityRouting: true });

	for (const stream of [false, true]) {
		it(`answers the local 429 of the account usable first for a message (stream=${stream})`, async () => {
			const weekly = makeAccount("weekly");
			const five = makeAccount("five");
			usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
			usageCache.set("five", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
			const calls = installUpstream((account) =>
				limit429(NOW + 2 * HOUR, account),
			);
			const { ctx } = routed([weekly, five]);

			const response = await send(ctx, makeRequest({ stream }));

			expect(perAccount(calls)).toEqual({});
			await expectBuiltLimit429(response, {
				resetAt: NOW + 2 * HOUR,
				claim: "five_hour",
			});
		});
	}

	for (const session of ["first-request-of-a-session", null]) {
		it(`answers session=${session} with the local 429 of the account usable first`, async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
			usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
			const calls = installUpstream((account) => limit429(NOW + HOUR, account));
			const { ctx } = routed([a, b]);

			const response = await send(ctx, makeRequest({ session }));

			expect(perAccount(calls)).toEqual({});
			await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
		});
	}

	it("builds the answer from cooldowns alone when usage data is missing, as right after a restart", async () => {
		const a = makeAccount("a", { rate_limited_until: NOW + 2 * HOUR });
		const b = makeAccount("b", { rate_limited_until: NOW + HOUR });
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = routed([a, b]);

		const response = await send(ctx);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	it("answers count_tokens with the local 429", async () => {
		const a = makeAccount("a");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + HOUR) }));
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = routed([a]);
		const request = new Request(
			"https://proxy.local/v1/messages/count_tokens",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: MODEL,
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);

		const response = await send(ctx, request);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR });
	});

	it("answers HEAD /api/hello with the local 429", async () => {
		const a = makeAccount("a");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + HOUR) }));
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = routed([a]);
		const request = new Request("https://proxy.local/api/hello", {
			method: "HEAD",
		});

		const response = await send(ctx, request);

		expect(perAccount(calls)).toEqual({});
		await expectBuiltLimit429(response, { resetAt: NOW + HOUR, head: true });
	});

	it("keeps the proxy's own 503 when every account is paused or needs re-login", async () => {
		const a = makeAccount("a", { paused: true });
		const b = makeAccount("b", { requires_reauth: true });
		usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx } = routed([a, b]);

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual([]);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pool_exhausted");
	});
});
