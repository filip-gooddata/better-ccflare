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
 * Every path that could reach a FULL account (five-hour or weekly at 100 %
 * with a future reset and no extra usage, or the request model family full)
 * answers with the local 429 instead of forwarding: forced id, auto-refresh
 * probe, combo slot, sticky session, pre-warm.
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
	opts: { combo?: ComboWithSlots | null } = {},
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
const internalProbe = (id: string) => ({
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

const FULL_KINDS: FullKind[] = ["five-hour", "weekly", "family"];

describe("forced x-better-ccflare-account-id naming a full account (no bypass)", () => {
	for (const kind of FULL_KINDS) {
		it(`forced id, ${kind} full, healthy other account: served by the other account, forced account gets no request`, async () => {
			setFull("full", kind, NOW + 2 * HOUR);
			const calls = installUpstream(ok200);
			const ctx = makeCtx([makeAccount("full"), makeAccount("healthy")]);

			const response = (await send(
				ctx,
				makeRequest({ headers: forced("full") }),
			)) as Response;

			expect(calls).toEqual(["healthy"]);
			expect(response.status).toBe(200);
		});

		it(`forced id, ${kind} full, no other account can serve: local 429 for the forced account, nothing forwarded`, async () => {
			setFull("full", kind, NOW + 2 * HOUR);
			setFull("other", "weekly", NOW + 30 * HOUR);
			const calls = installUpstream(ok200);
			const ctx = makeCtx([makeAccount("full"), makeAccount("other")]);

			const response = await send(
				ctx,
				makeRequest({ headers: forced("full") }),
			);

			expect(calls).toEqual([]);
			await expectLocal429(response, NOW + 2 * HOUR);
		});
	}

	it("forced id, the forced account resets LATER than the other full account: the local 429 still describes the forced account", async () => {
		setFull("full", "weekly", NOW + 30 * HOUR);
		setFull("other", "five-hour", NOW + HOUR);
		const calls = installUpstream(ok200);
		const ctx = makeCtx([makeAccount("full"), makeAccount("other")]);

		const response = await send(ctx, makeRequest({ headers: forced("full") }));

		expect(calls).toEqual([]);
		await expectLocal429(response, NOW + 30 * HOUR);
	});
});

describe("auto-refresh probe to a full (usage-capped) account", () => {
	const probes = [
		{ name: "bypass-session + forced id", headers: bypassProbe },
		{
			name: "secret-verified internal auto-refresh probe",
			headers: internalProbe,
		},
	];
	for (const probe of probes) {
		for (const kind of ["five-hour", "weekly"] as FullKind[]) {
			it(`probe (${probe.name}), ${kind} full, healthy other account exists: local 429 for the probed account, zero upstream requests`, async () => {
				setFull("capped", kind, NOW + 2 * HOUR);
				const calls = installUpstream(ok200);
				const ctx = makeCtx([makeAccount("capped"), makeAccount("healthy")]);

				const response = await send(
					ctx,
					makeRequest({ headers: probe.headers("capped") }),
				);

				expect(calls).toEqual([]);
				await expectLocal429(response, NOW + 2 * HOUR);
			});
		}

		it(`probe (${probe.name}), the only account is full: local 429, zero upstream requests`, async () => {
			setFull("capped", "weekly", NOW + 30 * HOUR);
			const calls = installUpstream(ok200);
			const ctx = makeCtx([makeAccount("capped")]);

			const response = await send(
				ctx,
				makeRequest({ headers: probe.headers("capped") }),
			);

			expect(calls).toEqual([]);
			await expectLocal429(response, NOW + 30 * HOUR);
		});
	}

	it("probe (bypass-session + forced id) to an overage-paused account NOT at a full limit is still allowed through", async () => {
		const paused = makeAccount("paused", {
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		} as Partial<Account>);
		usageCache.set("paused", usage({}));
		const calls = installUpstream(ok200);
		const ctx = makeCtx([paused, makeAccount("healthy")]);

		const response = (await send(
			ctx,
			makeRequest({ headers: bypassProbe("paused") }),
		)) as Response;

		expect(calls).toEqual(["paused"]);
		expect(response.status).toBe(200);
	});

	it("probe (bypass-session + forced id) to a rate-limited account NOT at a full limit is still allowed through", async () => {
		const limited = makeAccount("limited", { rate_limited_until: NOW + HOUR });
		usageCache.set("limited", usage({}));
		const calls = installUpstream(ok200);
		const ctx = makeCtx([limited, makeAccount("healthy")]);

		const response = (await send(
			ctx,
			makeRequest({ headers: bypassProbe("limited") }),
		)) as Response;

		expect(calls).toEqual(["limited"]);
		expect(response.status).toBe(200);
	});

	it("secret-verified internal probe to a failure_threshold-paused account NOT at a full limit is still allowed through", async () => {
		const broken = makeAccount("broken", {
			paused: true,
			pause_reason: "failure_threshold",
		} as Partial<Account>);
		usageCache.set("broken", usage({}));
		const calls = installUpstream(ok200);
		const ctx = makeCtx([broken, makeAccount("healthy")]);

		const response = (await send(
			ctx,
			makeRequest({ headers: internalProbe("broken") }),
		)) as Response;

		expect(calls).toEqual(["broken"]);
		expect(response.status).toBe(200);
	});
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

describe("combo slot whose account is full", () => {
	it("combo: first slot account full, next slot served", async () => {
		setFull("slot-a", "weekly", NOW + 30 * HOUR);
		const calls = installUpstream(ok200);
		const ctx = makeCtx([makeAccount("slot-a"), makeAccount("slot-b")], {
			combo: comboOf(["slot-a", "slot-b"]),
		});

		const response = (await send(ctx)) as Response;

		expect(calls).toEqual(["slot-b"]);
		expect(response.status).toBe(200);
	});

	it("combo: every slot account full and nothing else can serve: local 429, zero upstream requests", async () => {
		setFull("slot-a", "weekly", NOW + 30 * HOUR);
		setFull("slot-b", "five-hour", NOW + 2 * HOUR);
		const calls = installUpstream(ok200);
		const ctx = makeCtx([makeAccount("slot-a"), makeAccount("slot-b")], {
			combo: comboOf(["slot-a", "slot-b"]),
		});

		const response = await send(ctx);

		expect(calls).toEqual([]);
		await expectLocal429(response, NOW + 2 * HOUR);
	});
});

describe("sticky session account at 100 % with bypass-session and no forced id", () => {
	/** Maps `session` to an account and returns that account's id. */
	async function mapSession(ctx: ProxyContext, session: string) {
		const calls = installUpstream(ok200);
		await send(ctx, makeRequest({ session }));
		expect(calls).toHaveLength(1);
		return calls[0] as string;
	}

	it("sticky: the mapped account is full, another healthy account serves", async () => {
		const ctx = makeCtx([makeAccount("a"), makeAccount("b")]);
		const sticky = await mapSession(ctx, "s-1");
		const other = sticky === "a" ? "b" : "a";
		setFull(sticky, "five-hour", NOW + 2 * HOUR);
		const calls = installUpstream(ok200);

		const response = (await send(
			ctx,
			makeRequest({
				session: "s-1",
				headers: { "x-better-ccflare-bypass-session": "true" },
			}),
		)) as Response;

		expect(calls).toEqual([other]);
		expect(response.status).toBe(200);
	});

	it("sticky: the mapped account and every other account full: local 429, zero upstream requests", async () => {
		const ctx = makeCtx([makeAccount("a"), makeAccount("b")]);
		const sticky = await mapSession(ctx, "s-2");
		const other = sticky === "a" ? "b" : "a";
		setFull(sticky, "five-hour", NOW + 2 * HOUR);
		setFull(other, "weekly", NOW + 30 * HOUR);
		const calls = installUpstream(ok200);

		const response = await send(
			ctx,
			makeRequest({
				session: "s-2",
				headers: { "x-better-ccflare-bypass-session": "true" },
			}),
		);

		expect(calls).toEqual([]);
		await expectLocal429(response, NOW + 2 * HOUR);
	});
});

/**
 * The request shape a pre-warm sends through the proxy
 * (packages/forecast/src/prewarm/runner.ts): `claude --print ok --bare --model
 * <prewarmModel> --no-session-persistence --output-format text --tools ""`
 * with ANTHROPIC_BASE_URL at the proxy, ANTHROPIC_CUSTOM_HEADERS
 * `x-better-ccflare-account-id: <id>` and ANTHROPIC_API_KEY set to the proxy key
 * or "better-ccflare-prewarm". No bypass-session, no probe secret. The body is
 * whatever the claude CLI builds for that prompt; the fields below are the
 * ones the proxy reads (model, messages, max_tokens, stream), not a capture.
 */
function prewarmRequest(accountId: string): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "better-ccflare-prewarm",
			"x-better-ccflare-account-id": accountId,
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "ok" }],
			max_tokens: 32000,
			stream: true,
		}),
	});
}

describe("pre-warm request", () => {
	it("pre-warm forced to a full account, no other account can serve: local 429, nothing forwarded", async () => {
		setFull("full", "five-hour", NOW + 2 * HOUR);
		setFull("other", "weekly", NOW + 30 * HOUR);
		const calls = installUpstream(ok200);
		const ctx = makeCtx([makeAccount("full"), makeAccount("other")]);

		const response = await send(ctx, prewarmRequest("full"));

		expect(calls).toEqual([]);
		await expectLocal429(response, NOW + 2 * HOUR);
	});
});
