import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { isAccountAvailable, setUseExtraUsage } from "@better-ccflare/core";
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	LimitBlockedAccount,
	LoadBalancingStrategy,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getModelFamilyExhaustionInfo,
	selectAccountsForRequest,
} from "../account-selector";
import {
	collectLimitBlockedAccounts,
	isAllLimitedSelection,
	markAllLimitedSelection,
	selectAllLimitedTarget,
} from "../limit-blocked";
import {
	clearFamilyExhaustionCache,
	markFamilyExhausted,
} from "../model-capacity";
import type { ProxyContext } from "../proxy-types";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const MODEL = "claude-opus-4-5";

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + HOUR,
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
		...overrides,
	};
}

let reqCounter = 0;
function makeMeta(
	opts: { session?: string | null; headers?: Record<string, string> } = {},
): RequestMeta {
	reqCounter++;
	return {
		id: `req-${reqCounter}`,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(opts.headers ?? {}),
		clientSessionId: opts.session ?? null,
	};
}

const iso = (ms: number | null) =>
	ms === null ? null : new Date(ms).toISOString();
const win = (utilization: number, resetAt: number | null) => ({
	utilization,
	resets_at: iso(resetAt),
});

/** Anthropic usage payload; `spend` defaults to overage confirmed off. */
function usage(parts: {
	fiveHour?: { utilization: number; resets_at: string | null };
	sevenDay?: { utilization: number; resets_at: string | null };
	family?: Array<{ percent: number; resetAt: number }>;
	spend?: { enabled: boolean; percent?: number } | null;
}) {
	const data: Record<string, unknown> = {
		five_hour: parts.fiveHour ?? win(10, NOW + HOUR),
		seven_day: parts.sevenDay ?? win(10, NOW + 48 * HOUR),
	};
	if (parts.family) {
		data.limits = parts.family.map((row) => ({
			kind: "weekly_scoped",
			percent: row.percent,
			resets_at: iso(row.resetAt),
			scope: { model: { id: null, display_name: "Opus" }, surface: null },
		}));
	}
	if (parts.spend !== null) data.spend = parts.spend ?? { enabled: false };
	return data as never;
}

/** A fake strategy that filters like the real ones (isAccountAvailable). */
function availabilityStrategy(
	selectWhenAllLimited?: LoadBalancingStrategy["selectWhenAllLimited"],
): LoadBalancingStrategy {
	return {
		select: (accounts: Account[]) =>
			accounts.filter((a) => isAccountAvailable(a, Date.now())),
		peek: () => null,
		...(selectWhenAllLimited ? { selectWhenAllLimited } : {}),
	};
}

function makeCtx(opts: {
	accounts: Account[];
	strategy: LoadBalancingStrategy;
	capacityRouting?: boolean;
	forceAccountModel?: boolean;
	activeCombo?: ComboWithSlots | null;
	comboSessionFallback?: boolean;
}): ProxyContext {
	return {
		strategy: opts.strategy,
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getModelScopedCapacityRouting: () =>
				opts.capacityRouting ? "exhausted" : "off",
			getForceAccountModel: () => opts.forceAccountModel ?? false,
			getComboSessionFallback: () => opts.comboSessionFallback ?? true,
		},
	} as unknown as ProxyContext;
}

/** Records what the proxy hands the strategy; picks the first entry. */
function recordingPick() {
	const calls: LimitBlockedAccount[][] = [];
	const fn = (blocked: LimitBlockedAccount[]) => {
		calls.push(blocked);
		return blocked[0]?.account ?? null;
	};
	return { calls, fn };
}

function limitsOf(list: LimitBlockedAccount[], id: string) {
	return list.find((entry) => entry.account.id === id)?.limits ?? null;
}

beforeEach(() => {
	setSystemTime(new Date(NOW));
});

afterEach(() => {
	setSystemTime();
	usageCache.clear();
	clearFamilyExhaustionCache();
	setUseExtraUsage(false);
});

