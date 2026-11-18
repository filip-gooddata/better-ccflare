import { learnDays } from "../daily";
import { cleanDaysByWeekday, partitionFamily } from "../partition-family";
import type { LearnInput, NestedScorer, Partition, RowScores } from "../types";

type WeekLoss = { units: number[]; loss: number[] };

/** Losses per candidate on the union of their week units, NaN where a candidate has none. */
function weekLosses(oofs: WeekLoss[]): {
	units: number[];
	loss: Float64Array[];
} {
	const units = [...new Set(oofs.flatMap((o) => o.units))].sort(
		(a, b) => a - b,
	);
	const loss = oofs.map((o) => {
		const at = new Map(o.units.map((u, i) => [u, o.loss[i] as number]));
		return Float64Array.from(units, (u) => at.get(u) ?? Number.NaN);
	});
	return { units, loss };
}

/** The fixed family generated from E4's present partition, from the window's clean days. */
const familyOf = (input: LearnInput) =>
	partitionFamily(
		cleanDaysByWeekday(learnDays(input.series, input.now, input.workDays)),
	);

/**
 * Row 1 (day types, DESIGN-F2 §2): the fixed family generated from E4's present
 * partition, each member scored by its own full E4 fit (`fitWithPartition`) on
 * that fit's out-of-fold squared error of the served model per held-out ISO
 * week (`PaceFitState.oof`). NaN where a fit has no loss on a week.
 */
export function scoreDaytypes(input: LearnInput): RowScores<Partition> {
	const family = familyOf(input);
	const oofs = family.candidates.map(
		(p) => input.fitWithPartition(p).oof ?? { units: [], loss: [] },
	);
	return {
		row: "daytypes",
		candidates: family.candidates,
		presentIndex: family.presentIndex,
		preference: family.preference,
		...weekLosses(oofs),
	};
}

/**
 * Row 1's nested confirmation (DESIGN-F2 R3-2): the present partition and the
 * pending one, each scored per held-out ISO week by a full E4 fit without that
 * week (`nested`), with the family's size as m (its floor and BH count).
 */
export function scoreDaytypesNested(
	input: LearnInput,
	pending: Partition,
	nested: NestedScorer,
): RowScores<Partition> {
	const family = familyOf(input);
	const present = family.candidates[family.presentIndex] as Partition;
	return {
		row: "daytypes",
		candidates: [present, pending],
		presentIndex: 0,
		preference: [0, 1],
		...weekLosses([nested(present), nested(pending)]),
		m: family.candidates.length,
	};
}
