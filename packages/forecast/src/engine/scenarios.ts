/**
 * Demand scenarios (design 4.4): a smoothed bootstrap of whole recorded days
 * (resampled recorded days plus kernel noise on scale and time), every bucket
 * scaled by today's pace (E4) at its distance ahead of now.
 */
import { interquartileRange, sampleStandardDeviation } from "simple-statistics";
import { addLocalDays, localDayKey, localDayStart, localParts } from "../time";
import type { ForecastInput, PaceContext } from "../types";
import { BUCKET_MS } from "../types";
import { dayTypeOf, MIN_POOL_DAYS, poolFor } from "./days";
import { isPresentPartition, PRESENT_PARTITION } from "./learn/partition";
import type { Partition, PoolTau } from "./learn/types";
import type {
	DayTable,
	Horizon,
	NoiseMode,
	NoiseOptions,
	RecordedDay,
	Scenarios,
} from "./model";
import { type PaceNow, paceMultiplierAt } from "./pace";
import { createRng, type Rng } from "./rng";
import { yieldToEventLoop } from "./yield";

/** Normal-reference (Silverman's rule-of-thumb) bandwidth factor, Silverman 1986 eq. 3.31. */
const SILVERMAN_FACTOR = 1.06;
/** Interquartile range of a normal distribution in standard deviations (robust spread in Silverman's rule). */
const NORMAL_IQR_SD = 1.34;
/** Simulated days built between two yields to the event loop; at defaults a block takes a few ms. */
export const SIMULATED_DAYS_PER_YIELD = 25;

const SLOT_MINUTES = BUCKET_MS / 60_000;
const SLOTS_PER_DAY = 1440 / SLOT_MINUTES;

/**
 * Scale bandwidth for the smoothed bootstrap: the normal-reference (Silverman)
 * rule h = 1.06 · min(σ, IQR/1.34) · n^(−1/5) on the logarithms of the pool's
 * daily totals. Zero-total days have no logarithm and are left out. Fewer than 2
 * positive days, or no spread at all, gives 0 (no scale noise). When the IQR is 0
 * but σ is not, σ alone is used (the usual fallback of the rule).
 */
export function scaleBandwidth(pool: RecordedDay[]): number {
	const logs: number[] = [];
	for (const d of pool) if (d.total > 0) logs.push(Math.log(d.total));
	if (logs.length < 2) return 0;
	// all equal: no spread (σ would only be rounding residue)
	if (logs.every((x) => x === logs[0])) return 0;
	const sigma = sampleStandardDeviation(logs);
	const robust = interquartileRange(logs) / NORMAL_IQR_SD;
	const spread = robust > 0 ? Math.min(sigma, robust) : sigma;
	if (!(spread > 0)) return 0;
	return SILVERMAN_FACTOR * spread * logs.length ** -0.2;
}

/** Kernel noise mode from engine options: `noiseMode` wins; else `noise` true or absent = shrunk, false = off. */
export function resolveNoiseMode(options: NoiseOptions): NoiseMode {
	if (options.noiseMode) return options.noiseMode;
	return options.noise === false ? "off" : "shrunk";
}

/** Scale kernel of one pool: bandwidth h and the weighted mean m and variance s² of its log daily totals. */
export interface ScaleKernel {
	bandwidth: number;
	mean: number;
	variance: number;
}

/**
 * Scale kernel of a pool. h = scaleBandwidth(pool), times 2^(k/2) when F2 row 18
 * serves a bandwidth step k other than 0. m and s² are the
 * mean and variance of the log daily totals under the draw's own recency weights,
 * s² = Σw·(L − m)² ÷ Σw: the variance of the distribution that is resampled, not a
 * sample estimate of some other one, so the shrunk kernel keeps exactly that
 * distribution's m and s². Zero-total days have no logarithm and are left out, as in
 * the bandwidth; a drawn zero-total day stays 0 whatever its scale. No positive day
 * (or no positive weight) gives m = s² = 0.
 */
export function scaleKernel(pool: RecordedDay[], bandwidthK = 0): ScaleKernel {
	const bandwidth =
		bandwidthK === 0
			? scaleBandwidth(pool)
			: scaleBandwidth(pool) * 2 ** (bandwidthK / 2);
	let sw = 0;
	let swl = 0;
	for (const d of pool)
		if (d.total > 0) {
			sw += d.weight;
			swl += d.weight * Math.log(d.total);
		}
	if (!(sw > 0)) return { bandwidth, mean: 0, variance: 0 };
	const mean = swl / sw;
	let ss = 0;
	for (const d of pool)
		if (d.total > 0) ss += d.weight * (Math.log(d.total) - mean) ** 2;
	return { bandwidth, mean, variance: ss / sw };
}

