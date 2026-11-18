import { recencyWeight } from "../../calibration";
import { demandLookbackDays, poolFor } from "../../days";
import type { DayType, RecordedDay } from "../../model";
import { type LearnDay, learnDays, lowoFolds } from "../daily";
import type { LearnInput } from "../types";

/** A held-out day and the scenario pool its date would draw from, built from its fold's training days. */
export interface HeldOutPool {
	day: LearnDay;
	/** Recorded days as `scenarios.ts` draws them: weight = recency weight on the distance from the held-out day. */
	pool: RecordedDay[];
}

export interface ScenarioPools {
	days: LearnDay[];
	held: HeldOutPool[];
}

/** Local day number (E4's week key plus weekday), so distances count calendar days. */
const dayNo = (d: LearnDay): number => d.isoWeek + d.weekday;

/** `days.ts` `dayTypeOf` on a learn day: ISO weekday = weekday + 1. */
function typeOf(d: LearnDay, workDays: number): DayType {
	if (d.weekday + 1 > workDays) return "weekend";
	return d.weekday === 0 ? "monday" : "workday";
}

/**
 * Scenario pools of rows 18 and 20 at the present values of the other rows: for each
 * uncensored held-out day, the training days of its leave-one-ISO-week-out fold inside
 * the lookback (distance at most `historyLookbackDays`, capped at 84), weighted
 * 0.5^(distance / historyHalfLifeDays) as `days.ts` weights by age, pooled by the
 * held-out day's type through `poolFor` (monday and workday together below 3 days),
 * and every training day when that pool is empty (the `scenarios.ts` fallback).
 */
export function scenarioPools(input: LearnInput): ScenarioPools {
	const days = learnDays(input.series, input.now, input.workDays);
	const lookback = Math.max(
		0,
		Math.floor(demandLookbackDays(input.historyLookbackDays)),
	);
	const held: HeldOutPool[] = [];
	for (const fold of lowoFolds(days)) {
		for (const h of fold.heldOut) {
			const day = days[h] as LearnDay;
			const train: RecordedDay[] = [];
			for (const t of fold.train) {
				const d = days[t] as LearnDay;
				const dist = Math.abs(dayNo(d) - dayNo(day));
				if (dist > lookback) continue;
				train.push({
					key: String(dayNo(d)),
					start: d.startMs,
					type: typeOf(d, input.workDays),
					weight: recencyWeight(dist, input.historyHalfLifeDays),
					units: d.curve,
					fable: new Float64Array(d.curve.length),
					total: d.total,
					fableTotal: 0,
				});
			}
			const today = {
				key: String(dayNo(day)),
				start: day.startMs,
				type: typeOf(day, input.workDays),
			};
			let pool = poolFor({ days: train, today }, today.type);
			if (pool.length === 0) pool = train;
			held.push({ day, pool });
		}
	}
	held.sort((a, b) => a.day.dayIndex - b.day.dayIndex);
	return { days, held };
}

/** Rank per grid index by distance from the present index; ties go to the smaller index. */
export function distancePreference(n: number, present: number): number[] {
	const order = Array.from({ length: n }, (_, i) => i).sort(
		(a, b) => Math.abs(a - present) - Math.abs(b - present) || a - b,
	);
	const rank = new Array<number>(n).fill(0);
	order.forEach((i, r) => {
		rank[i] = r;
	});
	return rank;
}
