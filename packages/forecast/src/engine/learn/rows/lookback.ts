import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 4 (demand lookback). Stub: scores the present value only. */
export function scoreLookback(input: LearnInput): RowScores<number> {
	return presentOnly("lookback", input.historyLookbackDays);
}
