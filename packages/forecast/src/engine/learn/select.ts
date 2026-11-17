import { floorOf } from "../pace/fit";
import type { RowChoice, RowScores } from "./types";

export type { RowChoice, RowScores } from "./types";

/**
 * The E4 selection method for one row (DESIGN-F2 section 1).
 * Placeholder of the foundation contract: serves the present value with reason "no-units".
 */
export function selectRow<V>(s: RowScores<V>): RowChoice<V> {
	const present = s.candidates[s.presentIndex] as V;
	return {
		row: s.row,
		m: s.candidates.length,
		floor: floorOf(s.candidates.length),
		units: 0,
		present,
		chosen: present,
		runnerUp: null,
		served: present,
		presentLoss: Number.NaN,
		chosenLoss: Number.NaN,
		gain: 0,
		se: 0,
		p: 1,
		on: false,
		reason: "no-units",
	};
}
