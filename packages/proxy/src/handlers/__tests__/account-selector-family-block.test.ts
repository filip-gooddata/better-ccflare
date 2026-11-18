import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	LimitBlockedAccount,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getModelFamilyExhaustionInfo,
	selectAccountsForRequest,
} from "../account-selector";
import { collectLimitBlockedAccounts } from "../limit-blocked";
import {
	blockFamily,
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
	createModelFamilyExhaustedResponse,
} from "../model-capacity";
import type { ProxyContext } from "../proxy-types";

const DAY = 24 * 60 * 60 * 1000;
const FABLE = "claude-fable-5";
const OPUS = "claude-opus-4-5";

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeCtx(opts: {
	accounts: Account[];
	mode: "off" | "exhausted";
	activeCombo?: ComboWithSlots | null;
	selectWhenAllLimited?: (
		blocked: LimitBlockedAccount[],
		meta: RequestMeta,
	) => Account | null;
}): ProxyContext {
	return {
		strategy: {
			select: mock(() => opts.accounts),
			...(opts.selectWhenAllLimited
				? { selectWhenAllLimited: mock(opts.selectWhenAllLimited) }
				: {}),
		},
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getModelScopedCapacityRouting: () => opts.mode },
	} as unknown as ProxyContext;
}

afterEach(() => {
	usageCache.clear();
	clearFamilyExhaustionCache();
	clearFamilyBlocks();
});

for (const mode of ["off", "exhausted"] as const) {
	describe(`family block, MODEL_SCOPED_CAPACITY_ROUTING=${mode}`, () => {
		it("excludes the blocked account for that family and keeps the other", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			blockFamily("a", "fable", Date.now() + DAY, "header");
			const meta = makeRequestMeta();

			const result = await selectAccountsForRequest(
				meta,
				makeCtx({ accounts: [a, b], mode }),
				FABLE,
			);

			expect(result.map((acc) => acc.id)).toEqual(["b"]);
			expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
		});

		it("still routes another family to the blocked account", async () => {
			const a = makeAccount("a");
			blockFamily("a", "fable", Date.now() + DAY, "header");

			const result = await selectAccountsForRequest(
				makeRequestMeta(),
				makeCtx({ accounts: [a], mode }),
				OPUS,
			);

			expect(result.map((acc) => acc.id)).toEqual(["a"]);
		});

		it("excludes even when overage is reported available and the switch would allow it", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			usageCache.set("a", {
				spend: { enabled: true, percent: 10 },
				extra_usage: { is_enabled: true },
			} as never);
			blockFamily("a", "fable", Date.now() + DAY, "usage");

			const result = await selectAccountsForRequest(
				makeRequestMeta(),
				makeCtx({ accounts: [a, b], mode }),
				FABLE,
			);

			expect(result.map((acc) => acc.id)).toEqual(["b"]);
		});

		it("reports family_blocked with the earliest block end when every account is blocked and the strategy has no all-limited rule", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			const earliest = Date.now() + DAY;
			blockFamily("a", "fable", earliest + DAY, "header");
			blockFamily("b", "fable", earliest, "header");
			const meta = makeRequestMeta();

			const result = await selectAccountsForRequest(
				meta,
				makeCtx({ accounts: [a, b], mode }),
				FABLE,
			);

			expect(result).toEqual([]);
			expect(getModelFamilyExhaustionInfo(meta)).toEqual({
				family: "fable",
				resetAt: earliest,
				origin: "family_blocked",
			});
		});

		it("hands every blocked account to selectWhenAllLimited with its block as a family limit", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			const aUntil = Date.now() + 2 * DAY;
			const bUntil = Date.now() + DAY;
			blockFamily("a", "fable", aUntil, "header");
			blockFamily("b", "fable", bUntil, "header");
			const seen: LimitBlockedAccount[][] = [];
			const meta = makeRequestMeta();

			const result = await selectAccountsForRequest(
				meta,
				makeCtx({
					accounts: [a, b],
					mode,
					selectWhenAllLimited: (blocked) => {
						seen.push(blocked);
						return b;
					},
				}),
				FABLE,
			);

			// The pick names whose limit the answer describes; nothing is forwarded.
			expect(result).toEqual([]);
			expect(seen).toHaveLength(1);
			expect(seen[0].map((entry) => [entry.account.id, entry.limits])).toEqual([
				["a", [{ kind: "family", family: "fable", resetAt: aUntil }]],
				["b", [{ kind: "family", family: "fable", resetAt: bUntil }]],
			]);
		});

		it("skips a combo slot whose account is blocked for the slot's family", async () => {
			const a = makeAccount("a");
			const b = makeAccount("b");
			blockFamily("a", "fable", Date.now() + DAY, "header");
			const combo: ComboWithSlots = {
				id: "combo-1",
				name: "Fable combo",
				description: null,
				enabled: true,
				created_at: Date.now(),
				updated_at: Date.now(),
				slots: [
					{
						id: "slot-a",
						combo_id: "combo-1",
						account_id: "a",
						model: FABLE,
						priority: 0,
						enabled: true,
					},
					{
						id: "slot-b",
						combo_id: "combo-1",
						account_id: "b",
						model: FABLE,
						priority: 1,
						enabled: true,
					},
				],
			};

			const result = await selectAccountsForRequest(
				makeRequestMeta(),
				makeCtx({ accounts: [a, b], mode, activeCombo: combo }),
				FABLE,
			);

			expect(result.map((acc) => acc.id)).toEqual(["b"]);
		});
	});
}

describe("family block expiry", () => {
	it("routes to the account again once the block's reset has passed", async () => {
		const a = makeAccount("a");
		const now = Date.now();
		blockFamily("a", "fable", now + 1, "header", now);
		await Bun.sleep(5);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts: [a], mode: "off" }),
			FABLE,
		);

		expect(result.map((acc) => acc.id)).toEqual(["a"]);
	});
});

describe("collectLimitBlockedAccounts — family blocks", () => {
	it("lists a block as a family limit with capacity routing off, and not for another family", () => {
		const a = makeAccount("a");
		const until = Date.now() + DAY;
		blockFamily("a", "fable", until, "header");
		const ctx = makeCtx({ accounts: [a], mode: "off" });

		expect(
			collectLimitBlockedAccounts(
				[a],
				ctx,
				makeRequestMeta(),
				FABLE,
				Date.now(),
			),
		).toEqual([
			{
				account: a,
				limits: [{ kind: "family", family: "fable", resetAt: until }],
			},
		]);
		expect(
			collectLimitBlockedAccounts(
				[a],
				ctx,
				makeRequestMeta(),
				OPUS,
				Date.now(),
			),
		).toEqual([]);
	});
});

describe("createModelFamilyExhaustedResponse — family_blocked", () => {
	it("answers the local limit 429 for the family, without claiming weekly exhaustion", async () => {
		const response = createModelFamilyExhaustedResponse({
			family: "fable",
			resetAt: Date.now() + DAY,
			origin: "family_blocked",
		});
		const body = (await response.json()) as {
			error: { type: string; message: string };
		};

		expect(response.status).toBe(429);
		expect(
			response.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("seven_day_fable");
		expect(Object.keys(body.error).sort()).toEqual(["message", "type"]);
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).not.toContain("weekly");
	});
});
