import type { DemandSettings, LearnedDemand } from "../engine/learn/types";
import type { PaceFitState, PaceSeries } from "../engine/pace/types";
import type { EpochMs } from "../types";
import {
	createForecastWorkerRunner,
	type ForecastWorkerRunner,
} from "./forecast-worker-runner";

/**
 * Hard cap on one refit. Round 1 measured 3.6-5.3 s per refit (ROUND-2.md §4);
 * 120 s is over 20 times that, room for a slower machine, a busy CPU and the
 * larger round-3 grammar, and still far inside the 60-minute cadence, so a hung
 * fit costs at most one refit and never overlaps the next.
 */
export const PACE_REFIT_TIMEOUT_MS = 120_000;

export type PaceRefitFailure =
	| "fit-error"
	| "worker-error"
	| "stopped"
	| "busy"
	| "input-error";

/** The settings the refit job's demand learners (F2) start from: their present values and the work days. */
export interface RefitDemandSettings extends DemandSettings {
	/** As PaceContext.workDays. */
	workDays: number;
}

export type PaceRefitOutcome =
	/** `state` (E4) and `learned` (F2) come from the same job. */
	| { status: "ok"; state: PaceFitState; learned: LearnedDemand; ms: number }
	| { status: "timeout"; ms: number }
	| { status: "error"; reason: PaceRefitFailure; ms: number };

export interface PaceRefitRunner {
	/** Fits E4 on `series` and learns the demand rows in the worker. The series' buffers are transferred: do not use it afterwards. */
	run(
		series: PaceSeries,
		now: EpochMs,
		demand: RefitDemandSettings,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<PaceRefitOutcome>;
}

export function createPaceRefitRunner(
	worker: ForecastWorkerRunner = createForecastWorkerRunner(),
): PaceRefitRunner {
	return {
		async run(series, now, demand, { timeoutMs, signal }) {
			const { start, units, censored, timeZone } = series;
			const {
				workDays,
				historyLookbackDays,
				historyHalfLifeDays,
				workStartSharePct,
				timeShiftMin,
			} = demand;
			const outcome = await worker.run(
				"refit",
				{
					start,
					units,
					censored,
					timeZone,
					now,
					workDays,
					historyLookbackDays,
					historyHalfLifeDays,
					workStartSharePct,
					timeShiftMin,
				},
				{ timeoutMs, signal, transfer: [units.buffer, censored.buffer] },
			);
			if (outcome.status === "ok")
				return {
					status: "ok",
					state: outcome.result.pace,
					learned: outcome.result.learned,
					ms: outcome.ms,
				};
			if (outcome.status === "timeout") return outcome;
			const reason =
				outcome.reason === "job-error" ? "fit-error" : outcome.reason;
			return { status: "error", reason, ms: outcome.ms };
		},
	};
}
