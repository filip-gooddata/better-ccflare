import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 5 (demand half-life). Stub: scores the present value only. */
export function scoreHalflife(input: LearnInput): RowScores<number> {
	return presentOnly("halflife", input.historyHalfLifeDays);
}
