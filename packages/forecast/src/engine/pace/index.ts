import type { EpochMs } from "../../types";
import type {
	PaceFitState,
	PaceNow,
	PaceSeries,
	PaceSeriesInput,
} from "./types";

export type * from "./types";

/** Pooled five-minute demand and censoring over [historyFrom, now). */
export function buildPaceSeries(_input: PaceSeriesInput): PaceSeries {
	throw new Error("pace: buildPaceSeries not implemented");
}

/** The refit: selection, coefficients and clip ranges from the series before now. Runs in a worker. */
export function fitPaceModel(_series: PaceSeries, _now: EpochMs): PaceFitState {
	throw new Error("pace: fitPaceModel not implemented");
}

/** Applies a fitted state to the series up to now. A null state gives status unfitted, enabled false gives off; both give m = 1. */
export function applyPace(
	_state: PaceFitState | null,
	_series: PaceSeries,
	_now: EpochMs,
	_enabled: boolean,
): PaceNow {
	throw new Error("pace: applyPace not implemented");
}

/** Multiplier at a distance ahead: the log multiplier interpolated linearly between band centres. */
export function paceMultiplierAt(_pace: PaceNow, _aheadMin: number): number {
	throw new Error("pace: paceMultiplierAt not implemented");
}
