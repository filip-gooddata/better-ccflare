import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 16 (work-start share). Stub: scores the present value only. */
export function scoreWorkstartShare(input: LearnInput): RowScores<number> {
	return presentOnly("wsshare", input.workStartSharePct);
}
