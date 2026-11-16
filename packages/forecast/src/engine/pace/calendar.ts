import { BUCKET_MS, type EpochMs } from "../../types";

/** Buckets per local day as the sandbox counts them (lags shift by whole 288-bucket days). */
export const DAY_BUCKETS = 288;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Day types the served model segments by: 0 workday (Tue-Fri), 1 monday, 2 weekend. */
export const DAY_TYPES = ["workday", "monday", "weekend"] as const;
export type PaceDayType = (typeof DAY_TYPES)[number];
/** Weekday index 0 = Monday ... 6 = Sunday to day type index. */
export const PRESENT_GROUP = [1, 0, 0, 0, 0, 2, 2] as const;

export interface PaceDay {
	/** First bucket index and end (exclusive). */
	first: number;
	end: number;
	/** 0 = Monday. */
	wd: number;
	/** Local day number of the ISO week's Monday. */
	week: number;
}

/** Local calendar of buckets [start, start + n * BUCKET_MS). */
export interface PaceCalendar {
	n: number;
	minute: Int16Array;
	wd: Uint8Array;
	dtype: Uint8Array;
	dayIdx: Int32Array;
	days: PaceDay[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();

/** Offset (local minus UTC, ms) at the start of the UTC hour holding t. */
function offsetAt(timeZone: string, t: EpochMs): number {
	const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
	const key = `${timeZone}|${hour}`;
	const hit = offsets.get(key);
	if (hit !== undefined) return hit;
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
		});
		formatters.set(timeZone, fmt);
	}
	const p: Record<string, number> = {};
	for (const x of fmt.formatToParts(hour))
		if (x.type !== "literal") p[x.type] = Number(x.value);
	const local = Date.UTC(
		p.year as number,
		(p.month as number) - 1,
		p.day as number,
		p.hour as number,
		p.minute as number,
	);
	if (offsets.size > 100_000) offsets.clear();
	offsets.set(key, local - hour);
	return local - hour;
}

export function buildCalendar(
	start: EpochMs,
	n: number,
	timeZone: string,
): PaceCalendar {
	const minute = new Int16Array(n);
	const wd = new Uint8Array(n);
	const dtype = new Uint8Array(n);
	const dayIdx = new Int32Array(n);
	const days: PaceDay[] = [];
	let lastDay = Number.NaN;
	for (let i = 0; i < n; i++) {
		const t = start + i * BUCKET_MS;
		const local = t + offsetAt(timeZone, t);
		const dayNo = Math.floor(local / DAY_MS);
		minute[i] = Math.floor((local - dayNo * DAY_MS) / 60_000);
		// 1970-01-01 was a Thursday (index 3 with Monday = 0)
		const w = (((dayNo + 3) % 7) + 7) % 7;
		wd[i] = w;
		dtype[i] = PRESENT_GROUP[w] as number;
		if (dayNo !== lastDay) {
			days.push({ first: i, end: i + 1, wd: w, week: dayNo - w });
			lastDay = dayNo;
		} else (days[days.length - 1] as PaceDay).end = i + 1;
		dayIdx[i] = days.length - 1;
	}
	return { n, minute, wd, dtype, dayIdx, days };
}
