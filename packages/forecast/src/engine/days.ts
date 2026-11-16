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
/** Work start = median over this many most recent recorded work days with demand: two working weeks, recent enough to follow a changed routine. */
export const WORK_START_RECENT_DAYS = 10;
/** Work start = the minute by which this percent of a work day's demand is used, unless settings say otherwise (design amendment A3). */
export const DEFAULT_WORK_START_SHARE_PCT = 5;
/** Relative slack of the work-start share test, so float rounding in the running sum cannot move it a bucket later. */
const SHARE_SLACK = 1e-9;

export function dayTypeOf(dayStart: EpochMs, pace: PaceContext): DayType {
	const weekday = localParts(dayStart, pace.timeZone).isoWeekday;
	if (weekday > pace.workDays) return "weekend";
	return weekday === 1 ? "monday" : "workday";
}

/**
 * Complete local days inside [historyFrom, today 00:00) and the lookback, from the
 * pooled history, plus today's key and day type. Every such calendar day is a recorded day:
 * a missing bucket is zero demand (ForecastInput.history), so a day with no
 * buckets at all is recorded with total 0 (a weekend without work stays in the
 * weekend pool).
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

	for (const b of input.history) {
		// today is incomplete and never in a pool
		if (b.start >= now || b.start < input.historyFrom || b.start >= todayStart)
			continue;
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

	const today: TodaySoFar = {
		key: localDayKey(todayStart, tz),
		start: todayStart,
		type: dayTypeOf(todayStart, pace),
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
 * Median, over the most recent WORK_START_RECENT_DAYS recorded work days with
 * demand, of the local clock minute by which `sharePct` percent of that day's
 * demand (units) has been used: the start of the first bucket at which the
 * day's cumulative units reach the share. The share keeps a stray overnight
 * request from setting the work start (design amendment A3). Null when there
 * is no such day. Takes the time zone because DayTable carries none and on a
 * DST day the bucket index is not the clock.
 */
export function workStartMinute(
	table: DayTable,
	timeZone: string,
	sharePct: number = DEFAULT_WORK_START_SHARE_PCT,
): number | null {
	const minutes: number[] = [];
	for (
		let i = table.days.length - 1;
		i >= 0 && minutes.length < WORK_START_RECENT_DAYS;
		i--
	) {
		const d = table.days[i] as RecordedDay;
		if (d.type === "weekend") continue;
		const bucket = shareReachedAt(d.units, sharePct);
		if (bucket !== null)
			minutes.push(
				localParts(d.start + bucket * BUCKET_MS, timeZone).minuteOfDay,
			);
	}
	return minutes.length === 0 ? null : Math.round(median(minutes));
}

/** Index of the first bucket at which the cumulative units reach `sharePct` percent of the day's total; null without demand. */
function shareReachedAt(units: Float64Array, sharePct: number): number | null {
	let total = 0;
	for (const u of units) total += u;
	if (!(total > 0)) return null;
	const target = (total * sharePct) / 100 - total * SHARE_SLACK;
	let sum = 0;
	for (let b = 0; b < units.length; b++) {
		const u = units[b] as number;
		sum += u;
		if (u > 0 && sum >= target) return b;
	}
	return null;
}
