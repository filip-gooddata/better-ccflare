import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
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
import { selectAccountsForRequest } from "../account-selector";
import { resetHeaderMarkOutForTests } from "../header-mark-out";
import { collectLimitBlockedAccounts } from "../limit-blocked";
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

function makeCtx(providerName = "anthropic", rows: Account[] = []) {
	const marks: Array<{ accountId: string; until: number; reason: string }> = [];
	const strategy: LoadBalancingStrategy = {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
	};
	const provider =
		providerName === "anthropic"
			? new AnthropicProvider()
			: {
					name: providerName,
					parseRateLimit: () => ({ isRateLimited: false }),
					isStreamingResponse: () => false,
				};
	const ctx = {
		provider,
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
			updateAccountUsage: async () => {},
			updateAccountRateLimitMeta: async () => {},
			resetConsecutiveRateLimits: async () => {},
			getAdapter: () => ({ get: async () => null, run: async () => {} }),
		},
		asyncWriter: {
			enqueue: (job: () => unknown) => {
				void Promise.resolve().then(job);
			},
		},
		config: {
			getModelScopedCapacityRouting: () => "off",
			getForceAccountModel: () => false,
			getComboSessionFallback: () => true,
		},
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
	return { ctx, marks };
}

function meta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers: new Headers(),
		clientSessionId: null,
	};
}

const secs = (ms: number) => String(Math.floor(ms / 1000));

/** A plain (overage off) usage snapshot with both windows well below 100 %. */
function seedUsage(id: string, fiveHour = 40, sevenDay = 20) {
	usageCache.set(id, {
		five_hour: {
			utilization: fiveHour,
			resets_at: new Date(FIVE_HOUR_RESET).toISOString(),
		},
		seven_day: {
			utilization: sevenDay,
			resets_at: new Date(SEVEN_DAY_RESET).toISOString(),
		},
		spend: { enabled: false },
	} as never);
}

function headers(extra: Record<string, string>): Headers {
	return new Headers({ "content-type": "application/json", ...extra });
}

