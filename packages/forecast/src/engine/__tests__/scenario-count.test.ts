import { describe, expect, test } from "bun:test";
import type { ForecastInput } from "../../types";
import { prepareEngineContext } from "../engine";
import type { EngineContext, Scenarios, SimulationResult } from "../model";
import { scorePlan, TIER_TOLERANCE_POINTS } from "../planner";
import {
	chooseScenarioCount,
	climbCostMs,
	halfSplitSe,
	prebuiltScenarioSource,
	SCENARIO_LADDER_START,
	SCENARIO_LADDER_TOP,
	type ScenarioSource,
	SE_SPLITS,
	scenarioLadder,
	scenarioRangeSource,
	seTargetPoints,
} from "../scenario-count";
import { buildScenarios } from "../scenarios";
import { onDemandPlan, simulate } from "../simulate";
import { buildInput, replayFixture } from "./fixtures-engine";

const TIMEOUT_MS = 120_000;

function withDays(input: ForecastInput, simulatedDays: number): ForecastInput {
	return { ...input, settings: { ...input.settings, simulatedDays } };
}

async function replayContext(simulatedDays: number): Promise<EngineContext> {
	const ctx = await prepareEngineContext(
		withDays(buildInput(replayFixture()), simulatedDays),
		{ noise: true },
	);
	if (ctx === "insufficient_history")
		throw new Error("fixture has no forecast");
	return ctx;
}

function rangeOf(ctx: EngineContext): ScenarioSource {
	return scenarioRangeSource(
		ctx.input,
		ctx.table,
		ctx.horizon,
		{ noise: true },
		ctx.scenarios.diagnostics.pace,
	);
}

function withScenarios(
	ctx: EngineContext,
	scenarios: Scenarios,
): EngineContext {
	return { ...ctx, scenarios };
}

describe("scenario ladder and target", () => {
	test("the ladder doubles from 100 to 1600", () => {
		expect(SCENARIO_LADDER_START).toBe(100);
		expect(SCENARIO_LADDER_TOP).toBe(1600);
		expect(scenarioLadder()).toEqual([100, 200, 400, 800, 1600]);
		expect(scenarioLadder(20, 80)).toEqual([20, 40, 80]);
	});

	test("the SE target is half the tier tolerance", () => {
		expect(seTargetPoints()).toBe(TIER_TOLERANCE_POINTS / 2);
	});

	test("R is one named constant", () => {
		expect(SE_SPLITS).toBe(64);
	});
});

describe("prefix property", () => {
	test(
		"scenario day s is the same whatever the total N, and a range build matches the full build",
		async () => {
			const ctx = await replayContext(40);
			const pace = ctx.scenarios.diagnostics.pace;
			const small = await buildScenarios(
				withDays(ctx.input, 20),
				ctx.table,
				ctx.horizon,
				{ noise: true },
				pace,
			);
			const large = await buildScenarios(
				withDays(ctx.input, 40),
				ctx.table,
				ctx.horizon,
				{ noise: true },
				pace,
			);
			const tail = await buildScenarios(
				ctx.input,
				ctx.table,
				ctx.horizon,
				{ noise: true },
				pace,
				{ from: 20, to: 40 },
			);
			expect(small.units).toHaveLength(20);
			expect(large.units).toHaveLength(40);
			expect(tail.units).toHaveLength(20);
			for (let s = 0; s < 20; s++) {
				expect(large.units[s]).toEqual(small.units[s]);
				expect(large.fable[s]).toEqual(small.fable[s]);
				expect(tail.units[s]).toEqual(large.units[20 + s]);
				expect(tail.fable[s]).toEqual(large.fable[20 + s]);
			}
			expect(tail.start).toBe(large.start);
			expect(tail.bucketCount).toBe(large.bucketCount);
		},
		TIMEOUT_MS,
	);

	test(
		"a day's baseline trace does not depend on the other days simulated (DayRun.reset per day)",
		async () => {
			const ctx = await replayContext(40);
			const plan = onDemandPlan(ctx);
			const full = await simulate(ctx, plan);
			const second = await simulate(
				withScenarios(ctx, {
					...ctx.scenarios,
					units: ctx.scenarios.units.slice(20),
					fable: ctx.scenarios.fable.slice(20),
				}),
				plan,
			);
			expect(second.axis.times).toEqual(full.axis.times);
			for (let s = 0; s < 20; s++) {
				const a = second.traces[s];
				const b = full.traces[20 + s];
				expect(a?.day).toEqual(b?.day);
				expect(a?.week).toEqual(b?.week);
				expect(a?.unserved).toEqual(b?.unserved);
				expect(a?.opens).toEqual(b?.opens);
				expect(a?.outs).toEqual(b?.outs);
			}
		},
		TIMEOUT_MS,
	);
});

