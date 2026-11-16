import type { PaceSeries } from "../types";

export const B5 = 300_000;
export const DAY_BUCKETS = 288;
/** Monday 2026-08-24 00:00 UTC; synthetic series use the UTC time zone, so local time is UTC. */
export const MON0 = Date.UTC(2026, 7, 24);

export function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A series of `days` whole UTC days from `start`, units per bucket from `unitsAt(bucket index)`. */
export function makeSeries(
	days: number,
	unitsAt: (i: number) => number,
	censoredAt: (i: number) => boolean = () => false,
	start = MON0,
): PaceSeries {
	const n = days * DAY_BUCKETS;
	const units = new Float64Array(n);
	const censored = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		units[i] = unitsAt(i);
		censored[i] = censoredAt(i) ? 1 : 0;
	}
	return { start, units, censored, timeZone: "UTC" };
}

export const at = (day: number, hour: number, minute = 0) =>
	MON0 + (day * DAY_BUCKETS + hour * 12 + minute / 5) * B5;

/**
 * Planted predictor: each 8-hour block (00-08, 08-16, 16-24) of each day has
 * level 5 or 20 at random, so the last 2 h predict the next 2 h within a block.
 * `force` sets chosen blocks: key `${day}/${block}`.
 */
export function plantedLevels(
	days: number,
	seed: number,
	force: Record<string, number> = {},
): (i: number) => number {
	const r = rng(seed);
	const level: number[] = [];
	for (let d = 0; d < days; d++)
		for (let b = 0; b < 3; b++)
			level.push(force[`${d}/${b}`] ?? (r() < 0.5 ? 5 : 20));
	return (i) => {
		const d = Math.floor(i / DAY_BUCKETS);
		const b = Math.floor((i % DAY_BUCKETS) / 96);
		return level[d * 3 + b] as number;
	};
}
