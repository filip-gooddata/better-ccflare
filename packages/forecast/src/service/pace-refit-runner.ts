import type {
	DemandSettings,
	LearnedDemand,
	Partition,
	RowChoice,
} from "../engine/learn/types";
import type { PaceFitState, PaceSeries } from "../engine/pace/types";
import type { EpochMs } from "../types";
import {
	createForecastWorkerRunner,
	type ForecastJobFailure,
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

export type DaytypesOutcome =
	| { status: "ok"; choice: RowChoice<Partition>; ms: number }
	| { status: "timeout"; ms: number }
	| { status: "error"; reason: PaceRefitFailure; ms: number };

export interface PaceRefitRunner {
	/**
	 * Fits E4 on `series` with the partition of `options.daytypes` (the stored
	 * row-1 choice; null or absent fits the present partition) and learns rows
	 * 2-8, in the worker. The series' buffers are transferred: do not use it afterwards.
	 */
	run(
		series: PaceSeries,
		now: EpochMs,
		demand: RefitDemandSettings,
		options: {
			timeoutMs: number;
			signal?: AbortSignal;
			daytypes?: RowChoice<Partition> | null;
		},
	): Promise<PaceRefitOutcome>;
	/** Scores F2 row 1 (one E4 fit per candidate partition) in its own worker job. Transfers the series' buffers like `run`. */
	runDaytypes(
		series: PaceSeries,
		now: EpochMs,
		demand: RefitDemandSettings,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<DaytypesOutcome>;
}

const payloadOf = (
	{ start, units, censored, timeZone }: PaceSeries,
	now: EpochMs,
	{
		workDays,
		historyLookbackDays,
		historyHalfLifeDays,
		workStartSharePct,
		timeShiftMin,
	}: RefitDemandSettings,
) => ({
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
});

const failureOf = (reason: ForecastJobFailure): PaceRefitFailure =>
	reason === "job-error" ? "fit-error" : reason;

export function createPaceRefitRunner(
	worker: ForecastWorkerRunner = createForecastWorkerRunner(),
): PaceRefitRunner {
	return {
		async run(series, now, demand, { timeoutMs, signal, daytypes = null }) {
			const { units, censored } = series;
			const outcome = await worker.run(
				"refit",
				{ ...payloadOf(series, now, demand), daytypes },
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
			return {
				status: "error",
				reason: failureOf(outcome.reason),
				ms: outcome.ms,
			};
		},
		async runDaytypes(series, now, demand, { timeoutMs, signal }) {
			const { units, censored } = series;
			const outcome = await worker.run(
				"daytypes",
				payloadOf(series, now, demand),
				{ timeoutMs, signal, transfer: [units.buffer, censored.buffer] },
			);
			if (outcome.status === "ok")
				return { status: "ok", choice: outcome.result, ms: outcome.ms };
			if (outcome.status === "timeout") return outcome;
			return {
				status: "error",
				reason: failureOf(outcome.reason),
				ms: outcome.ms,
			};
		},
	};
}
