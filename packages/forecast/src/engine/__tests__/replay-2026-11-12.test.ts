/**
 * Replay of the 2026-11-12 shape (research 17): acct-a opened at 11:00 and was full at about
 * 13:17, acct-b idle until about 13:10 and full at about 14:55, both out 14:54:46 to 16:00.
 * Morning state 07:00: acct-a's window resets at 11:00, acct-b has none. Recorded days are that
 * day's demand shape within ±8 % (fixtures-engine.ts).
 */
import { describe, expect, test } from "bun:test";
import type {
	EpochMs,
	ForecastBlock,
	ForecastInput,
	Interval,
} from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { EngineContext, SimulationResult } from "../model";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import {
	buildInput,
	defaultSettings,
	prague,
	replayFixture,
} from "./fixtures-engine";

const MIN = 60_000;
// the recorded day's 5-hour fills (research 17); the replay must land within this of each
const TRACE_TOLERANCE_MS = 15 * MIN;

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

/** Median over the simulated days of the account's first 5-hour fill. */
function medianFirstFull(sim: SimulationResult, account: number): EpochMs {
	const at = sim.traces
		.map(
			(t) =>
				t.outs.find((o) => o.account === account && o.limit === "five_hour")
					?.at,
		)
		.filter((x): x is EpochMs => x !== undefined)
		.sort((a, b) => a - b);
	expect(at).toHaveLength(sim.traces.length);
	return at[Math.floor(at.length / 2)] ?? Number.NaN;
}

const BASELINE_STOP = { start: prague(12, 14, 44), end: prague(12, 16) };

describe("2026-11-12 replay through compute()", () => {
	test("on demand the day plays out as recorded: acct-a full near 13:17, acct-b near 14:55, heavy stop until 16:00", async () => {
		const ctx = await contextOf(buildInput(replayFixture()));
		const { baseline } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		const fullA = medianFirstFull(baseline.result, 0);
		const fullB = medianFirstFull(baseline.result, 1);
		expect(Math.abs(fullA - prague(12, 13, 17))).toBeLessThanOrEqual(
			TRACE_TOLERANCE_MS,
		);
		expect(Math.abs(fullB - prague(12, 14, 55))).toBeLessThanOrEqual(
			TRACE_TOLERANCE_MS,
		);
		expect(heavyLow(base)).toBe(0);
		expect(stops(base)).toEqual([BASELINE_STOP]);
	});

	test("pre-warm on: the plan opens acct-b at 09:00, lifts the heavy low point to 13.2 and has no heavy stop", async () => {
		const input = buildInput(
			replayFixture({ settings: defaultSettings({ prewarm: true }) }),
		);
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		const ctx = await contextOf(input);
		const { baseline, score } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		expect(result.plan.openAt).toEqual({ "acct-b": prague(12, 9) });
		expect(score.dayLowPoints).toBeCloseTo(13.242, 2);
		expect(baseline.score.dayLowPoints).toBe(0);
		expect(heavyLow(day)).toBe(13.2);
		expect(heavyLow(base)).toBe(0);
		expect(stops(day)).toEqual([]);
		expect(stops(base)).toEqual([BASELINE_STOP]);
	});

	test("pre-warm off: an opening only routes demand, so the plan opens nothing ahead and keeps the stop", async () => {
		const result = await createForecastEngine().compute(
			buildInput(replayFixture()),
		);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;
		expect(result.plan.openAt).toEqual({ "acct-b": null });
		expect(heavyLow(day)).toBe(0);
		expect(stops(day)).toEqual([BASELINE_STOP]);
	});

	test("the response covers the morning state: acct-a's 11:00 reset is a jump, day ends at midnight", async () => {
		const result = await createForecastEngine().compute(
			buildInput(replayFixture()),
		);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;
		expect(day.times[0]).toBe(prague(12, 7));
		expect(day.times.at(-1)).toBe(prague(12, 7) + 17 * 60 * MIN);
		expect(day.times.filter((t) => t === prague(12, 11))).toHaveLength(2);
	});
});
