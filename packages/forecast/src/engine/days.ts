/**
 * Day table and day types (design 4.1) and the history half of availability
 * (4.2): the pooled demand history cut into recorded local days, each with a
 * recency weight (recency-weighted profile by day type).
 */
import { median } from "simple-statistics";
import { addLocalDays, localDayKey, localDayStart, localParts } from "../time";
import type { EpochMs, ForecastInput, PaceContext } from "../types";
import { BUCKET_MS } from "../types";
import { recencyWeight } from "./calibration";
import type { DayTable, DayType, RecordedDay, TodaySoFar } from "./model";

/** Fewer recorded days than this in the lookback: no forecast (design 4.2). */
export const MIN_RECORDED_DAYS = 5;
/** A day type's pool needs this many days; below it monday and workday pool together (design 4.1). */
export const MIN_POOL_DAYS = 3;
/** "The last hour" whose mean rate per bucket the blend starts from (design 4.4). */
export const RECENT_WINDOW_MS = 60 * 60_000;
/** Work start = median over this many most recent recorded work days with demand: two working weeks, recent enough to follow a changed routine. */
export const WORK_START_RECENT_DAYS = 10;

const BUCKETS_PER_NORMAL_DAY = 288;

export function dayTypeOf(dayStart: EpochMs, pace: PaceContext): DayType {
	const weekday = localParts(dayStart, pace.timeZone).isoWeekday;
	if (weekday > pace.workDays) return "weekend";
	return weekday === 1 ? "monday" : "workday";
}

/**
 * Complete local days inside [historyFrom, today 00:00) and the lookback, from the
 * pooled history (a missing bucket is zero demand), plus today so far.
 */
export function buildDayTable(input: ForecastInput): DayTable {
	const { now, pace, settings } = input;
	const tz = pace.timeZone;
	const todayStart = localDayStart(now, tz);
	const lookback = Math.max(0, Math.floor(settings.historyLookbackDays));

	const days: RecordedDay[] = [];
	const ends: EpochMs[] = [];
	for (let back = lookback; back >= 1; back--) {
		const start = addLocalDays(todayStart, -back, tz);
		if (start < input.historyFrom) continue;
		const end = addLocalDays(start, 1, tz);
		const length = Math.round((end - start) / BUCKET_MS);
		days.push({
			key: localDayKey(start, tz),
			start,
			type: dayTypeOf(start, pace),
			weight: recencyWeight(back, settings.historyHalfLifeDays),
			units: new Float64Array(length),
			fable: new Float64Array(length),
			total: 0,
			fableTotal: 0,
		});
		ends.push(end);
	}

	let unitsSoFar = 0;
	let recent = 0;
	let recentFable = 0;
	const recentFrom = now - RECENT_WINDOW_MS;
	for (const b of input.history) {
		if (b.start >= now || b.start < input.historyFrom) continue;
		if (b.start >= recentFrom) {
			recent += b.units;
			recentFable += b.fableUnits;
		}
		if (b.start >= todayStart) {
			unitsSoFar += b.units;
			continue;
		}
		let lo = 0;
		let hi = days.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((ends[mid] as EpochMs) <= b.start) lo = mid + 1;
			else hi = mid;
		}
		const d = days[lo];
		if (!d || b.start < d.start) continue;
		const i = Math.floor((b.start - d.start) / BUCKET_MS);
		d.units[i] = (d.units[i] as number) + b.units;
		d.fable[i] = (d.fable[i] as number) + b.fableUnits;
	}
	for (const d of days) {
		let total = 0;
		let fableTotal = 0;
		for (let i = 0; i < d.units.length; i++) {
			total += d.units[i] as number;
			fableTotal += d.fable[i] as number;
		}
		d.total = total;
		d.fableTotal = fableTotal;
	}

	const perBucket = RECENT_WINDOW_MS / BUCKET_MS;
	const today: TodaySoFar = {
		key: localDayKey(todayStart, tz),
		start: todayStart,
		type: dayTypeOf(todayStart, pace),
		unitsSoFar,
		recentRate: recent / perBucket,
		recentFableRate: recentFable / perBucket,
	};
	return { days, today };
}

/** Recorded days of a type; below MIN_POOL_DAYS, monday and workday pool together (weekend stays alone). */
export function poolFor(table: DayTable, type: DayType): RecordedDay[] {
	const own = table.days.filter((d) => d.type === type);
	if (own.length >= MIN_POOL_DAYS || type === "weekend") return own;
	return table.days.filter((d) => d.type !== "weekend");
}

/** The history half of design 4.2. */
export function historyAvailable(table: DayTable): boolean {
	return (
		table.days.length >= MIN_RECORDED_DAYS &&
		poolFor(table, table.today.type).length >= MIN_POOL_DAYS
	);
}

/**
 * Median first minute with demand over the most recent WORK_START_RECENT_DAYS
 * recorded work days with demand; null when there is none. Days whose length is
 * not 24 hours (a DST change) are skipped: their bucket index is not the clock.
 */
export function workStartMinute(table: DayTable): number | null {
	const firsts: number[] = [];
	for (
		let i = table.days.length - 1;
		i >= 0 && firsts.length < WORK_START_RECENT_DAYS;
		i--
	) {
		const d = table.days[i] as RecordedDay;
		if (
			d.type === "weekend" ||
			d.total <= 0 ||
			d.units.length !== BUCKETS_PER_NORMAL_DAY
		)
			continue;
		const first = d.units.findIndex((u) => u > 0);
		if (first >= 0) firsts.push((first * BUCKET_MS) / 60_000);
	}
	return firsts.length === 0 ? null : Math.round(median(firsts));
}
