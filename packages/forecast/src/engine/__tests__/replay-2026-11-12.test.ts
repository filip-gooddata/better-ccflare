/**
 * Replay of 2026-11-12 (research 17, amendment A4): acct-a's window resetting at 11:00 went from
 * 0 % at 06:12 to 60 % at 10:58; its 11:00–16:00 window was full at 13:17:41; acct-b opened at
 * about 13:10 and was refused at 14:54:46; both out until 16:00. Morning state 07:00: acct-a's
 * window open (resets 11:00), acct-b closed. Recorded days are that day's shape within ±8 %
 * (fixtures-engine.ts).
 *
 * Amendment 5: the simulation sends new demand to the idle account first (E1), so on demand acct-b
 * opens at 07:00; the planner scores the unfloored heavy low point S (E2) and may hold an idle
 * account closed when S gains at least openMinGainPoints (E3). The assertions state what the engine
 * achieves on this day, measured, not a wanted number. The sandbox prototype
 * (line-options-2), with the day factor and the last-hour mix since removed, gave S +13.8 on
 * demand, +59.9 holding acct-b to 08:00, −3.3 for the old 10:00 opening, reason low-point+46.1;
 * on the plain lines the engine gives the values below.
 */
import { describe, expect, test } from "bun:test";
import type { EpochMs, ForecastBlock, ForecastInput } from "../../types";
import { createForecastEngine } from "../engine";
import type { EngineContext, SimulationResult } from "../model";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import { onDemandPlan, simulate } from "../simulate";
import {
	REPLAY_ENGINE,
	integratedContext,
	buildInput,
	defaultSettings,
	prague,
	replayFixture,
} from "./fixtures-engine";
import { FULL_GRID_TIMEOUT_MS } from "./plan-timeout";

const MIN = 60_000;
const FIVE_HOURS = 5 * 60 * MIN;
// Each test simulates the rule's N (1600 days here), some several plans and computes.
const REPLAY_TIMEOUT_MS = FULL_GRID_TIMEOUT_MS;

/** The context compute() plans on: the scenario-count rule's N over the ladder's top rung. */
async function contextOf(input: ForecastInput): Promise<EngineContext> {
	return (await integratedContext(input)).ctx;
}

/** acct-b's first opening on every simulated day. */
function firstOpensOfB(sim: SimulationResult): EpochMs[] {
	return sim.traces.map(
		(t) => t.opens.find((o) => o.account === 1)?.at ?? Number.NaN,
	);
}

/**
 * Reset instants shared by every simulated day: acct-a's morning reset at 11:00 and five hours after
 * each opening.
 */
function commonResets(sim: SimulationResult): Set<EpochMs> {
	const perDay = sim.traces.map(
		(t) => new Set([prague(12, 11), ...t.opens.map((o) => o.at + FIVE_HOURS)]),
	);
	return new Set([...perDay[0]].filter((at) => perDay.every((s) => s.has(at))));
}

/** Samples where the typical 5-hour line rises, each with the interval it rises over. */
function typicalRises(block: ForecastBlock): { from: EpochMs; to: EpochMs }[] {
	const rises: { from: EpochMs; to: EpochMs }[] = [];
	for (let i = 1; i < block.typical.length; i++)
		if (block.typical[i] > block.typical[i - 1] + 1e-9)
			rises.push({ from: block.times[i - 1], to: block.times[i] });
	return rises;
}

const openAtOf = (at: EpochMs | null) => [null, at];

describe("2026-11-12 replay: the scenario count (row 21)", () => {
	test(
		"at 07:00 the rule climbs the whole ladder to 1600 days: the SE of S stays above the 0.25 target",
		async () => {
			const { count } = await integratedContext(buildInput(replayFixture()));
			expect(count.n).toBe(1600);
			expect(count.stopReason).toBe("ladder-top");
			expect(count.targetPoints).toBe(0.25);
			expect(count.rungs.map((r) => r.n)).toEqual([100, 200, 400, 800, 1600]);
			const se = [1.674, 1.29, 1.269, 0.94, 0.623];
			for (const [i, r] of count.rungs.entries())
				expect(r.se).toBeCloseTo(se[i] as number, 3);
		},
		REPLAY_TIMEOUT_MS,
	);
});

