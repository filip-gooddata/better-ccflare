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
import {
	isAccountAvailable,
	setForceAccountModel,
	setUseExtraUsage,
} from "@better-ccflare/core";
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import { Logger } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type { Account, LoadBalancingStrategy } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	blockFamily,
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
	getFamilyBlock,
} from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearVisionCapability } from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * A family 429 (one model family's weekly limit) run through handleProxy end
 * to end: the stand-in upstream refuses, the classifier reads the account's
 * usage, the family is blocked, selection excludes the account for that family
 * only, and the all-limited rule hands the client the upstream's own 429.
 *
 * Readings replay the incident of 2026-11-13: the Fable request refused on
 * `gooddata` at 11:54:26 CET (10:54:26Z), Fable weekly at 100 % resetting
 * Sunday 15:00 CET, the same instant as weekly_all, while `gooddata-ai` was out
 * on its five-hour window until 12:00 CET.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-13T10:54:26Z");
const GD = "gooddata";
const AI = "gooddata-ai";
const FABLE = "claude-fable-5";
const OPUS = "claude-opus-4-5";
const FABLE_RESET_GD = Date.parse("2026-11-15T14:00:00.367Z");
const WEEKLY_ALL_RESET_GD = Date.parse("2026-11-15T14:00:00Z");
const FIVE_HOUR_RESET_GD = Date.parse("2026-11-13T13:00:00Z");
const FIVE_HOUR_RESET_AI = Date.parse("2026-11-13T11:00:00Z");
const originalFetch = globalThis.fetch;

/** Dropped on every proxied response (http-common withSanitizedProxyHeaders). */
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

const iso = (ms: number) => new Date(ms).toISOString();

interface Reading {
	fiveHour: [number, number];
	weeklyAll: [number, number];
	fable?: [number, number];
	spend?: { enabled: boolean; percent?: number };
}

/** An Anthropic usage payload as the usage cache holds it. */
function usage(reading: Reading) {
	const data: Record<string, unknown> = {
		five_hour: {
			utilization: reading.fiveHour[0],
			resets_at: iso(reading.fiveHour[1]),
		},
		seven_day: {
			utilization: reading.weeklyAll[0],
			resets_at: iso(reading.weeklyAll[1]),
		},
		spend: reading.spend ?? { enabled: false },
	};
	if (reading.fable) {
		data.limits = [
			{
				kind: "weekly_scoped",
				percent: reading.fable[0],
				resets_at: iso(reading.fable[1]),
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
			},
		];
	}
	return data as never;
}

/**
 * Usage readings that land with the upstream call: the fetch stand-in writes
 * them to the usage cache before answering, the way a poll lags a refusal.
 */
const freshOnCall = new Map<string, unknown>();

/**
 * Telemetry that lags the upstream, as in the measured incident: selection
 * reads the family at 99 % (a full family is never forwarded to), and the
 * full reading arrives with the first upstream call to that account.
 */
function setLaggingUsage(account: string, reading: Reading): void {
	const lagging: Reading = reading.fable
		? { ...reading, fable: [Math.min(reading.fable[0], 99), reading.fable[1]] }
		: reading;
	usageCache.set(account, usage(lagging));
	freshOnCall.set(account, usage(reading));
}

/** `gooddata` as measured at 11:54 CET. */
const measuredGooddata = (): Reading => ({
	fiveHour: [79, FIVE_HOUR_RESET_GD],
	weeklyAll: [89, WEEKLY_ALL_RESET_GD],
	fable: [100, FABLE_RESET_GD],
	spend: { enabled: true, percent: 205 },
});

/** `gooddata-ai` as measured: out on its five-hour window, Fable at 56 %. */
const measuredGooddataAi = (): Reading => ({
	fiveHour: [100, FIVE_HOUR_RESET_AI],
	weeklyAll: [40, WEEKLY_ALL_RESET_GD + 24 * HOUR],
	fable: [56, FABLE_RESET_GD + 24 * HOUR],
});

/**
 * The stand-in's limit refusal. Header names follow what the repo parses
 * (providers anthropic parseRateLimit); values are assumptions, not captures.
 * `claim` sets the representative-claim header; null leaves it out so the
 * classifier must decide from usage readings.
 */
function limitHeaders(
	account: string,
	resetAt: number,
	claim: string | null,
	extra: Record<string, string> = {},
): Record<string, string> {
	const resetSec = String(Math.floor(resetAt / 1000));
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"request-id": `req_upstream_${account}`,
		"retry-after": String(Math.ceil((resetAt - Date.now()) / 1000)),
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-reset": resetSec,
		"anthropic-ratelimit-unified-remaining": "0",
		"x-upstream-account": account,
		...extra,
	};
	if (claim)
		headers["anthropic-ratelimit-unified-representative-claim"] = claim;
	return headers;
}

