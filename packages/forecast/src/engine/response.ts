/**
 * The HTTP response of the forecast (endpoint spec sections 3 to 6): level
 * lines, stops, shortfall, Fable and past, built from one simulation run.
 */
import { localDayStart } from "../time";
import type {
	AccountId,
	EpochMs,
	ForecastBlock,
	ForecastResponse,
	ForecastSettings,
	Interval,
	Series,
	UnavailableReason,
} from "../types";
import { FORECAST_CONTRACT_VERSION } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { pastSeries, pastStops, type Quantity } from "./past";
import { levelLines, levelOf, quotaQuantile } from "./percentile";
import { freshDay } from "./served-day";
import {
	countsFor,
	type LineBlock,
	projectedStops,
	shortfall,
	stopNow,
	ZERO_POINTS,
} from "./stops";

const HOUR_MS = 3_600_000;
const LIGHT = 10;
const TYPICAL = 50;
const HEAVY = 90;

function namedLevels() {
	return { light: LIGHT, typical: TYPICAL, heavy: HEAVY };
}

/** The levels of the response: light, typical, heavy and the fan, ascending, without duplicates. */
export function responseLevels(settings: ForecastSettings): number[] {
	return [...new Set([LIGHT, TYPICAL, HEAVY, ...settings.fanLevels])].sort(
		(a, b) => a - b,
	);
}

/** The spec's "no forecast" shape. */
export function unavailableResponse(
	now: EpochMs,
	reason: UnavailableReason,
	accounts: AccountId[],
): ForecastResponse {
	return {
		contractVersion: FORECAST_CONTRACT_VERSION,
		computedAt: now,
		available: false,
		reason,
		accounts,
		levels: namedLevels(),
		day: null,
		week: null,
		fable: {},
	};
}

/**
 * `served`: index of the simulated day drawn as the typical day line; by
 * default the day picked without a held one.
 */
export function buildResponse(
	ctx: EngineContext,
	sim: SimulationResult,
	served: number = freshDay(sim, ctx.horizon.dayEnd),
): ForecastResponse {
	const levels = responseLevels(ctx.input.settings);
	return {
		contractVersion: FORECAST_CONTRACT_VERSION,
		computedAt: ctx.now,
		available: true,
		reason: null,
		accounts: ctx.accounts.map((a) => a.accountId),
		levels: namedLevels(),
		day: buildBlock(ctx, sim, "day", levels, served),
		week: buildBlock(ctx, sim, "week", levels, null),
		fable: fable(ctx, sim),
	};
}

/** Start of the local hour containing `at` (offset changes are whole hours in the zones in use). */
function hourFloor(at: EpochMs, timeZone: string): EpochMs {
	const day = localDayStart(at, timeZone);
	return day + Math.floor((at - day) / HOUR_MS) * HOUR_MS;
}

/** One decimal, after the percentiles. Rounding is monotone, so the ordering of the lines survives it. */
function round1(value: number): number {
	return Math.max(0, Math.round(value * 10) / 10);
}

function roundSeries(series: Series): Series {
	return { times: series.times, values: series.values.map(round1) };
}

/**
 * Smallest number of simulated days at 0 for which the quantile of quota left
 * behind `level` is 0, under the same type-7 rule levelLines uses (it reads
 * sorted values at index ceil((n − 1)·q), interpolating from floor((n − 1)·q)).
 */
export function daysAtZeroForLevel(days: number, level: number): number {
	return Math.min(days, Math.ceil((days - 1) * quotaQuantile(level)) + 1);
}

/**
 * Sample indices of a block. Day: every sample up to dayEnd. Week: computedAt,
 * every full local hour, both entries of every jump, and weekEnd.
 */
function blockIndices(
	ctx: EngineContext,
	times: EpochMs[],
	quantity: Quantity,
	lastIndex: number,
): number[] {
	const all = Array.from({ length: lastIndex + 1 }, (_, i) => i);
	if (quantity === "day") return all;
	const anchor = localDayStart(ctx.now, ctx.timeZone);
	return all.filter(
		(i) =>
			i === 0 ||
			times[i] === ctx.horizon.weekEnd ||
			(times[i] - anchor) % HOUR_MS === 0 ||
			times[i] === times[i - 1] ||
			times[i] === times[i + 1],
	);
}

