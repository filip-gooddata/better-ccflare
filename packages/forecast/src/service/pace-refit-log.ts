import type { PaceFitState } from "../engine/pace/types";
import type { EpochMs } from "../types";
import type { PaceRefitOutcome } from "./pace-refit-runner";

/** Minutes between refits; the service's cadence and the logged one. */
export const PACE_REFIT_CADENCE_MIN = 60;

const num = (x: number) =>
	Number.isFinite(x) ? String(+x.toPrecision(4)) : "na";

function dayTypes(state: PaceFitState): string {
	const rows = state.dayTypeComparison ?? [];
	if (rows.length === 0) return "daytypes=none";
	const parts = rows.map(({ partition, loss, se }) => {
		const value = `${num(loss)}/${num(se)}`;
		return partition.startsWith("merged:")
			? `merged=${partition.slice("merged:".length)}:${value}`
			: `${partition}=${value}`;
	});
	return `daytypes ${parts.join(" ")}`;
}

/**
 * One line per refit, numbers and ids only. On success: what the fit saw and
 * established, and the day-type partitions compared by out-of-fold loss and its
 * standard error. On failure: the reason and the age of the state kept.
 */
export function paceRefitLine(
	outcome: PaceRefitOutcome,
	kept: PaceFitState | null,
	now: EpochMs,
): string {
	const head = `forecast e4 refit status=${outcome.status} ms=${Math.round(outcome.ms)} cadenceMin=${PACE_REFIT_CADENCE_MIN}`;
	if (outcome.status === "ok") {
		const s = outcome.state;
		return `${head} days=${s.days} weeks=${s.weeks} cells=${s.cellsEstablished}/${s.cellsTotal} belowFloor=${s.belowFloor.length} candidates=${s.candidates} floor=${s.floor} ${dayTypes(s)}`;
	}
	const reason = outcome.status === "timeout" ? "timeout" : outcome.reason;
	const age =
		kept === null ? "none" : String(Math.floor((now - kept.fittedAt) / 60_000));
	return `${head} reason=${reason} keptAgeMin=${age}`;
}
