/**
 * Projected stops, the stop running now and the shortfall (endpoint spec
 * sections 5 and 6).
 */
import type {
	AccountId,
	AccountLimits,
	EpochMs,
	Interval,
	Shortfall,
} from "../types";
import type { EngineContext, OutLimit, SimulationResult } from "./model";
import {
	accountLeft,
	capRatio,
	comesBackAt,
	outSince,
	type Quantity,
} from "./past";
import { levelOf } from "./percentile";

/** A level value below this is 0: it is what the response rounds to 0.0. */
export const ZERO_POINTS = 0.05;

/** Points are reported to one decimal; spill arithmetic runs in tenths so the parts sum exactly. */
const TENTHS = 10;

/** The level lines of one block on its own time axis, before rounding. */
export interface LineBlock {
	times: EpochMs[];
	/** Ascending levels; values[l] belongs to levels[l]. */
	levels: number[];
	values: number[][];
	/** End of the projection of this block. */
	end: EpochMs;
}

/** The out events that bring a pooled quantity to 0: any limit for the day, the weekly one for the week. */
export function countsFor(quantity: Quantity, limit: OutLimit): boolean {
	return quantity === "day" || limit === "seven_day";
}

/**
 * An account's fill for the spill rule (spec section 6): its used share now.
 * Day: 100 minus its 5-hour quota left, capped by its weekly quota left in 5-hour
 * points (`ratio`; no cap when null) as in section 3; a running cooldown does not
 * enter the fill. Week: its weekly use.
 */
export function fillAtNow(
	account: AccountLimits,
	quantity: Quantity,
	now: EpochMs,
	ratio: number | null = null,
): number {
	if (quantity === "day")
		return (
			100 -
			accountLeft("day", account.fiveHour, account.weekly, now, false, ratio)
		);
	const limit = account.weekly;
	if (limit.resetsAt === null || limit.resetsAt <= now) return 0;
	return Math.min(100, Math.max(0, limit.usedPct));
}

/** Points of one account's limit per demand unit, averaged over the counted accounts. */
function meanK(ctx: EngineContext, quantity: Quantity): number {
	const table =
		quantity === "day" ? ctx.calibration.fiveHour : ctx.calibration.weekly;
	if (ctx.accounts.length === 0) return 0;
	let sum = 0;
	for (const a of ctx.accounts) sum += table[a.accountId] ?? 0;
	return sum / ctx.accounts.length;
}

/**
 * Per simulated day: the points of demand left unserved inside `interval`
 * converted from units with the counted accounts' mean k of the quantity's
 * limit. A step that only partly overlaps the interval (a stop starting at an
 * inserted zero point) counts in proportion to the overlap: the trace holds
 * step totals only, so demand is taken as spread evenly over its step.
 */
function unservedPoints(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	interval: Interval,
): number[] {
	const times = sim.axis.times;
	const k = meanK(ctx, quantity);
	return sim.traces.map((trace) => {
		let units = 0;
		for (let i = 1; i < times.length; i++) {
			const from = Math.max(times[i - 1], interval.start);
			const to = Math.min(times[i], interval.end);
			if (to > from)
				units += (trace.unserved[i] * (to - from)) / (times[i] - times[i - 1]);
		}
		return units * k;
	});
}

/**
 * Unserved points "at a level" (spec section 5: the simulated days at that
 * level leave at least minStopPoints unserved). The level line pNN of quota
 * left is the (100 − NN)th percentile of quota left, the heavy side being low
 * quota; unserved demand grows as quota falls, so the heavy side of unserved
 * is its upper tail and pNN reads its NNth percentile (an aggregation choice:
 * pointwise quantiles do not tie a level to fixed days). Hence
 * levelOf(…, 100 − NN), the shared quantile rule read from the other end. It also keeps stops nested: a heavier
 * level reads a higher percentile over a longer interval, never less.
 */
function unservedAtLevel(points: number[], level: number): number {
	return levelOf(points, 100 - level);
}

/**
 * Projected stops of one level (spec section 5): maximal intervals in which the
 * line is 0, `start` the first point at 0, `end` the first point above 0 again
 * (a reset jump shows as its second entry) or the end of the projection. A run
 * that begins at computedAt has already begun and belongs to stopNow only. Listed
 * only when the level's unserved points inside reach settings.minStopPoints, so
 * zero quota with no demand (night, weekend) is not a stop.
 */
export function projectedStops(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	block: LineBlock,
	level: number,
): Interval[] {
	const values = block.values[block.levels.indexOf(level)];
	const runs: { first: number; end: EpochMs }[] = [];
	let first: number | null = null;
	for (let i = 0; i < values.length; i++) {
		const zero = values[i] < ZERO_POINTS;
		if (zero && first === null) first = i;
		if (!zero && first !== null) {
			runs.push({ first, end: block.times[i] });
			first = null;
		}
	}
	if (first !== null) runs.push({ first, end: block.end });
	const min = ctx.input.settings.minStopPoints;
	return runs
		.filter((run) => run.first > 0 && block.times[run.first] > ctx.now)
		.map((run) => ({ start: block.times[run.first], end: run.end }))
		.filter(
			(stop) =>
				unservedAtLevel(unservedPoints(ctx, sim, quantity, stop), level) >= min,
		);
}

interface CurrentStop {
	stop: Interval;
	/** Account index that went out last. */
	last: number;
	/** Per account index: when it went out. */
	outAt: number[];
}

/**
 * The stop running now (spec section 5), a fact from the accounts as last read:
 * every counted account out. `start` = when the last one went out per the
 * readings (an account whose going out the readings do not show, such as a
 * refusal cooldown, counts from its last read, the latest time it is known
 * out); `end` = the earliest moment one comes back.
 */
