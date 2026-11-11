import { describe, expect, it } from "bun:test";
import type { UsageData } from "../usage-fetcher";
import {
	extractFiveHourWindow,
	extractModelFamilyWindows,
	extractWeeklyWindow,
} from "../usage-fetcher";

const R1 = "2026-11-15T14:00:00.000Z";
const R2 = "2026-11-11T18:00:00.000Z";
const R1_MS = Date.parse(R1);
const R2_MS = Date.parse(R2);

const flat = {
	five_hour: { utilization: 12, resets_at: R2 },
	seven_day: { utilization: 2, resets_at: R1 },
	extra_usage: {
		is_enabled: true,
		monthly_limit: 100,
		used_credits: 100,
		utilization: 100,
	},
	limits: [
		{ kind: "session", percent: 40, resets_at: R2, scope: null },
		{ kind: "weekly_all", percent: 70, resets_at: R1, scope: null },
		{
			kind: "weekly_scoped",
			percent: 4,
			resets_at: R1,
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
		{
			kind: "weekly_scoped",
			percent: 30,
			resets_at: null,
			scope: { model: { id: null, display_name: "Opus" }, surface: null },
		},
		{
			kind: "weekly_scoped",
			percent: null,
			resets_at: R1,
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
} as unknown as UsageData;

const limitsOnly = {
	limits: [
		{ kind: "session", percent: 40, resets_at: R2, scope: null },
		{ kind: "weekly_all", percent: 70, resets_at: R1, scope: null },
	],
} as unknown as UsageData;

describe("session-pace usage windows", () => {
	it("reads the weekly window from seven_day, else limits[] weekly_all", () => {
		expect(extractWeeklyWindow(flat, "anthropic")).toEqual({
			utilization: 2,
			resetsAt: R1_MS,
		});
		expect(extractWeeklyWindow(limitsOnly, "anthropic")).toEqual({
			utilization: 70,
			resetsAt: R1_MS,
		});
	});

	it("reads the five-hour window from five_hour, else limits[] session", () => {
		expect(extractFiveHourWindow(flat, "anthropic")).toEqual({
			utilization: 12,
			resetsAt: R2_MS,
		});
		expect(extractFiveHourWindow(limitsOnly, "codex")).toEqual({
			utilization: 40,
			resetsAt: R2_MS,
		});
	});

	it("returns weekly_scoped rows for the family only, keeping a missing reset as null", () => {
		expect(extractModelFamilyWindows(flat, "anthropic", "fable")).toEqual([
			{ utilization: 4, resetsAt: R1_MS },
		]);
		expect(extractModelFamilyWindows(flat, "anthropic", "opus")).toEqual([
			{ utilization: 30, resetsAt: null },
		]);
		expect(extractModelFamilyWindows(flat, "anthropic", "haiku")).toEqual([]);
		expect(extractModelFamilyWindows(limitsOnly, "anthropic", "fable")).toEqual(
			[],
		);
	});

	it("returns nothing for providers without these windows", () => {
		expect(extractWeeklyWindow(flat, "zai")).toBeNull();
		expect(extractFiveHourWindow(flat, "openai-compatible")).toBeNull();
		expect(extractModelFamilyWindows(flat, "zai", "fable")).toEqual([]);
	});
});
