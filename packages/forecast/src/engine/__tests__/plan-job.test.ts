import { describe, expect, test } from "bun:test";
import { FORECAST_MIN_SPACING_MS } from "../../service/service";
import { prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import {
	PLAN_BUDGET_MS,
	PLAN_JOB_TIMEOUT_MS,
	planJobTransfer,
	planReplyTransfer,
	runPlanJob,
} from "../plan-job";
import { planForecast } from "../planner";
import { buildInput, replayFixture } from "./fixtures-engine";

// 400 simulated days, several plans each; the default 5 s is short under a loaded full suite.
const REPLAY_TIMEOUT_MS = 120_000;

async function replayContext(): Promise<EngineContext> {
	const ctx = await prepareEngineContext(buildInput(replayFixture()), {
		noise: true,
	});
	if (ctx === "insufficient_history") throw new Error("fixture has no forecast");
	return ctx;
}

describe("plan job: budget and timeout come from the forecast spacing", () => {
	test("the planner budget is half the minimum spacing; the job timeout is the spacing", () => {
		expect(PLAN_BUDGET_MS).toBe(FORECAST_MIN_SPACING_MS / 2);
		expect(PLAN_JOB_TIMEOUT_MS).toBe(FORECAST_MIN_SPACING_MS);
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
});