describe("collectLimitBlockedAccounts", () => {
	const collect = (
		accounts: Account[],
		opts: { capacityRouting?: boolean; forceAccountModel?: boolean } = {},
		meta: RequestMeta = makeMeta(),
		now = NOW,
	) =>
		collectLimitBlockedAccounts(
			accounts,
			makeCtx({ accounts, strategy: availabilityStrategy(), ...opts }),
			meta,
			MODEL,
			now,
		);

	it("lists both accounts out on the 5-hour window with each reset", () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
		usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));
		const list = collect([a, b]);
		expect(limitsOf(list, "a")).toEqual([
			{ kind: "five_hour", resetAt: NOW + 2 * HOUR },
		]);
		expect(limitsOf(list, "b")).toEqual([
			{ kind: "five_hour", resetAt: NOW + HOUR },
		]);
	});

	it("lists both accounts out on the weekly window", () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ sevenDay: win(100, NOW + 20 * HOUR) }));
		usageCache.set("b", usage({ sevenDay: win(101, NOW + 40 * HOUR) }));
		const list = collect([a, b]);
		expect(limitsOf(list, "a")).toEqual([
			{ kind: "weekly", resetAt: NOW + 20 * HOUR },
		]);
		expect(limitsOf(list, "b")).toEqual([
			{ kind: "weekly", resetAt: NOW + 40 * HOUR },
		]);
	});

	it("lists a 5-hour account and a weekly account side by side", () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
		usageCache.set("b", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
		const list = collect([a, b]);
		expect(limitsOf(list, "a")).toEqual([
			{ kind: "five_hour", resetAt: NOW + 3 * HOUR },
		]);
		expect(limitsOf(list, "b")).toEqual([
			{ kind: "weekly", resetAt: NOW + 30 * HOUR },
		]);
	});

	it("lists both accounts in provider cooldown", () => {
		const a = makeAccount("a", { rate_limited_until: NOW + 10 * 60_000 });
		const b = makeAccount("b", { rate_limited_until: NOW + 5 * 60_000 });
		const list = collect([a, b]);
		expect(limitsOf(list, "a")).toEqual([
			{ kind: "cooldown", resetAt: NOW + 10 * 60_000 },
		]);
		expect(limitsOf(list, "b")).toEqual([
			{ kind: "cooldown", resetAt: NOW + 5 * 60_000 },
		]);
	});

	it("carries every limit of an account out on several at once", () => {
		const a = makeAccount("a", { rate_limited_until: NOW + 60_000 });
		usageCache.set(
			"a",
			usage({
				fiveHour: win(100, NOW + 2 * HOUR),
				sevenDay: win(100, NOW + 50 * HOUR),
			}),
		);
		const limits = limitsOf(collect([a]), "a");
		expect(limits).toEqual([
			{ kind: "cooldown", resetAt: NOW + 60_000 },
			{ kind: "five_hour", resetAt: NOW + 2 * HOUR },
			{ kind: "weekly", resetAt: NOW + 50 * HOUR },
		]);
	});

	it("reports an exhausted window with no reset time as null", () => {
		const a = makeAccount("a");
		usageCache.set("a", usage({ fiveHour: win(100, null) }));
		expect(limitsOf(collect([a]), "a")).toEqual([
			{ kind: "five_hour", resetAt: null },
		]);
	});

	it("leaves out limits whose reset has passed", () => {
		const a = makeAccount("a", { rate_limited_until: NOW - 1 });
		usageCache.set(
			"a",
			usage({
				fiveHour: win(100, NOW - HOUR),
				sevenDay: win(100, NOW + 5 * HOUR),
			}),
		);
		expect(limitsOf(collect([a]), "a")).toEqual([
			{ kind: "weekly", resetAt: NOW + 5 * HOUR },
		]);
		expect(collect([a], {}, makeMeta(), NOW + 6 * HOUR)).toEqual([]);
	});

	it("lists a full five-hour window even with the setting on and extra usage left", () => {
		setUseExtraUsage(true);
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				fiveHour: win(100, NOW + HOUR),
				spend: { enabled: true, percent: 20 },
			}),
		);
		expect(limitsOf(collect([a]), "a")).toEqual([
			{ kind: "five_hour", resetAt: NOW + HOUR },
		]);
	});

	it("lists a full weekly window even with the setting on and extra usage left", () => {
		setUseExtraUsage(true);
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				sevenDay: win(100, NOW + 3 * 24 * HOUR),
				spend: { enabled: true, percent: 20 },
			}),
		);
		expect(limitsOf(collect([a]), "a")).toEqual([
			{ kind: "weekly", resetAt: NOW + 3 * 24 * HOUR },
		]);
	});

	it("lists the account when extra usage exists and the setting is off", () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				fiveHour: win(100, NOW + HOUR),
				spend: { enabled: true, percent: 20 },
			}),
		);
		expect(limitsOf(collect([a]), "a")).toEqual([
			{ kind: "five_hour", resetAt: NOW + HOUR },
		]);
	});

	it("never lists a paused or re-auth account", () => {
		const paused = makeAccount("paused", { paused: true });
		const reauth = makeAccount("reauth", { requires_reauth: true } as never);
		for (const id of ["paused", "reauth"]) {
			usageCache.set(id, usage({ fiveHour: win(100, NOW + HOUR) }));
		}
		expect(collect([paused, reauth])).toEqual([]);
	});

	it("never lists a provider-excluded account", () => {
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const meta = makeMeta({
			headers: { "x-better-ccflare-exclude-providers": "anthropic-oauth" },
		});
		expect(collect([a], {}, meta)).toEqual([]);
	});

	it("never lists an account that cannot serve the model under force account model", () => {
		const other = makeAccount("other", {
			provider: "openai-compatible",
			rate_limited_until: NOW + HOUR,
		});
		expect(collect([other], { forceAccountModel: true })).toEqual([]);
		expect(collect([other], { forceAccountModel: false })).toHaveLength(1);
	});

	it("leaves out an account with no limit in force", () => {
		expect(collect([makeAccount("a")])).toEqual([]);
	});

	it("lists a full family in every mode, at the latest family reset", () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				family: [
					{ percent: 100, resetAt: NOW + 10 * HOUR },
					{ percent: 100, resetAt: NOW + 30 * HOUR },
				],
			}),
		);
		for (const capacityRouting of [false, true]) {
			expect(limitsOf(collect([a], { capacityRouting }), "a")).toEqual([
				{ kind: "family", family: "opus", resetAt: NOW + 30 * HOUR },
			]);
		}
	});

	it("lists a full family row with no reset as a family limit with an unknown reset", () => {
		const a = makeAccount("a");
		usageCache.set("a", {
			five_hour: win(10, NOW + HOUR),
			seven_day: win(10, NOW + 48 * HOUR),
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: null,
					scope: { model: { id: null, display_name: "Opus" }, surface: null },
				},
			],
		} as never);
		expect(limitsOf(collect([a], { capacityRouting: false }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: null },
		]);
	});

	it("leaves a reactive family mark out while capacity routing is off", () => {
		const a = makeAccount("a");
		markFamilyExhausted("a", "opus", NOW);
		expect(collect([a], { capacityRouting: false })).toEqual([]);
	});

	it("does not count overage reported enabled as family capacity", () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				family: [{ percent: 100, resetAt: NOW + 10 * HOUR }],
				spend: { enabled: true, percent: 100 },
			}),
		);
		// Spend at its limit, and the extra-usage switch off: no capacity.
		expect(limitsOf(collect([a], { capacityRouting: true }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: NOW + 10 * HOUR },
		]);
		setUseExtraUsage(true);
		expect(limitsOf(collect([a], { capacityRouting: true }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: NOW + 10 * HOUR },
		]);
	});

	it("lists the full family even with the setting on and extra usage left", () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({
				family: [{ percent: 100, resetAt: NOW + 10 * HOUR }],
				spend: { enabled: true, percent: 40 },
			}),
		);
		setUseExtraUsage(true);
		expect(limitsOf(collect([a], { capacityRouting: true }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: NOW + 10 * HOUR },
		]);
	});

	it("gives a reactive family mark an unknown reset", () => {
		const a = makeAccount("a");
		markFamilyExhausted("a", "opus", NOW);
		expect(limitsOf(collect([a], { capacityRouting: true }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: null },
		]);
	});

	it("prefers exhausted telemetry rows over a reactive mark's guess", () => {
		const a = makeAccount("a");
		// No spend block: no extra usage, so telemetry and the reactive mark
		// both exclude, and the rows carry the real reset.
		usageCache.set(
			"a",
			usage({
				family: [{ percent: 100, resetAt: NOW + 12 * HOUR }],
				spend: null,
			}),
		);
		markFamilyExhausted("a", "opus", NOW);
		expect(limitsOf(collect([a], { capacityRouting: true }), "a")).toEqual([
			{ kind: "family", family: "opus", resetAt: NOW + 12 * HOUR },
		]);
	});
});

