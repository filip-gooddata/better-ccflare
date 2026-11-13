import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { Logger } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { markAllLimitedSelection } from "../limit-blocked";
import { clearFamilyBlocks, getFamilyBlock } from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { HeldLimitRefusal, ProxyContext } from "../proxy-types";

const HOUR = 3_600_000;
const BODY_MARKER = "refusal-body-marker";

function makeAccount(): Account {
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

function refusal(extraHeaders: Record<string, string> = {}): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: BODY_MARKER },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String(
					Math.floor((Date.now() + 2 * 24 * HOUR) / 1000),
				),
				"set-cookie": "session=cookie-secret",
				"x-api-key": "sk-header-secret",
				...extraHeaders,
			},
		},
	);
}

// The measured shape: family at 100 %, five-hour and weekly_all with room,
// weekly resets coinciding.
function usage({ session = 79, weeklyAll = 89, fable = 100 } = {}) {
	const now = Date.now();
	const weeklyReset = new Date(now + 2 * 24 * HOUR).toISOString();
	return {
		limits: [
			{
				kind: "session",
				percent: session,
				resets_at: new Date(now + HOUR).toISOString(),
			},
			{ kind: "weekly_all", percent: weeklyAll, resets_at: weeklyReset },
			{
				kind: "weekly_scoped",
				percent: fable,
				resets_at: weeklyReset,
				scope: { model: { display_name: "Fable" } },
			},
		],
		spend: { enabled: true },
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

describe("proxyWithAccount — family-scoped 429", () => {
	let originalFetch: typeof globalThis.fetch;
	let warnSpy: ReturnType<typeof spyOn>;
	let infoSpy: ReturnType<typeof spyOn>;
	const lines = () =>
		[...warnSpy.mock.calls, ...infoSpy.mock.calls].map((c) => String(c[0]));

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		infoSpy = spyOn(Logger.prototype, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		warnSpy.mockRestore();
		infoSpy.mockRestore();
		usageCache.clear();
		clearFamilyBlocks();
	});

	it("blocks the family without benching the account and fails over", async () => {
		globalThis.fetch = mock(async () => refusal());
		const ctx = makeContext();
		const account = makeAccount();
		const readings = usage();
		usageCache.set(account.id, readings as never);

		const result = await run(ctx, account);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);

		const block = getFamilyBlock(account.id, "fable");
		expect(block?.source).toBe("usage");
		expect(block?.until).toBe(
			Date.parse(readings.limits[2].resets_at as string),
		);
		expect(getFamilyBlock(account.id, "opus")).toBeNull();

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		expect((saveMock.mock.calls[0] as unknown[])[6]).toBe("model_fallback_429");

		const blockLine = lines().find((l) => l.includes(" family_block "));
		expect(blockLine).toContain(
			"[ccflare] account=gooddata family_block family=fable until=",
		);
		expect(blockLine).toContain("source=usage");
	});

	it("still benches the account for an account-wide refusal", async () => {
		globalThis.fetch = mock(async () => refusal());
		const ctx = makeContext();
		const account = makeAccount();
		usageCache.set(account.id, usage({ session: 100 }) as never);

		const result = await run(ctx, account);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(1);
		expect(getFamilyBlock(account.id, "fable")).toBeNull();
		expect(lines().some((l) => l.includes("family_block"))).toBe(false);
		expect(lines().some((l) => l.includes("family_refusal_unclassified"))).toBe(
			false,
		);
	});

	it("benches and logs family_refusal_unclassified when nothing settles it", async () => {
		globalThis.fetch = mock(async () => refusal());
		const ctx = makeContext();
		const account = makeAccount();

		const result = await run(ctx, account);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(1);
		expect(getFamilyBlock(account.id, "fable")).toBeNull();
		expect(lines()).toContain(
			"[ccflare] account=gooddata family_refusal_unclassified detail=no usage readings",
		);
	});

	it("logs one upstream_429 line with rate-limit headers only", async () => {
		globalThis.fetch = mock(async () => refusal());
		const ctx = makeContext();
		const account = makeAccount();
		usageCache.set(account.id, usage() as never);

		await run(ctx, account);

		const headerLines = lines().filter((l) => l.includes(" upstream_429 "));
		expect(headerLines.length).toBe(1);
		const line = headerLines[0];
		expect(line).toStartWith(
			"[ccflare] account=gooddata upstream_429 model=claude-fable-5-2 headers=anthropic-ratelimit-unified-reset=",
		);
		expect(line).toContain("anthropic-ratelimit-unified-status=rejected");
		for (const secret of [
			"cookie-secret",
			"sk-header-secret",
			"client-auth-secret",
			"set-cookie",
			"authorization",
			BODY_MARKER,
		]) {
			expect(line).not.toContain(secret);
		}
	});

	it("holds a family refusal for the all-limited replay without benching", async () => {
		globalThis.fetch = mock(async () => refusal());
		const ctx = makeContext(true);
		const account = makeAccount();
		usageCache.set(account.id, usage() as never);
		const meta = makeRequestMeta();
		markAllLimitedSelection(meta, account.id);
		const held: HeldLimitRefusal[] = [];

		const result = await run(ctx, account, meta, (r) => held.push(r));

		expect(result).toBeNull();
		expect(held.length).toBe(1);
		expect(held[0].status).toBe(429);
		expect(held[0].account.id).toBe(account.id);
		expect(held[0].headers.get("anthropic-ratelimit-unified-status")).toBe(
			"rejected",
		);
		expect(new TextDecoder().decode(held[0].body as never)).toContain(
			BODY_MARKER,
		);
		expect(account.rate_limited_until).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);
		expect(getFamilyBlock(account.id, "fable")).not.toBeNull();
	});
});
