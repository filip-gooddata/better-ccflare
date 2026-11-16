import type { PaceFitState } from "../engine/pace/types";
import type { EpochMs } from "../types";
import type { PaceRefitOutcome } from "./pace-refit-runner";

/** Minutes between refits; the service's cadence and the logged one. */
export const PACE_REFIT_CADENCE_MIN = 60;

const num = (x: number) =>
	Number.isFinite(x) ? String(+x.toPrecision(4)) : "na";

/** Model ids (bands, features) as logged: anything outside the id alphabet is masked. */
const ident = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

const count = (x: number | null) =>
	x !== null && Number.isFinite(x) ? String(x) : "na";

/** Cells that pass every test but the evidence floor (band:dayType:hour/feature/units each), so they switch on by themselves. */
function switchOn(state: PaceFitState): string {
	if (state.belowFloor.length === 0) return "switchOn=none";
	return `switchOn=${state.belowFloor
		.map(
			({ band, dayType, hour, feature, units }) =>
				`${ident(band)}:${ident(dayType)}:${count(hour)}/${ident(feature)}/${count(units)}`,
		)
		.join(",")}`;
}

/** The pooled selection per band: band/feature/gain in standard errors/independent units. */
function selected(state: PaceFitState): string {
	const rows = state.bands.filter((b) => b.feature !== null);
	if (rows.length === 0) return "selected=none";
	return `selected=${rows
		.map(
			(b) =>
				`${ident(b.band)}/${ident(b.feature?.id ?? "")}/${b.gainSE === null ? "na" : num(b.gainSE)}/${count(b.units)}`,
		)
		.join(",")}`;
}

function dayTypes(state: PaceFitState): string {
	const rows = state.dayTypeComparison ?? [];
	if (rows.length === 0) return "daytypes=none";
	const parts = rows.map(({ partition, loss, se }) => {
		const value = `${num(loss)}/${num(se)}`;
		// Partition ids are the model's own; anything else is masked, never logged as text.
		const id = partition.replace(/[^A-Za-z0-9|:-]/g, "_");
		return id.startsWith("merged:")
			? `merged=${id.slice("merged:".length)}:${value}`
			: `${id}=${value}`;
	});
	return `daytypes ${parts.join(" ")}`;
}

/**
 * One line per refit, numbers and ids only. On success: what the fit saw and
 * established, the feature selected per band with its gain, and the day-type partitions compared by out-of-fold loss and its
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
		return `${head} days=${s.days} weeks=${s.weeks} cells=${s.cellsEstablished}/${s.cellsTotal} ${selected(s)} belowFloor=${s.belowFloor.length} ${switchOn(s)} candidates=${s.candidates} floor=${s.floor} ${dayTypes(s)}`;
	}
	const reason = outcome.status === "timeout" ? "timeout" : outcome.reason;
	const age =
		kept === null ? "none" : String(Math.floor((now - kept.fittedAt) / 60_000));
	return `${head} reason=${reason} keptAgeMin=${age}`;
}