function allowedHeaders(extra: Record<string, string> = {}) {
	return headers({
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

/**
 * The limits in force for a freshly loaded row (no cooldown persisted yet),
 * i.e. what the next selection in the same event-loop turn sees.
 */
function blockedNow(ctx: ProxyContext, id: string, now = NOW) {
	const fresh = makeAccount(id);
	return {
		limits:
			collectLimitBlockedAccounts([fresh], ctx, meta(), MODEL, now)[0]
				?.limits ?? [],
	};
}

let refreshSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	setSystemTime(new Date(NOW));
	resetHeaderMarkOutForTests();
	resetRateLimitProbeGatesForTests();
	refreshSpy = spyOn(usageCache, "refreshNow").mockImplementation(
		async () => true,
	);
});

afterEach(() => {
	refreshSpy.mockRestore();
	setSystemTime();
	usageCache.clear();
});

describe("header-driven mark-out on Anthropic responses", () => {
	it("overage-in-use on a 200 marks the account out until the unified reset without pausing it", async () => {
		const { ctx, marks } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		const response = new Response("{}", {
			status: 200,
			headers: allowedHeaders({ [`${P}overage-in-use`]: "true" }),
		});

		const limited = await processProxyResponse(response, account, ctx);
		expect(limited).toBe(false);

		const now = blockedNow(ctx, "a");
		expect(now.limits.length).toBeGreaterThan(0);
		expect(account.paused).toBe(false);
		expect(account.rate_limited_until).toBe(
			Math.floor(FIVE_HOUR_RESET / 1000) * 1000,
		);
		expect(account.rate_limited_reason).toBe("overage_in_use");
		await Promise.resolve();
		await Promise.resolve();
		expect(marks).toEqual([
			{
				accountId: "a",
				until: Math.floor(FIVE_HOUR_RESET / 1000) * 1000,
				reason: "overage_in_use",
			},
		]);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("5h utilization 1.0 writes the header numbers into the usage cache and re-reads usage once per burst", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		const tipped = () =>
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({
					[`${P}5h-utilization`]: "1.0",
					[`${P}5h-status`]: "allowed_warning",
				}),
			});

		await processProxyResponse(tipped(), makeAccount("a"), ctx);
		const cached = usageCache.get("a") as {
			five_hour: { utilization: number; resets_at: string };
			seven_day: { utilization: number; resets_at: string };
		};
		expect(cached.five_hour.utilization).toBe(100);
		expect(Date.parse(cached.five_hour.resets_at)).toBe(
			Math.floor(FIVE_HOUR_RESET / 1000) * 1000,
		);
		expect(cached.seven_day.utilization).toBe(21);
		expect(blockedNow(ctx, "a").limits.map((l) => l.kind)).toContain(
			"five_hour",
		);

		await processProxyResponse(tipped(), makeAccount("a"), ctx);
		await processProxyResponse(tipped(), makeAccount("a"), ctx);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith("a");
	});

	it("7d utilization 1.0 marks the weekly window out", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({ [`${P}7d-utilization`]: "1.0" }),
			}),
			makeAccount("a"),
			ctx,
		);
		expect(blockedNow(ctx, "a").limits.map((l) => l.kind)).toContain("weekly");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("a 5h status of rejected marks the account out even below 1.0", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		await processProxyResponse(
			new Response("{}", {
				status: 429,
				headers: headers({
					"retry-after": "7200",
					[`${P}status`]: "rejected",
					[`${P}reset`]: secs(FIVE_HOUR_RESET),
					[`${P}5h-status`]: "rejected",
					[`${P}5h-reset`]: secs(FIVE_HOUR_RESET),
					[`${P}5h-utilization`]: "0.99",
					[`${P}7d-status`]: "allowed_warning",
					[`${P}7d-reset`]: secs(SEVEN_DAY_RESET),
					[`${P}7d-utilization`]: "0.17",
				}),
			}),
			makeAccount("a"),
			ctx,
		);
		const cached = usageCache.get("a") as {
			five_hour: { utilization: number };
		};
		expect(cached.five_hour.utilization).toBe(100);
		expect(blockedNow(ctx, "a").limits.map((l) => l.kind)).toContain(
			"five_hour",
		);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("an overall unified status of rejected on a 200 marks the binding window out", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({
					[`${P}status`]: "rejected",
					[`${P}representative-claim`]: "seven_day",
					[`${P}reset`]: secs(SEVEN_DAY_RESET),
				}),
			}),
			makeAccount("a"),
			ctx,
		);
		const kinds = blockedNow(ctx, "a").limits.map((l) => l.kind);
		expect(kinds).toContain("weekly");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("below-threshold headers change nothing", async () => {
		const { ctx, marks } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		const before = usageCache.get("a");
		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({
					[`${P}5h-utilization`]: "0.99",
					[`${P}5h-status`]: "allowed_warning",
					[`${P}overage-in-use`]: "false",
				}),
			}),
			account,
			ctx,
		);
		await Promise.resolve();
		expect(usageCache.get("a")).toBe(before);
		expect(blockedNow(ctx, "a").limits).toEqual([]);
		expect(account.rate_limited_until).toBeNull();
		expect(marks).toEqual([]);
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("the mark ends at the reported reset", async () => {
		const { ctx } = makeCtx();
		const account = makeAccount("a");
		seedUsage("a");
		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({
					[`${P}overage-in-use`]: "true",
					[`${P}5h-utilization`]: "1.0",
				}),
			}),
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

	it("never cuts a stream already being served", async () => {
		const { ctx } = makeCtx();
		seedUsage("a");
		const chunks = [
			"event: message_start\ndata: {}\n\n",
			'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n',
			"event: message_stop\ndata: {}\n\n",
		];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
				controller.close();
			},
		});
		const response = new Response(body, {
			status: 200,
			headers: allowedHeaders({
				"content-type": "text/event-stream",
				[`${P}overage-in-use`]: "true",
			}),
		});

		await processProxyResponse(response, makeAccount("a"), ctx);

		expect(blockedNow(ctx, "a").limits.length).toBeGreaterThan(0);
		expect(response.bodyUsed).toBe(false);
		expect(await response.text()).toBe(chunks.join(""));
	});

	it("the very next selection, before any database write lands, skips the marked account", async () => {
		const rows = [makeAccount("a"), makeAccount("b")];
		const { ctx } = makeCtx("anthropic", rows);
		seedUsage("a");
		seedUsage("b");
		expect(
			(await selectAccountsForRequest(meta(), ctx, MODEL)).map((x) => x.id),
		).toEqual(["a", "b"]);

		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({ [`${P}overage-in-use`]: "true" }),
			}),
			makeAccount("a"),
			ctx,
		);

		expect(rows[0].rate_limited_until).toBeNull();
		expect(
			(await selectAccountsForRequest(meta(), ctx, MODEL)).map((x) => x.id),
		).toEqual(["b"]);
	});

	it("a keepalive burst refusal marks nothing", async () => {
		const { ctx } = makeCtx();
		(ctx as { internalProbeSecret?: string }).internalProbeSecret = "s3cret";
		seedUsage("a");
		const before = usageCache.get("a");
		await processProxyResponse(
			new Response("{}", {
				status: 429,
				headers: headers({
					[`${P}status`]: "rejected",
					[`${P}reset`]: secs(FIVE_HOUR_RESET),
					[`${P}5h-utilization`]: "0.42",
				}),
			}),
			makeAccount("a"),
			ctx,
			undefined,
			{
				headers: new Headers({
					[INTERNAL_PROBE_SECRET_HEADER]: "s3cret",
					"x-better-ccflare-keepalive": "true",
				}),
			},
		);
		expect(usageCache.get("a")).toBe(before);
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("leaves non-Anthropic providers alone", async () => {
		const { ctx, marks } = makeCtx("openai-compatible");
		const account = makeAccount("c", { provider: "openai-compatible" });
		await processProxyResponse(
			new Response("{}", {
				status: 200,
				headers: allowedHeaders({
					[`${P}overage-in-use`]: "true",
					[`${P}5h-utilization`]: "1.0",
				}),
			}),
			account,
			ctx,
		);
		await Promise.resolve();
		expect(usageCache.get("c")).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(marks).toEqual([]);
		expect(refreshSpy).not.toHaveBeenCalled();
	});
});