function limitBody(account: string): string {
	return JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: `limit reached (${account})` },
	});
}

interface Refusal {
	status: number;
	headers: Record<string, string>;
	body: string;
}

function refusal(
	account: string,
	resetAt: number,
	claim: string | null,
	extra: Record<string, string> = {},
): Refusal {
	return {
		status: 429,
		headers: limitHeaders(account, resetAt, claim, extra),
		body: limitBody(account),
	};
}

const toResponse = (r: Refusal) =>
	new Response(r.body, {
		status: r.status,
		statusText: "Too Many Requests",
		headers: r.headers,
	});

function ok200(account: string, model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: `hi from ${account}` }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

interface Call {
	account: string;
	model: string;
}

/** The stand-in upstream: answers per account and requested model. */
function installUpstream(handler: (call: Call) => Response) {
	const calls: Call[] = [];
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const account = (headers.get("authorization") ?? "").replace(
			/^Bearer token-/,
			"",
		);
		let model = "";
		const body = init?.body ?? (input instanceof Request ? input.body : null);
		if (typeof body === "string") model = JSON.parse(body).model ?? "";
		else if (body) {
			const text = await new Response(body as BodyInit).text();
			model = JSON.parse(text).model ?? "";
		}
		const call = { account, model };
		calls.push(call);
		const fresh = freshOnCall.get(account);
		if (fresh !== undefined) {
			usageCache.set(account, fresh as never);
			freshOnCall.delete(account);
		}
		return handler(call);
	}) as unknown as typeof fetch;
	return calls;
}