describe("half-split SE", () => {
	test(
		"is zero when every day is the same, and repeatable for a seed",
		async () => {
			const ctx = await replayContext(40);
			const base = await simulate(ctx, onDemandPlan(ctx));
			const first = base.traces[0];
			if (!first) throw new Error("no trace");
			const same: SimulationResult = {
				...base,
				traces: base.traces.map(() => first),
			};
			const flat = halfSplitSe(ctx, same, "seed");
			expect(flat.se).toBe(0);
			expect(flat.seDay).toBe(0);
			expect(flat.seWeek).toBe(0);

			const a = halfSplitSe(ctx, base, "seed");
			const b = halfSplitSe(ctx, base, "seed");
			expect(a).toEqual(b);
			expect(a.se).toBeGreaterThan(0);
			expect(Number.isFinite(a.se)).toBe(true);
		},
		TIMEOUT_MS,
	);

	test(
		"the full-sample S it is built on is scorePlan's",
		async () => {
			const ctx = await replayContext(40);
			const base = await simulate(ctx, onDemandPlan(ctx));
			const se = halfSplitSe(ctx, base, "seed");
			const score = scorePlan(ctx, base);
			expect(se.lowPoint).toBe(score.lowPoint);
			expect(se.dayLowPoints).toBe(score.dayLowPoints);
			expect(se.weekLowPoints).toBe(score.weekLowPoints);
		},
		TIMEOUT_MS,
	);
});

describe("climb cost", () => {
	test("covers the extension, the baseline and the candidate search at the next rung", () => {
		expect(
			climbCostMs({
				from: 100,
				to: 200,
				buildMsPerDay: 2,
				simMsPerDay: 3,
				seMs: 7,
				searchPlans: 10,
			}),
		).toBe(100 * 2 + 100 * 3 + 7 * 2 + 10 * 200 * 3);
	});
});

describe("chooseScenarioCount", () => {
	test(
		"stops at the first rung once the SE target is met",
		async () => {
			const ctx = await replayContext(20);
			const out = await chooseScenarioCount(ctx, rangeOf(ctx), {
				deadline: Number.POSITIVE_INFINITY,
				start: 20,
				top: 80,
				targetPoints: Number.POSITIVE_INFINITY,
			});
			expect(out.n).toBe(20);
			expect(out.stopReason).toBe("target-met");
			expect(out.rungs.map((r) => r.n)).toEqual([20]);
			expect(out.ctx.scenarios.units).toHaveLength(20);
			expect(out.baseline.traces).toHaveLength(20);
		},
		TIMEOUT_MS,
	);

	test(
		"climbs to the top rung when the target is never met and time is ample",
		async () => {
			const ctx = await replayContext(20);
			const out = await chooseScenarioCount(ctx, rangeOf(ctx), {
				deadline: Number.POSITIVE_INFINITY,
				start: 20,
				top: 80,
				targetPoints: 0,
			});
			expect(out.n).toBe(80);
			expect(out.stopReason).toBe("ladder-top");
			expect(out.rungs.map((r) => r.n)).toEqual([20, 40, 80]);
			for (const r of out.rungs) {
				expect(Number.isFinite(r.se)).toBe(true);
				expect(Number.isFinite(r.seDay)).toBe(true);
				expect(Number.isFinite(r.seWeek)).toBe(true);
			}
			expect(out.ctx.scenarios.units).toHaveLength(80);
			expect(out.baseline.traces).toHaveLength(80);
			// the climbed scenarios are the prefix of one build
			const direct = await rangeOf(ctx)(0, 80);
			for (let s = 0; s < 80; s++)
				expect(out.ctx.scenarios.units[s]).toEqual(direct.units[s]);
		},
		TIMEOUT_MS,
	);

	test(
		"with an injected clock, climbs only while the remaining budget covers the next rung",
		async () => {
			const ctx = await replayContext(20);
			const inner = rangeOf(ctx);
			let t = 1_000;
			// building costs 1 ms per day; nothing else advances the clock
			const source: ScenarioSource = async (from, to) => {
				const built = await inner(from, to);
				t += to - from;
				return built;
			};
			// first rung: 20 ms (t = 1020); 20 -> 40 needs 20 ms, 59 left: climb (t = 1040);
			// 40 -> 80 needs 40 ms, 39 left: stop.
			const out = await chooseScenarioCount(ctx, source, {
				deadline: 1_000 + 20 + 20 + 39,
				now: () => t,
				start: 20,
				top: 80,
				targetPoints: 0,
				searchPlans: 10,
			});
			expect(out.n).toBe(40);
			expect(out.stopReason).toBe("budget");
			expect(out.rungs.map((r) => r.n)).toEqual([20, 40]);
			expect(out.ctx.scenarios.units).toHaveLength(40);
		},
		TIMEOUT_MS,
	);

	test(
		"a deadline already past still returns the first rung, as a budget stop",
		async () => {
			const ctx = await replayContext(20);
			const out = await chooseScenarioCount(ctx, rangeOf(ctx), {
				deadline: 0,
				now: () => 10,
				start: 20,
				top: 80,
				targetPoints: 0,
			});
			expect(out.n).toBe(20);
			expect(out.stopReason).toBe("budget");
		},
		TIMEOUT_MS,
	);

	test(
		"a prebuilt source serves prefixes of its scenarios",
		async () => {
			const ctx = await replayContext(40);
			const source = prebuiltScenarioSource(ctx.scenarios);
			const part = await source(10, 30);
			expect(part.units).toHaveLength(20);
			expect(part.units[0]).toBe(ctx.scenarios.units[10] as Float32Array);
			await expect(source(30, 41)).rejects.toThrow();
		},
		TIMEOUT_MS,
	);
});
