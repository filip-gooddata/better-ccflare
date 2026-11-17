import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 20 (jitter bound, minutes). Stub: scores the present value only. */
export function scoreJitter(input: LearnInput): RowScores<number> {
	return presentOnly("jitter", input.timeShiftMin);
}