/**
 * Log scale noise L* − L_I for a drawn day with log total L_I and ε ~ N(0, 1); the day
 * is multiplied by exp of it. `shrunk`: the shrunk smoothed bootstrap of Silverman and
 * Young (1987), "The bootstrap: to smooth or not to smooth?", Biometrika 74(3),
 * 469–479 (also Silverman 1986, Density Estimation for Statistics and Data Analysis,
 * section 6.4.1): L* = m + (L_I − m + h·ε) ÷ √(1 + h²/s²), so the simulated log totals
 * keep the resampled mean m and variance s² instead of widening to s² + h².
 * `unshrunk`: h·ε (the plain kernel, kept for measurement). `off`: 0. h = 0, or s² = 0
 * when shrunk: 0 (no scale noise for that pool).
 */
export function scaleLogShift(
	kernel: ScaleKernel,
	logTotal: number,
	eps: number,
	mode: NoiseMode,
): number {
	const h = kernel.bandwidth;
	if (mode === "off" || !(h > 0)) return 0;
	if (mode === "unshrunk") return h * eps;
	const s2 = kernel.variance;
	if (!(s2 > 0)) return 0;
	const m = kernel.mean;
	return m + (logTotal - m + h * eps) / Math.sqrt(1 + (h * h) / s2) - logTotal;
}

/**
 * Row 2 shrinkage draw: w·own + (1 − w)·all with w = n/(n + τ), n = own days;
 * w = 0 when n = 0, w = 1 when τ = 0 and n > 0, τ = ∞ gives w = 0. Each of
 * the two parts keeps its days' relative recency weights; the result is one
 * weighted pool over the days with positive weight.
 */
export function shrinkPool(
	own: RecordedDay[],
	all: RecordedDay[],
	tau: number,
): RecordedDay[] {
	const n = own.length;
	const w = n === 0 ? 0 : tau === 0 ? 1 : n / (n + tau);
	if (w === 1) return own;
	if (w === 0) return all;
	let so = 0;
	for (const d of own) so += d.weight;
	let sa = 0;
	for (const d of all) sa += d.weight;
	const mine = new Set(own);
	return all.map((d) => ({
		...d,
		weight: (mine.has(d) ? (w * d.weight) / so : 0) + ((1 - w) * d.weight) / sa,
	}));
}

/**
 * The scenario day-pool partition (DESIGN-F2 R3-4): the partition of the E4
 * state actually served, present when none is (pace off, or no fit yet). Not
 * the learned demand's partition, so a fit of one partition never pairs with
 * pools of another (e.g. after a demand setting changes, presentDemand is
 * served while the last fit stays).
 */
export function servedPartition(input: ForecastInput): Partition {
	if (!input.settings.paceConditioning || !input.demandModel)
		return PRESENT_PARTITION;
	return input.demandModel.dayTypes?.group ?? PRESENT_PARTITION;
}

/** Served pool rows of the scenario draw (DESIGN-F2 rows 1, 2); absent = present. */
export interface PoolDemand {
	partition?: Partition;
	poolTau?: PoolTau;
}

/**
 * The draw pool of a future date. Present (E4 partition, hard 3): the date's
 * day-type pool after the monday+workday pooling, or every recorded day when
 * that pool is empty. A partition other than the present groups the date with
 * the recorded days whose weekday shares its group; under hard 3 a group below
 * MIN_POOL_DAYS days draws from every recorded day. A numeric τ draws the
 * shrinkage mixture of the own group (day type, or partition group) and all days.
 */
export function datePool(
	table: DayTable,
	dayStart: number,
	pace: PaceContext,
	demand: PoolDemand = {},
): RecordedDay[] {
	const tau = demand.poolTau ?? "hard3";
	const partition = demand.partition;
	const present = !partition || isPresentPartition(partition);
	if (present && tau === "hard3") {
		const pool = poolFor(table, dayTypeOf(dayStart, pace));
		// no day of this type in the history range at all: all recorded days (see buildScenarios)
		return pool.length === 0 ? table.days : pool;
	}
	let own: RecordedDay[];
	if (present) {
		const type = dayTypeOf(dayStart, pace);
		own = table.days.filter((d) => d.type === type);
	} else {
		const groupOf = (t: number) =>
			partition[localParts(t, pace.timeZone).isoWeekday - 1];
		const group = groupOf(dayStart);
		own = table.days.filter((d) => groupOf(d.start) === group);
	}
	if (tau === "hard3") return own.length >= MIN_POOL_DAYS ? own : table.days;
	return shrinkPool(own, table.days, tau);
}