describe("all-limited selection mark", () => {
	it("is set only on the marked request", () => {
		const marked = makeMeta();
		const other = makeMeta();
		markAllLimitedSelection(marked, "a");
		expect(isAllLimitedSelection(marked)).toBe(true);
		expect(isAllLimitedSelection(other)).toBe(false);
	});
});

describe("selectAllLimitedTarget", () => {
	it("returns null under a strategy without selectWhenAllLimited", async () => {
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const ctx = makeCtx({ accounts: [a], strategy: availabilityStrategy() });
		expect(await selectAllLimitedTarget(ctx, makeMeta(), MODEL)).toBeNull();
	});

	it("returns null when nothing is limit-blocked", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { paused: true });
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
		});
		expect(await selectAllLimitedTarget(ctx, makeMeta(), MODEL)).toBeNull();
		expect(pick.calls).toHaveLength(0);
	});

	it("hands the strategy only limit-blocked accounts", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const paused = makeAccount("p", {
			paused: true,
			rate_limited_until: NOW + HOUR,
		});
		const ctx = makeCtx({
			accounts: [paused, a],
			strategy: availabilityStrategy(pick.fn),
		});
		const target = await selectAllLimitedTarget(ctx, makeMeta(), MODEL);
		expect(target?.id).toBe("a");
		expect(pick.calls[0].map((e) => e.account.id)).toEqual(["a"]);
	});
});

