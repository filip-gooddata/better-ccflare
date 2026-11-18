import { WORK_START_RECENT_DAYS } from "../../days";
import type { LearnInput, RowScores } from "../types";
import { WS_SHARE_GRID, workStartRow } from "./workstart";

/** Row 16 (work-start share): share {1,2,4,8,16} % plus the setting, sample held at its present value. */
export function scoreWorkstartShare(input: LearnInput): RowScores<number> {
	return workStartRow(
		"wsshare",
		input,
		WS_SHARE_GRID,
		input.workStartSharePct,
		(sharePct) => ({ sharePct, sample: WORK_START_RECENT_DAYS }),
	);
}