/** Account rows with the repository's markAccountRateLimited write rules. */
function fakeDb(accounts: Account[]) {
	const rows = new Map(accounts.map((a) => [a.id, { ...a }]));
	const writes: Array<{ id: string; until: number }> = [];
	const markAccountRateLimited = mock(
		async (id: string, until: number, _reason: string, increment = true) => {
			writes.push({ id, until });
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
	return { dbOps, writes, row };
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

let logs: string[] = [];

function paceStrategy(): SessionPaceStrategy {
	const strategy = new SessionPaceStrategy({}, { timeZone: "Europe/Prague" });
	(strategy as unknown as { log: { info: (m: string) => void } }).log.info = (
		message: string,
	) => {
		logs.push(message);
	};
	return strategy;
}

/** Filters like the real strategies; keeps the given order. No all-limited rule. */
function orderedStrategy(): LoadBalancingStrategy {
	return {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
	} as unknown as LoadBalancingStrategy;
}

function makeRequest(
	model: string,
	opts: { session?: string; headers?: Record<string, string> } = {},
): Request {
	const body: Record<string, unknown> = {
		model,
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

async function send(ctx: ProxyContext, request: Request) {
	try {
		return await handleProxy(request, new URL(request.url), ctx);
	} catch (error) {
		return error as Error;
	}
}

/** Status, every upstream header and the body bytes reach the client unchanged. */
async function expectUpstreamRefusal(
	received: Response | Error,
	expected: Refusal,
) {
	expect(received).toBeInstanceOf(Response);
	const response = received as Response;
	expect(response.status).toBe(expected.status);
	for (const [name, value] of Object.entries(expected.headers)) {
		if (HOP_BY_HOP.has(name)) continue;
		expect([name, response.headers.get(name)]).toEqual([name, value]);
	}
	const text = await response.text();
	expect(text).toBe(expected.body);
	expect(text).not.toContain("model_family_exhausted");
}

const logged = (pattern: string | RegExp) =>
	logs.filter((line) =>
		typeof pattern === "string" ? line.includes(pattern) : pattern.test(line),
	);

beforeEach(() => {
	logs = [];
	setSystemTime(new Date(NOW));
	setUseExtraUsage(false);
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	for (const level of ["info", "warn"] as const) {
		spyOn(Logger.prototype, level).mockImplementation((message: string) => {
			logs.push(message);
		});
	}
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
});

afterEach(() => {
	setSystemTime();
	setUseExtraUsage(false);
	setForceAccountModel(false);
	globalThis.fetch = originalFetch;
	usageCache.clear();
	freshOnCall.clear();
	clearFamilyExhaustionCache();
	clearFamilyBlocks();
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	mock.restore();
});

describe("scenario 1: the measured incident replayed", () => {
	it("blocks Fable on gooddata only, replays the upstream 429, keeps Opus on gooddata, sends Fable elsewhere", async () => {
		setLaggingUsage(GD, measuredGooddata());
		usageCache.set(AI, usage(measuredGooddataAi()));
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null);
		const aiRefusal = refusal(AI, FIVE_HOUR_RESET_AI, "five_hour");
		let aiBack = false;
		const calls = installUpstream(({ account, model }) => {
			if (account === GD && model === FABLE) return toResponse(gdRefusal);
			if (account === AI && !aiBack) return toResponse(aiRefusal);
			return ok200(account, model);
		});
		const { ctx, row } = makeCtx(
			[
				makeAccount(GD),
				makeAccount(AI, { rate_limited_until: FIVE_HOUR_RESET_AI }),
			],
			paceStrategy(),
		);

		// The refused Fable request.
		const first = await send(ctx, makeRequest(FABLE));
		expect(calls[0]).toEqual({ account: GD, model: FABLE });
		expect(row(GD).rate_limited_until).toBeNull();
		expect(row(GD).consecutive_rate_limits).toBe(0);
		const block = getFamilyBlock(GD, "fable", Date.now());
		expect(block?.until).toBe(FABLE_RESET_GD);
		expect(block?.source).toBe("usage");
		expect(
			logged(
				`account=${GD} family_block family=fable until=${iso(FABLE_RESET_GD)} source=usage`,
			),
		).toHaveLength(1);
		expect(logged("rule=all-exhausted").length).toBeGreaterThan(0);
		// gooddata-ai is usable again at 11:00Z, before the Fable reset, so the
		// rule forwards once to it and the client gets that upstream 429 as is.
		expect(calls.map((c) => c.account)).toEqual([GD, AI]);
		await expectUpstreamRefusal(first, aiRefusal);
		expect(row(GD).rate_limited_until).toBeNull();

		// Opus on gooddata is untouched by the Fable block.
		const opus = (await send(ctx, makeRequest(OPUS))) as Response;
		expect(opus.status).toBe(200);
		expect(calls.at(-1)).toEqual({ account: GD, model: OPUS });

		// Fable is never sent to gooddata again while the block stands.
		const before = calls.length;
		await send(ctx, makeRequest(FABLE));
		expect(
			calls.slice(before).filter((c) => c.account === GD && c.model === FABLE),
		).toEqual([]);

		// gooddata-ai back after its five-hour reset: Fable goes there.
		setSystemTime(new Date(FIVE_HOUR_RESET_AI + 60_000));
		aiBack = true;
		usageCache.set(
			AI,
			usage({
				...measuredGooddataAi(),
				fiveHour: [3, FIVE_HOUR_RESET_AI + 5 * HOUR],
			}),
		);
		usageCache.set(GD, usage(measuredGooddata()));
		const afterReset = calls.length;
		const fable = (await send(ctx, makeRequest(FABLE))) as Response;
		expect(fable.status).toBe(200);
		expect(calls.slice(afterReset)).toEqual([{ account: AI, model: FABLE }]);
		expect(row(GD).rate_limited_until).toBeNull();
	});
});

describe("scenario 1b: a family 429 after the account's model list", () => {
	it("blocks Fable without a bench when every model in the list is Fable", async () => {
		setLaggingUsage(GD, measuredGooddata());
		usageCache.set(AI, usage(measuredGooddataAi()));
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null);
		const aiRefusal = refusal(AI, FIVE_HOUR_RESET_AI, "five_hour");
		const calls = installUpstream(({ account, model }) => {
			if (account === GD && model.startsWith("claude-fable"))
				return toResponse(gdRefusal);
			if (account === AI) return toResponse(aiRefusal);
			return ok200(account, model);
		});
		const { ctx, row } = makeCtx(
			[
				makeAccount(GD, {
					model_mappings: JSON.stringify({
						fable: [FABLE, "claude-fable-5-2"],
					}),
				}),
				makeAccount(AI, { rate_limited_until: FIVE_HOUR_RESET_AI }),
			],
			paceStrategy(),
		);

		const first = await send(ctx, makeRequest(FABLE));
		expect(calls.filter((c) => c.account === GD).map((c) => c.model)).toEqual([
			FABLE,
			"claude-fable-5-2",
		]);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(getFamilyBlock(GD, "fable", Date.now())?.until).toBe(FABLE_RESET_GD);
		expect(
			logged(`account=${GD} family_block family=fable`).length,
		).toBeGreaterThan(0);
		await expectUpstreamRefusal(first, aiRefusal);

		const opus = (await send(ctx, makeRequest(OPUS))) as Response;
		expect(opus.status).toBe(200);
		expect(calls.at(-1)).toEqual({ account: GD, model: OPUS });
	});

	it("blocks Fable without a bench when an Opus request is mapped to two Fable models", async () => {
		usageCache.set(GD, usage(measuredGooddata()));
		usageCache.set(AI, usage(measuredGooddataAi()));
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null);
		const calls = installUpstream(({ account, model }) => {
			if (account === GD && model.startsWith("claude-fable"))
				return toResponse(gdRefusal);
			return ok200(account, model);
		});
		const { ctx, row } = makeCtx(
			[
				makeAccount(GD, {
					model_mappings: JSON.stringify({
						opus: [FABLE, "claude-fable-5-2"],
					}),
				}),
				makeAccount(AI, { rate_limited_until: FIVE_HOUR_RESET_AI }),
			],
			paceStrategy(),
		);

		await send(ctx, makeRequest(OPUS));
		expect(calls.filter((c) => c.account === GD).map((c) => c.model)).toEqual([
			FABLE,
			"claude-fable-5-2",
		]);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(getFamilyBlock(GD, "fable", Date.now())?.until).toBe(FABLE_RESET_GD);
		expect(logged(`account=${GD} family_refusal_unclassified`)).toEqual([]);

		// The next mapped Opus request must not reach gooddata while the Fable
		// block it would run into stands.
		await send(ctx, makeRequest(OPUS));
		expect(calls.filter((c) => c.account === GD)).toHaveLength(2);
		expect(
			logged(`family_blocked: excluding ${GD} for fable`).length,
		).toBeGreaterThan(0);
	});

	it("ignores an Opus-to-Fable mapping that force account model turns off", async () => {
		usageCache.set(GD, usage(measuredGooddata()));
		usageCache.set(AI, usage(measuredGooddataAi()));
		setForceAccountModel(true);
		blockFamily(GD, "fable", FABLE_RESET_GD, "usage", Date.now());
		const calls = installUpstream(({ account, model }) =>
			ok200(account, model),
		);
		const { ctx } = makeCtx(
			[
				makeAccount(GD, {
					model_mappings: JSON.stringify({
						opus: [FABLE, "claude-fable-5-2"],
					}),
				}),
				makeAccount(AI, { rate_limited_until: FIVE_HOUR_RESET_AI }),
			],
			paceStrategy(),
		);

		// Mapping is off, so the request goes upstream as Opus: the Fable block
		// on gooddata must not exclude it.
		const opus = (await send(ctx, makeRequest(OPUS))) as Response;
		expect(opus.status).toBe(200);
		expect(calls).toEqual([{ account: GD, model: OPUS }]);
		expect(logged(`family_blocked: excluding ${GD}`)).toEqual([]);
	});

	it("still benches the account when the model list spans families", async () => {
		setLaggingUsage(GD, measuredGooddata());
		usageCache.set(AI, usage(measuredGooddataAi()));
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null);
		installUpstream(({ account, model }) => {
			if (account === GD) return toResponse(gdRefusal);
			return ok200(account, model);
		});
		const { ctx, row } = makeCtx(
			[
				makeAccount(GD, {
					model_mappings: JSON.stringify({ fable: [FABLE, OPUS] }),
				}),
				makeAccount(AI, { rate_limited_until: FIVE_HOUR_RESET_AI }),
			],
			paceStrategy(),
		);

		await send(ctx, makeRequest(FABLE));
		expect(row(GD).rate_limited_until).not.toBeNull();
		expect(getFamilyBlock(GD, "fable", Date.now())).toBeNull();
		expect(
			logged(`account=${GD} family_refusal_unclassified`).length,
		).toBeGreaterThan(0);
	});
});

describe("scenario 2: sticky sessions after a family 429", () => {
	it("moves the Fable session to gooddata-ai and rebinds it; the Opus session stays on gooddata", async () => {
		// Fable reads 99 % while the sessions are placed; the full reading
		// lands with the refused call.
		usageCache.set(
			GD,
			usage({ ...measuredGooddata(), fable: [99, FABLE_RESET_GD] }),
		);
		usageCache.set(
			AI,
			usage({
				...measuredGooddataAi(),
				fiveHour: [20, FIVE_HOUR_RESET_AI + 4 * HOUR],
			}),
		);
		let gdFableOut = false;
		const gdRefusal = refusal(GD, FABLE_RESET_GD, "seven_day_fable");
		const calls = installUpstream(({ account, model }) => {
			if (account === GD && model === FABLE && gdFableOut)
				return toResponse(gdRefusal);
			return ok200(account, model);
		});
		const { ctx, row } = makeCtx(
			[makeAccount(GD), makeAccount(AI)],
			paceStrategy(),
		);

		// Find a session id that session-pace places on gooddata for each family.
		const placeOnGd = async (model: string, tag: string) => {
			for (let i = 0; i < 40; i++) {
				const session = `user_abc_account_x_session_${tag}-${i}`;
				const before = calls.length;
				await send(ctx, makeRequest(model, { session }));
				if (calls[before]?.account === GD) return session;
			}
			throw new Error(`session-pace never placed a ${tag} session on ${GD}`);
		};
		const fableSession = await placeOnGd(FABLE, "fable");
		const opusSession = await placeOnGd(OPUS, "opus");

		gdFableOut = true;
		freshOnCall.set(GD, usage(measuredGooddata()));
		const before = calls.length;
		const moved = (await send(
			ctx,
			makeRequest(FABLE, { session: fableSession }),
		)) as Response;
		expect(moved.status).toBe(200);
		expect(calls.slice(before)).toEqual([
			{ account: GD, model: FABLE },
			{ account: AI, model: FABLE },
		]);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(getFamilyBlock(GD, "fable", Date.now())?.until).toBe(FABLE_RESET_GD);

		// Rebound: it stays on gooddata-ai even once the block is gone.
		await send(ctx, makeRequest(FABLE, { session: fableSession }));
		clearFamilyBlocks();
		gdFableOut = false;
		await send(ctx, makeRequest(FABLE, { session: fableSession }));
		expect(calls.slice(before + 2).map((c) => c.account)).toEqual([AI, AI]);

		const opusBefore = calls.length;
		const opus = (await send(
			ctx,
			makeRequest(OPUS, { session: opusSession }),
		)) as Response;
		expect(opus.status).toBe(200);
		expect(calls.slice(opusBefore)).toEqual([{ account: GD, model: OPUS }]);
	});
});

describe("scenario 3: Fable out on every account", () => {
	it("returns an upstream 429 unchanged, benches neither account, and still routes Opus", async () => {
		const aiFableReset = NOW + 20 * HOUR;
		setLaggingUsage(GD, measuredGooddata());
		setLaggingUsage(AI, {
			fiveHour: [30, NOW + 3 * HOUR],
			weeklyAll: [60, aiFableReset],
			fable: [100, aiFableReset],
		});
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null);
		const aiRefusal = refusal(AI, aiFableReset, "seven_day_fable");
		const calls = installUpstream(({ account, model }) => {
			if (model === FABLE)
				return toResponse(account === GD ? gdRefusal : aiRefusal);
			return ok200(account, model);
		});
		const { ctx, row, writes } = makeCtx(
			[makeAccount(GD), makeAccount(AI)],
			paceStrategy(),
		);

		const first = await send(ctx, makeRequest(FABLE));
		// Both refuse; gooddata-ai's block ends first, so its 429 is the answer.
		expect(new Set(calls.map((c) => c.account))).toEqual(new Set([GD, AI]));
		await expectUpstreamRefusal(first, aiRefusal);
		expect(logged("rule=all-exhausted").length).toBeGreaterThan(0);
		expect(getFamilyBlock(GD, "fable", Date.now())?.until).toBe(FABLE_RESET_GD);
		expect(getFamilyBlock(AI, "fable", Date.now())?.until).toBe(aiFableReset);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(row(AI).rate_limited_until).toBeNull();
		expect(writes).toEqual([]);

		// With both blocks standing, the next Fable request still gets an
		// upstream 429 through the all-limited rule, not a local error.
		logs = [];
		const second = await send(ctx, makeRequest(FABLE));
		await expectUpstreamRefusal(second, aiRefusal);
		expect(logged("rule=all-exhausted").length).toBeGreaterThan(0);
		expect(writes).toEqual([]);

		const opus = (await send(ctx, makeRequest(OPUS))) as Response;
		expect(opus.status).toBe(200);
		expect(calls.at(-1)?.model).toBe(OPUS);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(row(AI).rate_limited_until).toBeNull();
	});
});

