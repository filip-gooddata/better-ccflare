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
import * as providersModule from "@better-ccflare/providers";
import { getProvider, usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * The send gate, round 2: a cycled fallback model is gated on the family of
 * the model actually sent; the last check runs right before the upstream
 * fetch, after every await of request preparation; the local 429 for gated
 * skips ranks attempted accounts' cooldowns too; every retry site is gated.
 * Helpers copied from gate-every-attempt.test.ts.
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

const iso = (ms: number | null) =>
	ms === null ? null : new Date(ms).toISOString();
const win = (utilization: number, resetAt: number | null) => ({
	utilization,
	resets_at: iso(resetAt),
});

function usage(parts: {
	fiveHour?: { utilization: number; resets_at: string | null };
	sevenDay?: { utilization: number; resets_at: string | null };
	family?: Array<{ percent: number; resetAt: number; displayName?: string }>;
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
			scope: {
				model: { id: null, display_name: row.displayName ?? "Opus" },
				surface: null,
			},
		}));
	}
	return data as never;
}

type FullKind = "five-hour" | "weekly" | "family";

/** Puts `id` at a full limit of `kind` resetting at `resetAt`. */
function setFull(id: string, kind: FullKind, resetAt: number) {
	if (kind === "five-hour")
		usageCache.set(id, usage({ fiveHour: win(100, resetAt) }));
	else if (kind === "weekly")
		usageCache.set(id, usage({ sevenDay: win(100, resetAt) }));
	else
		usageCache.set(id, usage({ family: [{ percent: 100, resetAt: resetAt }] }));
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

/** Copied from all-limited-forward.test.ts installUpstream. */
function _installUpstream(handler: (account: string) => Response) {
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

const forced = (id: string) => ({ "x-better-ccflare-account-id": id });
const bypassProbe = (id: string) => ({
	...forced(id),
	"x-better-ccflare-bypass-session": "true",
});
/** The headers AutoRefreshScheduler.sendDummyMessage sends (auto-refresh-scheduler.ts). */
const _internalProbe = (id: string) => ({
	...bypassProbe(id),
	"x-better-ccflare-auto-refresh": "true",
	"x-better-ccflare-internal-probe-secret": PROBE_SECRET,
});

async function send(ctx: ProxyContext, request = makeRequest()) {
	try {
		return await handleProxy(request, new URL(request.url), ctx);
	} catch (error) {
		return error as Error;
	}
}

/** The local 429 describing a limit that resets at `resetAt`. */
async function expectLocal429(received: Response | Error, resetAt: number) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(429);
	expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
		"rejected",
	);
	expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(
		String(Math.floor(resetAt / 1000)),
	);
	expect(response.headers.get("retry-after")).toBe(
		String(Math.max(1, Math.floor((resetAt - NOW) / 1000))),
	);
	expect(response.headers.get("x-should-retry")).toBe("true");
	const body = (await response.json()) as {
		type: string;
		error: { type: string };
	};
	expect(body.type).toBe("error");
	expect(body.error.type).toBe("rate_limit_error");
}

/** The local 429 describing a cooldown only (no unified reset): status,
 * retry-after under `maxSeconds`, x-should-retry, rate_limit_error body. */
async function expectCooldown429(
	received: Response | Error,
	maxSeconds: number,
) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(429);
	const retryAfter = Number(response.headers.get("retry-after"));
	expect(retryAfter).toBeGreaterThan(0);
	expect(retryAfter).toBeLessThan(maxSeconds);
	expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBeNull();
	expect(response.headers.get("x-should-retry")).toBe("true");
	const body = (await response.json()) as { error: { type: string } };
	expect(body.error.type).toBe("rate_limit_error");
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

function _comboOf(accountIds: string[]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: NOW,
		updated_at: NOW,
		slots: accountIds.map((accountId, index) => ({
			id: `slot-${index}`,
			combo_id: "combo-1",
			account_id: accountId,
			model: MODEL,
			priority: index,
			enabled: true,
		})),
	} as ComboWithSlots;
}

/** Records which account and which model every upstream request carried. */
function installRecordingUpstream(
	handler: (account: string, model: string, call: number) => Response,
) {
	const calls: Array<{ account: string; model: string }> = [];
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const account = accountOf(input, init);
		const raw =
			init?.body !== undefined && init?.body !== null
				? await new Response(init.body as BodyInit).text()
				: input instanceof Request
					? await input.clone().text()
					: "";
		let model = "";
		try {
			model = (JSON.parse(raw) as { model?: string }).model ?? "";
		} catch {}
		calls.push({ account, model });
		return handler(account, model, calls.length);
	}) as unknown as typeof fetch;
	return calls;
}

