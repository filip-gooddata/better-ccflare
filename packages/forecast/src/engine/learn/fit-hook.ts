import type { EpochMs } from "../../types";
import { fitPaceModel } from "../pace";
import type { PaceFitState, PaceSeries } from "../pace/types";
import {
	isPresentPartition,
	normalizePartition,
	partitionKey,
} from "./partition";
import type { PartitionFitter } from "./types";

/**
 * The row-1 hook: E4 fits per candidate partition, memoized by normalized
 * partition within one refit job. The worker serves `fitter(learned.partition)`
 * as the job's pace state, so a switched partition serves its own fit.
 * The present partition fits exactly as E4 does today; any other fits E4 segmented by it.
 */
export function makePartitionFitter(
	series: PaceSeries,
	now: EpochMs,
): PartitionFitter {
	const fits = new Map<string, PaceFitState>();
	return (partition) => {
		const key = partitionKey(partition);
		const hit = fits.get(key);
		if (hit) return hit;
		const fit = isPresentPartition(partition)
			? fitPaceModel(series, now)
			: fitPaceModel(series, now, normalizePartition(partition));
		fits.set(key, fit);
		return fit;
	};
}