describe("selectAccountsForRequest: a full limit is never a candidate", () => {
	it("excludes an account whose family telemetry is full while capacity routing is off", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set(
			"a",
			usage({ family: [{ percent: 100, resetAt: NOW + 10 * HOUR }] }),
		);
		const ctx = makeCtx({
			accounts: [a, b],
			strategy: availabilityStrategy(),
			capacityRouting: false,
		});
		const selected = await selectAccountsForRequest(makeMeta(), ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["b"]);
	});

	it("keeps an account with only a reactive family mark while capacity routing is off", async () => {
		const a = makeAccount("a");
		markFamilyExhausted("a", "opus", NOW);
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(),
			capacityRouting: false,
		});
		const selected = await selectAccountsForRequest(makeMeta(), ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["a"]);
	});

	it("excludes an account whose stale full five-hour window hides a full weekly window", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set(
			"a",
			usage({
				fiveHour: win(100, NOW - HOUR),
				sevenDay: win(100, NOW + 30 * HOUR),
			}),
		);
		const ctx = makeCtx({
			accounts: [a, b],
			strategy: availabilityStrategy(),
		});
		const selected = await selectAccountsForRequest(makeMeta(), ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["b"]);
	});

	it("keeps a full account out of normal selection whatever the bypass-session header says", async () => {
		const a = makeAccount("a");
		const b = makeAccount("b");
		usageCache.set("a", usage({ fiveHour: win(100, NOW + HOUR) }));
		const ctx = makeCtx({
			accounts: [a, b],
			strategy: availabilityStrategy(),
		});
		const meta = makeMeta({
			headers: { "x-better-ccflare-bypass-session": "true" },
		});
		const selected = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["b"]);
	});
});

