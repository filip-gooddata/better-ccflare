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
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * The gate right before every upstream send: an account that is full by then
 * (five-hour, weekly, or the outgoing model's family at 100 %) is not sent to,
 * whether it filled up after selection or a fallback model's family is full;
 * when nothing else serves, the local 429 answers. A stream already being
 * served is never cut. A combo whose every slot is full answers with the local
 * 429 even with session fallback disabled. Helpers copied from
 * full-account-local-429.test.ts.
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

function comboOf(accountIds: string[]): ComboWithSlots {
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

describe("gate before every upstream attempt", () => {
	it("model cycling: a fallback model whose family is full is not sent", async () => {
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
				model_mappings: JSON.stringify({ opus: [MODEL, SONNET] }),
			}),
		]);

		const response = await send(ctx);

		expect(calls.map((c) => c.model)).not.toContain(SONNET);
		expect(calls).toEqual([{ account: "a", model: MODEL }]);
		expect(response).toBeInstanceOf(Response);
		expect((response as Response).status).not.toBe(200);
	});

	it("a candidate that turned full between selection and failover is skipped; local 429 answers", async () => {
		const reset = NOW + 2 * HOUR;
		const calls = installRecordingUpstream((account) => {
			if (account === "a") {
				// While the first candidate is being asked, the second fills up.
				setFull("b", "five-hour", reset);
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
		// a's transient-error cooldown ends before b's reset: it is described.
		await expectCooldown429(response, (reset - NOW) / 1000);
	});

	it("a combo slot that turned full after selection is skipped, with session fallback disabled: local 429, not 503", async () => {
		const reset = NOW + 2 * HOUR;
		const calls = installRecordingUpstream((account) => {
			if (account === "slot-a") {
				setFull("slot-b", "weekly", reset);
				return serverError();
			}
			return ok200(account);
		});
		const ctx = makeCtx([makeAccount("slot-a"), makeAccount("slot-b")], {
			combo: comboOf(["slot-a", "slot-b"]),
			comboFallback: false,
		});

		const response = await send(ctx);

		expect(calls.map((c) => c.account)).not.toContain("slot-b");
		// slot-a's transient-error cooldown ends before slot-b's reset.
		await expectCooldown429(response, (reset - NOW) / 1000);
	});

	it("a stream already being served is not cut when its account turns full mid-stream", async () => {
		const encoder = new TextEncoder();
		const events = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part one "}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part two"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls = installRecordingUpstream(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode(events[0] as string));
							await gate;
							for (const event of events.slice(1)) {
								controller.enqueue(encoder.encode(event));
							}
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const ctx = makeCtx([makeAccount("a")]);

		const response = (await send(
			ctx,
			makeRequest({
				body: {
					model: MODEL,
					stream: true,
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				},
			}),
		)) as Response;
		expect(response.status).toBe(200);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);

		// The account fills up while its stream is still being served.
		setFull("a", "five-hour", NOW + 2 * HOUR);
		release();

		let text = new TextDecoder().decode(first.value);
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}
		expect(calls).toHaveLength(1);
		expect(text).toContain("part two");
		expect(text).toContain("message_stop");
	});
});

describe("combo with session fallback disabled", () => {
	it("every combo slot full: local 429 (status, body, unified headers), zero upstream requests", async () => {
		setFull("slot-a", "weekly", NOW + 30 * HOUR);
		setFull("slot-b", "five-hour", NOW + 2 * HOUR);
		const calls = installUpstream(ok200);
		const ctx = makeCtx([makeAccount("slot-a"), makeAccount("slot-b")], {
			combo: comboOf(["slot-a", "slot-b"]),
			comboFallback: false,
		});

		const response = await send(ctx);

		expect(calls).toEqual([]);
		await expectLocal429(response, NOW + 2 * HOUR);
	});

	it("every combo slot unusable for a non-limit reason: the 503 combo_session_fallback_disabled stays", async () => {
		const calls = installUpstream(ok200);
		const ctx = makeCtx(
			[
				makeAccount("slot-a", { paused: true }),
				makeAccount("slot-b", { paused: true }),
			],
			{ combo: comboOf(["slot-a", "slot-b"]), comboFallback: false },
		);

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual([]);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("combo_session_fallback_disabled");
	});
});
