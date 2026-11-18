import { WORK_START_RECENT_DAYS } from "../../days";
import type { LearnInput, RowScores } from "../types";
import { WS_SAMPLE_GRID, workStartRow } from "./workstart";

/** Row 16 (work-start sample): sample {5,10,20} work days plus the present 10, share held at the setting. */
export function scoreWorkstartSample(input: LearnInput): RowScores<number> {
	return workStartRow(
		"wssample",
		input,
		WS_SAMPLE_GRID,
		WORK_START_RECENT_DAYS,
		(sample) => ({ sharePct: input.workStartSharePct, sample }),
	);
}
