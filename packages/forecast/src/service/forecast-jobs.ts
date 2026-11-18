import {
	type DaytypesResult,
	learnDaytypes,
	learnDemand,
	makeNestedScorer,
	makePartitionFitter,
	type NestedScorer,
	type PartitionFitter,
	PRESENT_PARTITION,
} from "../engine/learn";
import type { PaceSeries } from "../engine/pace/types";
import { runPlanJob } from "../engine/plan-job";
import type { EpochMs } from "../types";
import type {
	ForecastWorkerJobs,
	SeriesPayload,
} from "./forecast-worker-runner";

/** What both refit jobs receive: the pooled series (buffers transferred), the fit instant and the demand settings. */
export type SeriesJobPayload = SeriesPayload;

type FitterFactory = (series: PaceSeries, now: EpochMs) => PartitionFitter;
type NestedFactory = (series: PaceSeries, now: EpochMs) => NestedScorer;

function split({
	start,
	units,
	censored,
	timeZone,
	now,
	...settings
}: SeriesJobPayload) {
	return { series: { start, units, censored, timeZone }, now, settings };
}

/**
 * The main refit job: E4 fitted once, with the partition row 1 serves (the
 * stored choice's, else the present one), and rows 2-8. `pace` is that fit.
 */
export function refitJob(
	payload: ForecastWorkerJobs["refit"]["payload"],
	makeFitter: FitterFactory = makePartitionFitter,
): ForecastWorkerJobs["refit"]["result"] {
	const { daytypes, ...rest } = payload;
	const { series, now, settings } = split(rest);
	const fitWithPartition = makeFitter(series, now);
	const learned = learnDemand(
		{ ...settings, series, now, fitWithPartition },
		daytypes,
	);
	return { pace: fitWithPartition(learned.partition), learned };
}

/**
 * The row-1 job (DESIGN-F2 R3-2): with nothing pending, every candidate
 * partition fitted, scored and selected, a switch stored as pending; with a
 * pending partition, the nested comparison of present vs pending instead.
 */
export function daytypesJob(
	payload: ForecastWorkerJobs["daytypes"]["payload"],
	makeFitter: FitterFactory = makePartitionFitter,
	makeNested: NestedFactory = makeNestedScorer,
): DaytypesResult {
	const { daytypes, pending, ...rest } = payload;
	const { series, now, settings } = split(rest);
	return learnDaytypes(
		{
			...settings,
			series,
			now,
			fitWithPartition: makeFitter(series, now),
			nestedLoss: makeNested(series, now),
		},
		{ served: daytypes?.served ?? PRESENT_PARTITION, pending },
	);
}

/**
 * The plan job (F1): the scenario count, then the planner, on the prepared context. The
 * deadline is on this worker's clock: performance.now has a per-thread origin.
 */
export function planJob({
	ctx,
	budgetMs,
	ladder,
}: ForecastWorkerJobs["plan"]["payload"]): Promise<
	ForecastWorkerJobs["plan"]["result"]
> {
	return runPlanJob(ctx, {
		deadline: performance.now() + budgetMs,
		now: () => performance.now(),
		ladder,
	});
}
