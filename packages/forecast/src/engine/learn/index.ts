import { WORK_START_RECENT_DAYS } from "../days";
import { PRESENT_PARTITION, partitionKey } from "./partition";
import { scoreBandwidth } from "./rows/bandwidth";
import { scoreDaytypes, scoreDaytypesNested } from "./rows/daytypes";
import { scoreHalflife } from "./rows/halflife";
import { scoreJitter } from "./rows/jitter";
import { scoreLookback } from "./rows/lookback";
import { scorePool } from "./rows/pool";
import { scoreWorkstartSample } from "./rows/workstart-sample";
import { scoreWorkstartShare } from "./rows/workstart-share";
import { selectRow } from "./select";
import type {
	DaytypesResult,
	DemandSettings,
	LearnedDemand,
	LearnInput,
	Partition,
	PoolTau,
	RowChoice,
} from "./types";

export { makeNestedScorer, makePartitionFitter } from "./fit-hook";
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

/**
 * Row 1 (day types), DESIGN-F2 R3-2. Runs in its own worker job, after the
 * main refit job, because one fit per candidate is too slow for the main job
 * (REPORT.md section 4). `prior` is the stored state: the partition served now
 * and the pending one.
 *
 * Nothing pending: scores the family unnested. A selection that would switch
 * (on, chosen not the served partition) does not switch: the served partition
 * stays and the chosen one becomes pending. Otherwise the selection is served
 * (present when off).
 *
 * Pending X: instead of family scoring, the nested comparison of present vs X
 * (`input.nestedLoss`) selected with the family's m and floor; X is served iff
 * it passes, else the served partition stays. Pending is cleared either way.
 */
export function learnDaytypes(
	input: LearnInput,
	prior: { served: Partition; pending: Partition | null } = {
		served: PRESENT_PARTITION,
		pending: null,
	},
): DaytypesResult {
	if (prior.pending) {
		if (!input.nestedLoss)
			throw new Error("row 1: a pending partition needs the nested scorer");
		const choice = selectRow(
			scoreDaytypesNested(input, prior.pending, input.nestedLoss),
		);
		return {
			choice: choice.on ? choice : { ...choice, served: prior.served },
			pending: null,
			nested: true,
		};
	}
	const choice = selectRow(scoreDaytypes(input));
	if (choice.on && partitionKey(choice.chosen) !== partitionKey(prior.served))
		return {
			choice: { ...choice, served: prior.served },
			pending: choice.chosen,
			nested: false,
		};
	return { choice, pending: null, nested: false };
}

/**
 * Runs rows 2-8 and the selector; returns the served values. Runs inside the
 * main refit worker job. Row 1 is not scored here: `daytypes` is the last
 * choice the row-1 job stored (null before its first success), and the served
 * partition is its served partition, else the present one. Calls no fitter.
 */
export function learnDemand(
	input: LearnInput,
	daytypes: RowChoice<Partition> | null,
): LearnedDemand {
	const t0 = performance.now();
	const pool = selectRow(scorePool(input));
	const lookback = selectRow(scoreLookback(input));
	const halflife = selectRow(scoreHalflife(input));
	const wsShare = selectRow(scoreWorkstartShare(input));
	const wsSample = selectRow(scoreWorkstartSample(input));
	const bandwidth = selectRow(scoreBandwidth(input));
	const jitter = selectRow(scoreJitter(input));
	const choices = [
		...(daytypes ? [daytypes] : []),
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
		partition: daytypes?.served ?? PRESENT_PARTITION,
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
