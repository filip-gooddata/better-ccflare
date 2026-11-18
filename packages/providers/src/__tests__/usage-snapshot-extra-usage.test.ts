/**
 * Extra usage is a display fact, never capacity. An account whose plan window
 * reads 100% is exhausted even while its provider reports billed capacity
 * beyond the plan (Codex credits, Anthropic extra usage / spend), and even
 * when the "use extra usage" setting is on: that setting is ignored. The
 * snapshot carries no extra-usage flag, so selection, /health and the
 * pool-exhausted body all see the same exhausted window.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isUsageExhausted, setUseExtraUsage } from "@better-ccflare/core";
import type { UsageData } from "../usage-fetcher";
import {
	getRepresentativeUsageSnapshotForProvider,
	hasExtraUsageCapacity,
} from "../usage-fetcher";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const WEEKLY_RESET = "2030-01-04T00:00:00.000Z";

function spentWeekly(extra: Partial<UsageData> = {}): UsageData {
	return {
		seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
		...extra,
	} as UsageData;
}

afterEach(() => {
	setUseExtraUsage(false);
});

describe("hasExtraUsageCapacity — what each provider reports", () => {
	it("codex: purchased credits or an unlimited allowance", () => {
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: true, unlimited: false, balance: "5" },
				}),
				"codex",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: false, unlimited: true, balance: null },
				}),
				"codex",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: false, unlimited: false, balance: "0" },
				}),
				"codex",
			),
		).toBe(false);
		expect(hasExtraUsageCapacity(spentWeekly(), "codex")).toBe(false);
	});

	it("anthropic: extra usage that is enabled and not yet spent", () => {
		const extra = (is_enabled: boolean, utilization: number | null) =>
			spentWeekly({
				extra_usage: {
					is_enabled,
					monthly_limit: 100,
					used_credits: 0,
					utilization,
				},
			});
		expect(hasExtraUsageCapacity(extra(true, 30), "anthropic")).toBe(true);
		expect(hasExtraUsageCapacity(extra(true, null), "anthropic")).toBe(true);
		expect(hasExtraUsageCapacity(extra(true, 100), "anthropic")).toBe(false);
		expect(hasExtraUsageCapacity(extra(false, 0), "anthropic")).toBe(false);
	});

	it("anthropic: the 2026 spend block wins over legacy extra_usage", () => {
		const both = spentWeekly({
			spend: { enabled: false },
			extra_usage: {
				is_enabled: true,
				monthly_limit: null,
				used_credits: null,
				utilization: null,
			},
		});
		expect(hasExtraUsageCapacity(both, "anthropic")).toBe(false);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({ spend: { enabled: true, percent: 40 } }),
				"anthropic",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({ spend: { enabled: true, percent: 100 } }),
				"anthropic",
			),
		).toBe(false);
	});

	it("reports nothing for a provider with no extra-usage surface", () => {
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: true, unlimited: true, balance: null },
				}),
				"anthropic",
			),
		).toBe(false);
		expect(hasExtraUsageCapacity(null, "codex")).toBe(false);
		expect(hasExtraUsageCapacity(spentWeekly(), "openai-compatible")).toBe(
			false,
		);
	});
});

describe("getRepresentativeUsageSnapshotForProvider — extra usage is not capacity", () => {
	const codexWithCredits = spentWeekly({
		credits: { has_credits: true, unlimited: false, balance: "5" },
	});

	function expectExhaustedSnapshot(data: UsageData, provider: string) {
		const snapshot = getRepresentativeUsageSnapshotForProvider(data, provider);
		expect(snapshot).not.toBeNull();
		// The window is reported as it is, and nothing rides along that could
		// let a gate treat it as usable.
		expect(snapshot?.utilization).toBe(100);
		expect(snapshot?.resetMs).toBe(Date.parse(WEEKLY_RESET));
		expect(Object.keys(snapshot ?? {}).sort()).toEqual([
			"resetMs",
			"utilization",
		]);
		expect(
			isUsageExhausted(snapshot?.utilization ?? null, snapshot?.resetMs, NOW),
		).toBe(true);
	}

	it("a spent Codex window with credits is exhausted, setting off", () => {
		expectExhaustedSnapshot(codexWithCredits, "codex");
	});

	it("a spent Codex window with credits is exhausted, setting on", () => {
		setUseExtraUsage(true);
		expectExhaustedSnapshot(codexWithCredits, "codex");
	});

	it("a spent Anthropic window with spend room is exhausted, setting on", () => {
		setUseExtraUsage(true);
		expectExhaustedSnapshot(
			spentWeekly({ spend: { enabled: true, percent: 10 } }),
			"anthropic",
		);
	});

	it("a spent Anthropic window with legacy extra_usage room is exhausted, setting on", () => {
		setUseExtraUsage(true);
		expectExhaustedSnapshot(
			spentWeekly({
				extra_usage: { is_enabled: true, utilization: 10, monthly_limit: 100 },
			} as Partial<UsageData>),
			"anthropic",
		);
	});
});
