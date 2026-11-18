/**
 * One integrated weekend run (amendment A5): compute() on Saturday 2026-11-14 09:00 with four
 * recorded weeks of the 2026-11-12 work-day shape and nearly idle weekends (fixtures-engine.ts).
 */
import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract/validate";
import type { EpochMs, ForecastBlock } from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { Scenarios } from "../model";
import {
	FIXED_N_ENGINE,
	buildInput,
	defaultSettings,
	type EngineFixture,
	prague,
	replayFixture,
} from "./fixtures-engine";
import { FULL_GRID_TIMEOUT_MS } from "./plan-timeout";

const BUCKET_MS = 5 * 60_000;
const SATURDAY_0900 = prague(14, 9);

function saturdayFixture(over: Partial<EngineFixture> = {}): EngineFixture {
	return replayFixture({
		now: SATURDAY_0900,
		fiveHour: {
			a: { usedPct: 0, resetsAt: null },
			b: { usedPct: 0, resetsAt: null },
		},
		...over,
	});
}

/** Mean over the simulated days of the units in [from, to). */
function meanUnits(sc: Scenarios, from: EpochMs, to: EpochMs): number {
	const i0 = Math.round((from - sc.start) / BUCKET_MS);
	const i1 = Math.round((to - sc.start) / BUCKET_MS);
	let sum = 0;
	for (const day of sc.units) for (let i = i0; i < i1; i++) sum += day[i] ?? 0;
	return sum / sc.units.length;
}

describe("Saturday morning", () => {
	test(
		"the response conforms to the contract",
		async () => {
			const result = await createForecastEngine(FIXED_N_ENGINE).compute(
				buildInput(saturdayFixture()),
			);
			if (!result.available) throw new Error(result.reason);
			expect(validateForecastResponse(result.response)).toEqual([]);
			expect(result.response.week).not.toBeNull();
			// the week block ends at acct-b's weekly reset, Tuesday 03:00 (horizon.ts)
			expect(result.response.week?.times.at(-1)).toBe(prague(17, 3));
		},
		FULL_GRID_TIMEOUT_MS,
	);

	test("the weekend pool is drawn: Saturday's demand is far below the following Monday's over the same hours", async () => {
		const ctx = await prepareEngineContext(buildInput(saturdayFixture()), {
			noise: true,
		});
		if (ctx === "insufficient_history") throw new Error("no forecast");
		const saturday = meanUnits(ctx.scenarios, SATURDAY_0900, prague(14, 18));
		const monday = meanUnits(ctx.scenarios, prague(16, 9), prague(16, 18));
		expect(saturday).toBeGreaterThan(0);
		// weekend days are 2 % of the work-day shape, Mondays 70 %
		expect(saturday).toBeLessThan(0.1 * monday);
	});

	test("the week block reaches through Monday; the work start is learned from work days only", async () => {
		const ctx = await prepareEngineContext(buildInput(saturdayFixture()), {
			noise: true,
		});
		if (ctx === "insufficient_history") throw new Error("no forecast");
		// this week's Friday 24:00 is behind; the later end ahead is the last weekly reset of a
		// counted account (acct-b, Tuesday 11-17 03:00, horizon.ts), so Monday's work day is inside
		expect(ctx.horizon.weekEnd).toBe(prague(17, 3));
		expect(ctx.horizon.weekEnd).toBeGreaterThan(prague(16, 18));
		// 5 % of a work day's demand is used by 08:15; the weekend days do not pull it later
		expect(ctx.workStartMinute).toBe(8 * 60 + 15);
	});

	test(
		"with pre-warm on nothing is opened ahead on a weekend morning: no demand needs it before Monday",
		async () => {
			const result = await createForecastEngine(FIXED_N_ENGINE).compute(
				buildInput(
					saturdayFixture({ settings: defaultSettings({ prewarm: true }) }),
				),
			);
			if (!result.available) throw new Error(result.reason);
			expect(result.plan.openAt).toEqual({ "acct-a": null, "acct-b": null });
			const day = result.response.day as ForecastBlock;
			expect(day.stops.heavy).toEqual([]);
		},
		FULL_GRID_TIMEOUT_MS,
	);
});
