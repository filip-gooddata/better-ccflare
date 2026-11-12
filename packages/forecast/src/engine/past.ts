/**
 * Facts from the recorded usage readings (endpoint spec sections 3, 5, 6): the
 * `past` series of pooled quota left and the stops that already happened.
 */
import { localDayStart, localWeekStart } from "../time";
import type {
	AccountLimits,
	EpochMs,
	Interval,
	LimitReading,
	LimitWindow,
	Series,
} from "../types";
import type { EngineContext } from "./model";

/** `day` = pooled 5-hour quota left, `week` = pooled weekly quota left. */
export type Quantity = "day" | "week";

/** week.past keeps at most one entry per this span, besides jumps (spec section 6). */
const WEEK_PAST_SPACING_MS = 30 * 60_000;

const WINDOWS: Record<Quantity, LimitWindow[]> = {
	day: ["five_hour", "seven_day"],
	week: ["seven_day"],
};

interface Limit {
	usedPct: number;
	resetsAt: EpochMs | null;
}

/**
 * Whether a window's reset has happened at `t`. `before` reads the instant just
 * before `t`, so a reset at exactly `t` has not happened yet.
 */
function resetPassed(limit: Limit, t: EpochMs, before: boolean): boolean {
	if (limit.resetsAt === null) return false;
	return before ? limit.resetsAt < t : limit.resetsAt <= t;
}

/** Used up with its reset still ahead. */
function full(limit: Limit | undefined, t: EpochMs, before = false): boolean {
	return (
		limit !== undefined &&
		limit.usedPct >= 100 &&
		limit.resetsAt !== null &&
		!resetPassed(limit, t, before)
	);
}

