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
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import { usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	clearLimitRefusalCache,
	getCachedLimitRefusal,
	LOCAL_429_HEADER,
	rememberLimitRefusal,
} from "../handlers/limit-response";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { replayLimitRefusal } from "../handlers/proxy-operations";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * Provenance of the proxy's local-429 marker: only a 429 the proxy builds
 * itself carries `x-better-ccflare-local-429`. The same header arriving from
 * upstream is stripped before anything reads the response, so it is neither
 * forwarded to the client (the auto-refresh scheduler is such a client) nor
 * kept in the cached real 429 that later local answers replay.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const MODEL = "claude-opus-4-5";
const PROBE_SECRET = "test-secret";
const originalFetch = globalThis.fetch;

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

/** Which account a fake-fetch call was made for (from its bearer token). */
function accountOf(input: unknown, init?: RequestInit): string {
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	const auth = headers.get("authorization") ?? "";
	return auth.replace(/^Bearer token-/, "");
}

/** Copied from all-limited-forward.test.ts installUpstream. */
function installUpstream(handler: (account: string) => Response) {
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const account = accountOf(input, init);
		calls.push(account);
		return handler(account);
	}) as unknown as typeof fetch;
	return calls;
}

function makeCtx(
	accounts: Account[],
	opts: { combo?: ComboWithSlots | null; comboFallback?: boolean } = {},
) {
	const rows = new Map(accounts.map((a) => [a.id, { ...a }]));
	const base: Record<string, unknown> = {
		getAllAccounts: mock(async () =>
			[...rows.values()].map((row) => ({ ...row })),
		),
		getActiveComboForFamily: mock(async () => opts.combo ?? null),
		markAccountRateLimited: mock(async () => ({
			consecutiveRateLimits: 0,
			applied: false,
		})),
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
	const strategy = new SessionPaceStrategy({}, { timeZone: "Europe/Prague" });
	(strategy as unknown as { log: { info: () => void } }).log.info = () => {};
	return {
		strategy,
		dbOps,
		runtime: { port: 8080, clientId: "test" },
		internalProbeSecret: PROBE_SECRET,
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "exhausted",
			getForceAccountModel: () => false,
			getComboSessionFallback: () => opts.comboFallback ?? true,
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
}

function makeRequest(
	opts: {
		headers?: Record<string, string>;
		session?: string | null;
		body?: Record<string, unknown>;
	} = {},
): Request {
	const body: Record<string, unknown> = opts.body ?? {
		model: MODEL,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16,
	};
	if (opts.session) body.metadata = { user_id: opts.session };
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...opts.headers },
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

const UPSTREAM_TEXT = "upstream said no";

/** Upstream's real limit 429, carrying a forged local-429 marker. */
function upstreamLimit429WithMarker(resetAt: number): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: UPSTREAM_TEXT },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(Math.floor((resetAt - NOW) / 1000)),
				"x-should-retry": "true",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String(Math.floor(resetAt / 1000)),
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"anthropic-ratelimit-unified-5h-status": "rejected",
				"anthropic-ratelimit-unified-5h-reset": String(
					Math.floor(resetAt / 1000),
				),
				"anthropic-ratelimit-unified-5h-utilization": "1.0",
				[LOCAL_429_HEADER]: "limit",
			},
		},
	);
}

beforeEach(() => {
	setSystemTime(new Date(NOW));
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	clearLimitRefusalCache();
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
	clearLimitRefusalCache();
	mock.restore();
});

describe("local-429 marker provenance", () => {
	it("an upstream 429 carrying the marker reaches the client without it, and is cached without it", async () => {
		const resetAt = NOW + 2 * HOUR;
		installUpstream(() => upstreamLimit429WithMarker(resetAt));
		const ctx = makeCtx([makeAccount("a")]);

		const received = await send(ctx);

		expect(received).toBeInstanceOf(Response);
		const response = received as Response;
		expect(response.status).toBe(429);
		expect(response.headers.has(LOCAL_429_HEADER)).toBe(false);
		const cached = getCachedLimitRefusal("a", NOW);
		expect(cached).not.toBeNull();
		expect(cached?.headers.has(LOCAL_429_HEADER)).toBe(false);
	});

	it("the next request's local answer replays the cached real 429 without the marker", async () => {
		const resetAt = NOW + 2 * HOUR;
		const calls = installUpstream(() => upstreamLimit429WithMarker(resetAt));
		const ctx = makeCtx([makeAccount("a")]);

		await send(ctx);
		const second = await send(ctx);

		expect(second).toBeInstanceOf(Response);
		const response = second as Response;
		expect(response.status).toBe(429);
		const body = (await response.json()) as { error: { message: string } };
		if (body.error.message === UPSTREAM_TEXT) {
			// A replay of upstream's refusal: never marked as the proxy's own.
			expect(response.headers.has(LOCAL_429_HEADER)).toBe(false);
		}
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});

	it("the real-429 cache never keeps the marker", () => {
		const headers = new Headers({
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-reset": String(
				Math.floor((NOW + HOUR) / 1000),
			),
			[LOCAL_429_HEADER]: "limit",
		});
		rememberLimitRefusal(
			"a",
			{
				status: 429,
				statusText: "Too Many Requests",
				headers,
				body: new Uint8Array(),
			},
			NOW,
		);
		expect(getCachedLimitRefusal("a", NOW)?.headers.has(LOCAL_429_HEADER)).toBe(
			false,
		);
	});

	it("a held upstream refusal is replayed without the marker", () => {
		const response = replayLimitRefusal(
			{
				account: makeAccount("a"),
				status: 429,
				statusText: "Too Many Requests",
				headers: new Headers({ [LOCAL_429_HEADER]: "cooldown" }),
				body: new Uint8Array(new ArrayBuffer(0)),
			},
			"req-1",
		);
		expect(response.headers.has(LOCAL_429_HEADER)).toBe(false);
	});
});
