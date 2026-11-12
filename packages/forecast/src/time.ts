/**
 * Local calendar arithmetic in an IANA time zone, built on Intl.DateTimeFormat
 * alone. Every function throws a RangeError for an unknown zone name.
 */
import type { EpochMs } from "./types";

const DAY_MS = 86_400_000;

export interface LocalParts {
	year: number;
	month: number;
	day: number;
	/** 1 = Monday … 7 = Sunday. */
	isoWeekday: number;
	minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string, at: EpochMs) {
	let fmt = formatters.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(timeZone, fmt);
	}
	const p: Record<string, number> = {};
	for (const part of fmt.formatToParts(at)) {
		if (part.type !== "literal") p[part.type] = Number(part.value);
	}
	return {
		year: p.year,
		month: p.month,
		day: p.day,
		hour: p.hour === 24 ? 0 : p.hour,
		minute: p.minute,
		second: p.second,
	};
}

/** The wall-clock time at `at`, read as if it were UTC, to the second. */
function wallAsUtc(timeZone: string, at: EpochMs): number {
	const w = wallClock(timeZone, at);
	return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Offset of timeZone from UTC at `at`, in ms (positive east of UTC). */
function offsetMs(timeZone: string, at: EpochMs): number {
	return wallAsUtc(timeZone, at) - Math.floor(at / 1000) * 1000;
}

/** The local calendar day containing `at`, named by its UTC midnight. */
function localDayUtc(timeZone: string, at: EpochMs): number {
	const w = wallClock(timeZone, at);
	return Date.UTC(w.year, w.month - 1, w.day);
}

/**
 * The first instant whose wall-clock reading is `wall` (a wall time read as
 * UTC), assuming at most one offset change within a day of it. A wall time
 * that occurs twice resolves to the earlier instant; one skipped by a forward
 * change resolves to the instant the gap's length later on the wall clock.
 */
function instantOfWall(timeZone: string, wall: number): EpochMs {
	const before = wall - offsetMs(timeZone, wall - DAY_MS);
	const after = wall - offsetMs(timeZone, wall + DAY_MS);
	for (const c of before <= after ? [before, after] : [after, before]) {
		if (wallAsUtc(timeZone, c) === wall) return c;
	}
	return before;
}

/**
 * The first instant of the local day named by dayUtc: its local midnight or,
 * where a change skips midnight, the first instant with that local date.
 */
function startOfDayUtc(timeZone: string, dayUtc: number): EpochMs {
	const a = dayUtc - offsetMs(timeZone, dayUtc - DAY_MS);
	const b = dayUtc - offsetMs(timeZone, dayUtc + DAY_MS);
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (const c of [lo, hi]) {
		if (wallAsUtc(timeZone, c) === dayUtc) return c;
	}
	let early = lo;
	let late = hi;
	while (late - early > 1000) {
		const mid = early + Math.floor((late - early) / 2000) * 1000;
		if (localDayUtc(timeZone, mid) >= dayUtc) late = mid;
		else early = mid;
	}
	return late;
}

export function localParts(at: EpochMs, timeZone: string): LocalParts {
	const w = wallClock(timeZone, at);
	return {
		year: w.year,
		month: w.month,
		day: w.day,
		isoWeekday: new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() || 7,
		minuteOfDay: w.hour * 60 + w.minute,
	};
}

/** Local midnight of the day containing `at` (the first instant of that day if a change skips midnight). */
export function localDayStart(at: EpochMs, timeZone: string): EpochMs {
	return startOfDayUtc(timeZone, localDayUtc(timeZone, at));
}

/** Start of the local day n days after the day containing dayStart; n may be negative. */
export function addLocalDays(
	dayStart: EpochMs,
	n: number,
	timeZone: string,
): EpochMs {
	return startOfDayUtc(timeZone, localDayUtc(timeZone, dayStart) + n * DAY_MS);
}

/** Monday 00:00 local of the week containing `at`. */
export function localWeekStart(at: EpochMs, timeZone: string): EpochMs {
	const day = localDayUtc(timeZone, at);
	const isoWeekday = new Date(day).getUTCDay() || 7;
	return startOfDayUtc(timeZone, day - (isoWeekday - 1) * DAY_MS);
}

/** "YYYY-MM-DD" of the local day containing `at`. */
export function localDayKey(at: EpochMs, timeZone: string): string {
	const w = wallClock(timeZone, at);
	const mm = String(w.month).padStart(2, "0");
	const dd = String(w.day).padStart(2, "0");
	return `${String(w.year).padStart(4, "0")}-${mm}-${dd}`;
}

/**
 * The instant the wall clock reads minuteOfDay on the local day containing
 * dayStart. minuteOfDay must be an integer in 0..1439 (RangeError otherwise).
 * A repeated minute (clocks set back) resolves to its earlier instant, which
 * may already be past when the later one is not; a skipped minute moves
 * forward by the length of the gap. Assumes at most one offset change within
 * a day of the minute, true of every zone in use today. Identify buckets by
 * epoch ms: two instants can share one local minute.
 */
export function atLocalMinute(
	dayStart: EpochMs,
	minuteOfDay: number,
	timeZone: string,
): EpochMs {
	if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439)
		throw new RangeError(`minuteOfDay out of range: ${minuteOfDay}`);
	return instantOfWall(
		timeZone,
		localDayUtc(timeZone, dayStart) + minuteOfDay * 60_000,
	);
}
