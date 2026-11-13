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
import type { Account, LoadBalancingStrategy } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	blockFamily,
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
} from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const MODEL = "claude-fable-5";
const DAY = 24 * HOUR;
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

function makeRequest(
	opts: { stream?: boolean; session?: string | null; model?: string } = {},
): Request {
	const body: Record<string, unknown> = {
		model: opts.model ?? MODEL,
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
	clearFamilyBlocks();
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	mock.restore();
});

for (const capacityRouting of [false, true]) {
	describe(`every account blocked for the family (capacity routing ${capacityRouting ? "on" : "off"})`, () => {
		for (const stream of [false, true]) {
			it(`forwards to the account whose block ends first and returns its upstream 429 unchanged (stream=${stream})`, async () => {
				const a = makeAccount("a");
				const b = makeAccount("b");
				blockFamily("a", "fable", NOW + 50 * HOUR, "header");
				blockFamily("b", "fable", NOW + 20 * HOUR, "header");
				const calls = installUpstream((account) =>
					limit429(NOW + 20 * HOUR, account),
				);
				const { ctx } = makeCtx([a, b], paceStrategy(), { capacityRouting });

				const response = await send(ctx, makeRequest({ stream }));

				expect(calls).toEqual(["b"]);
				await expectUpstreamIdentity(response, {
					status: 429,
					headers: limitHeaders(NOW + 20 * HOUR, "b"),
					body: limitBody("b"),
				});
			});
		}

		it("keeps the local model_family_exhausted for a strategy without the all-limited rule", async () => {
			const a = makeAccount("a");
			blockFamily("a", "fable", NOW + 20 * HOUR, "header");
			const calls = installUpstream((account) => limit429(NOW + HOUR, account));
			const { ctx } = makeCtx([a], plainStrategy(), { capacityRouting });

			const response = (await send(ctx)) as Response;

			expect(calls).toEqual([]);
			expect(response.status).toBe(429);
			const body = (await response.json()) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("model_family_exhausted");
			expect(body.error.message).toContain("Upstream refused the fable");
		});

		it("still serves another family from a blocked account", async () => {
			const a = makeAccount("a");
			blockFamily("a", "fable", NOW + 20 * HOUR, "header");
			const calls = installUpstream((account) => ok200(account));
			const { ctx } = makeCtx([a], paceStrategy(), { capacityRouting });

			const response = (await send(
				ctx,
				makeRequest({ model: "claude-opus-4-5" }),
			)) as Response;

			expect(calls).toEqual(["a"]);
			expect(response.status).toBe(200);
		});
	});
}

describe("a sticky session-pace session on a family-blocked account", () => {
	it("moves to another account that serves the family and stays there", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		const calls = installUpstream((account) => ok200(account));
		const { ctx } = makeCtx([a, b], paceStrategy());
		const session = "user_abc_account_x_session_sticky-family";

		const first = (await send(ctx, makeRequest({ session }))) as Response;
		expect(first.status).toBe(200);
		const home = calls[0];
		const other = home === "a" ? "b" : "a";

		// Still sticky without a block.
		await send(ctx, makeRequest({ session }));
		expect(calls[1]).toBe(home);

		blockFamily(home, "fable", NOW + DAY, "header");
		const moved = (await send(ctx, makeRequest({ session }))) as Response;
		expect(moved.status).toBe(200);
		expect(calls[2]).toBe(other);

		// Rebound: once the block is gone the session stays where it moved.
		clearFamilyBlocks();
		await send(ctx, makeRequest({ session }));
		expect(calls).toEqual([home, home, other, other]);
	});
});
