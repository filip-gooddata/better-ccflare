import { describe, expect, it } from "bun:test";
import type { DemandBucket } from "../../types";
import { createForecastWorkerRunner } from "../forecast-worker-runner";
import { paceRefitLine } from "../pace-refit-log";
import { createPaceRefitRunner } from "../pace-refit-runner";

/** One scenario-count rung at the days the context holds (400 here): N as before the rule. */
const atBuiltDays = (ctx: { scenarios: { units: unknown[] } }) => ({
	start: ctx.scenarios.units.length,
	top: ctx.scenarios.units.length,
});

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const BUCKET = 300_000;

/** The source forecast-worker.ts, not the embedded bundle: this tests the checkout. */
const sourceRunner = () =>
	createForecastWorkerRunner({ embeddedCode: async () => "" });

describe("forecast worker: the real worker module", () => {
	it("answers a refit job with a fitted state or a fit error, never a worker failure", async () => {
		const n = 288;
		const outcome = await createPaceRefitRunner(sourceRunner()).run(
			{
				start: T0 - n * BUCKET,
				units: new Float64Array(n),
				censored: new Uint8Array(n),
				timeZone: "Europe/Prague",
			},
			T0,
			{ timeoutMs: 60_000 },
		);
		if (outcome.status === "error") expect(outcome.reason).toBe("fit-error");
		else expect(outcome.status).toBe("ok");
	});
});

describe("forecast worker: the default loader", () => {
	it("starts the built-in worker (embedded after a CLI build, else the source module)", async () => {
		const n = 12;
		const outcome = await createPaceRefitRunner().run(
			{
				start: T0 - n * BUCKET,
				units: new Float64Array(n),
				censored: new Uint8Array(n),
				timeZone: "Europe/Prague",
			},
			T0,
			{ timeoutMs: 60_000 },
		);
		if (outcome.status === "error") expect(outcome.reason).toBe("fit-error");
		else expect(outcome.status).toBe("ok");
	});
});

/**
 * Off-main-thread proof with the real fit. Needs the fitted pace model, so it
 * is off until the model part is integrated: run with PACE_REFIT_REAL_WORKER=1.
 */
describe.skipIf(!process.env.PACE_REFIT_REAL_WORKER)(
	"forecast worker: the real refit off the main thread",
	() => {
		it("keeps a 20 ms interval ticking while an 84-day refit runs", async () => {
			const { buildPaceSeries } = await import("../../engine/pace");
			const days = 84;
			const n = (days * 24 * 60 * 60_000) / BUCKET;
			const historyFrom = T0 - n * BUCKET;
			const history: DemandBucket[] = Array.from({ length: n }, (_, i) => {
				const at = historyFrom + i * BUCKET;
				const hour = new Date(at).getUTCHours();
				const day = new Date(at).getUTCDay();
				const work = day >= 1 && day <= 5 && hour >= 7 && hour < 17;
				const units = work
					? 1 + ((i * 7919) % 13) / 13
					: ((i * 104729) % 5) / 50;
				return { start: at, units, fableUnits: 0, requests: units > 0 ? 1 : 0 };
			});
			const series = buildPaceSeries({
				history,
				historyFrom,
				now: T0,
				readings: [],
				accounts: ["a", "b"],
				timeZone: "Europe/Prague",
			});
			let last = performance.now();
			let maxGap = 0;
			let ticks = 0;
			const handle = setInterval(() => {
				const t = performance.now();
				maxGap = Math.max(maxGap, t - last);
				last = t;
				ticks++;
			}, 20);
			try {
				const outcome = await createPaceRefitRunner(sourceRunner()).run(
					series,
					T0,
					{ timeoutMs: 600_000 },
				);
				expect(outcome.status).toBe("ok");
				expect(outcome.ms).toBeGreaterThanOrEqual(1_000);
				console.info(
					`real refit ms=${Math.round(outcome.ms)} ticks=${ticks} maxGapMs=${maxGap.toFixed(1)}`,
				);
				console.info(paceRefitLine(outcome, null, T0));
				expect(ticks).toBeGreaterThanOrEqual(Math.floor(outcome.ms / 40));
				expect(maxGap).toBeLessThan(250);
			} finally {
				clearInterval(handle);
			}
		}, 660_000);
	},
);

