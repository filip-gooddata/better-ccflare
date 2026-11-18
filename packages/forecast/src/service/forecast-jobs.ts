import {
	learnDaytypes,
	learnDemand,
	makePartitionFitter,
	type Partition,
	type PartitionFitter,
	type RowChoice,
} from "../engine/learn";
import type { PaceSeries } from "../engine/pace/types";
import type { EpochMs } from "../types";
import type { ForecastWorkerJobs } from "./forecast-worker-runner";

/** What both refit jobs receive: the pooled series (buffers transferred), the fit instant and the demand settings. */
export type SeriesJobPayload = ForecastWorkerJobs["daytypes"]["payload"];

type FitterFactory = (series: PaceSeries, now: EpochMs) => PartitionFitter;

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

/** The row-1 job: every candidate partition fitted and scored, then selected. */
export function daytypesJob(
	payload: SeriesJobPayload,
	makeFitter: FitterFactory = makePartitionFitter,
): RowChoice<Partition> {
	const { series, now, settings } = split(payload);
	return learnDaytypes({
		...settings,
		series,
		now,
		fitWithPartition: makeFitter(series, now),
	});
}