describe("scenario 4: an account-wide refusal", () => {
	// The refusal lands while the cached reading still shows room, as when the
	// window fills between usage polls: either the claim header names the
	// five-hour window, or the poll that lands with the 429 reads 100 %.
	for (const variant of ["claim header", "fresh usage reading"] as const) {
		it(`benches gooddata on a five-hour 429 and stops routing Opus there (${variant})`, async () => {
			setLaggingUsage(GD, {
				...measuredGooddata(),
				fiveHour: [97, FIVE_HOUR_RESET_GD],
			});
			usageCache.set(
				AI,
				usage({ ...measuredGooddataAi(), fiveHour: [10, NOW + 4 * HOUR] }),
			);
			const gdRefusal = refusal(
				GD,
				FIVE_HOUR_RESET_GD,
				variant === "claim header" ? "five_hour" : null,
			);
			const calls = installUpstream(({ account, model }) => {
				if (account !== GD) return ok200(account, model);
				if (variant === "fresh usage reading") {
					usageCache.set(
						GD,
						usage({
							...measuredGooddata(),
							fiveHour: [100, FIVE_HOUR_RESET_GD],
						}),
					);
				}
				return toResponse(gdRefusal);
			});
			const { ctx, row } = makeCtx(
				[makeAccount(GD), makeAccount(AI)],
				orderedStrategy(),
			);

			const first = (await send(ctx, makeRequest(FABLE))) as Response;
			expect(first.status).toBe(200);
			expect(calls.map((c) => c.account)).toEqual([GD, AI]);
			expect(row(GD).rate_limited_until).toBe(FIVE_HOUR_RESET_GD);
			expect(getFamilyBlock(GD, "fable", Date.now())).toBeNull();
			expect(logged("family_block")).toEqual([]);

			const before = calls.length;
			const opus = (await send(ctx, makeRequest(OPUS))) as Response;
			expect(opus.status).toBe(200);
			expect(calls.slice(before)).toEqual([{ account: AI, model: OPUS }]);
		});
	}
});

