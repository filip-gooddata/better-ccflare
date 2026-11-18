import { localParts } from "../../../time";
import { BUCKET_MS, TIME_SHIFT_MIN_MAX } from "../../../types";
import type { LearnDay } from "../daily";
import type { LearnInput, RowScores } from "../types";
import { distancePreference, scenarioPools } from "./c-scenario";

const SLOT_MINUTES = BUCKET_MS / 60_000;
const SLOTS = 1440 / SLOT_MINUTES;
/** Largest jitter bound the setting allows: the `timeShiftMin` maximum. */
const MAX_JITTER_MIN = TIME_SHIFT_MIN_MAX;
/** 0, then the bucket times 2^k up to the maximum, which is always included. */
const BASE_GRID = [0, 10, 20, 40, 80, MAX_JITTER_MIN];

/** Row 20 grid in minutes: the base grid plus the setting, ascending, no duplicates. */
export function jitterGrid(settingMin: number): number[] {
	const grid = BASE_GRID.includes(settingMin)
		? [...BASE_GRID]
		: [...BASE_GRID, settingMin];
	return grid.sort((a, b) => a - b);
}

/** Preference rank per grid index: by grid distance from the setting, ties to the smaller index. */
export const jitterPreference = (n: number, presentIndex: number): number[] =>
	distancePreference(n, presentIndex);

/** Whole-bucket shift bound of a jitter bound, as `scenarios.ts` computes `shiftMax`. */
const shiftsOf = (min: number): number =>
	Math.max(0, Math.floor((min * 60_000) / BUCKET_MS));

/** Wall-clock slot of each bucket of a day; null for a regular day (slot = bucket). */
function slotsOf(day: LearnDay, timeZone: string): Int32Array | null {
	if (day.curve.length === SLOTS) return null;
	const slots = new Int32Array(day.curve.length);
	for (let i = 0; i < day.curve.length; i++)
		slots[i] = Math.floor(
			localParts(day.startMs + i * BUCKET_MS, timeZone).minuteOfDay /
				SLOT_MINUTES,
		);
	return slots;
}

/**
 * A recorded day laid on the wall clock as `scenarios.ts` reads it: units per slot, a
 * repeated hour read from its first pass, a skipped slot 0.
 */
function slotCurve(day: LearnDay, timeZone: string): Float64Array {
	const slots = slotsOf(day, timeZone);
	if (!slots) return day.curve;
	const out = new Float64Array(SLOTS);
	const seen = new Uint8Array(SLOTS);
	for (let i = 0; i < slots.length; i++) {
		const s = slots[i] as number;
		if (seen[s]) continue;
		seen[s] = 1;
		out[s] = day.curve[i] as number;
	}
	return out;
}

/**
 * Adds CRPS(F_c, y) · scale to out[c] for every candidate c, where F_c is the weighted
 * empirical distribution of the samples: sample k has value vals[k] and weight
 * base[k] · (|shift| ≤ bound[c] ? 1/(2·bound[c] + 1) : 0). `order` sorts `vals`.
 * Closed form for a sorted weighted sample:
 * CRPS = Σ q_k |x_k − y| − Σ q_k x_k (2 P_k + q_k − 1), P_k the weight before k.
 */
function addCrps(
	vals: Float64Array,
	base: Float64Array,
	absShift: Int32Array,
	order: Uint32Array,
	y: number,
	bound: readonly number[],
	out: Float64Array,
	scale: number,
): void {
	const C = bound.length;
	const inv = bound.map((b) => 1 / (2 * b + 1));
	const before = new Float64Array(C);
	const acc = new Float64Array(C);
	for (let r = 0; r < order.length; r++) {
		const k = order[r] as number;
		const w = base[k] as number;
		if (w === 0) continue;
		const x = vals[k] as number;
		const a = absShift[k] as number;
		const dev = Math.abs(x - y);
		for (let c = 0; c < C; c++) {
			if (a > (bound[c] as number)) continue;
			const q = w * (inv[c] as number);
			const p = before[c] as number;
			acc[c] = (acc[c] as number) + q * dev - q * x * (2 * p + q - 1);
			before[c] = p + q;
		}
	}
	for (let c = 0; c < C; c++)
		out[c] = (out[c] as number) + (acc[c] as number) * scale;
}

const sortedOrder = (vals: Float64Array): Uint32Array =>
	Uint32Array.from(vals.keys()).sort(
		(a, b) => (vals[a] as number) - (vals[b] as number),
	);

/**
 * Row 20 (jitter bound, minutes). Unit = held-out active day. Loss = CRPS of its
 * cumulative units curve, averaged over its buckets; the predictive at a bucket is the
 * mixture over its scenario pool (see `scenarioPools`) of each pool day's cumulative
 * curve under every whole-bucket shift within ±W, the pool day weighted by its
 * recency weight and every shift equally likely, laid by wall-clock slot as
 * `scenarios.ts` does (a shift past either end of the day reads 0). No scale noise
 * and no E4 multiplier.
 */
