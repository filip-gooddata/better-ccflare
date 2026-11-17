import { type LearnedDemand, partitionKey } from "../engine/learn";

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

/**
 * The `forecast f2 learn` line (DESIGN-F2 section 3), logged right after
 * `forecast e4 refit`. Numbers only: per row, in `learned.choices` order,
 * served/chosen/runnerUp/presentLoss/chosenLoss/gain/se/units/floor/on.
 */
export function formatF2LearnLine(
	learned: LearnedDemand,
	jobMs: number,
): string {
	const rows = learned.choices
		.map(
			(c) =>
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
				].join("/")}`,
		)
		.join(",");
	return `forecast f2 learn ms=${Math.round(jobMs)} rows=${rows}`;
}
