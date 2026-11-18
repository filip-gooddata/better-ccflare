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
	LikelyStop,
	Series,
	UnavailableReason,
} from "../types";
import { FORECAST_CONTRACT_VERSION } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { pastSeries, pastStops, type Quantity } from "./past";
import { levelLines, levelOf, quotaQuantile } from "./percentile";
import {
	countsFor,
	type LineBlock,
	projectedStops,
	shortfall,
	stopNow,
	zeroPoints,
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

export function buildResponse(
	ctx: EngineContext,
	sim: SimulationResult,
): ForecastResponse {
	const levels = responseLevels(ctx.input.settings);
	return {
		contractVersion: FORECAST_CONTRACT_VERSION,
		computedAt: ctx.now,
		available: true,
		reason: null,
		accounts: ctx.accounts.map((a) => a.accountId),
		levels: namedLevels(),
		day: buildBlock(ctx, sim, "day", levels),
		week: buildBlock(ctx, sim, "week", levels),
		fable: fable(ctx, sim),
	};
}

/** Start of the local hour containing `at` (offset changes are whole hours in the zones in use). */
function hourFloor(at: EpochMs, timeZone: string): EpochMs {
	const day = localDayStart(at, timeZone);
	return day + Math.floor((at - day) / HOUR_MS) * HOUR_MS;
}

/** Printed values are tenths of a point. */
const PRINT_SCALE = 10;

/** One decimal, after the percentiles. Rounding is monotone, so the ordering of the lines survives it. */
function round1(value: number): number {
	return Math.max(0, Math.round(value * PRINT_SCALE) / PRINT_SCALE);
}

/**
 * A level line to one decimal, with 0.0 kept for 0: a value above the zero
 * cutoff prints at least one print step (0.1), so a stop starts and ends where
 * its printed line leaves 0. Still monotone, so the ordering of the lines survives.
 */
function roundLevel(value: number, cutoff: number): number {
	return value <= cutoff ? 0 : Math.max(1 / PRINT_SCALE, round1(value));
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
 */
function blockLines(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	levels: number[],
	end: EpochMs,
): LineBlock {
	const times = sim.axis.times;
	let lastIndex = 0;
	while (lastIndex + 1 < times.length && times[lastIndex + 1] <= end)
		lastIndex++;
	const series = sim.traces.map((t) => (quantity === "day" ? t.day : t.week));
	const lines = levelLines(series, lastIndex + 1, levels);
	const need = levels.map((l) => daysAtZeroForLevel(series.length, l));
	const cutoff = zeroPoints(ctx.accounts.length);

	const stepCache = new Map<number, { atZero: number; hits: EpochMs[] }>();
	const stepHits = (j: number) => {
		const cached = stepCache.get(j);
		if (cached) return cached;
		let atZero = 0;
		const hits: EpochMs[] = [];
		sim.traces.forEach((trace, s) => {
			const zeroNow = series[s][j] <= cutoff;
			if (!zeroNow) return;
			if (series[s][j - 1] <= cutoff) {
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
		stepCache.set(j, entry);
		return entry;
	};
	/** When level l reaches 0 in step j; t[j] when the days give no earlier time. */
	const zeroTime = (j: number, l: number): EpochMs => {
		if (lines[l][j - 1] <= cutoff) return times[j - 1];
		const { atZero, hits } = stepHits(j);
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
				if (lines[l][a] <= cutoff || lines[l][b] > cutoff) return;
				let j = a + 1;
				while (lines[l][j] > cutoff) j++;
				const tau = zeroTime(j, l);
				// A zero exactly on a sample the block leaves out (week: between
				// full hours) is kept too, so the stop starts where the line does.
				if (tau > times[j - 1] && (tau < times[j] || j !== b))
					inserts.set(tau, j);
			});
			for (const [tau, j] of [...inserts].sort((x, y) => x[0] - y[0])) {
				const w = (tau - times[j - 1]) / (times[j] - times[j - 1]);
				push(tau, (l) =>
					lines[l][j] <= cutoff && zeroTime(j, l) <= tau
						? 0
						: lines[l][j - 1] + w * (lines[l][j] - lines[l][j - 1]),
				);
			}
		}
		push(times[b], (l) => lines[l][b]);
	}
	return { times: outTimes, levels, values, end };
}

function buildBlock(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	levels: number[],
): ForecastBlock {
	const end = quantity === "day" ? ctx.horizon.dayEnd : ctx.horizon.weekEnd;
	const block = blockLines(ctx, sim, quantity, levels, end);
	const stops = {
		light: projectedStops(ctx, sim, quantity, block, LIGHT),
		typical: projectedStops(ctx, sim, quantity, block, TYPICAL),
		heavy: projectedStops(ctx, sim, quantity, block, HEAVY),
	};
	const cutoff = zeroPoints(ctx.accounts.length);
	const rounded = block.values.map((line) =>
		line.map((v) => roundLevel(v, cutoff)),
	);
	const line = (level: number) => rounded[levels.indexOf(level)];
	const fan: Record<string, number[]> = {};
	levels.forEach((level, l) => {
		if (level !== LIGHT && level !== TYPICAL && level !== HEAVY)
			fan[`p${level}`] = rounded[l];
	});
	const current = stopNow(ctx, quantity);
	return {
		past: roundSeries(pastSeries(ctx, quantity)),
		times: block.times,
		light: line(LIGHT),
		typical: line(TYPICAL),
		heavy: line(HEAVY),
		fan,
		stops,
		stopNow: current,
		pastStops: pastStops(ctx, quantity),
		shortfall: shortfall(ctx, sim, quantity, block, stops.typical),
		...stopOdds(ctx, sim, quantity, end, current),
	};
}

const MINUTE_MS = 60_000;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The chance of being stopped at some point before the block's end, and the
 * stop that is typical on the days that stop. Each simulated day is read on its
 * own: the block's line of a simulation holding only that day, under the same
 * stop rule as the headline (projectedStops at the typical level, so the zero
 * cutoff and minStopPoints apply as they do there). With one day every level is
 * that day's line, so one level is built. stopChance is the share of days that
 * list a stop; likelyStop is the median start and length of their first stop
 * when that share (rounded) is at least one half. During a running stop the
 * chance is 1 and likelyStop is null: the client shows stopNow.
 */
function stopOdds(
	ctx: EngineContext,
	sim: SimulationResult,
	quantity: Quantity,
	end: EpochMs,
	current: Interval | null,
): { stopChance: number; likelyStop: LikelyStop | null } {
	if (current) return { stopChance: 1, likelyStop: null };
	const starts: number[] = [];
	const lengths: number[] = [];
	for (const trace of sim.traces) {
		const one: SimulationResult = { ...sim, traces: [trace] };
		const line = blockLines(ctx, one, quantity, [TYPICAL], end);
		const first = projectedStops(ctx, one, quantity, line, TYPICAL)[0];
		if (!first) continue;
		starts.push(first.start);
		lengths.push(first.end - first.start);
	}
	const days = sim.traces.length;
	const stopChance =
		days === 0 ? 0 : Math.round((starts.length / days) * 100) / 100;
	if (stopChance < 0.5 || starts.length === 0)
		return { stopChance, likelyStop: null };
	return {
		stopChance,
		likelyStop: {
			start: Math.round(median(starts)),
			minutes: Math.max(1, Math.round(median(lengths) / MINUTE_MS)),
		},
	};
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