export function scoreJitter(input: LearnInput): RowScores<number> {
	const setting = input.timeShiftMin;
	const candidates = jitterGrid(setting);
	const presentIndex = candidates.indexOf(setting);
	const bound = candidates.map(shiftsOf);
	const S = Math.max(...bound);
	const nShift = 2 * S + 1;
	const C = candidates.length;
	const tz = input.series.timeZone;
	const { days, held } = scenarioPools(input);

	const sources = days.filter((d) => !d.censored);
	const srcIndex = new Map<number, number>();
	sources.forEach((d, i) => {
		srcIndex.set(d.startMs, i);
	});
	const slotCurves = sources.map((d) => slotCurve(d, tz));
	const prefix = slotCurves.map((p) => {
		const out = new Float64Array(SLOTS);
		let a = 0;
		for (let i = 0; i < SLOTS; i++) {
			a += p[i] as number;
			out[i] = a;
		}
		return out;
	});

	const units: number[] = [];
	const loss = candidates.map(() => [] as number[]);
	/** Per scored held-out day: normalized pool weight per source day (0 outside the pool). */
	const regular: { col: number; day: LearnDay; weight: Float64Array }[] = [];
	const irregular: { col: number; day: LearnDay; weight: Float64Array }[] = [];
	for (const { day, pool } of held) {
		if (!day.active) continue;
		const col = units.length;
		units.push(day.dayIndex);
		let sw = 0;
		for (const d of pool) sw += d.weight;
		if (pool.length === 0 || !(sw > 0)) {
			for (const l of loss) l.push(Number.NaN);
			continue;
		}
		for (const l of loss) l.push(0);
		const weight = new Float64Array(sources.length);
		for (const d of pool) {
			const i = srcIndex.get(d.start);
			if (i !== undefined) weight[i] = (weight[i] as number) + d.weight / sw;
		}
		(day.curve.length === SLOTS ? regular : irregular).push({
			col,
			day,
			weight,
		});
	}

	const N = sources.length * nShift;
	const absShift = new Int32Array(N);
	for (let i = 0; i < sources.length; i++)
		for (let k = 0; k < nShift; k++) absShift[i * nShift + k] = Math.abs(k - S);
	const vals = new Float64Array(N);
	const base = new Float64Array(N);
	const out = new Float64Array(C);

	// regular held-out days: bucket b, pool day i, shift s sums slots max(0, −s)..min(b − s, end)
	// (an earlier shift drops the day's first −s slots, a later one its last s slots)
	if (regular.length > 0) {
		const yCum = regular.map(() => 0);
		for (let b = 0; b < SLOTS; b++) {
			for (let i = 0; i < sources.length; i++) {
				const pc = prefix[i] as Float64Array;
				for (let k = 0; k < nShift; k++) {
					const s = k - S;
					const from = b - s;
					vals[i * nShift + k] =
						from < 0
							? 0
							: (pc[Math.min(from, SLOTS - 1)] as number) -
								(s < 0 ? (pc[-s - 1] as number) : 0);
				}
			}
			const order = sortedOrder(vals);
			regular.forEach((h, r) => {
				yCum[r] = (yCum[r] as number) + (h.day.curve[b] as number);
				for (let i = 0; i < sources.length; i++) {
					const w = h.weight[i] as number;
					for (let k = 0; k < nShift; k++) base[i * nShift + k] = w;
				}
				out.fill(0);
				addCrps(
					vals,
					base,
					absShift,
					order,
					yCum[r] as number,
					bound,
					out,
					1 / SLOTS,
				);
				for (let c = 0; c < C; c++) {
					const l = loss[c] as number[];
					l[h.col] = (l[h.col] as number) + (out[c] as number);
				}
			});
		}
	}

	// DST held-out days: accumulate each shifted pool day along the held-out day's own slots
	for (const h of irregular) {
		const slots = slotsOf(h.day, tz) as Int32Array;
		const len = slots.length;
		for (let i = 0; i < sources.length; i++) {
			const w = h.weight[i] as number;
			for (let k = 0; k < nShift; k++) base[i * nShift + k] = w;
		}
		const cum = new Float64Array(N);
		let y = 0;
		for (let j = 0; j < len; j++) {
			y += h.day.curve[j] as number;
			const slot = slots[j] as number;
			for (let i = 0; i < sources.length; i++) {
				if (h.weight[i] === 0) continue;
				const p = slotCurves[i] as Float64Array;
				for (let k = 0; k < nShift; k++) {
					const from = slot - (k - S);
					if (from >= 0 && from < SLOTS)
						cum[i * nShift + k] =
							(cum[i * nShift + k] as number) + (p[from] as number);
				}
			}
			out.fill(0);
			addCrps(cum, base, absShift, sortedOrder(cum), y, bound, out, 1 / len);
			for (let c = 0; c < C; c++) {
				const l = loss[c] as number[];
				l[h.col] = (l[h.col] as number) + (out[c] as number);
			}
		}
	}

	return {
		row: "jitter",
		candidates,
		presentIndex,
		preference: jitterPreference(C, presentIndex),
		units,
		loss: loss.map((l) => Float64Array.from(l)),
	};
}
