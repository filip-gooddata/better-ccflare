import { describe, expect, test } from "bun:test";
import type {
	ForecastJobOptions,
	ForecastJobOutcome,
	ForecastWorkerRunner,
} from "../../service/forecast-worker-runner";
import { createForecastEngine } from "../engine";
import { PLAN_BUDGET_MS, PLAN_JOB_TIMEOUT_MS, runPlanJob } from "../plan-job";
import { buildInput, replayFixture } from "./fixtures-engine";

const REPLAY_TIMEOUT_MS = 120_000;

interface Call {
	job: string;
	payload: unknown;
	options: ForecastJobOptions;
}

/** A runner that answers every job with a fixed outcome and records the calls. */
function fixedRunner(outcome: ForecastJobOutcome<never>): {
	runner: ForecastWorkerRunner;
	calls: Call[];
} {
	const calls: Call[] = [];
	const runner = {
		run: async (job: string, payload: unknown, options: ForecastJobOptions) => {
			calls.push({ job, payload, options });
			return outcome;
		},
	} as ForecastWorkerRunner;
	return { runner, calls };
}

/** A runner that plans on the calling thread, as the worker would, recording the calls. */
function inlineRunner(): { runner: ForecastWorkerRunner; calls: Call[] } {
	const calls: Call[] = [];
	const runner = {
		run: async (job: string, payload: unknown, options: ForecastJobOptions) => {
			calls.push({ job, payload, options });
			const { ctx, budgetMs } = payload as {
				ctx: Parameters<typeof runPlanJob>[0];
				budgetMs: number;
			};
			const result = await runPlanJob(ctx, {
				deadline: performance.now() + budgetMs,
				now: () => performance.now(),
			});
			return { status: "ok", result, ms: 0 };
		},
	} as ForecastWorkerRunner;
	return { runner, calls };
}

describe("engine: the planner runs as a worker plan job", () => {
	test(
		"compute posts one plan job with the spacing-derived budget and timeout, transferring the scenarios",
		async () => {
			const { runner, calls } = inlineRunner();
			const result = await createForecastEngine({ planRunner: runner }).compute(
				buildInput(replayFixture()),
			);
			expect(result.available).toBe(true);
			expect(calls).toHaveLength(1);
			const call = calls[0];
			expect(call?.job).toBe("plan");
			expect((call?.payload as { budgetMs: number }).budgetMs).toBe(
				PLAN_BUDGET_MS,
			);
			expect(call?.options.timeoutMs).toBe(PLAN_JOB_TIMEOUT_MS);
			expect(call?.options.transfer?.length).toBeGreaterThan(0);
		},
		REPLAY_TIMEOUT_MS,
	);

	test(
		"the same input gives the same result through the worker job as through an inline job",
		async () => {
			const input = buildInput(replayFixture());
			const viaWorker = await createForecastEngine().compute(input);
			const viaInline = await createForecastEngine({
				planRunner: inlineRunner().runner,
			}).compute(buildInput(replayFixture()));
			expect(viaWorker.available).toBe(true);
			expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(viaInline));
		},
		REPLAY_TIMEOUT_MS,
	);

	for (const [name, outcome] of [
		["a timeout", { status: "timeout", ms: PLAN_JOB_TIMEOUT_MS }],
		["a job error", { status: "error", reason: "job-error", ms: 3 }],
		["a worker failure", { status: "error", reason: "worker-error", ms: 3 }],
	] as const) {
		test(
			`${name} of the plan job is a forecast error, as other engine errors are`,
			async () => {
				const { runner, calls } = fixedRunner(
					outcome as ForecastJobOutcome<never>,
				);
				const result = await createForecastEngine({
					planRunner: runner,
				}).compute(buildInput(replayFixture()));
				expect(calls).toHaveLength(1);
				expect(result.available).toBe(false);
				if (!result.available) expect(result.reason).toBe("error");
				expect(result.plan).toBeNull();
			},
			REPLAY_TIMEOUT_MS,
		);
	}
});