function clampPct(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/**
 * One account's share of the pooled quota left (spec section 3). Day: no open
 * window counts 100, a used-up weekly limit counts 0. Week: 100 minus weekly use.
 */
export function accountLeft(
	quantity: Quantity,
	fiveHour: Limit | undefined,
	weekly: Limit | undefined,
	t: EpochMs,
	before = false,
): number {
	if (quantity === "week") {
		if (weekly === undefined || resetPassed(weekly, t, before)) return 100;
		return clampPct(100 - weekly.usedPct);
	}
	if (full(weekly, t, before)) return 0;
	if (
		fiveHour === undefined ||
		fiveHour.resetsAt === null ||
		resetPassed(fiveHour, t, before)
	)
		return 100;
	return clampPct(100 - fiveHour.usedPct);
}

/** Out by its usage limits (the refusal cooldown is not in the readings). */
function limitsOut(
	quantity: Quantity,
	fiveHour: Limit | undefined,
	weekly: Limit | undefined,
	t: EpochMs,
	before = false,
): boolean {
	if (quantity === "week") return full(weekly, t, before);
	return full(fiveHour, t, before) || full(weekly, t, before);
}

/** Pooled quota left of the counted accounts as last read. */
export function pooledLeftNow(
	accounts: AccountLimits[],
	quantity: Quantity,
	now: EpochMs,
): number {
	let sum = 0;
	for (const a of accounts)
		sum += accountLeft(quantity, a.fiveHour, a.weekly, now);
	return sum;
}

/**
 * When the account comes back, if it is out now (spec section 5): the latest of
 * its running reasons, because all of them must end. Null when it is not out.
 * The day quantity also counts a running refusal cooldown; the week only the weekly limit.
 */
export function comesBackAt(
	account: AccountLimits,
	quantity: Quantity,
	now: EpochMs,
): EpochMs | null {
	let back: EpochMs | null = null;
	const extend = (at: EpochMs | null) => {
		if (at !== null && (back === null || at > back)) back = at;
	};
	if (full(account.weekly, now)) extend(account.weekly.resetsAt);
	if (quantity === "day") {
		if (full(account.fiveHour, now)) extend(account.fiveHour.resetsAt);
		if (account.blockedUntil !== null && account.blockedUntil > now)
			extend(account.blockedUntil);
	}
	return back;
}

interface Snapshot {
	left: number;
	out: boolean[];
}

interface ReplayEvent {
	t: EpochMs;
	/** State just before t (readings before t, resets before t). */
	before: Snapshot;
	/** State at t (readings up to t, resets up to t). */
	after: Snapshot;
	/** A window reset at t: a change here is a jump. */
	reset: boolean;
}

/**
 * Replays the counted accounts' readings from `from` to now. Events are reading
 * times and reset times, so a reset shows even when no reading follows it.
 * Starts at the first moment every counted account has a reading of every
 * window the quantity needs; null when that never happens.
 */
function replay(
	ctx: EngineContext,
	quantity: Quantity,
	from: EpochMs,
): ReplayEvent[] | null {
	const ids = ctx.accounts.map((a) => a.accountId);
	if (ids.length === 0) return null;
	const windows = WINDOWS[quantity];
	const readings = ctx.input.readings
		.filter(
			(r) =>
				r.at <= ctx.now &&
				ids.includes(r.accountId) &&
				windows.includes(r.window),
		)
		.sort((a, b) => a.at - b.at);
	const firstSeen = new Map<string, EpochMs>();
	for (const r of readings) {
		const key = `${r.accountId}|${r.window}`;
		if (!firstSeen.has(key)) firstSeen.set(key, r.at);
	}
	if (firstSeen.size < ids.length * windows.length) return null;
	const start = Math.max(from, ...firstSeen.values());
	const times = new Set<EpochMs>([start]);
	const resets = new Set<EpochMs>();
	for (const r of readings) {
		if (r.at > start) times.add(r.at);
		if (r.resetsAt !== null && r.resetsAt > start && r.resetsAt <= ctx.now) {
			times.add(r.resetsAt);
			resets.add(r.resetsAt);
		}
	}
	const state = new Map<string, LimitReading>();
	const snapshot = (t: EpochMs, before: boolean): Snapshot => {
		let left = 0;
		const out: boolean[] = [];
		for (const id of ids) {
			const five = state.get(`${id}|five_hour`);
			const weekly = state.get(`${id}|seven_day`);
			left += accountLeft(quantity, five, weekly, t, before);
			out.push(limitsOut(quantity, five, weekly, t, before));
		}
		return { left, out };
	};
	const events: ReplayEvent[] = [];
	let next = 0;
	for (const t of [...times].sort((a, b) => a - b)) {
		while (next < readings.length && readings[next].at < t) {
			const r = readings[next++];
			state.set(`${r.accountId}|${r.window}`, r);
		}
		const before = snapshot(t, true);
		while (next < readings.length && readings[next].at === t) {
			const r = readings[next++];
			state.set(`${r.accountId}|${r.window}`, r);
		}
		events.push({ t, before, after: snapshot(t, false), reset: resets.has(t) });
	}
	return events;
}

/** Local midnight (day) or Monday 00:00 local (week) of now. */
export function pastFrom(ctx: EngineContext, quantity: Quantity): EpochMs {
	return quantity === "day"
		? localDayStart(ctx.now, ctx.timeZone)
		: localWeekStart(ctx.now, ctx.timeZone);
}

interface Entry {
	t: EpochMs;
	v: number;
	jump: boolean;
}

/**
 * `day.past` / `week.past` (spec section 6): pooled quota left from the block's
 * start to now, one entry per change in the readings, a reset as two entries.
 * Before a change that follows a flat stretch, the last reading of the stretch
 * is kept too, so the line stays flat until the readings moved instead of
 * sloping across the whole stretch. The last entry is now, from the accounts as
 * last read (where the projection starts). The week keeps at most one entry per
 * WEEK_PAST_SPACING_MS besides jumps and its first and last entry.
 */
export function pastSeries(ctx: EngineContext, quantity: Quantity): Series {
	const nowValue = pooledLeftNow(ctx.accounts, quantity, ctx.now);
	const events = replay(ctx, quantity, pastFrom(ctx, quantity));
	if (events === null) return { times: [ctx.now], values: [nowValue] };
	const entries: Entry[] = [
		{ t: events[0].t, v: events[0].after.left, jump: false },
	];
	const last = () => entries[entries.length - 1];
	const change = (prevT: EpochMs, t: EpochMs, v: number) => {
		if (prevT > last().t) entries.push({ t: prevT, v: last().v, jump: false });
		entries.push({ t, v, jump: false });
	};
	let prevT = events[0].t;
	for (const event of events.slice(1)) {
		const { t, before, after, reset } = event;
		if (reset && before.left !== after.left) {
			entries.push({ t, v: before.left, jump: true });
			entries.push({ t, v: after.left, jump: true });
		} else if (after.left !== last().v) {
			change(prevT, t, after.left);
		}
		prevT = t;
	}
	if (last().t < ctx.now) change(prevT, ctx.now, nowValue);
	const kept = quantity === "week" ? thin(entries) : entries;
	return { times: kept.map((e) => e.t), values: kept.map((e) => e.v) };
}

function thin(entries: Entry[]): Entry[] {
	const kept: Entry[] = [];
	entries.forEach((e, i) => {
		const prev = kept[kept.length - 1];
		if (
			prev === undefined ||
			e.jump ||
			i === entries.length - 1 ||
			e.t - prev.t >= WEEK_PAST_SPACING_MS
		)
			kept.push(e);
	});
	return kept;
}

/**
 * `pastStops` (spec section 5): ended intervals since the block's start in which
 * every counted account was out per the readings. A stop still running at the
 * last reading is `stopNow`, not a past stop; when the accounts as last read
 * show it over without a reading that ended it, it ends at now, the closest the
 * readings can place it. A refusal cooldown is not in the readings and does not count.
 */
export function pastStops(ctx: EngineContext, quantity: Quantity): Interval[] {
	const events = replay(ctx, quantity, pastFrom(ctx, quantity));
	if (events === null) return [];
	const stops: Interval[] = [];
	let open: EpochMs | null = null;
	for (const { t, after } of events) {
		const allOut = after.out.every(Boolean);
		if (allOut && open === null) open = t;
		if (!allOut && open !== null) {
			stops.push({ start: open, end: t });
			open = null;
		}
	}
	const outNow = ctx.accounts.every(
		(a) => comesBackAt(a, quantity, ctx.now) !== null,
	);
	if (open !== null && !outNow && open < ctx.now)
		stops.push({ start: open, end: ctx.now });
	return stops;
}

/**
 * When the account at `index` went out in its current out run, per the readings
 * (all of them, not only this block's). Null when the readings do not show it out
 * at the last reading (for example out only by a refusal cooldown).
 */
export function outSince(
	ctx: EngineContext,
	index: number,
	quantity: Quantity,
): EpochMs | null {
	const events = replay(ctx, quantity, Number.NEGATIVE_INFINITY);
	if (events === null || !events[events.length - 1].after.out[index])
		return null;
	let since = events[events.length - 1].t;
	for (let e = events.length - 1; e >= 0; e--) {
		if (!events[e].after.out[index]) break;
		since = events[e].t;
	}
	return since;
}
