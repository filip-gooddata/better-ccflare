import { WORK_START_RECENT_DAYS } from "../../days";
import type { LearnInput, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 16 (work-start sample). Stub: scores the present value only. */
export function scoreWorkstartSample(_input: LearnInput): RowScores<number> {
	return presentOnly("wssample", WORK_START_RECENT_DAYS);
}
