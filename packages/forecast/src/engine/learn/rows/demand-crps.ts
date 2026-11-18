import { recencyWeight } from "../../calibration";
import { poolFor } from "../../days";
import type { DayType, RecordedDay } from "../../model";
import type { LearnDay } from "../daily";
import { lowoFolds } from "../daily";
import type { PoolTau } from "../types";

/**
 * Shared loss of rows 2, 4 and 5: per held-out day, the CRPS of its total units
 * against the weighted mixture of training-day totals that the scenario day
 * draw would use (days.ts pool, recency weights, lookback), with the other two
 * rows at the given values. Zero-demand days are pool members, as in days.ts
 * buildDayTable; censored days are neither trained on nor scored (lowoFolds).
 */
export interface DemandSetting {
	pool: PoolTau;
	lookbackDays: number;
	halfLifeDays: number;
}

/** "lowo": other ISO weeks, both directions. "forward": earlier days outside the held-out ISO week. */
export type TrainRule = "lowo" | "forward";

/** Local day number, as daily.ts orders days (ISO week key + weekday). */
const dayNo = (d: LearnDay): number => d.isoWeek + d.weekday;

/** days.ts dayTypeOf on a learn day. */
export function learnDayType(d: LearnDay): DayType {
	if (!d.isWorkday) return "weekend";
	return d.weekday === 0 ? "monday" : "workday";
}

/**
 * Exact CRPS of the weighted empirical distribution (xs, ws) at y:
 * E|X - y| - E|X - X'| / 2, weights normalized. NaN without positive mass.
 */
export function crpsWeighted(
	xs: ArrayLike<number>,
	ws: ArrayLike<number>,
	y: number,
): number {
	const order: number[] = [];
	let mass = 0;
	for (let i = 0; i < xs.length; i++) {
		const w = ws[i] as number;
		if (w > 0) {
			order.push(i);
			mass += w;
		}
	}
	if (!(mass > 0)) return Number.NaN;
	order.sort((a, b) => (xs[a] as number) - (xs[b] as number));
	let abs = 0;
	let pair = 0;
	let wBefore = 0;
	let sBefore = 0;
	for (const i of order) {
		const x = xs[i] as number;
		const w = (ws[i] as number) / mass;
		abs += w * Math.abs(x - y);
		pair += w * (x * wBefore - sBefore);
		wBefore += w;
		sBefore += w * x;
	}
	// pair = sum over i<j (sorted) of w_i w_j (x_j - x_i) = E|X - X'| / 2
	return abs - pair;
}

/**
 * Mixture weights over `train` (aligned to it, summing to 1, or all 0 when no
 * training day lies within the lookback) for the held-out day.
 */
export function mixtureWeights(
	held: LearnDay,
	train: readonly LearnDay[],
	s: DemandSetting,
): Float64Array {
	const out = new Float64Array(train.length);
	const lookback = Math.max(0, Math.floor(s.lookbackDays));
	const type = learnDayType(held);
	const recorded: RecordedDay[] = [];
	const at = new Map<RecordedDay, number>();
	train.forEach((d, i) => {
		const dist = Math.abs(dayNo(d) - dayNo(held));
		if (dist > lookback) return;
		const r: RecordedDay = {
			key: String(dayNo(d)),
			start: d.startMs,
			type: learnDayType(d),
			weight: recencyWeight(dist, s.halfLifeDays),
			units: d.curve,
			fable: new Float64Array(0),
			total: d.total,
			fableTotal: 0,
		};
		recorded.push(r);
		at.set(r, i);
	});
	if (recorded.length === 0) return out;
	const add = (pool: RecordedDay[], share: number) => {
		let mass = 0;
		for (const r of pool) mass += r.weight;
		if (!(mass > 0) || share === 0) return;
		for (const r of pool) {
			const i = at.get(r) as number;
			out[i] = (out[i] as number) + (share * r.weight) / mass;
		}
	};
	if (s.pool === "hard3") {
		const table = {
			days: recorded,
			today: { key: "", start: held.startMs, type },
		};
		let pool = poolFor(table, type);
		// scenarios.ts: an empty day-type pool draws from all recorded days
		if (pool.length === 0) pool = recorded;
		add(pool, 1);
		return out;
	}
	const own = recorded.filter((r) => r.type === type);
	const n = own.length;
	const tau = s.pool;
	const w = n === 0 ? 0 : tau === 0 ? 1 : n / (n + tau);
	add(own, w);
	add(recorded, 1 - w);
	return out;
}

/** CRPS of the held-out day's total under the setting's mixture; NaN when unscored. */
export function demandDayLoss(
	held: LearnDay,
	train: readonly LearnDay[],
	s: DemandSetting,
): number {
	const w = mixtureWeights(held, train, s);
	const xs = train.map((d) => d.total);
	return crpsWeighted(xs, w, held.total);
}

/**
 * Loss of every setting on every uncensored held-out day (units = dayIndex in
 * fold order). Training per `rule`; NaN where a setting has no training day.
 */
export function demandLosses(
	days: readonly LearnDay[],
	settings: readonly DemandSetting[],
	rule: TrainRule,
): { units: number[]; loss: Float64Array[] } {
	const units: number[] = [];
	const trains: LearnDay[][] = [];
	for (const fold of lowoFolds(days)) {
		const train = fold.train.map((i) => days[i] as LearnDay);
		for (const h of fold.heldOut) {
			const held = days[h] as LearnDay;
			units.push(h);
			trains.push(
				rule === "lowo" ? train : train.filter((d) => dayNo(d) < dayNo(held)),
			);
		}
	}
	const loss = settings.map((s) => {
		const l = new Float64Array(units.length);
		units.forEach((h, u) => {
			l[u] = demandDayLoss(days[h] as LearnDay, trains[u] as LearnDay[], s);
		});
		return l;
	});
	return { units, loss };
}

/**
 * Preference rank per grid index: by distance from the present index; ties go
 * to the smaller index, or to the larger one when `tieToLarger`.
 */
export function gridPreference(
	size: number,
	present: number,
	tieToLarger: boolean,
): number[] {
	const idx = [...Array(size).keys()];
	idx.sort((a, b) => {
		const d = Math.abs(a - present) - Math.abs(b - present);
		if (d !== 0) return d;
		return tieToLarger ? b - a : a - b;
	});
	const rank = new Array<number>(size);
	idx.forEach((i, r) => {
		rank[i] = r;
	});
	return rank;
}