/**
 * The block's lines on its axis plus every point where a level reaches 0
 * between two samples.
 *
 * Zero point of level NN in the axis step (t[j−1], t[j]]: per simulated day
 * that reaches 0 in that step, the time it did (the last relevant out event in
 * the step, SimTrace.outs; the sample time when none is recorded). The line
 * reaches 0 when as many days are at 0 as its quantile needs
 * (daysAtZeroForLevel), so its zero time is that order statistic of those
 * times, counting the days already at 0 through the step. This is the
 * percentile reading of the same days the line is made of. At an inserted time
 * τ every level that is 0 at t[j] and whose own zero time is ≤ τ is 0 (a
 * heavier level needs fewer days, so its time is never later); every other
 * level is interpolated linearly in the step. Linear interpolation of ordered
 * values with one weight keeps them ordered, and 0 is below all of them, so the
 * ordering holds at inserted points.
 *
 * With `served` the typical line is that one day (its own zero times), clamped
 * into [heavy, light] at every point so the level order and stop nesting hold.
 */
function blockLines(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	levels: number[],
	end: EpochMs,
	served: SimulationResult | null,
): LineBlock {
	const times = sim.axis.times;
	let lastIndex = 0;
	while (lastIndex + 1 < times.length && times[lastIndex + 1] <= end)
		lastIndex++;
	const seriesOf = (r: SimulationResult) =>
		r.traces.map((t) => (quantity === "day" ? t.day : t.week));
	const typical = served ? levels.indexOf(TYPICAL) : -1;
	const simOf = (l: number) => (l === typical && served ? served : sim);
	const series = seriesOf(sim);
	const lines = levelLines(series, lastIndex + 1, levels);
	if (served)
		lines[typical] = levelLines(seriesOf(served), lastIndex + 1, [TYPICAL])[0];
	const need = levels.map((level, l) =>
		daysAtZeroForLevel(simOf(l).traces.length, level),
	);

	const stepCache = new Map<
		SimulationResult,
		Map<number, { atZero: number; hits: EpochMs[] }>
	>();
	const stepHits = (j: number, l: number) => {
		const days = simOf(l);
		let cache = stepCache.get(days);
		if (!cache) {
			cache = new Map();
			stepCache.set(days, cache);
		}
		const cached = cache.get(j);
		if (cached) return cached;
		const series = seriesOf(days);
		let atZero = 0;
		const hits: EpochMs[] = [];
		days.traces.forEach((trace, s) => {
			const zeroNow = series[s][j] < ZERO_POINTS;
			if (!zeroNow) return;
			if (series[s][j - 1] < ZERO_POINTS) {
				atZero++;
				return;
			}
			let hit = times[j];
			let found = false;
			for (const out of trace.outs)
				if (
					out.at > times[j - 1] &&
					out.at <= times[j] &&
					countsFor(quantity, out.limit) &&
					(!found || out.at > hit)
				) {
					hit = out.at;
					found = true;
				}
			hits.push(hit);
		});
		hits.sort((a, b) => a - b);
		const entry = { atZero, hits };
		cache.set(j, entry);
		return entry;
	};
	/** When level l reaches 0 in step j; t[j] when the days give no earlier time. */
	const zeroTime = (j: number, l: number): EpochMs => {
		if (lines[l][j - 1] < ZERO_POINTS) return times[j - 1];
		const { atZero, hits } = stepHits(j, l);
		const k = need[l] - atZero - 1;
		if (k < 0) return times[j - 1];
		if (k >= hits.length) return times[j];
		return Math.min(times[j], Math.max(times[j - 1], hits[k]));
	};

	const outTimes: EpochMs[] = [];
	const values: number[][] = levels.map(() => []);
	const push = (t: EpochMs, row: (l: number) => number) => {
		outTimes.push(t);
		levels.forEach((_, l) => {
			values[l].push(row(l));
		});
	};
	const indices = blockIndices(ctx, times, quantity, lastIndex);
	push(times[indices[0]], (l) => lines[l][indices[0]]);
	for (let p = 1; p < indices.length; p++) {
		const a = indices[p - 1];
		const b = indices[p];
		if (times[a] < times[b]) {
			const inserts = new Map<EpochMs, number>();
			levels.forEach((_, l) => {
				if (lines[l][a] < ZERO_POINTS || lines[l][b] >= ZERO_POINTS) return;
				let j = a + 1;
				while (lines[l][j] >= ZERO_POINTS) j++;
				const tau = zeroTime(j, l);
				// A zero exactly on a sample the block leaves out (week: between
				// full hours) is kept too, so the stop starts where the line does.
				if (tau > times[j - 1] && (tau < times[j] || j !== b))
					inserts.set(tau, j);
			});
			for (const [tau, j] of [...inserts].sort((x, y) => x[0] - y[0])) {
				const w = (tau - times[j - 1]) / (times[j] - times[j - 1]);
				push(tau, (l) =>
					lines[l][j] < ZERO_POINTS && zeroTime(j, l) <= tau
						? 0
						: lines[l][j - 1] + w * (lines[l][j] - lines[l][j - 1]),
				);
			}
		}
		push(times[b], (l) => lines[l][b]);
	}
	if (served) {
		const light = values[levels.indexOf(LIGHT)];
		const heavy = values[levels.indexOf(HEAVY)];
		values[typical] = values[typical].map((v, k) =>
			Math.min(light[k], Math.max(heavy[k], v)),
		);
	}
	return { times: outTimes, levels, values, end };
}

