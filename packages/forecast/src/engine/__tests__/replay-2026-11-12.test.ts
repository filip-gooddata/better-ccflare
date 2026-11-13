/**
 * Replay of 2026-11-12 (research 17, amendment A4): acct-a's window resetting at 11:00 went from
 * 0 % at 06:12 to 60 % at 10:58; its 11:00–16:00 window was full at 13:17:41; acct-b opened at
 * about 13:10 and was refused at 14:54:46; both out until 16:00. Morning state 07:00: acct-a's
 * window open (resets 11:00), acct-b closed. Recorded days are that day's shape within ±8 %
 * (fixtures-engine.ts). The assertions state what the engine achieves on this day, measured, not
 * a wanted number.
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

describe("2026-11-12 replay through compute()", () => {
	test("on demand the day plays out as recorded: acct-a full near 13:17, acct-b near 14:55, heavy stop 14:55–16:00", async () => {
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
		expect(plan.placement).toEqual(result.plan.placement);
		expect(heavyLow(day)).toBe(0);
		expect(heavyLow(base)).toBe(0);
		expect(stops(day)).toEqual([ROUTED_STOP]);
		expect(stops(base)).toEqual([BASELINE_STOP]);
		expect(score.stopMinutes).toBe(40);
		expect(baseline.score.stopMinutes).toBe(60);
	});

	test("pre-warm on: the planner keeps the routing plan and opens nothing ahead, the same outcome as pre-warm off", async () => {
		const input = buildInput(
			replayFixture({ settings: defaultSettings({ prewarm: true }) }),
		);
		const result = await createForecastEngine().compute(input);
		if (!result.available) throw new Error(result.reason);
		const day = result.response.day as ForecastBlock;

		expect(result.plan.openAt).toEqual({ "acct-b": null });
		expect(result.plan.placement?.rule).toBe("forecast-open");
		expect(result.plan.placement?.tiers).toEqual([["acct-b"], ["acct-a"]]);
		expect(heavyLow(day)).toBe(0);
		expect(stops(day)).toEqual([ROUTED_STOP]);
	});

	test("pre-warm on, why: opening acct-b at 09:00 alone ends the heavy stop but serving that demand lowers the heavy weekly low point by more than the tier tolerance (score item 2 outranks item 3)", async () => {
		const ctx = await contextOf(
			buildInput(
				replayFixture({ settings: defaultSettings({ prewarm: true }) }),
			),
		);
		const base = onDemandPlan(ctx);
		const baseScore = scorePlan(ctx, await simulate(ctx, base));
		const open9 = scorePlan(
			ctx,
			await simulate(ctx, { ...base, openAt: [null, prague(12, 9)] }),
		);
		expect(baseScore.dayLowPoints).toBe(0);
		expect(open9.dayLowPoints).toBe(0);
		expect(baseScore.stopMinutes).toBe(60);
		expect(open9.stopMinutes).toBe(0);
		expect(open9.weekLowPoints).toBeCloseTo(81.97, 1);
		expect(baseScore.weekLowPoints).toBeCloseTo(84.31, 1);
		// the opening does not earn its place, and the on-demand plan ranks above it
		expect(
			openingEarns(open9, baseScore, ctx.input.settings.openMinGainPoints),
		).toBe(false);
		expect(compareScores(baseScore, open9)).toBeLessThan(0);
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
