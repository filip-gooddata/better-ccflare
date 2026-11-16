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

export type PaceRefitOutcome =
	| { status: "ok"; state: PaceFitState; ms: number }
	| { status: "timeout"; ms: number }
	| { status: "error"; reason: PaceRefitFailure; ms: number };

export interface PaceRefitRunner {
	/** Fits `series` in the worker. The series' buffers are transferred: do not use it afterwards. */
	run(
		series: PaceSeries,
		now: EpochMs,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<PaceRefitOutcome>;
}

export function createPaceRefitRunner(
	worker: ForecastWorkerRunner = createForecastWorkerRunner(),
): PaceRefitRunner {
	return {
		async run(series, now, { timeoutMs, signal }) {
			const { start, units, censored, timeZone } = series;
			const outcome = await worker.run(
				"refit",
				{ start, units, censored, timeZone, now },
				{ timeoutMs, signal, transfer: [units.buffer, censored.buffer] },
			);
			if (outcome.status === "ok")
				return { status: "ok", state: outcome.result, ms: outcome.ms };
			if (outcome.status === "timeout") return outcome;
			const reason =
				outcome.reason === "job-error" ? "fit-error" : outcome.reason;
			return { status: "error", reason, ms: outcome.ms };
		},
	};
}