function buildBlock(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	levels: number[],
	served: number | null,
): ForecastBlock {
	const end = quantity === "day" ? ctx.horizon.dayEnd : ctx.horizon.weekEnd;
	const day: SimulationResult | null =
		served === null ? null : { ...sim, traces: [sim.traces[served]] };
	const block = blockLines(ctx, sim, quantity, levels, end, day);
	const typicalDays = day ?? sim;
	const light = projectedStops(ctx, sim, quantity, block, LIGHT);
	const heavy = projectedStops(ctx, sim, quantity, block, HEAVY);
	const typical = projectedStops(ctx, typicalDays, quantity, block, TYPICAL);
	const stops = {
		light,
		typical: day ? nestedStops(block, typical, light, heavy) : typical,
		heavy,
	};
	const rounded = block.values.map((line) => line.map(round1));
	const line = (level: number) => rounded[levels.indexOf(level)];
	const fan: Record<string, number[]> = {};
	levels.forEach((level, l) => {
		if (level !== LIGHT && level !== TYPICAL && level !== HEAVY)
			fan[`p${level}`] = rounded[l];
	});
	return {
		past: roundSeries(pastSeries(ctx, quantity)),
		times: block.times,
		light: line(LIGHT),
		typical: line(TYPICAL),
		heavy: line(HEAVY),
		fan,
		stops,
		stopNow: stopNow(ctx, quantity),
		pastStops: pastStops(ctx, quantity),
		shortfall: shortfall(ctx, typicalDays, quantity, block, stops.typical),
	};
}

/**
 * The served day's stops kept nested between the pointwise ones (light ⊂
 * typical ⊂ heavy): a stop of its own only inside a heavy stop, and every zero
 * run of the typical line that holds a light stop. The clamp makes the zero runs
 * nest; the levels filter their runs by different unserved demand.
 */
function nestedStops(
	block: LineBlock,
	own: Interval[],
	light: Interval[],
	heavy: Interval[],
): Interval[] {
	const inside = (a: Interval, b: Interval) =>
		b.start <= a.start && a.end <= b.end;
	const kept = own.filter((s) => heavy.some((h) => inside(s, h)));
	const line = block.values[block.levels.indexOf(TYPICAL)];
	for (const stop of light) {
		if (kept.some((s) => inside(stop, s))) continue;
		const at = block.times.indexOf(stop.start);
		let first = at;
		while (first > 0 && line[first - 1] < ZERO_POINTS) first -= 1;
		if (first === 0) continue;
		let after = at;
		while (after < line.length && line[after] < ZERO_POINTS) after += 1;
		kept.push({
			start: block.times[first],
			end: after < line.length ? block.times[after] : block.end,
		});
	}
	return kept.sort((a, b) => a.start - b.start);
}

/**
 * Fable outAt per counted account (spec section 6): the median over the
 * simulated days of when its weekly Fable sub-limit reaches 100, a day that
 * never does counting as later than all; null when at least half never do.
 * Rounded down to the local hour.
 */
function fable(
	ctx: EngineContext,
	sim: SimulationResult,
): Record<AccountId, { outAt: EpochMs | null }> {
	const result: Record<AccountId, { outAt: EpochMs | null }> = {};
	ctx.accounts.forEach((a, i) => {
		const at = sim.traces.map(
			(t) => t.fableOutAt[i] ?? Number.POSITIVE_INFINITY,
		);
		const never = at.filter((t) => t === Number.POSITIVE_INFINITY).length;
		result[a.accountId] = {
			outAt:
				at.length === 0 || never * 2 >= at.length
					? null
					: hourFloor(levelOf(at, TYPICAL), ctx.timeZone),
		};
	});
	return result;
}
