import { WORK_START_RECENT_DAYS } from "../days";
import { PRESENT_PARTITION } from "./partition";
import { scoreBandwidth } from "./rows/bandwidth";
import { scoreDaytypes } from "./rows/daytypes";
import { scoreHalflife } from "./rows/halflife";
import { scoreJitter } from "./rows/jitter";
import { scoreLookback } from "./rows/lookback";
import { scorePool } from "./rows/pool";
import { scoreWorkstartSample } from "./rows/workstart-sample";
import { scoreWorkstartShare } from "./rows/workstart-share";
import { selectRow } from "./select";
import type {
	DemandSettings,
	LearnedDemand,
	LearnInput,
	Partition,
	PoolTau,
	RowChoice,
} from "./types";

export { makePartitionFitter } from "./fit-hook";
export {
	isPresentPartition,
	normalizePartition,
	PRESENT_PARTITION,
	partitionKey,
} from "./partition";
export { selectRow } from "./select";
export type * from "./types";

/** Every row at its present value: what the engine serves before the first successful refit. */
export function presentDemand(settings: DemandSettings): LearnedDemand {
	return {
		choices: [],
		partition: PRESENT_PARTITION,
		poolTau: "hard3",
		lookbackDays: settings.historyLookbackDays,
		halfLifeDays: settings.historyHalfLifeDays,
		workStartSharePct: settings.workStartSharePct,
		workStartSample: WORK_START_RECENT_DAYS,
		bandwidthK: 0,
		jitterMin: settings.timeShiftMin,
		ms: 0,
	};
}

/** Runs every row learner and the selector; returns the served values. Runs inside the refit worker job. */
export function learnDemand(input: LearnInput): LearnedDemand {
	const t0 = performance.now();
	const daytypes = selectRow(scoreDaytypes(input));
	const pool = selectRow(scorePool(input));
	const lookback = selectRow(scoreLookback(input));
	const halflife = selectRow(scoreHalflife(input));
	const wsShare = selectRow(scoreWorkstartShare(input));
	const wsSample = selectRow(scoreWorkstartSample(input));
	const bandwidth = selectRow(scoreBandwidth(input));
	const jitter = selectRow(scoreJitter(input));
	const choices = [
		daytypes,
		pool,
		lookback,
		halflife,
		wsShare,
		wsSample,
		bandwidth,
		jitter,
	] as RowChoice<unknown>[];
	return {
		choices,
		partition: daytypes.served as Partition,
		poolTau: pool.served as PoolTau,
		lookbackDays: lookback.served,
		halfLifeDays: halflife.served,
		workStartSharePct: wsShare.served,
		workStartSample: wsSample.served,
		bandwidthK: bandwidth.served,
		jitterMin: jitter.served,
		ms: Math.round(performance.now() - t0),
	};
}
