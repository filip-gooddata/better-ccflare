/**
 * Replay of 2026-11-12 (research 17, amendment A4): acct-a's window resetting at 11:00 went from
 * 0 % at 06:12 to 60 % at 10:58; its 11:00–16:00 window was full at 13:17:41; acct-b opened at
 * about 13:10 and was refused at 14:54:46; both out until 16:00. Morning state 07:00: acct-a's
 * window open (resets 11:00), acct-b closed. Recorded days are that day's shape within ±8 %
 * (fixtures-engine.ts). The heavy (p90) day is heavier than the recorded one, so the heavy 5-hour
 * low point is 0 under every plan (amendment 2, B5). The assertions state what the engine
 * achieves on this day, measured, not a wanted number.
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
import {
	compareScores,
	openingEarns,
	planForecast,
	scorePlan,
} from "../planner";
import { buildResponse } from "../response";
import { onDemandPlan, simulate } from "../simulate";
import {
	buildInput,
	defaultSettings,
	prague,
	replayFixture,
} from "./fixtures-engine";

const MIN = 60_000;
// The median simulated day's first 5-hour fills must land within these of the recorded ones
// (research 17): a simulated median, not a claim of exact replay. acct-a's median fill is 13:25.
// The recorded day lies on the heavy side of its pool: the heavy line reproduces acct-b's 14:55
// refusal exactly (BASELINE_STOP), while the median day fills acct-b at 15:18, 23 minutes later.
const TRACE_TOLERANCE_A_MS = 15 * MIN;
const TRACE_TOLERANCE_B_MS = 30 * MIN;

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

// on demand: the recorded stop (refused 14:54:46, reset 16:00) on the heavy line
const BASELINE_STOP = { start: prague(12, 14, 55), end: prague(12, 16) };
// routing new sessions to acct-b from 07:00: one shorter stop, later in the afternoon
const ROUTED_STOP = { start: prague(12, 16, 14), end: prague(12, 17) };
// the typical (p50) line: the recorded day itself had a stop
const TYPICAL_BASELINE_STOP = {
	start: prague(12, 15, 20),
	end: prague(12, 16),
};
const TYPICAL_ROUTED_STOP = { start: prague(12, 16, 34), end: prague(12, 17) };

describe("2026-11-12 replay through compute()", () => {
	test("on demand the day plays out as recorded: acct-a full near 13:17, acct-b near 14:55, heavy stop 14:55–16:00, typical stop 15:20–16:00", async () => {
		const ctx = await contextOf(buildInput(replayFixture()));
		const { baseline } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		const fullA = medianFirstFull(baseline.result, 0);
		const fullB = medianFirstFull(baseline.result, 1);
		expect(Math.abs(fullA - prague(12, 13, 17))).toBeLessThanOrEqual(
			TRACE_TOLERANCE_A_MS,
		);
		expect(Math.abs(fullB - prague(12, 14, 55))).toBeLessThanOrEqual(
			TRACE_TOLERANCE_B_MS,
		);
		expect(heavyLow(base)).toBe(0);
		expect(stops(base)).toEqual([BASELINE_STOP]);
		expect(baseline.score.stopMinutes).toBe(60);
		expect(baseline.score.weekLowPoints).toBeCloseTo(84.31, 1);
		expect(Math.min(...base.typical)).toBe(0);
		expect(base.stops.typical).toEqual([TYPICAL_BASELINE_STOP]);
	});

	test("pre-warm off: routing alone sends new sessions to acct-b from 07:00 (forecast-open); the heavy stop shrinks from 60 to 40 unserved minutes and moves to 16:14–17:00, the low point stays 0", async () => {
		const input = buildInput(replayFixture());
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		const ctx = await contextOf(input);
		const { baseline, score, plan } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		expect(result.plan.openAt).toEqual({ "acct-b": null });
		expect(result.plan.placement?.rule).toBe("forecast-open");
		expect(result.plan.placement?.tiers).toEqual([["acct-b"], ["acct-a"]]);
		// decided by score item 2 against the next tier (amendment 2, B4)
		expect(result.plan.placement?.reason).toBe("stop-shorter+20min");
		expect(plan.placement).toEqual(result.plan.placement);
		expect(heavyLow(day)).toBe(0);
		expect(heavyLow(base)).toBe(0);
		expect(stops(day)).toEqual([ROUTED_STOP]);
		expect(stops(base)).toEqual([BASELINE_STOP]);
		expect(score.stopMinutes).toBe(40);
		expect(baseline.score.stopMinutes).toBe(60);
		expect(score.weekLowPoints).toBeCloseTo(84.59, 1);
		// the typical line also keeps a shorter, later stop
		expect(day.stops.typical).toEqual([TYPICAL_ROUTED_STOP]);
	});

	test("pre-warm on: the planner opens acct-b at 10:00 ahead of demand; no heavy or typical stop is left and the heavy low point is not lower than on demand", async () => {
		const input = buildInput(
			replayFixture({ settings: defaultSettings({ prewarm: true }) }),
		);
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		const ctx = await contextOf(input);
		const { baseline, score } = await planForecast(ctx);
		const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

		expect(result.plan.openAt).toEqual({ "acct-b": prague(12, 10) });
		expect(result.plan.placement?.rule).toBe("forecast-lookahead");
		expect(result.plan.placement?.reason).toBe("reset-soon");
		expect(result.plan.placement?.tiers).toEqual([["acct-a"], ["acct-b"]]);
		expect(stops(day)).toEqual([]);
		expect(score.stopMinutes).toBe(0);
		expect(score.stopMinutes).toBeLessThan(baseline.score.stopMinutes);
		expect(heavyLow(day)).toBeGreaterThanOrEqual(heavyLow(base));
		expect(day.stops.typical).toEqual([]);
		expect(Math.min(...day.typical)).toBeGreaterThan(0);
	});

	test("pre-warm on, why: the 10:00 opening earns by rule B3(b): item 1 ties at 0 and the heavy stop falls 60 → 0 minutes, although the heavy weekly low point falls 84.31 → 82.15", async () => {
		const ctx = await contextOf(
			buildInput(
				replayFixture({ settings: defaultSettings({ prewarm: true }) }),
			),
		);
		const base = onDemandPlan(ctx);
		const baseScore = scorePlan(ctx, await simulate(ctx, base));
		const open10 = scorePlan(
			ctx,
			await simulate(ctx, { ...base, openAt: [null, prague(12, 10)] }),
		);
		expect(baseScore.item1).toBe(0);
		expect(open10.item1).toBe(0);
		expect(baseScore.stopMinutes).toBe(60);
		expect(open10.stopMinutes).toBe(0);
		expect(baseScore.weekLowPoints).toBeCloseTo(84.31, 1);
		expect(open10.weekLowPoints).toBeCloseTo(82.15, 1);
		expect(
			openingEarns(open10, baseScore, ctx.input.settings.openMinGainPoints),
		).toBe(true);
		// fewer stop minutes rank before the higher weekly low point (amendment 2, B2)
		expect(compareScores(open10, baseScore)).toBeLessThan(0);
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
