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
import type { ProxyContext } from "../handlers";
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
): Record<string, string> {
	const resetSec = String(Math.floor(resetAt / 1000));
	return {
		"content-type": "application/json",
		"request-id": `req_upstream_${account}`,
		"retry-after": String(Math.ceil((resetAt - Date.now()) / 1000)),
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

function limit429(resetAt: number, account: string): Response {
	return new Response(limitBody(account), {
		status: 429,
		statusText: "Too Many Requests",
		headers: limitHeaders(resetAt, account),
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

async function expectUpstreamIdentity(
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

beforeEach(() => {
	setSystemTime(new Date(NOW));
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
	clearFamilyExhaustionCache();
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	mock.restore();
});

describe("session-pace with every account out on limits", () => {
	for (const stream of [false, true]) {
		it(`forwards to the account that resets first and returns its upstream response unchanged (stream=${stream})`, async () => {
			const weekly = makeAccount("weekly");
			const fiveHour = makeAccount("five");
			usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
			usageCache.set("five", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
			const calls = installUpstream((account) =>
				limit429(NOW + 2 * HOUR, account),
			);
			const { ctx } = makeCtx([weekly, fiveHour], paceStrategy());

			const response = await send(ctx, makeRequest({ stream }));

			expect(calls).toEqual(["five"]);
			const added = await expectUpstreamIdentity(response, {
				status: 429,
				headers: limitHeaders(NOW + 2 * HOUR, "five"),
				body: limitBody("five"),
			});
			expect(added).toEqual(["x-better-ccflare-request-id"]);
		});
	}

	it("passes a success from the target through like any success", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
		usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([a, b], paceStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual(["b"]);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("hi from b");
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

			const response = (await send(ctx, makeRequest({ session }))) as Response;

			expect(calls).toEqual(["b"]);
			expect(response.status).toBe(429);
			expect(await response.text()).toBe(limitBody("b"));
		});
	}

	it("forwards a family-exhausted request to the account whose family limit resets first", async () => {
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

		expect(calls).toEqual(["b"]);
		await expectUpstreamIdentity(response, {
			status: 429,
			headers: limitHeaders(NOW + 20 * HOUR, "b"),
			body: limitBody("b"),
		});
	});

	it("never targets a paused account, even one that resets first", async () => {
		const paused = makeAccount("paused", { paused: true });
		const b = makeAccount("b");
		usageCache.set("paused", usage({ fiveHour: win(100, NOW + HOUR) }));
		usageCache.set("b", usage({ fiveHour: win(100, NOW + 4 * HOUR) }));
		const calls = installUpstream((account) =>
			limit429(NOW + 4 * HOUR, account),
		);
		const { ctx } = makeCtx([paused, b], paceStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual(["b"]);
		expect(response.status).toBe(429);
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

	it("keeps the local 429 model_family_exhausted", async () => {
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
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("model_family_exhausted");
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
	it("returns the held refusal when the account that refused last resets first", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + 3 * HOUR, "a")
				: limit429(NOW + HOUR, "b"),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(calls).toEqual(["a", "b"]);
		await expectUpstreamIdentity(response, {
			status: 429,
			headers: limitHeaders(NOW + HOUR, "b"),
			body: limitBody("b"),
		});
	});

	it("forwards once more to the earliest account when it is not the one held", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + HOUR, "a")
				: limit429(NOW + 3 * HOUR, "b"),
		);
		const strategy = earliestResetStrategy();
		const { ctx, writes, row } = makeCtx([a, b], strategy);

		const response = await send(ctx);

		expect(calls).toEqual(["a", "b", "a"]);
		expect(strategy.picks).toHaveLength(1);
		await expectUpstreamIdentity(response, {
			status: 429,
			headers: limitHeaders(NOW + HOUR, "a"),
			body: limitBody("a"),
		});
		// The extra forward is on the rule path: its refusal does not grow the streak.
		expect(writes.at(-1)).toMatchObject({ id: "a", increment: false });
		expect(row("a").consecutive_rate_limits).toBe(1);
	});

	it("passes a success from the extra forward through", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account, index) =>
			index === 2
				? ok200(account)
				: account === "a"
					? limit429(NOW + HOUR, "a")
					: limit429(NOW + 3 * HOUR, "b"),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual(["a", "b", "a"]);
		expect(response.status).toBe(200);
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
		expect(calls).toEqual(["a", "b", "a"]);
		await expectUpstreamIdentity(response, {
			status: 429,
			headers: limitHeaders(NOW + HOUR, "a"),
			body: limitBody("a"),
		});
	});

	it("answers with the held refusal even when a token looks old enough to need re-authentication", async () => {
		const a = makeAccount("a", { created_at: NOW - 400 * 24 * HOUR });
		const b = makeAccount("b");
		const calls = installUpstream((account) =>
			account === "a"
				? limit429(NOW + 3 * HOUR, "a")
				: limit429(NOW + HOUR, "b"),
		);
		const { ctx } = makeCtx([a, b], earliestResetStrategy());

		const response = await send(ctx);

		expect(calls).toEqual(["a", "b"]);
		await expectUpstreamIdentity(response, {
			status: 429,
			headers: limitHeaders(NOW + HOUR, "b"),
			body: limitBody("b"),
		});
	});
});

describe("refusals on the rule path (point 6)", () => {
	it("leave consecutive_rate_limits unchanged and the account eligible once its reset passes", async () => {
		const a = makeAccount("a", { consecutive_rate_limits: 2 });
		const b = makeAccount("b");
		usageCache.set("b", usage({ sevenDay: win(100, NOW + 40 * HOUR) }));
		a.rate_limited_until = NOW + HOUR;
		a.rate_limited_reason = "upstream_429_with_reset";
		const calls = installUpstream((account) => limit429(NOW + HOUR, account));
		const { ctx, writes, row } = makeCtx([a, b], paceStrategy());

		for (let i = 0; i < 4; i++) {
			const response = (await send(ctx)) as Response;
			expect(response.status).toBe(429);
		}

		expect(calls).toEqual(["a", "a", "a", "a"]);
		expect(row("a").consecutive_rate_limits).toBe(2);
		expect(writes).toHaveLength(4);
		expect(writes.every((w) => w.id === "a" && !w.increment)).toBe(true);
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
	it("prefers the account out on its 5-hour window over the one out for the week", async () => {
		const weekly = makeAccount("weekly", { priority: 0 });
		const five = makeAccount("five", { priority: 5 });
		usageCache.set("weekly", usage({ sevenDay: win(100, NOW + 20 * HOUR) }));
		usageCache.set("five", usage({ fiveHour: win(100, NOW + 4 * HOUR) }));
		const calls = installUpstream((account) =>
			limit429(NOW + 4 * HOUR, account),
		);
		const { ctx } = makeCtx([weekly, five], paceStrategy());

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual(["five"]);
		expect(response.status).toBe(429);
		expect(response.headers.get("x-upstream-account")).toBe("five");
	});
});
