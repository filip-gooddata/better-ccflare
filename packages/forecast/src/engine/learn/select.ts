import { floorOf, meanSd, Q } from "../pace/fit";
import { bh, signFlipP } from "../pace/stats";
import type { RowChoice, RowScores } from "./types";

export type { RowChoice, RowScores } from "./types";

const hasFinite = (l: Float64Array) => l.some((x) => Number.isFinite(x));

/**
 * The E4 selection method for one row (DESIGN-F2 section 1). Every candidate
 * with a finite loss somewhere is searched on the units all of them scored; a
 * candidate with none is dropped but still counts in m. The row serves a value
 * other than its present one only when that value beats the present out of
 * sample by more than one standard error, on at least floorOf(m) units, and
 * survives BH over every non-present candidate.
 */
export function selectRow<V>(s: RowScores<V>): RowChoice<V> {
	const m = s.candidates.length;
	const floor = floorOf(m);
	const P = s.presentIndex;
	const present = s.candidates[P] as V;
	const lossOf = (c: number) => s.loss[c] as Float64Array;

	const kept = s.candidates
		.map((_, c) => c)
		.filter((c) => hasFinite(lossOf(c)));
	const units = kept.includes(P)
		? s.units
				.map((_, u) => u)
				.filter((u) => kept.every((c) => Number.isFinite(lossOf(c)[u])))
		: [];
	const n = units.length;

	const off = (
		reason: RowChoice<V>["reason"],
		fields: Partial<RowChoice<V>> = {},
	): RowChoice<V> => ({
		row: s.row,
		m,
		floor,
		units: n,
		present,
		chosen: present,
		runnerUp: null,
		served: present,
		presentLoss: Number.NaN,
		chosenLoss: Number.NaN,
		gain: 0,
		se: 0,
		p: 1,
		on: false,
		reason,
		...fields,
	});
	if (n === 0) return off("no-units");

	const vec = (c: number) => units.map((u) => lossOf(c)[u] as number);
	const diff = (a: number, b: number) => {
		const la = lossOf(a);
		const lb = lossOf(b);
		return units.map((u) => (la[u] as number) - (lb[u] as number));
	};
	const mean = new Map(kept.map((c) => [c, meanSd(vec(c)).mu]));
	const meanOf = (c: number) => mean.get(c) as number;
	const byMean = (a: number, b: number) => meanOf(a) - meanOf(b) || a - b;

	const best = [...kept].sort(byMean)[0] as number;
	const inSet = kept.filter(
		(c) => meanOf(c) - meanOf(best) <= meanSd(diff(c, best)).sd / Math.sqrt(n),
	);
	const pref = (c: number) => s.preference[c] as number;
	const chosenIdx = inSet.includes(P)
		? P
		: ([...inSet].sort(
				(a, b) => pref(a) - pref(b) || byMean(a, b),
			)[0] as number);
	const runnerIdx = kept.filter((c) => c !== chosenIdx).sort(byMean)[0];

	const d = diff(P, chosenIdx);
	const { mu: gain, sd } = meanSd(d);
	const se = chosenIdx === P ? 0 : sd / Math.sqrt(n);

	const others = s.candidates.map((_, c) => c).filter((c) => c !== P);
	const ps = others.map((c) => (kept.includes(c) ? signFlipP(diff(P, c)) : 1));
	const rejected = bh(ps, Q);
	const chosenAt = others.indexOf(chosenIdx);
	const p = chosenAt < 0 ? 1 : (ps[chosenAt] as number);

	const chosen = s.candidates[chosenIdx] as V;
	const fields: Partial<RowChoice<V>> = {
		chosen,
		runnerUp: runnerIdx === undefined ? null : (s.candidates[runnerIdx] as V),
		presentLoss: meanOf(P),
		chosenLoss: meanOf(chosenIdx),
		gain: chosenIdx === P ? 0 : gain,
		se,
		p,
	};
	if (chosenIdx === P) return off("present-best", fields);
	if (n < floor) return off("below-floor", fields);
	if (!(gain > se)) return off("gain-le-se", fields);
	if (!rejected.has(chosenAt)) return off("bh", fields);
	return { ...off("on", fields), served: chosen, on: true };
}
