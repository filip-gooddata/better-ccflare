import { BUCKET_MS, type EpochMs } from "../../types";
import { buildCalendar } from "../pace/calendar";
import type { PaceSeries } from "../pace/types";

/** One complete local calendar day of the pooled series. */
export interface LearnDay {
	/** Index into the array `learnDays` returns. */
	dayIndex: number;
	/** Local midnight, epoch ms. */
	startMs: EpochMs;
	/** E4's ISO week key: the local day number of the week's Monday. */
	isoWeek: number;
	/** 0 = Monday ... 6 = Sunday. */
	weekday: number;
	/** ISO weekday (Monday = 1) at most `workDays`, as `days.ts` `dayTypeOf` decides. */
	isWorkday: boolean;
	/** Any bucket of the day censored. */
	censored: boolean;
	/** The day's bucket units; 288 buckets, 276 or 300 on a DST change. */
	curve: Float64Array;
	total: number;
	active: boolean;
	/** First bucket with demand, -1 when none. */
	firstActiveBucket: number;
}

export interface LowoFold {
	week: number;
	/** Uncensored days of this ISO week. */
	heldOut: number[];
	/** Uncensored days of every other ISO week. */
	train: number[];
}

/**
 * Complete local days of the series before now's local day, in the series time
 * zone. A day is complete when the series covers it from local midnight to the
 * next local midnight.
 */
export function learnDays(
	series: PaceSeries,
	now: EpochMs,
	workDays: number,
): LearnDay[] {
	const n = series.units.length;
	// one extra bucket shows whether the last covered day ends at the series end
	const cal = buildCalendar(series.start, n + 1, series.timeZone);
	const nowDay = buildCalendar(
		Math.floor(now / BUCKET_MS) * BUCKET_MS,
		1,
		series.timeZone,
	).days[0];
	const nowDayNo = nowDay ? nowDay.week + nowDay.wd : Number.POSITIVE_INFINITY;
	const out: LearnDay[] = [];
	for (let d = 0; d < cal.days.length - 1; d++) {
		const day = cal.days[d];
		if (!day || day.end > n) continue;
		if (cal.minute[day.first] !== 0) continue;
		if (day.week + day.wd >= nowDayNo) continue;
		const curve = series.units.slice(day.first, day.end);
		let total = 0;
		let firstActiveBucket = -1;
		let censored = false;
		for (let i = 0; i < curve.length; i++) {
			const u = curve[i] as number;
			total += u;
			if (firstActiveBucket < 0 && u > 0) firstActiveBucket = i;
			if (series.censored[day.first + i]) censored = true;
		}
		out.push({
			dayIndex: out.length,
			startMs: series.start + day.first * BUCKET_MS,
			isoWeek: day.week,
			weekday: day.wd,
			isWorkday: day.wd + 1 <= workDays,
			censored,
			curve,
			total,
			active: total > 0,
			firstActiveBucket,
		});
	}
	return out;
}

/** Leave-one-ISO-week-out folds over `learnDays` output, weeks in time order. */
export function lowoFolds(days: readonly LearnDay[]): LowoFold[] {
	const weeks: number[] = [];
	for (const d of days)
		if (weeks[weeks.length - 1] !== d.isoWeek) weeks.push(d.isoWeek);
	return weeks.map((week) => ({
		week,
		heldOut: days
			.filter((d) => d.isoWeek === week && !d.censored)
			.map((d) => d.dayIndex),
		train: days
			.filter((d) => d.isoWeek !== week && !d.censored)
			.map((d) => d.dayIndex),
	}));
}
