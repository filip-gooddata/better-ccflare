import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as discard from "../discard-body-cancel";
import { markAllLimitedSelection } from "../limit-blocked";
import {
	clearLimitRefusalCache,
	getCachedLimitRefusal,
} from "../limit-response";
import { clearFamilyBlocks } from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { HeldLimitRefusal, ProxyContext } from "../proxy-types";

const HOUR = 3_600_000;
const _BODY_MARKER = "refusal-body-marker";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-gooddata",
		name: "gooddata",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
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
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(model: string) {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

function makeContext(allLimitedStrategy = false): ProxyContext {
	return {
		strategy: (allLimitedStrategy
			? { getNextAccount: () => null, selectWhenAllLimited: () => null }
			: { getNextAccount: () => null }) as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

async function run(
	ctx: ProxyContext,
	account: Account,
	meta = makeRequestMeta(),
	onLimitRefusal?: (r: HeldLimitRefusal) => void,
) {
	const body = makeRequestBody("claude-fable-5-2");
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body,
			headers: {
				"Content-Type": "application/json",
				authorization: "Bearer client-auth-secret",
				cookie: "client=cookie-secret",
			},
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		meta,
		body,
		() => undefined,
		0,
		ctx,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		onLimitRefusal,
	);
}

const RESET_S = Math.floor((Date.now() + 2 * HOUR) / 1000);

/** A real-shaped upstream 429 whose body counts how often it is pulled and cancelled. */
function trackedRefusal(
	bodyBytes: Uint8Array,
	reset: string | null = String(RESET_S),
) {
	const stats = { pulls: 0, cancels: 0 };
	let sent = 0;
	const chunk = 16 * 1024;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			stats.pulls++;
			if (sent >= bodyBytes.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(bodyBytes.slice(sent, sent + chunk));
			sent += chunk;
		},
		cancel() {
			stats.cancels++;
		},
	});
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"retry-after": "7200",
		"x-should-retry": "true",
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-5h-status": "rejected",
		"anthropic-ratelimit-unified-5h-utilization": "1.0",
	};
	if (reset !== null) {
		headers["anthropic-ratelimit-unified-reset"] = reset;
		headers["anthropic-ratelimit-unified-5h-reset"] = reset;
	}
	const response = new Response(body, { status: 429, headers });
	return { response, stats };
}

const SMALL_BODY = new TextEncoder().encode(
	JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: "capture-body-marker" },
	}),
);

describe("holdLimitRefusal — per-account capture of the last real 429", () => {
	let discardSpy: ReturnType<typeof spyOn>;
	beforeEach(() => {
		clearLimitRefusalCache();
		clearFamilyBlocks();
		discardSpy = spyOn(discard, "cancelDiscardedResponseBody");
	});
	afterEach(() => {
		discardSpy.mockRestore();
		clearLimitRefusalCache();
		clearFamilyBlocks();
	});

	it("caches the 429 of a request not eligible for holding and drains it once", async () => {
		const { response, stats } = trackedRefusal(SMALL_BODY);
		globalThis.fetch = mock(async () => response);
		const account = makeAccount({ id: "acc-capture" });

		const result = await run(makeContext(false), account);

		expect(result).toBeNull();
		const cached = getCachedLimitRefusal(account.id);
		expect(cached).not.toBeNull();
		expect(cached?.status).toBe(429);
		expect(cached?.resetMs).toBe(RESET_S * 1000);
		expect(new TextDecoder().decode(cached?.body)).toContain(
			"capture-body-marker",
		);
		expect(cached?.headers.get("anthropic-ratelimit-unified-reset")).toBe(
			String(RESET_S),
		);
		// Read once to its end by the capture; the caller did not drain it again.
		expect(discardSpy.mock.calls.some((c) => c[0] === response)).toBe(false);
		expect(stats.cancels).toBe(0);
	});

	it("caches the 429 it holds for an eligible all-limited request, and still hands it over", async () => {
		const { response } = trackedRefusal(SMALL_BODY);
		globalThis.fetch = mock(async () => response);
		const account = makeAccount({ id: "acc-held" });
		const meta = makeRequestMeta();
		markAllLimitedSelection(meta, account.id);
		const held: HeldLimitRefusal[] = [];

		await run(makeContext(true), account, meta, (r) => held.push(r));

		expect(held.length).toBe(1);
		expect(getCachedLimitRefusal(account.id)?.body).toEqual(SMALL_BODY);
		expect(discardSpy.mock.calls.some((c) => c[0] === response)).toBe(false);
	});

	it("does not cache a body over the buffer bound and cancels its stream once", async () => {
		const { response, stats } = trackedRefusal(new Uint8Array(200 * 1024));
		globalThis.fetch = mock(async () => response);
		const account = makeAccount({ id: "acc-large" });

		await run(makeContext(false), account);

		expect(getCachedLimitRefusal(account.id)).toBeNull();
		expect(stats.cancels).toBe(1);
		expect(discardSpy.mock.calls.some((c) => c[0] === response)).toBe(false);
	});

	it("leaves a 429 without a parseable future reset to the caller to drain", async () => {
		const { response } = trackedRefusal(SMALL_BODY, null);
		globalThis.fetch = mock(async () => response);
		const account = makeAccount({ id: "acc-noreset" });

		await run(makeContext(false), account);

		expect(getCachedLimitRefusal(account.id)).toBeNull();
		expect(discardSpy.mock.calls.some((c) => c[0] === response)).toBe(true);
	});
});