const SONNET = "claude-sonnet-4-5";

function modelNotFound(model: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "not_found_error", message: `model: ${model}` },
		}),
		{ status: 404, headers: { "content-type": "application/json" } },
	);
}

function serverError(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "api_error", message: "Internal server error" },
		}),
		{ status: 500, headers: { "content-type": "application/json" } },
	);
}
const FABLE = "claude-fable-5-2";

/** Runs `flip` inside the anthropic provider's upstream observation hook: the
 * last await before the upstream fetch. `flip` gets the 1-based call number. */
function duringPreparation(flip: (call: number) => void): () => void {
	const provider = getProvider("anthropic") as unknown as {
		observeUpstream?: unknown;
	};
	const had = Object.hasOwn(provider, "observeUpstream");
	const previous = provider.observeUpstream;
	let call = 0;
	provider.observeUpstream = async () => {
		call++;
		await Promise.resolve();
		flip(call);
		return undefined;
	};
	return () => {
		if (had) provider.observeUpstream = previous;
		else delete provider.observeUpstream;
	};
}

function anthropicError(status: number, type: string, message: string) {
	return new Response(
		JSON.stringify({ type: "error", error: { type, message } }),
		{ status, headers: { "content-type": "application/json" } },
	);
}

describe("cycled fallback model: gated on the family actually sent", () => {
	it("the fallback's own family is full while the mapping sends it to another family: not sent", async () => {
		const reset = NOW + 3 * HOUR;
		usageCache.set(
			"a",
			usage({
				family: [{ percent: 100, resetAt: reset, displayName: "Sonnet" }],
			}),
		);
		const calls = installRecordingUpstream((_account, model) =>
			model === MODEL ? modelNotFound(model) : ok200("a"),
		);
		const ctx = makeCtx([
			makeAccount("a", {
				model_mappings: JSON.stringify({
					opus: [MODEL, SONNET],
					sonnet: [FABLE],
				}),
			}),
		]);

		const response = await send(ctx);

		expect(calls).toEqual([{ account: "a", model: MODEL }]);
		expect((response as Response).status).not.toBe(200);
	});

	it("the converse: the mapped family is full but the fallback's own family is not: sent", async () => {
		usageCache.set(
			"a",
			usage({
				family: [
					{ percent: 100, resetAt: NOW + 3 * HOUR, displayName: "Fable" },
				],
			}),
		);
		const calls = installRecordingUpstream((_account, model) =>
			model === MODEL ? modelNotFound(model) : ok200("a"),
		);
		const ctx = makeCtx([
			makeAccount("a", {
				model_mappings: JSON.stringify({
					opus: [MODEL, SONNET],
					sonnet: [FABLE],
				}),
			}),
		]);

		const response = await send(ctx);

		expect(calls).toEqual([
			{ account: "a", model: MODEL },
			{ account: "a", model: SONNET },
		]);
		expect((response as Response).status).toBe(200);
	});
});

describe("final check right before the upstream fetch", () => {
	it("the only account turns full during request preparation: not sent, local 429", async () => {
		const reset = NOW + 2 * HOUR;
		const restore = duringPreparation(() => setFull("a", "five-hour", reset));
		try {
			const calls = installRecordingUpstream((account) => ok200(account));
			const ctx = makeCtx([makeAccount("a")]);

			const response = await send(ctx);

			expect(calls).toEqual([]);
			await expectLocal429(response, reset);
		} finally {
			restore();
		}
	});

	it("the first candidate turns full during preparation: not sent, the next one serves", async () => {
		const restore = duringPreparation((call) => {
			if (call === 1) setFull("a", "five-hour", NOW + 2 * HOUR);
		});
		try {
			const calls = installRecordingUpstream((account) => ok200(account));
			const ctx = makeCtx([
				makeAccount("a", { priority: 0 }),
				makeAccount("b", { priority: 1 }),
			]);

			const response = await send(ctx);

			expect(calls.map((c) => c.account)).toEqual(["b"]);
			expect((response as Response).status).toBe(200);
		} finally {
			restore();
		}
	});

	it("a cycled fallback model's family turns full during its preparation: not sent, local 429", async () => {
		const reset = NOW + 3 * HOUR;
		const restore = duringPreparation((call) => {
			if (call === 2)
				usageCache.set(
					"a",
					usage({
						family: [{ percent: 100, resetAt: reset, displayName: "Sonnet" }],
					}),
				);
		});
		try {
			const calls = installRecordingUpstream((_account, model) =>
				model === MODEL ? modelNotFound(model) : ok200("a"),
			);
			const ctx = makeCtx([
				makeAccount("a", {
					model_mappings: JSON.stringify({ opus: [MODEL, SONNET] }),
				}),
			]);

			const response = await send(ctx);

			expect(calls).toEqual([{ account: "a", model: MODEL }]);
			await expectLocal429(response, reset);
		} finally {
			restore();
		}
	});
});

