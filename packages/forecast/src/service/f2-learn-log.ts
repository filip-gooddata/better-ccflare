import {
	type LearnedDemand,
	partitionKey,
	type RowChoice,
} from "../engine/learn";
import type { EpochMs } from "../types";
import type { DaytypesOutcome } from "./pace-refit-runner";

/** Same compact form as the `forecast e4 refit` line: four significant digits, trailing zeros dropped. */
const num = (x: number) => {
	if (Number.isNaN(x)) return "na";
	if (x === Number.POSITIVE_INFINITY) return "inf";
	if (x === Number.NEGATIVE_INFINITY) return "-inf";
	return String(+x.toPrecision(4));
};

const isPartition = (v: unknown): v is number[] =>
	Array.isArray(v) && v.length === 7 && v.every((g) => typeof g === "number");

/** A row value as logged: a number, a partition key, h3, or na. Never free text. */
function value(v: unknown): string {
	if (typeof v === "number") return num(v);
	if (v === "hard3") return "h3";
	if (isPartition(v)) return partitionKey(v);
	return "na";
}

const ident = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

/** One row: served/chosen/runnerUp/presentLoss/chosenLoss/gain/se/units/floor/on. */
const entry = (c: RowChoice<unknown>) =>
	`${ident(c.row)}:${[
		value(c.served),
		value(c.chosen),
		value(c.runnerUp),
		num(c.presentLoss),
		num(c.chosenLoss),
		num(c.gain),
		num(c.se),
		num(c.units),
		num(c.floor),
		c.on ? "1" : "0",
	].join("/")}`;

/** Row 1 before its first successful job: every field na. */
const NO_DAYTYPES = `daytypes:${Array(10).fill("na").join("/")}`;

/**
 * The `forecast f2 learn` line (DESIGN-F2 section 3), logged right after
 * `forecast e4 refit`. Numbers only: per row, in `learned.choices` order,
 * served/chosen/runnerUp/presentLoss/chosenLoss/gain/se/units/floor/on.
 * Row 1 is scored by its own job: for a main refit job (`mainJob`) that
 * carries no stored row-1 choice yet, its entry comes first with every field na.
 */
export function formatF2LearnLine(
	learned: LearnedDemand,
	jobMs: number,
	{ mainJob = false }: { mainJob?: boolean } = {},
): string {
	const rows = learned.choices.map(entry);
	if (mainJob && learned.choices[0]?.row !== "daytypes")
		rows.unshift(NO_DAYTYPES);
	return `forecast f2 learn ms=${Math.round(jobMs)} rows=${rows.join(",")}`;
}

/**
 * The `forecast f2 daytypes` line, logged when the row-1 job ends. On success
 * its wall time and the row-1 entry as in the f2 learn line; on failure the
 * status and the age in minutes of the row-1 choice kept (none before any).
 */
export function formatF2DaytypesLine(
	outcome: DaytypesOutcome,
	keptAt: EpochMs | null,
	now: EpochMs,
): string {
	if (outcome.status === "ok")
		return `forecast f2 daytypes ms=${Math.round(outcome.ms)} rows=${entry(outcome.choice as RowChoice<unknown>)}`;
	const age =
		keptAt === null ? "none" : String(Math.floor((now - keptAt) / 60_000));
	return `forecast f2 daytypes status=${outcome.status} keptAgeMin=${age}`;
}
