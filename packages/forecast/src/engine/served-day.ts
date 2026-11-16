/**
 * The simulated day served as the typical day line (spec section 4a): the days
 * ranked by five-hour quota missed until local midnight, and among the days
 * around the median of that ranking the one most central in the bundle.
 */
import type { EpochMs, ServedDay } from "../types";
import type { SimulationResult } from "./model";

const HOUR_MS = 3_600_000;

export const MEDIAN_DAY_WINDOW = 41;

/**
 * Quota missed in point-hours: the area between the pool's full size and the
 * line over samples 0..lastIndex, trapezoid per step. A jump pair (two samples
 * at one time) adds no area.
 */
export function missedQuota(
	day: ArrayLike<number>,
	times: ArrayLike<EpochMs>,
	lastIndex: number,
	pool: number,
): number {
	let area = 0;
	for (let i = 1; i <= lastIndex; i++)
		area +=
			((pool - day[i - 1] + (pool - day[i])) / 2) *
			((times[i] - times[i - 1]) / HOUR_MS);
	return area;
}

/**
 * Modified band depth (J = 2) of each day over samples 0..length−1: the share of
 * day pairs whose band [min, max] holds the day at a sample, averaged over the
 * samples. The pairs that miss a value are those wholly below or wholly above it.
 * Pair counts are summed as integers and divided once, so equal depths compare equal.
 */
export function bandDepths(
	days: ArrayLike<number>[],
	length: number,
): Float64Array {
	const n = days.length;
	const pairs = (n * (n - 1)) / 2;
	const depth = new Float64Array(n);
	if (pairs === 0 || length === 0) return depth;
	const column = new Float64Array(n);
	const sorted = new Float64Array(n);
	for (let i = 0; i < length; i++) {
		for (let s = 0; s < n; s++) column[s] = days[s][i];
		sorted.set(column);
		sorted.sort();
		for (let s = 0; s < n; s++) {
			const below = firstAtLeast(sorted, column[s], false);
			const above = n - firstAtLeast(sorted, column[s], true);
			depth[s] += pairs - (below * (below - 1)) / 2 - (above * (above - 1)) / 2;
		}
	}
	for (let s = 0; s < n; s++) depth[s] /= pairs * length;
	return depth;
}

/** First index whose value is ≥ v (or > v when `strict`). */
function firstAtLeast(sorted: Float64Array, v: number, strict: boolean) {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] < v || (strict && sorted[mid] === v)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export interface DayRanking {
	/** Day indices by quota missed ascending, ties by day index. */
	order: number[];
	/** Band depth per day index. */
	depth: Float64Array;
	/** The selection window: positions first..last of `order`. */
	first: number;
	last: number;
}

/** Ranks the simulated days of `sim` over the samples up to `dayEnd`. */
export function rankDays(sim: SimulationResult, dayEnd: EpochMs): DayRanking {
	const times = sim.axis.times;
	let lastIndex = 0;
	while (lastIndex + 1 < times.length && times[lastIndex + 1] <= dayEnd)
		lastIndex++;
	const pool = 100 * sim.accounts.length;
	const days = sim.traces.map((t) => t.day);
	const missed = days.map((d) => missedQuota(d, times, lastIndex, pool));
	const order = days
		.map((_, s) => s)
		.sort((a, b) => missed[a] - missed[b] || a - b);
	const n = order.length;
	const median = Math.round(0.5 * (n - 1));
	const half = (MEDIAN_DAY_WINDOW - 1) / 2;
	return {
		order,
		depth: bandDepths(days, lastIndex + 1),
		first: Math.max(0, median - half),
		last: Math.min(n - 1, median + half),
	};
}

/** The day served without a held one: the deepest of the selection window. */
export function freshDay(sim: SimulationResult, dayEnd: EpochMs): number {
	return deepest(rankDays(sim, dayEnd));
}

/** The deepest day of the window; on equal depth the earlier one in the ranking. */
function deepest(ranking: DayRanking): number {
	let best = ranking.order[ranking.first];
	for (let p = ranking.first + 1; p <= ranking.last; p++) {
		const s = ranking.order[p];
		if (ranking.depth[s] > ranking.depth[best]) best = s;
	}
	return best;
}

/**
 * The day to serve on local date `date`: the held day while it is of the same
 * date and its rank lies inside the selection window, else the window's deepest day.
 */
export function serveDay(
	sim: SimulationResult,
	dayEnd: EpochMs,
	date: string,
	held: ServedDay | null,
): ServedDay {
	const ranking = rankDays(sim, dayEnd);
	if (held !== null && held.date === date) {
		const position = ranking.order.indexOf(held.day);
		if (position >= ranking.first && position <= ranking.last) return held;
	}
	return { date, day: deepest(ranking) };
}