function currentStop(
	ctx: EngineContext,
	quantity: Quantity,
): CurrentStop | null {
	if (ctx.accounts.length === 0) return null;
	const back: EpochMs[] = [];
	for (const a of ctx.accounts) {
		const at = comesBackAt(a, quantity, ctx.now);
		if (at === null) return null;
		back.push(at);
	}
	const outAt = ctx.accounts.map(
		(a, i) => outSince(ctx, i, quantity) ?? Math.min(a.readAt, ctx.now),
	);
	let last = 0;
	outAt.forEach((at, i) => {
		if (at > outAt[last]) last = i;
	});
	return {
		stop: { start: outAt[last], end: Math.min(...back) },
		last,
		outAt,
	};
}

export function stopNow(
	ctx: EngineContext,
	quantity: Quantity,
): Interval | null {
	return currentStop(ctx, quantity)?.stop ?? null;
}

/**
 * Who ran out before a projected stop. Per simulated day that is at 0 inside the
 * stop: the out events up to its first sample at 0 inside the stop; the last of
 * them names that day's last account. `last` = the account most days name (ties:
 * lower index); `outAt` = per account the median of its last out time over those
 * days (never out: +Infinity, i.e. after everyone). With no such day, the
 * account with the most quota left now, the one that would run out last.
 */
function projectedOuts(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	stop: Interval,
): { last: number; outAt: number[] } {
	const times = sim.axis.times;
	const n = ctx.accounts.length;
	const lastCount = new Array<number>(n).fill(0);
	const outTimes: number[][] = Array.from({ length: n }, () => []);
	for (const trace of sim.traces) {
		const series = quantity === "day" ? trace.day : trace.week;
		let zeroAt: EpochMs | null = null;
		for (let i = 0; i < times.length && times[i] <= stop.end; i++)
			if (times[i] >= stop.start && series[i] < ZERO_POINTS) {
				zeroAt = times[i];
				break;
			}
		if (zeroAt === null) continue;
		const latest = new Array<EpochMs | null>(n).fill(null);
		let lastOut: { account: number; at: EpochMs } | null = null;
		for (const out of trace.outs) {
			if (out.at > zeroAt || !countsFor(quantity, out.limit)) continue;
			latest[out.account] = out.at;
			if (lastOut === null || out.at >= lastOut.at) lastOut = out;
		}
		if (lastOut === null) continue;
		lastCount[lastOut.account]++;
		latest.forEach((at, a) => {
			if (at !== null) outTimes[a].push(at);
		});
	}
	let last = 0;
	if (lastCount.some((c) => c > 0)) {
		lastCount.forEach((c, a) => {
			if (c > lastCount[last]) last = a;
		});
	} else {
		const left = ctx.accounts.map((a) =>
			accountLeft(
				quantity,
				a.fiveHour,
				a.weekly,
				ctx.now,
				false,
				capRatio(ctx.calibration, a.accountId),
			),
		);
		left.forEach((l, a) => {
			if (l > left[last]) last = a;
		});
	}
	const outAt = outTimes.map((list) =>
		list.length === 0 ? Number.POSITIVE_INFINITY : levelOf(list, 50),
	);
	return { last, outAt };
}

/**
 * The spill rule (spec section 6), in tenths of a point: the last account takes
 * as much as fits its fill (its used share now), the others follow in reverse
 * order of running out (latest first, ties by index), each capped the same way;
 * any leftover goes to the last account, so the parts sum to `points`.
 */
export function spill(
	pointsTenths: number,
	last: number,
	fills: number[],
	outAt: number[],
): number[] {
	const caps = fills.map((f) =>
		Math.round(Math.min(100, Math.max(0, f)) * TENTHS),
	);
	const parts = new Array<number>(fills.length).fill(0);
	let rest = pointsTenths;
	const order = fills
		.map((_, i) => i)
		.filter((i) => i !== last)
		.sort((a, b) => outAt[b] - outAt[a] || a - b);
	for (const i of [last, ...order]) {
		const take = Math.min(rest, caps[i]);
		parts[i] = take;
		rest -= take;
	}
	parts[last] += rest;
	return parts;
}

/**
 * `shortfall` (spec section 6) for the stop running now, else the first typical
 * stop. points = median over the simulated days of the unserved points inside it
 * (for the running stop from computedAt to its end, within the projection).
 */
export function shortfall(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	block: LineBlock,
	typicalStops: Interval[],
): Shortfall | null {
	const current = currentStop(ctx, quantity);
	let stop: Interval;
	let counted: Interval;
	let who: { last: number; outAt: number[] };
	if (current !== null) {
		stop = current.stop;
		counted = { start: ctx.now, end: Math.min(stop.end, block.end) };
		who = current;
	} else if (typicalStops.length > 0) {
		stop = typicalStops[0];
		counted = stop;
		who = projectedOuts(ctx, sim, quantity, stop);
	} else {
		return null;
	}
	const points = levelOf(unservedPoints(ctx, sim, quantity, counted), 50);
	const pointsTenths = Math.round(points * TENTHS);
	const fills = ctx.accounts.map((a) =>
		fillAtNow(a, quantity, ctx.now, capRatio(ctx.calibration, a.accountId)),
	);
	const parts = spill(pointsTenths, who.last, fills, who.outAt);
	const perAccount: Record<AccountId, number> = {};
	ctx.accounts.forEach((a, i) => {
		perAccount[a.accountId] = parts[i] / TENTHS;
	});
	return {
		stop,
		points: pointsTenths / TENTHS,
		lastAccount: ctx.accounts[who.last].accountId,
		perAccount,
	};
}