/** Index of each wall-clock slot (minute of day ÷ bucket) in a recorded day; -1 for a slot the day skipped. */
function slotIndex(d: RecordedDay, timeZone: string): Int32Array | null {
	if (d.units.length === SLOTS_PER_DAY) return null;
	const map = new Int32Array(SLOTS_PER_DAY).fill(-1);
	for (let i = 0; i < d.units.length; i++) {
		const slot = Math.floor(
			localParts(d.start + i * BUCKET_MS, timeZone).minuteOfDay / SLOT_MINUTES,
		);
		// a repeated hour (clocks set back) keeps its first pass
		if (map[slot] === -1) map[slot] = i;
	}
	return map;
}

interface DatePlan {
	key: string;
	/** Scenario bucket range [from, to) of this date. */
	from: number;
	to: number;
	/** Wall-clock slot of each bucket in [from, to). */
	slots: Int32Array;
	pool: RecordedDay[];
	maps: (Int32Array | null)[];
	/** Cumulative weights of `pool`. */
	cumulative: Float64Array;
	kernel: ScaleKernel;
	/** This date's own stream, so a longer or shorter horizon leaves the other dates' draws unchanged. */
	rng: Rng;
}

/** Index of the pool day whose cumulative weight first exceeds x (weighted draw). */
function pick(cumulative: Float64Array, x: number): number {
	let lo = 0;
	let hi = cumulative.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((cumulative[mid] as number) > x) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * N = settings.simulatedDays simulated days of demand from bucketStart(now) to
 * horizon.simEnd. Per simulated day and future local date: draw a recorded day
 * from that date's pool with probability proportional to its weight; with noise,
 * scale it by exp(scaleLogShift(...)) (shrunk by default, see scaleLogShift; a
 * zero-total day has no log total and gets no scale noise), and shift it by a
 * uniform whole number of buckets within ±timeShiftMin (F2 row 20's served
 * jitter bound when input.learnedDemand is set); then scale every bucket,
 * Fable part included, by today's pace m(h) = paceMultiplierAt(pace, h), with h
 * the minutes from now to the bucket start (0 for the bucket holding now). The
 * light, typical and heavy lines are read from these scaled days. Off or unfitted
 * pace is m = 1 everywhere: the plain lines. Each date has its own
 * generator, seeded with today's local day key and the date's key, and draws the
 * same numbers in the same order in every noise mode, so noise off is plain
 * resampling of the same drawn days. A recorded day is laid onto the date by
 * wall-clock 5-minute slot, and the shift moves along that clock: on DST days a
 * repeated hour is read from its first pass and a skipped slot, or a shift past
 * either end of the day, reads 0, so totals are kept only on regular days.
 * Empty pool: a date whose day-type pool (after the monday+workday pooling of
 * 4.1) is empty draws from all recorded days with their recency weights, and its
 * scale bandwidth comes from that same fallback pool. This arises only when the
 * history range holds no day of that type at all (a short history): a calendar
 * day without demand is still a recorded day with total 0, so a weekend without
 * work is in the weekend pool. Planning is against the heavy day, so the error
 * leans toward more demand. F2: input.learnedDemand, when set, serves the
 * pool (rows 1, 2, see datePool), the bandwidth step (row 18) and the jitter
 * bound (row 20); at its present values every draw is as without it.
 */
export async function buildScenarios(
	input: ForecastInput,
	table: DayTable,
	horizon: Horizon,
	options: NoiseOptions,
	pace: PaceNow,
): Promise<Scenarios> {
	const mode = resolveNoiseMode(options);
	const tz = input.pace.timeZone;
	const now = horizon.now;
	const { settings } = input;
	const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
	const bucketCount =
		Math.max(0, Math.floor((horizon.simEnd - 1 - start) / BUCKET_MS)) + 1;
	const end = start + bucketCount * BUCKET_MS;
	const simulated = Math.max(0, Math.floor(settings.simulatedDays));
	const demand = input.learnedDemand;
	const jitterMin = demand ? demand.jitterMin : settings.timeShiftMin;
	const bandwidthK = demand ? demand.bandwidthK : 0;
	const shiftMax = Math.max(0, Math.floor((jitterMin * 60_000) / BUCKET_MS));

	const maps = new Map<RecordedDay, Int32Array | null>();
	const bandwidths: Record<string, number> = {};
	const dates: DatePlan[] = [];
	for (
		let dayStart = localDayStart(start, tz);
		dayStart < end;
		dayStart = addLocalDays(dayStart, 1, tz)
	) {
		const dayEnd = addLocalDays(dayStart, 1, tz);
		const from = Math.max(0, Math.round((dayStart - start) / BUCKET_MS));
		const to = Math.min(bucketCount, Math.round((dayEnd - start) / BUCKET_MS));
		if (to <= from) continue;
		const key = localDayKey(dayStart, tz);
		const regular =
			Math.round((dayEnd - dayStart) / BUCKET_MS) === SLOTS_PER_DAY;
		const slots = new Int32Array(to - from);
		for (let j = from; j < to; j++) {
			const t = start + j * BUCKET_MS;
			slots[j - from] = regular
				? Math.round((t - dayStart) / BUCKET_MS)
				: Math.floor(localParts(t, tz).minuteOfDay / SLOT_MINUTES);
		}
		const pool = datePool(table, dayStart, input.pace, {
			poolTau: demand?.poolTau,
			partition: servedPartition(input),
		});
		const cumulative = new Float64Array(pool.length);
		let acc = 0;
		pool.forEach((d, i) => {
			acc += d.weight;
			cumulative[i] = acc;
		});
		const dayMaps = pool.map((d) => {
			if (!maps.has(d)) maps.set(d, slotIndex(d, tz));
			return maps.get(d) ?? null;
		});
		const kernel = scaleKernel(pool, bandwidthK);
		bandwidths[key] = kernel.bandwidth;
		dates.push({
			key,
			from,
			to,
			slots,
			pool,
			maps: dayMaps,
			cumulative,
			kernel,
			rng: createRng(`${table.today.key}/${key}`),
		});
	}

	const multiplier = new Float64Array(bucketCount);
	for (let j = 0; j < bucketCount; j++) {
		const ahead = Math.max(0, start + j * BUCKET_MS - now) / 60_000;
		multiplier[j] = paceMultiplierAt(pace, ahead);
	}

	const units: Float32Array[] = [];
	const fable: Float32Array[] = [];
	for (let s = 0; s < simulated; s++) {
		const u = new Float32Array(bucketCount);
		const f = new Float32Array(bucketCount);
		for (const date of dates) {
			const x = date.rng.uniform();
			const eps = date.rng.normal();
			const shiftDraw = date.rng.int(2 * shiftMax + 1);
			const totalWeight = date.cumulative[date.cumulative.length - 1] ?? 0;
			const i =
				date.pool.length > 0 ? pick(date.cumulative, x * totalWeight) : -1;
			const day = date.pool[i];
			const map = date.maps[i] ?? null;
			const logShift =
				day && day.total > 0
					? scaleLogShift(date.kernel, Math.log(day.total), eps, mode)
					: 0;
			const scale = Math.exp(logShift);
			const shift = mode === "off" ? 0 : shiftDraw - shiftMax;
			for (let j = date.from; j < date.to; j++) {
				let v = 0;
				let vf = 0;
				if (day) {
					const slot = date.slots[j - date.from] as number;
					// shift on the wall clock, then find that slot in the recorded day
					const from = slot - shift;
					const src =
						from < 0 || from >= SLOTS_PER_DAY
							? -1
							: map
								? (map[from] as number)
								: from;
					if (src >= 0) {
						v = (day.units[src] as number) * scale;
						vf = (day.fable[src] as number) * scale;
					}
				}
				const m = multiplier[j] as number;
				u[j] = v * m;
				f[j] = vf * m;
			}
		}
		units.push(u);
		fable.push(f);
		if ((s + 1) % SIMULATED_DAYS_PER_YIELD === 0 && s + 1 < simulated)
			await yieldToEventLoop();
	}

	return {
		start,
		bucketCount,
		units,
		fable,
		diagnostics: {
			noise: mode !== "off",
			noiseMode: mode,
			bandwidths,
			pace,
		},
	};
}
