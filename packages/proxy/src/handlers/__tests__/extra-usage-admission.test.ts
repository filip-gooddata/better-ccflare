/**
 * A full limit is final. An account whose five-hour or weekly window is at
 * 100 % has no capacity, even when the provider still reports billed capacity
 * beyond the plan (Codex credits, Anthropic extra usage / spend) and even when
 * the "use extra usage" setting is on: that setting is ignored. Every gate
 * that reads the usage snapshot — the usage-cap prefilter, the forced-account
 * availability, combo slots, the pool-exhaustion reasons and recovery
 * candidates — must treat such an account as exhausted.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isAccountAvailable, setUseExtraUsage } from "@better-ccflare/core";
import {
	getRepresentativeUsageSnapshotForProvider,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { selectAccountsForRequest } from "../account-selector";
import { createPoolExhaustedResponse } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

const CODEX_ID = "codex-on-credits";
const ANTHROPIC_ID = "anthropic-with-spend";
const SPARE_ID = "anthropic-spare";

function account(id: string, provider: string): Account {
	return {
		id,
		name: id,
		provider,
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
	} as Account;
}

function meta(headers: Record<string, string> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(headers),
	};
}

function ctxFor(
	accounts: Account[],
	activeCombo: ComboWithSlots | null = null,
) {
	const select = mock(
		(candidates: Account[], _meta: RequestMeta) => candidates,
	);
	const ctx = {
		strategy: { select },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => activeCombo),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getModelScopedCapacityRouting: () => "off" },
	} as unknown as ProxyContext;
	return { ctx, select };
}

const WEEKLY_RESET_MS = Date.now() + 3 * 24 * 3_600_000;
const FIVE_HOUR_RESET_MS = Date.now() + 2 * 3_600_000;

/** Codex: weekly window spent, purchased credits left. */
function seedCodexSpentWithCredits() {
	usageCache.set(CODEX_ID, {
		seven_day: {
			utilization: 100,
			resets_at: new Date(WEEKLY_RESET_MS).toISOString(),
		},
		credits: { has_credits: true, unlimited: false, balance: "12" },
	} as never);
}

/** Anthropic: five-hour window spent, extra usage enabled with room left. */
function seedAnthropicFiveHourSpentWithSpend(id = ANTHROPIC_ID) {
	usageCache.set(id, {
		five_hour: {
			utilization: 100,
			resets_at: new Date(FIVE_HOUR_RESET_MS).toISOString(),
		},
		seven_day: {
			utilization: 40,
			resets_at: new Date(WEEKLY_RESET_MS).toISOString(),
		},
		spend: { enabled: true, percent: 30 },
		extra_usage: { is_enabled: true, utilization: 30, monthly_limit: 100 },
	} as never);
}

beforeEach(() => {
	// The setting is still accepted but must change nothing.
	setUseExtraUsage(true);
});

afterEach(() => {
	setUseExtraUsage(false);
	usageCache.delete(CODEX_ID);
	usageCache.delete(ANTHROPIC_ID);
	usageCache.delete(SPARE_ID);
});

describe("usage-cap prefilter — a full limit is final", () => {
	it("excludes a spent Codex account with credits, setting on", async () => {
		seedCodexSpentWithCredits();
		const { ctx, select } = ctxFor([account(CODEX_ID, "codex")]);

		await selectAccountsForRequest(meta(), ctx);

		expect(select.mock.calls[0]?.[0]).toEqual([]);
	});

	it("excludes an Anthropic account at 100 % five-hour with extra usage left, setting on", async () => {
		seedAnthropicFiveHourSpentWithSpend();
		const { ctx, select } = ctxFor([
			account(ANTHROPIC_ID, "anthropic"),
			account(SPARE_ID, "anthropic"),
		]);

		await selectAccountsForRequest(meta(), ctx);

		expect(select.mock.calls[0]?.[0]?.map((a: Account) => a.id)).toEqual([
			SPARE_ID,
		]);
	});
});

describe("forced account availability — a full limit is final", () => {
	it("isAccountAvailable is false for the snapshot of a spent account with extra usage", () => {
		seedAnthropicFiveHourSpentWithSpend();
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			usageCache.get(ANTHROPIC_ID),
			"anthropic",
		);
		expect(snapshot).not.toBeNull();
		expect(
			isAccountAvailable(
				account(ANTHROPIC_ID, "anthropic"),
				Date.now(),
				snapshot ?? undefined,
			),
		).toBe(false);
	});

	it("does not serve x-better-ccflare-account-id to a spent account with extra usage", async () => {
		seedAnthropicFiveHourSpentWithSpend();
		const { ctx } = ctxFor([
			account(ANTHROPIC_ID, "anthropic"),
			account(SPARE_ID, "anthropic"),
		]);

		let served: string[] = [];
		try {
			const result = await selectAccountsForRequest(
				meta({ "x-better-ccflare-account-id": ANTHROPIC_ID }),
				ctx,
			);
			served = result.map((a) => a.id);
		} catch {
			// A local refusal is also "not served".
		}
		expect(served).not.toContain(ANTHROPIC_ID);
	});
});

describe("combo slot gate — a full limit is final", () => {
	it("skips the slot of a spent account with extra usage", async () => {
		seedAnthropicFiveHourSpentWithSpend();
		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "combo",
			description: null,
			enabled: true,
			created_at: Date.now(),
			updated_at: Date.now(),
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: ANTHROPIC_ID,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-2",
					combo_id: "combo-1",
					account_id: SPARE_ID,
					model: "claude-sonnet-4-5",
					priority: 1,
					enabled: true,
				},
			],
		} as ComboWithSlots;
		const { ctx } = ctxFor(
			[account(ANTHROPIC_ID, "anthropic"), account(SPARE_ID, "anthropic")],
			combo,
		);

		const result = await selectAccountsForRequest(
			meta(),
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual([SPARE_ID]);
	});
});

describe("createPoolExhaustedResponse — a full limit is final", () => {
	it("blames the spent window and offers its reset, whatever extra usage says", async () => {
		seedCodexSpentWithCredits();
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			usageCache.get(CODEX_ID),
			"codex",
		);
		expect(snapshot).not.toBeNull();

		const response = createPoolExhaustedResponse(
			[account(CODEX_ID, "codex")],
			new Map([[CODEX_ID, snapshot as NonNullable<typeof snapshot>]]),
		);
		const body = (await response.json()) as {
			error: {
				accounts: { reason: string; available_at: string | null }[];
				next_available_at: string | null;
			};
		};
		expect(body.error.accounts[0]?.reason).toBe("usage_exhausted");
		expect(body.error.accounts[0]?.available_at).toBe(
			new Date(WEEKLY_RESET_MS).toISOString(),
		);
		expect(body.error.next_available_at).toBe(
			new Date(WEEKLY_RESET_MS).toISOString(),
		);
	});
});