/** The 2026-11-12 replay context: 400 simulated days, the planner fixture of record. */
async function replayContext() {
	const { prepareEngineContext } = await import("../../engine/engine");
	const { buildInput, replayFixture } = await import(
		"../../engine/__tests__/fixtures-engine"
	);
	const ctx = await prepareEngineContext(buildInput(replayFixture()), {
		noise: true,
	});
	if (ctx === "insufficient_history")
		throw new Error("fixture has no forecast");
	return ctx;
}

describe("forecast worker: the plan job", () => {
	it("answers a plan job with the plan an inline planForecast gives", async () => {
		const { planForecast } = await import("../../engine/planner");
		const {
			PLAN_BUDGET_MS,
			PLAN_JOB_TIMEOUT_MS,
			planJobContext,
			planJobTransfer,
		} = await import("../../engine/plan-job");
		const inline = await planForecast(await replayContext());
		const ctx = await replayContext();
		const outcome = await sourceRunner().run(
			"plan",
			{
				ctx: planJobContext(ctx),
				budgetMs: PLAN_BUDGET_MS,
				ladder: atBuiltDays(ctx),
			},
			{ timeoutMs: 4 * PLAN_JOB_TIMEOUT_MS, transfer: planJobTransfer(ctx) },
		);
		if (outcome.status !== "ok") throw new Error(JSON.stringify(outcome));
		expect(outcome.result.plan).toEqual(inline.plan);
		expect(outcome.result.score).toEqual(inline.score);
		expect(outcome.result.baseline.score).toEqual(inline.baseline.score);
		expect(outcome.result.result).toEqual(inline.result);
		// The scenarios moved to the worker: the caller keeps detached views.
		expect(ctx.scenarios.units[0]?.length).toBe(0);
	}, 240_000);

	it("keeps a 20 ms interval ticking while a plan job runs", async () => {
		const {
			PLAN_BUDGET_MS,
			PLAN_JOB_TIMEOUT_MS,
			planJobContext,
			planJobTransfer,
		} = await import("../../engine/plan-job");
		const ctx = await replayContext();
		let last = performance.now();
		let maxGap = 0;
		let ticks = 0;
		const handle = setInterval(() => {
			const t = performance.now();
			maxGap = Math.max(maxGap, t - last);
			last = t;
			ticks++;
		}, 20);
		try {
			const outcome = await sourceRunner().run(
				"plan",
				{
					ctx: planJobContext(ctx),
					budgetMs: PLAN_BUDGET_MS,
					ladder: atBuiltDays(ctx),
				},
				{ timeoutMs: 4 * PLAN_JOB_TIMEOUT_MS, transfer: planJobTransfer(ctx) },
			);
			expect(outcome.status).toBe("ok");
			console.info(
				`plan job ms=${outcome.ms} ticks=${ticks} maxGapMs=${maxGap.toFixed(1)}`,
			);
			expect(ticks).toBeGreaterThanOrEqual(Math.floor(outcome.ms / 40));
			expect(maxGap).toBeLessThan(250);
		} finally {
			clearInterval(handle);
		}
	}, 240_000);

	it("reports a timeout when the plan job outlasts its timeout", async () => {
		const ctx = await replayContext();
		const outcome = await sourceRunner().run(
			"plan",
			{ ctx, budgetMs: 1, ladder: atBuiltDays(ctx) },
			{ timeoutMs: 1 },
		);
		expect(outcome.status).toBe("timeout");
	}, 120_000);

	it("reports a job error, not a worker failure, when the planner throws", async () => {
		const outcome = await sourceRunner().run(
			"plan",
			// A context without scenarios: the job throws inside the worker.
			{ ctx: {} as never, budgetMs: 1_000 },
			{ timeoutMs: 60_000 },
		);
		expect(outcome).toMatchObject({ status: "error", reason: "job-error" });
	}, 120_000);

	it("stops a running plan job on abort", async () => {
		const ctx = await replayContext();
		const controller = new AbortController();
		const pending = sourceRunner().run(
			"plan",
			{ ctx, budgetMs: 15_000, ladder: atBuiltDays(ctx) },
			{ timeoutMs: 60_000, signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 5);
		expect(await pending).toMatchObject({ status: "error", reason: "stopped" });
	}, 120_000);
});
