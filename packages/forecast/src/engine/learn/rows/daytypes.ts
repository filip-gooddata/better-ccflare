import { PRESENT_PARTITION } from "../partition";
import type { LearnInput, Partition, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 1 (day types). Stub: scores the present value only. */
export function scoreDaytypes(_input: LearnInput): RowScores<Partition> {
	return presentOnly("daytypes", PRESENT_PARTITION);
}
