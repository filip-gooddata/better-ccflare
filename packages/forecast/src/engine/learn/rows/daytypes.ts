import { learnDays } from "../daily";
import { cleanDaysByWeekday, partitionFamily } from "../partition-family";
import type { LearnInput, Partition, RowScores } from "../types";

/**
 * Row 1 (day types, DESIGN-F2 §2): the fixed family generated from E4's present
 * partition, each member scored by its own full E4 fit (`fitWithPartition`) on
 * that fit's out-of-fold squared error of the served model per held-out ISO
 * week (`PaceFitState.oof`). NaN where a fit has no loss on a week.
 */
export function scoreDaytypes(input: LearnInput): RowScores<Partition> {
	const days = learnDays(input.series, input.now, input.workDays);
	const family = partitionFamily(cleanDaysByWeekday(days));
	const oofs = family.candidates.map(
		(p) => input.fitWithPartition(p).oof ?? { units: [], loss: [] },
	);
	const units = [...new Set(oofs.flatMap((o) => o.units))].sort(
		(a, b) => a - b,
	);
	const loss = oofs.map((o) => {
		const at = new Map(o.units.map((u, i) => [u, o.loss[i] as number]));
		return Float64Array.from(units, (u) => at.get(u) ?? Number.NaN);
	});
	return {
		row: "daytypes",
		candidates: family.candidates,
		presentIndex: family.presentIndex,
		preference: family.preference,
		units,
		loss,
	};
}