describe("selectAccountsForRequest with the all-limited rule", () => {
	it("returns the strategy's target and marks the request when every account is out on limits", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const b = makeAccount("b");
		usageCache.set("b", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
		const ctx = makeCtx({
			accounts: [a, b],
			strategy: availabilityStrategy(pick.fn),
		});
		const meta = makeMeta();
		const selected = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["a"]);
		expect(isAllLimitedSelection(meta)).toBe(true);
		expect(pick.calls[0].map((e) => e.account.id).sort()).toEqual(["a", "b"]);
	});

	it("keeps today's empty result under a strategy without the method", async () => {
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const ctx = makeCtx({ accounts: [a], strategy: availabilityStrategy() });
		const meta = makeMeta();
		expect(await selectAccountsForRequest(meta, ctx, MODEL)).toEqual([]);
		expect(isAllLimitedSelection(meta)).toBe(false);
	});

	it("does not fire while any account is selectable", async () => {
		const pick = recordingPick();
		const a = makeAccount("a");
		const b = makeAccount("b", { rate_limited_until: NOW + HOUR });
		usageCache.set("a", usage({ fiveHour: win(50, NOW + HOUR) }));
		const ctx = makeCtx({
			accounts: [a, b],
			strategy: availabilityStrategy(pick.fn),
		});
		const meta = makeMeta();
		const selected = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["a"]);
		expect(isAllLimitedSelection(meta)).toBe(false);
		expect(pick.calls).toHaveLength(0);
	});

	it("forwards a family-exhausted request instead of setting the family side channel", async () => {
		const pick = recordingPick();
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({ family: [{ percent: 100, resetAt: NOW + 10 * HOUR }] }),
		);
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
			capacityRouting: true,
		});
		const meta = makeMeta();
		const selected = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["a"]);
		expect(isAllLimitedSelection(meta)).toBe(true);
		expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
		expect(pick.calls[0][0].limits).toEqual([
			{ kind: "family", family: "opus", resetAt: NOW + 10 * HOUR },
		]);
	});

	it("keeps the family side channel under a strategy without the method", async () => {
		const a = makeAccount("a");
		usageCache.set(
			"a",
			usage({ family: [{ percent: 100, resetAt: NOW + 10 * HOUR }] }),
		);
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(),
			capacityRouting: true,
		});
		const meta = makeMeta();
		expect(await selectAccountsForRequest(meta, ctx, MODEL)).toEqual([]);
		expect(getModelFamilyExhaustionInfo(meta)).toEqual({
			family: "opus",
			resetAt: NOW + 10 * HOUR,
			origin: "telemetry_confirmed",
		});
	});

	it("keeps a forced-account request out of the rule", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
		});
		const meta = makeMeta({
			headers: { "x-better-ccflare-account-id": "a" },
		});
		expect(await selectAccountsForRequest(meta, ctx, MODEL)).toEqual([]);
		expect(isAllLimitedSelection(meta)).toBe(false);
		expect(pick.calls).toHaveLength(0);
	});

	it("keeps an auto-refresh bypass request out of the rule", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
		});
		const meta = makeMeta({
			headers: { "x-better-ccflare-bypass-session": "true" },
		});
		expect(await selectAccountsForRequest(meta, ctx, MODEL)).toEqual([]);
		expect(pick.calls).toHaveLength(0);
	});

	it("leaves a combo with session fallback disabled at today's empty result", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "Combo",
			description: null,
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: "a",
					model: MODEL,
					priority: 0,
					enabled: true,
				},
			],
		} as ComboWithSlots;
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
			activeCombo: combo,
			comboSessionFallback: false,
		});
		const meta = makeMeta();
		expect(await selectAccountsForRequest(meta, ctx, MODEL)).toEqual([]);
		expect(isAllLimitedSelection(meta)).toBe(false);
		expect(pick.calls).toHaveLength(0);
	});

	it("routes normally again once the reset passes", async () => {
		const pick = recordingPick();
		const a = makeAccount("a", { rate_limited_until: NOW + HOUR });
		usageCache.set("a", usage({ fiveHour: win(100, NOW + HOUR) }));
		const ctx = makeCtx({
			accounts: [a],
			strategy: availabilityStrategy(pick.fn),
		});
		setSystemTime(new Date(NOW + HOUR + 1));
		const meta = makeMeta();
		const selected = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(selected.map((x) => x.id)).toEqual(["a"]);
		expect(isAllLimitedSelection(meta)).toBe(false);
		expect(pick.calls).toHaveLength(0);
	});

	describe("with the real SessionPaceStrategy", () => {
		function paceCtx(accounts: Account[]) {
			const strategy = new SessionPaceStrategy(
				{},
				{ timeZone: "Europe/Prague" },
			);
			(strategy as unknown as { log: { info: () => void } }).log.info =
				() => {};
			return { strategy, ctx: makeCtx({ accounts, strategy }) };
		}

		it("sends the request to the 5-hour account over the weekly one", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			usageCache.set("a", usage({ sevenDay: win(100, NOW + 30 * HOUR) }));
			usageCache.set("b", usage({ fiveHour: win(100, NOW + 2 * HOUR) }));
			const { ctx } = paceCtx([a, b]);
			const meta = makeMeta({ session: "s1" });
			const selected = await selectAccountsForRequest(meta, ctx, MODEL);
			expect(selected.map((x) => x.id)).toEqual(["b"]);
			expect(isAllLimitedSelection(meta)).toBe(true);
		});

		it("applies to mapped, new and no-session requests alike", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			const { strategy, ctx } = paceCtx([a, b]);

			const first = makeMeta({ session: "mapped" });
			const [served] = await selectAccountsForRequest(first, ctx, MODEL);
			strategy.onRequestServed(first, served, 200);

			usageCache.set("a", usage({ fiveHour: win(100, NOW + 3 * HOUR) }));
			usageCache.set("b", usage({ fiveHour: win(100, NOW + HOUR) }));

			for (const session of ["mapped", "new", null]) {
				const meta = makeMeta({ session });
				const selected = await selectAccountsForRequest(meta, ctx, MODEL);
				expect(selected.map((x) => x.id)).toEqual(["b"]);
				expect(isAllLimitedSelection(meta)).toBe(true);
			}
		});
	});
});
