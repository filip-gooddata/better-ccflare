import type { EpochMs } from "../../types";
import { fitPaceModel } from "../pace";
import type { PaceFitState, PaceSeries } from "../pace/types";
import { isPresentPartition, partitionKey } from "./partition";
import type { PartitionFitter } from "./types";

/**
 * The row-1 hook: E4 fits per candidate partition, memoized by normalized
 * partition within one refit job. The worker serves `fitter(learned.partition)`
 * as the job's pace state, so a switched partition serves its own fit.
 * Foundation: only the present partition is fittable; row 1 extends E4.
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
		if (!isPresentPartition(partition))
			throw new RangeError("learn: partition fit not available");
		const fit = fitPaceModel(series, now);
		fits.set(key, fit);
		return fit;
	};
}
