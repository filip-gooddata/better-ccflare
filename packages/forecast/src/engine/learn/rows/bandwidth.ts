import type { RecordedDay } from "../../model";
import { scaleKernel } from "../../scenarios";
import type { LearnInput, RowScores } from "../types";
import { distancePreference, scenarioPools } from "./c-scenario";

/** Row 18 grid: bandwidth multiplier 2^(k/2) on the Silverman h; k = 0 is today's rule. */
export const BANDWIDTH_K: readonly number[] = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const PRESENT_INDEX = BANDWIDTH_K.indexOf(0);

/** Preference rank per grid index: by |k| (distance from k = 0), ties to the smaller index. */
export const bandwidthPreference = (): number[] =>
	distancePreference(BANDWIDTH_K.length, PRESENT_INDEX);

const HALF_LOG_2PI = 0.5 * Math.log(2 * Math.PI);

/**
 * −log density of log total `y` under the shrunk smoothed bootstrap `scenarios.ts`
 * samples from `pool`, with bandwidth h = Silverman · mult per multiplier. A drawn
 * positive day I with log total L_I becomes m + (L_I − m + hε) ÷ c, c = √(1 + h²/s²),
 * so it contributes N(m + (L_I − m)/c, (h/c)²) with probability w_I ÷ Σw; a drawn
 * zero-total day stays 0 and only carries weight. Jitter loss past midnight is not
 * modelled. Silverman h = 0, s² = 0 or no positive weight: null (unscored).
 */
export function bandwidthLoss(
	pool: readonly RecordedDay[],
	y: number,
	mults: readonly number[],
): number[] | null {
	const kernel = scaleKernel(pool as RecordedDay[]);
	const h0 = kernel.bandwidth;
	const s2 = kernel.variance;
	if (!(h0 > 0) || !(s2 > 0)) return null;
	let sw = 0;
	const logs: number[] = [];
	const logw: number[] = [];
	for (const d of pool) {
		sw += d.weight;
		if (d.total > 0 && d.weight > 0) {
			logs.push(Math.log(d.total));
			logw.push(Math.log(d.weight));
		}
	}
	if (logs.length === 0 || !(sw > 0)) return null;
	const logSw = Math.log(sw);
	const m = kernel.mean;
	const terms = new Float64Array(logs.length);
	return mults.map((mult) => {
		const h = h0 * mult;
		const c = Math.sqrt(1 + (h * h) / s2);
		const sd = h / c;
		const logSd = Math.log(sd);
		let max = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < logs.length; i++) {
			const z = (y - (m + ((logs[i] as number) - m) / c)) / sd;
			const t = (logw[i] as number) - 0.5 * z * z;
			terms[i] = t;
			if (t > max) max = t;
		}
		let acc = 0;
		for (let i = 0; i < logs.length; i++)
			acc += Math.exp((terms[i] as number) - max);
		return -(max + Math.log(acc) - logSw - logSd - HALF_LOG_2PI);
	});
}

/**
 * Row 18 (bandwidth exponent k, multiplier 2^(k/2)). Unit = held-out day with positive
 * total; loss = −log density of its log total under the served shrunk mixture of its
 * scenario pool (see `scenarioPools`), without the E4 multiplier.
 */
export function scoreBandwidth(input: LearnInput): RowScores<number> {
	const mults = BANDWIDTH_K.map((k) => 2 ** (k / 2));
	const { held } = scenarioPools(input);
	const units: number[] = [];
	const cols: (number[] | null)[] = [];
	for (const { day, pool } of held) {
		if (!(day.total > 0)) continue;
		units.push(day.dayIndex);
		cols.push(bandwidthLoss(pool, Math.log(day.total), mults));
	}
	return {
		row: "bandwidth",
		candidates: [...BANDWIDTH_K],
		presentIndex: PRESENT_INDEX,
		preference: bandwidthPreference(),
		units,
		loss: BANDWIDTH_K.map((_, c) =>
			Float64Array.from(cols, (col) => (col ? (col[c] as number) : Number.NaN)),
		),
	};
}