describe("2026-11-12 replay through compute()", () => {
	test(
		"on demand the idle acct-b opens at 07:00 on every simulated day (amendment 5, E1); S +14.2, no stop",
		async () => {
			const ctx = await contextOf(buildInput(replayFixture()));
			const { baseline } = await planForecast(ctx);
			const base = buildResponse(ctx, baseline.result).day as ForecastBlock;

			const opens = firstOpensOfB(baseline.result);
			expect(opens).toHaveLength(1600);
			for (const at of opens) expect(at).toBe(prague(12, 7));
			expect(baseline.score.lowPoint).toBeCloseTo(14.16, 1);
			expect(baseline.score.dayLowPoints).toBeCloseTo(14.16, 1);
			expect(baseline.score.weekLowPoints).toBeCloseTo(80.2, 1);
			expect(base.stops.heavy).toEqual([]);
			expect(base.stops.typical).toEqual([]);
			expect(Math.min(...base.heavy)).toBeCloseTo(14.2, 1);
			expect(Math.min(...base.typical)).toBeCloseTo(27.0, 1);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"pre-warm off: the plan holds acct-b closed until 08:30 (E3), S +76.7 against +14.2 on demand; no stop is left",
		async () => {
			const input = buildInput(replayFixture());
			const result = await createForecastEngine(REPLAY_ENGINE).compute(input);
			if (!result.available) throw new Error(result.reason);
			const day = result.response.day as ForecastBlock;

			const ctx = await contextOf(input);
			const {
				baseline,
				score,
				plan,
				result: sim,
				scored,
			} = await planForecast(ctx);

			expect(result.plan.openAt).toEqual({ "acct-b": prague(12, 8, 30) });
			expect(plan.openAt).toEqual(result.plan.openAt);
			// acct-a first (it resets first); acct-b is held behind it until 08:30
			expect(result.plan.placement).toEqual({
				tiers: [["acct-a"], ["acct-b"]],
				rule: "forecast-lookahead",
				reason: "low-point+62.6",
			});
			expect(plan.placement).toEqual(result.plan.placement);
			for (const at of firstOpensOfB(sim)) expect(at).toBe(prague(12, 8, 30));
			expect(score.lowPoint).toBeCloseTo(76.72, 1);
			expect(baseline.score.lowPoint).toBeCloseTo(14.16, 1);
			expect(score.lowPoint - baseline.score.lowPoint).toBeCloseTo(62.56, 1);
			expect(day.stops.heavy).toEqual([]);
			expect(day.stops.typical).toEqual([]);
			expect(Math.min(...day.typical)).toBeCloseTo(87.5, 1);

			// Every opening time searched, the baseline first. Opening at 07:00 is on demand itself; the
			// old 10:00 opening now scores −4.8 (its heavy stops count below zero).
			expect(scored[0].plan).toEqual(onDemandPlan(ctx));
			const sOf = (at: EpochMs) =>
				scored.find(
					(s) =>
						s.plan.preferred === null &&
						JSON.stringify(s.plan.openAt) === JSON.stringify(openAtOf(at)),
				)?.score.lowPoint;
			expect(sOf(prague(12, 7))).toBeCloseTo(14.16, 1);
			expect(sOf(prague(12, 7, 30))).toBeCloseTo(37.48, 1);
			expect(sOf(prague(12, 8))).toBeCloseTo(60.62, 1);
			// the quarter-hour grid and its 5-minute refinement around the peak
			expect(sOf(prague(12, 8, 15))).toBeCloseTo(71.41, 1);
			expect(sOf(prague(12, 8, 25))).toBeCloseTo(75.84, 1);
			expect(sOf(prague(12, 8, 30))).toBeCloseTo(76.72, 1);
			expect(sOf(prague(12, 8, 35))).toBeCloseTo(76.2, 1);
			expect(sOf(prague(12, 8, 45))).toBeCloseTo(68.71, 1);
			expect(sOf(prague(12, 9))).toBeCloseTo(52.6, 1);
			expect(sOf(prague(12, 10))).toBeCloseTo(-4.77, 1);
			expect(sOf(prague(12, 11))).toBeCloseTo(-25.2, 1);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"the gate: with openMinGainPoints above the 62.6 gain the hold is not taken; at 62 it is",
		async () => {
			const above = await createForecastEngine(REPLAY_ENGINE).compute(
				buildInput(
					replayFixture({
						settings: defaultSettings({ openMinGainPoints: 63 }),
					}),
				),
			);
			if (!above.available) throw new Error(above.reason);
			expect(above.plan.openAt).toEqual({ "acct-b": null });
			const ctx = await contextOf(
				buildInput(
					replayFixture({
						settings: defaultSettings({ openMinGainPoints: 63 }),
					}),
				),
			);
			const { score, baseline } = await planForecast(ctx);
			expect(score.lowPoint).toBe(baseline.score.lowPoint);

			const at62 = await createForecastEngine(REPLAY_ENGINE).compute(
				buildInput(
					replayFixture({
						settings: defaultSettings({ openMinGainPoints: 62 }),
					}),
				),
			);
			if (!at62.available) throw new Error(at62.reason);
			expect(at62.plan.openAt).toEqual({ "acct-b": prague(12, 8, 30) });
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"the typical line rises only at reset instants shared by every simulated day, on demand and under the plan",
		async () => {
			const ctx = await contextOf(buildInput(replayFixture()));
			const { baseline, result } = await planForecast(ctx);
			for (const sim of [baseline.result, result]) {
				const block = buildResponse(ctx, sim).day as ForecastBlock;
				const resets = [...commonResets(sim)];
				const rises = typicalRises(block);
				expect(rises.length).toBeGreaterThan(0);
				for (const { from, to } of rises)
					expect(
						resets.some(
							(r) => (r > from && r <= to) || (from === to && r === to),
						),
					).toBe(true);
			}
			// under the plan: acct-a at 11:00, 16:00, 21:00; acct-b at 13:30, 18:30, 23:30
			const planResets = commonResets(result);
			for (const [h, m] of [
				[11, 0],
				[13, 30],
				[16, 0],
				[18, 30],
				[21, 0],
				[23, 30],
			])
				expect(planResets.has(prague(12, h, m))).toBe(true);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"determinism: the same input gives the same result twice",
		async () => {
			const input = buildInput(replayFixture());
			const a = await createForecastEngine(REPLAY_ENGINE).compute(input);
			const b = await createForecastEngine(REPLAY_ENGINE).compute(input);
			expect(JSON.stringify(b)).toBe(JSON.stringify(a));
			const ctx = await contextOf(input);
			const plan = onDemandPlan(ctx);
			expect(await simulate(ctx, plan)).toEqual(await simulate(ctx, plan));
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"pre-warm on: the same plan as pre-warm off (hold acct-b to 08:30, S +76.7); the extra pre-warm openings do not win",
		async () => {
			const input = buildInput(
				replayFixture({ settings: defaultSettings({ prewarm: true }) }),
			);
			const result = await createForecastEngine(REPLAY_ENGINE).compute(input);
			if (!result.available) throw new Error(result.reason);
			expect(result.plan.openAt).toEqual({ "acct-b": prague(12, 8, 30) });
			expect(result.plan.placement).toEqual({
				tiers: [["acct-a"], ["acct-b"]],
				rule: "forecast-lookahead",
				reason: "low-point+62.6",
			});

			const ctx = await contextOf(input);
			const {
				score,
				baseline,
				scored,
				candidates,
				result: sim,
			} = await planForecast(ctx);
			expect(score.lowPoint).toBeCloseTo(76.72, 1);
			expect(baseline.score.lowPoint).toBeCloseTo(14.16, 1);
			for (const at of firstOpensOfB(sim)) expect(at).toBe(prague(12, 8, 30));
			// the same quarter-hour grid as pre-warm off, across the night; more peaks, so more refinement
			expect(candidates).toBe(147);
			const sOf = (at: EpochMs) =>
				scored.find(
					(s) =>
						s.plan.preferred === null &&
						JSON.stringify(s.plan.openAt) === JSON.stringify(openAtOf(at)),
				)?.score.lowPoint;
			expect(sOf(prague(12, 7, 15))).toBeCloseTo(25.8, 1);
			expect(sOf(prague(13, 3, 15))).toBeCloseTo(-22.64, 1);
			const day = result.response.day as ForecastBlock;
			expect(day.stops.heavy).toEqual([]);
			expect(day.stops.typical).toEqual([]);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"the response covers the morning state: acct-a's 11:00 reset is a jump, day ends at midnight",
		async () => {
			const result = await createForecastEngine(REPLAY_ENGINE).compute(
				buildInput(replayFixture()),
			);
			if (!result.available) throw new Error(result.reason);
			const day = result.response.day as ForecastBlock;
			expect(day.times[0]).toBe(prague(12, 7));
			expect(day.times.at(-1)).toBe(prague(12, 7) + 17 * 60 * MIN);
			expect(day.times.filter((t) => t === prague(12, 11))).toHaveLength(2);
		},
		REPLAY_TIMEOUT_MS,
	);
});
