import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 18 (bandwidth exponent k, multiplier 2^(k/2)). Stub: scores the present value only. */
export function scoreBandwidth(_input: LearnInput): RowScores<number> {
	return presentOnly("bandwidth", 0);
}