describe("scenario 5: overage reported as enabled", () => {
	for (const useExtraUsage of [false, true]) {
		it(`excludes gooddata for Fable before any upstream call (use-extra-usage ${useExtraUsage ? "on, spend at 205 %" : "off"})`, async () => {
			setUseExtraUsage(useExtraUsage);
			usageCache.set(GD, usage(measuredGooddata()));
			usageCache.set(
				AI,
				usage({ ...measuredGooddataAi(), fiveHour: [10, NOW + 4 * HOUR] }),
			);
			const calls = installUpstream(({ account, model }) =>
				ok200(account, model),
			);
			const { ctx, row } = makeCtx(
				[makeAccount(GD), makeAccount(AI)],
				orderedStrategy(),
				{ capacityRouting: true },
			);

			const fable = (await send(ctx, makeRequest(FABLE))) as Response;
			expect(fable.status).toBe(200);
			expect(calls).toEqual([{ account: AI, model: FABLE }]);

			const opus = (await send(ctx, makeRequest(OPUS))) as Response;
			expect(opus.status).toBe(200);
			expect(calls.at(-1)).toEqual({ account: GD, model: OPUS });
			expect(row(GD).rate_limited_until).toBeNull();
		});
	}
});

describe("scenario 6: a refusal the evidence cannot classify", () => {
	it("benches the account, logs family_refusal_unclassified, and logs only rate-limit headers", async () => {
		const gdRefusal = refusal(GD, FABLE_RESET_GD, null, {
			"set-cookie": "sessionKey=upstream-cookie-secret; Path=/",
			"anthropic-organization-id": "org-secret-id",
		});
		const calls = installUpstream(({ account, model }) =>
			account === GD ? toResponse(gdRefusal) : ok200(account, model),
		);
		const { ctx, row } = makeCtx(
			[makeAccount(GD), makeAccount(AI)],
			orderedStrategy(),
		);

		const response = (await send(
			ctx,
			makeRequest(FABLE, {
				headers: {
					cookie: "client=client-cookie-secret",
					authorization: "Bearer client-bearer-secret",
				},
			}),
		)) as Response;
		expect(response.status).toBe(200);
		expect(calls.map((c) => c.account)).toEqual([GD, AI]);
		// The bench takes the response's reset, rounded to whole seconds.
		expect(
			Math.abs((row(GD).rate_limited_until ?? 0) - FABLE_RESET_GD),
		).toBeLessThan(1_000);
		expect(getFamilyBlock(GD, "fable", Date.now())).toBeNull();
		expect(
			logged(
				`account=${GD} family_refusal_unclassified detail=no usage readings`,
			),
		).toHaveLength(1);

		const upstream429 = logged(`account=${GD} upstream_429 model=${FABLE} `);
		expect(upstream429).toHaveLength(1);
		const line = upstream429[0];
		expect(line).toContain("anthropic-ratelimit-unified-status=rejected");
		expect(line).toContain(
			`anthropic-ratelimit-unified-reset=${Math.floor(FABLE_RESET_GD / 1000)}`,
		);
		expect(line).toContain("retry-after=");
		for (const secret of [
			"token-gooddata",
			"client-bearer-secret",
			"client-cookie-secret",
			"upstream-cookie-secret",
			"org-secret-id",
			"authorization",
			"cookie",
		]) {
			expect(line).not.toContain(secret);
		}
	});
});

