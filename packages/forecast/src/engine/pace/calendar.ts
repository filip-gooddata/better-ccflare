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

const WEEKDAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PRESENT_NAMES: Record<string, PaceDayType> = {
	"0": "monday",
	"1,2,3,4": "workday",
	"5,6": "weekend",
};

/** Relabels a weekday partition's groups 0..k-1 by first occurrence Monday..Sunday. */
export function normalizeGroup(group: ArrayLike<number>): number[] {
	const ids = new Map<number, number>();
	return Array.from(group, (g) => {
		let id = ids.get(g);
		if (id === undefined) {
			id = ids.size;
			ids.set(g, id);
		}
		return id;
	});
}

/** Number of groups of a weekday partition whose ids are 0..k-1. */
export const groupCount = (group: ArrayLike<number>): number =>
	Math.max(...Array.from(group)) + 1;

/** True when `group` splits the week as E4's present calendar does, whatever its labels. */
export function isPresentGroup(group: ArrayLike<number>): boolean {
	for (let i = 0; i < 7; i++)
		for (let j = i + 1; j < 7; j++)
			if ((group[i] === group[j]) !== (PRESENT_GROUP[i] === PRESENT_GROUP[j]))
				return false;
	return true;
}

/**
 * Names of the groups of a weekday partition, by group id. A group equal to one
 * of E4's present groups keeps its present name; any other is named by its
 * weekdays: "all", a cyclic block "tue-sun" / "sat-mon" / "wed", else blocks joined by "+".
 */
export function groupNames(group: ArrayLike<number>): string[] {
	const k = groupCount(group);
	return Array.from({ length: k }, (_, g) => {
		const days: number[] = [];
		for (let w = 0; w < 7; w++) if (group[w] === g) days.push(w);
		const present = PRESENT_NAMES[days.join(",")];
		if (present) return present;
		if (days.length === 7) return "all";
		const blocks: number[][] = [];
		for (const w of days) {
			const last = blocks[blocks.length - 1];
			if (last && last[last.length - 1] === w - 1) last.push(w);
			else blocks.push([w]);
		}
		const first = blocks[0] as number[];
		const tail = blocks[blocks.length - 1] as number[];
		if (blocks.length > 1 && first[0] === 0 && tail[tail.length - 1] === 6) {
			blocks.pop();
			blocks[0] = [...tail, ...first];
		}
		return blocks
			.map((b) =>
				b.length === 1
					? (WEEKDAY[b[0] as number] as string)
					: `${WEEKDAY[b[0] as number]}-${WEEKDAY[b[b.length - 1] as number]}`,
			)
			.join("+");
	});
}

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
	group: ArrayLike<number> = PRESENT_GROUP,
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
		dtype[i] = group[w] as number;
		if (dayNo !== lastDay) {
			days.push({ first: i, end: i + 1, wd: w, week: dayNo - w });
			lastDay = dayNo;
		} else (days[days.length - 1] as PaceDay).end = i + 1;
		dayIdx[i] = days.length - 1;
	}
	return { n, minute, wd, dtype, dayIdx, days };
}