describe("local 429 from gated skips ranks attempted accounts too", () => {
	it("an attempted account's cooldown ends before the skipped account's reset: the 429 describes the cooldown", async () => {
		const skippedReset = NOW + 2 * HOUR;
		const calls = installRecordingUpstream((account) => {
			if (account === "a") {
				setFull("b", "five-hour", skippedReset);
				return serverError();
			}
			return ok200(account);
		});
		const ctx = makeCtx([
			makeAccount("a", { priority: 0 }),
			makeAccount("b", { priority: 1 }),
		]);

		const response = await send(ctx);

		expect(calls.map((c) => c.account)).not.toContain("b");
		// a's transient-error cooldown (60 s) ends long before b's five-hour
		// reset: the local 429 describes a's cooldown, not b's reset.
		await expectCooldown429(response, (skippedReset - NOW) / 1000);
	});
});

describe("every retry site is gated", () => {
	const fill = () => setFull("a", "five-hour", NOW + 2 * HOUR);

	it("thinking-signature retry: not sent once the account is full", async () => {
		const calls = installRecordingUpstream(() => {
			fill();
			return anthropicError(
				400,
				"invalid_request_error",
				"messages.1.content.0: Invalid `signature` in `thinking` block",
			);
		});
		const ctx = makeCtx([makeAccount("a")]);
		const request = makeRequest({
			body: {
				model: MODEL,
				max_tokens: 16,
				messages: [
					{ role: "user", content: "hello" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "t", signature: "bad" },
							{ type: "text", text: "x" },
						],
					},
					{ role: "user", content: "again" },
				],
			},
		});

		const response = await send(ctx, request);

		expect(calls).toHaveLength(1);
		await expectLocal429(response, NOW + 2 * HOUR);
	});

	it("cache_control retry: not sent once the account is full", async () => {
		const calls = installRecordingUpstream(() => {
			fill();
			return anthropicError(
				400,
				"invalid_request_error",
				"Extra inputs are not permitted: cache_control",
			);
		});
		const ctx = makeCtx([makeAccount("a")]);
		const request = makeRequest({
			body: {
				model: MODEL,
				max_tokens: 16,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "hello",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			},
		});

		const response = await send(ctx, request);

		expect(calls).toHaveLength(1);
		await expectLocal429(response, NOW + 2 * HOUR);
	});

	it("529 in-place retry: not re-issued once the account is full", async () => {
		const calls = installRecordingUpstream(() => {
			fill();
			return anthropicError(529, "overloaded_error", "Overloaded");
		});
		const ctx = makeCtx([makeAccount("a")]);

		await send(ctx);

		expect(calls).toHaveLength(1);
	});

	it("transient 5xx in-place retry: not re-issued once the account is full", async () => {
		const calls = installRecordingUpstream(() => {
			fill();
			return serverError();
		});
		const ctx = makeCtx([makeAccount("a")]);

		await send(ctx);

		expect(calls).toHaveLength(1);
	});

	it("codex continuation retry: not sent once the account is full", async () => {
		spyOn(
			providersModule,
			"recoverCodexMessagesContinuation",
		).mockImplementation(
			(async (_provider: unknown, _response: Response, request: Request) =>
				request) as never,
		);
		const calls = installRecordingUpstream(() => {
			fill();
			return anthropicError(404, "not_found_error", "previous response");
		});
		const ctx = makeCtx([makeAccount("a", { provider: "codex" })]);

		await send(ctx);

		expect(calls).toHaveLength(1);
	});
});