describe("scenario 7: a full family known from usage, before any refusal", () => {
	// The second measured case (2026-11-13T12:07:24.338Z): the Fable session
	// mapped to gooddata-ai fails over while gooddata reads Fable 100 % with
	// overage reported as enabled and spent, and no family block exists.
	it("never sends the Fable request to gooddata, replays the 429 of gooddata-ai, still serves Opus on gooddata", async () => {
		const at = Date.parse("2026-11-13T12:07:24.338Z");
		const aiOutUntil = Date.parse("2026-11-13T16:00:00.229Z");
		setSystemTime(new Date(at - 10 * 60_000));
		const gdReading = (): Reading => ({
			fiveHour: [81, FIVE_HOUR_RESET_GD + 4 * HOUR],
			weeklyAll: [92, WEEKLY_ALL_RESET_GD],
			fable: [100, Date.parse("2026-11-15T14:00:00Z")],
			spend: { enabled: true, percent: 205 },
		});
		usageCache.set(GD, usage(gdReading()));
		usageCache.set(
			AI,
			usage({ ...measuredGooddataAi(), fiveHour: [60, aiOutUntil] }),
		);
		const aiRefusal = refusal(AI, aiOutUntil, "five_hour");
		let aiOut = false;
		const calls = installUpstream(({ account, model }) =>
			account === AI && aiOut ? toResponse(aiRefusal) : ok200(account, model),
		);
		const { ctx, row, writes } = makeCtx(
			[makeAccount(GD), makeAccount(AI)],
			paceStrategy(),
			{ capacityRouting: true },
		);
		const session = "user_abc_account_x_session_634d3f22";

		// The session is mapped to gooddata-ai while it is available. gooddata
		// is held out for this one request so the mapping does not depend on
		// the capacity rule under test.
		row(GD).rate_limited_until = at - 5 * 60_000;
		await send(ctx, makeRequest(FABLE, { session }));
		expect(calls).toEqual([{ account: AI, model: FABLE }]);
		row(GD).rate_limited_until = null;
		const gdWritesBefore = writes.filter((w) => w.id === GD).length;

		// gooddata-ai goes out on its five-hour window.
		setSystemTime(new Date(at));
		aiOut = true;
		row(AI).rate_limited_until = aiOutUntil;
		usageCache.set(
			AI,
			usage({ ...measuredGooddataAi(), fiveHour: [100, aiOutUntil] }),
		);
		usageCache.set(GD, usage(gdReading()));
		logs = [];
		const before = calls.length;
		const response = await send(ctx, makeRequest(FABLE, { session }));
		expect(calls.slice(before).filter((c) => c.account === GD)).toEqual([]);
		expect(calls.slice(before)).toEqual([{ account: AI, model: FABLE }]);
		await expectUpstreamRefusal(response, aiRefusal);
		expect(logged("rule=all-exhausted").length).toBeGreaterThan(0);
		expect(row(GD).rate_limited_until).toBeNull();
		expect(writes.filter((w) => w.id === GD)).toHaveLength(gdWritesBefore);

		const opusBefore = calls.length;
		const opus = (await send(
			ctx,
			makeRequest(OPUS, { session: "user_abc_account_x_session_opus-1" }),
		)) as Response;
		expect(opus.status).toBe(200);
		expect(calls.slice(opusBefore)).toEqual([{ account: GD, model: OPUS }]);
		expect(row(GD).rate_limited_until).toBeNull();
	});
});
