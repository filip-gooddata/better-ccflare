import { describe, expect, test } from "bun:test";
import { FORECAST_MIN_SPACING_MS } from "../../service/service";
import { prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import {
	PLAN_BUDGET_MS,
	PLAN_JOB_TIMEOUT_MS,
	planJobContext,
	planJobTransfer,
	planReplyTransfer,
	planSearchSize,
	runPlanJob,
	type ScenarioLadderOverride,
} from "../plan-job";
import { openingGrid, planForecast } from "../planner";
import { buildInput, replayFixture } from "./fixtures-engine";
import { account, MIN, makeCtx, prague, session } from "./fixtures-sim";

/** One rung at the days the context holds: the job plans on exactly those, as before F1's count rule. */
function atBuiltDays(ctx: EngineContext): ScenarioLadderOverride {
	const days = ctx.scenarios.units.length;
	return { start: days, top: days };
}

/** Three accounts, two closed, two warm sessions on 20 simulated days (planner-grid's shape). */
function threeAccounts(): EngineContext {
	const now = prague(12, 7, 30);
	const weekReset = prague(13, 20);
	return makeCtx({
		now,
		days: 20,
		spread: 0.1,
		accounts: [
			account({
				id: "acct-a",
				fiveUsed: 40,
				fiveReset: prague(12, 10),
				weekUsed: 10,
				weekReset,
			}),
			account({ id: "acct-b", weekUsed: 10, weekReset }),
			account({ id: "acct-c", weekUsed: 10, weekReset }),
		],
		rate: (m, w) => {
			if (w > 5) return 0;
			if (m >= 480 && m < 795) return 0.9;
			if (m >= 795 && m < 960) return 1.4;
			return 0;
		},
		sessions: [
			session({
				sessionId: "s1",
				accountId: "acct-a",
				lastRequestAt: now - MIN,
				recentUnits: 5,
			}),
			session({
				sessionId: "s2",
				accountId: "acct-a",
				lastRequestAt: now - 2 * MIN,
				recentUnits: 3,
			}),
		],
		settings: { prewarm: true },
		workStartMinute: 480,
	});
}

/** ctx with only its first n simulated days. */
function firstDays(ctx: EngineContext, n: number): EngineContext {
	return {
		...ctx,
		scenarios: {
			...ctx.scenarios,
			units: ctx.scenarios.units.slice(0, n),
			fable: ctx.scenarios.fable.slice(0, n),
		},
	};
}

// 400 simulated days, several plans each; the default 5 s is short under a loaded full suite.
const REPLAY_TIMEOUT_MS = 120_000;

async function replayContext(): Promise<EngineContext> {
	const ctx = await prepareEngineContext(buildInput(replayFixture()), {
		noise: true,
	});
	if (ctx === "insufficient_history")
		throw new Error("fixture has no forecast");
	return ctx;
}

describe("plan job: budget and timeout come from the forecast spacing", () => {
	test("the planner budget is half the minimum spacing; the job timeout is four spacings", () => {
		expect(PLAN_BUDGET_MS).toBe(FORECAST_MIN_SPACING_MS / 2);
		expect(PLAN_JOB_TIMEOUT_MS).toBe(4 * FORECAST_MIN_SPACING_MS);
	});
});

describe("plan job: the worker-side planner call", () => {
	test(
		"answers what computeForecast needs, equal to an inline planForecast, also after a structured clone of the context",
		async () => {
			const inline = await planForecast(await replayContext());
			const cloned = structuredClone(await replayContext());
			const job = await runPlanJob(cloned, {
				deadline: performance.now() + PLAN_BUDGET_MS,
				now: () => performance.now(),
				ladder: atBuiltDays(cloned),
			});
			expect(job.plan).toEqual(inline.plan);
			expect(job.score).toEqual(inline.score);
			expect(job.baseline.score).toEqual(inline.baseline.score);
			expect(job.result).toEqual(inline.result);
			// Only the baseline's score crosses back: computeForecast reads no baseline traces.
			expect(Object.keys(job.baseline)).toEqual(["score"]);
			const back = structuredClone(job);
			expect(back).toEqual(job);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"transfers each scenario buffer and each trace buffer once",
		async () => {
			const ctx = await replayContext();
			const out = planJobTransfer(ctx);
			expect(new Set(out).size).toBe(out.length);
			const expected = new Set(
				[...ctx.scenarios.units, ...ctx.scenarios.fable].map((a) => a.buffer),
			);
			expect(new Set(out)).toEqual(expected);

			const job = await runPlanJob(ctx, {
				deadline: performance.now() + PLAN_BUDGET_MS,
				now: () => performance.now(),
				ladder: atBuiltDays(ctx),
			});
			const back = planReplyTransfer(job);
			expect(new Set(back).size).toBe(back.length);
			const traceBuffers = new Set(
				job.result.traces.flatMap((t) => [
					t.day.buffer,
					t.week.buffer,
					t.unserved.buffer,
				]),
			);
			expect(new Set(back)).toEqual(traceBuffers);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"the planner reads none of the input left out of the job context",
		async () => {
			const ctx = await replayContext();
			const inline = await planForecast(await replayContext());
			const input = { ...ctx.input };
			for (const key of ["history", "accountHistory", "readings"] as const)
				Object.defineProperty(input, key, {
					get() {
						throw new Error(`planner read input.${key}`);
					},
				});
			const guarded = Object.defineProperty({ ...ctx, input }, "inputs", {
				get() {
					throw new Error("planner read ctx.inputs");
				},
			});
			const planned = await planForecast(guarded);
			expect(planned.plan).toEqual(inline.plan);
			expect(planned.score).toEqual(inline.score);

			const slim = planJobContext(ctx);
			expect(slim.input.history).toEqual([]);
			expect(slim.input.accountHistory).toEqual([]);
			expect(slim.input.readings).toEqual([]);
			expect("inputs" in slim).toBe(false);
			expect(ctx.input.history.length).toBeGreaterThan(0);
			expect(ctx.inputs).toBeDefined();
		},
		REPLAY_TIMEOUT_MS,
	);
});

describe("plan job: the scenario count rule, then the planner, under one deadline", () => {
	test(
		"climbs the ladder first and plans over exactly the chosen N; reports N, its rungs and the search",
		async () => {
			const ctx = threeAccounts();
			const job = await runPlanJob(ctx, {
				deadline: Number.POSITIVE_INFINITY,
				now: () => performance.now(),
				ladder: { start: 5, top: 20 },
			});
			const count = job.scenarioCount;
			expect(count.rungs.map((r) => r.n)).toEqual(
				count.rungs.map((_, i) => 5 * 2 ** i),
			);
			expect(count.n).toBe(count.rungs.at(-1)?.n as number);
			expect(["target-met", "ladder-top"]).toContain(count.stopReason);
			expect(count.targetPoints).toBeGreaterThan(0);
			// The planner ran on the chosen days, not on all the context holds.
			expect(job.result.traces).toHaveLength(count.n);
			const inline = await planForecast(firstDays(ctx, count.n));
			expect(job.plan).toEqual(inline.plan);
			expect(job.score).toEqual(inline.score);
			expect(job.baseline.score).toEqual(inline.baseline.score);
			expect(job.search.cutByDeadline).toBe(false);
			expect(job.search.stage1).toBe(inline.search.stage1);
			expect(job.search.combos).toEqual(inline.search.combos);
			expect(job.search.moves).toEqual(inline.search.moves);
			expect(job.candidates).toBe(inline.candidates);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"a passed deadline stops the climb at the first rung and cuts the planner search; the plan stays valid",
		async () => {
			const ctx = threeAccounts();
			let clock = 0;
			const job = await runPlanJob(ctx, {
				deadline: 0,
				now: () => clock++,
				ladder: { start: 5, top: 20 },
			});
			expect(job.scenarioCount.n).toBe(5);
			expect(job.scenarioCount.rungs.map((r) => r.n)).toEqual([5]);
			expect(["budget", "target-met"]).toContain(job.scenarioCount.stopReason);
			expect(job.result.traces).toHaveLength(5);
			const { search } = job;
			expect(search.cutByDeadline).toBe(true);
			expect(search.combos.evaluated).toBeLessThan(search.combos.available);
			expect(search.refine.evaluated).toBe(0);
			expect(search.moves.evaluated).toBe(0);
			expect(search.moves.available).toBe(4);
			// Both closed accounts still get placed by the stages that always complete.
			expect(Object.keys(job.plan.openAt).sort()).toEqual(["acct-b", "acct-c"]);
			expect(job.plan.moves).toEqual([]);
			expect(job.plan.placement?.tiers.flat().sort()).toEqual([
				"acct-a",
				"acct-b",
				"acct-c",
			]);
		},
		REPLAY_TIMEOUT_MS,
	);

	test("the climb is told the search size from the grid builder: baseline, every stage-1 single per closed account, the final simulation", () => {
		const ctx = threeAccounts();
		expect(planSearchSize(ctx)).toBe(2 + 2 * openingGrid(ctx).length);
		expect(planSearchSize(ctx)).toBe(2 + 2 * 96);
	});
});
