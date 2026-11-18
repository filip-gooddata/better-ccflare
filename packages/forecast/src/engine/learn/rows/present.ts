import type { RowScores } from "../types";

/** Scores of a row that searches nothing yet: its present value only, no units. */
export const presentOnly = <V>(row: string, present: V): RowScores<V> => ({
	row,
	candidates: [present],
	presentIndex: 0,
	preference: [0],
	units: [],
	loss: [new Float64Array(0)],
});
