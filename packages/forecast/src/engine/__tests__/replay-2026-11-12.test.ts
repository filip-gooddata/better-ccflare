/**
 * Replay of the 2026-11-12 shape (research 17): acct-a opened at 11:00 and was full at about
 * 13:17, acct-b idle until about 13:10 and full at about 14:55, both out 14:54:46 to 16:00.
 * Morning state 07:00: acct-a's window resets at 11:00, acct-b has none.
 */
import { describe, expect, test } from "bun:test";
import type { ForecastBlock, ForecastInput, Interval } from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import {
	buildInput,
	defaultSettings,
	prague,
	REPLAY_DEMAND_SCALE,
	replayFixture,
	replayHourly,
	TRACE_DEMAND_SCALE,
} from "./fixtures-engine";

async function contextOf(input: ForecastInput): Promise<EngineContext> {
	const ctx = await prepareEngineContext(input, { noise: true });
	if (ctx === "insufficient_history")
		throw new Error("fixture has no forecast");
	return ctx;
}

/** Lowest point of the heavy line over the day block. */
function heavyLow(block: ForecastBlock): number {
	return Math.min(...block.heavy);
}

function stops(block: ForecastBlock): Interval[] {
	return block.stops.heavy;
}

describe("2026-11-12 replay through compute()", () => {
	test("pre-warm on: the plan opens acct-b at 10:00, lifts the heavy low point off 0 and has no heavy stop", async () => {
		const input = buildInput(
			replayFixture({ settings: defaultSettings({ prewarm: true }) }),
		);
		expect(REPLAY_DEMAND_SCALE).toBe(0.6);
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		const ctx = await contextOf(input);
		const { baseline, score } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		expect(result.plan.openAt).toEqual({ "acct-b": prague(12, 10) });
		expect(score.dayLowPoints).toBeCloseTo(4.563, 2);
		expect(baseline.score.dayLowPoints).toBe(0);
		expect(heavyLow(day)).toBe(4.6);
		expect(heavyLow(base)).toBe(0);
		expect(stops(day)).toEqual([]);
		expect(stops(base)).toEqual([
			{ start: prague(12, 15, 53), end: prague(12, 16) },
			{ start: prague(12, 18, 10), end: prague(12, 18, 15) },
		]);
	});

	test("stop-time analogue, pre-warm off: the heavy line stops 14:54 to 16:00 and the plan opens nothing ahead", async () => {
		const input = buildInput(
			replayFixture({ hourly: replayHourly(TRACE_DEMAND_SCALE) }),
		);
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		const ctx = await contextOf(input);
		const { baseline, score } = await planForecast(ctx);

		expect(result.plan.openAt).toEqual({ "acct-b": null });
		expect(score.dayLowPoints).toBe(0);
		expect(baseline.score.stopMinutes).toBe(score.stopMinutes);
		expect(stops(day)[0]).toEqual({
			start: prague(12, 14, 54),
			end: prague(12, 16),
		});
		expect(heavyLow(day)).toBe(0);
	});

	test("the response covers the morning state: acct-a's 11:00 reset is a jump, day ends at midnight", async () => {
		const input = buildInput(replayFixture());
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;
		expect(day.times[0]).toBe(prague(12, 7));
		expect(day.times.at(-1)).toBe(prague(12, 7) + 17 * 3_600_000);
		expect(day.times.filter((t) => t === prague(12, 11))).toHaveLength(2);
	});
});
