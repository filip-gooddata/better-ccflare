import { describe, expect, test } from "bun:test";
import { fitPaceModel, nestedOof } from "../fit";
import type { PaceSeries } from "../types";
import { at, DAY_BUCKETS, makeSeries } from "./synth";

const LONG = 240_000;
const ONE_GROUP = [0, 0, 0, 0, 0, 0, 0];

/** Band edges in buckets (PACE_BANDS from/to minutes / 5). */
const EDGES = [0, 60, 120, 240, 480, 960, 1440, 2880, 5760, 10080].map(
	(m) => m / 5,
);

/**
 * Hand value of a week's plain-line loss: sum over every band's origins (every
 * 30 min of the week, target ending by `cut`) of log((U + 2) / (B·len + 2))^2,
 * skipping rows whose target touches a day in `skipDays`.
 */
function want(
	unit: (i: number) => number,
	from: number,
	B: number,
	cut: number,
	skipDays: number[] = [],
): number {
	let sum = 0;
	for (let k = 0; k < 9; k++)
		for (let o = from; o < from + 7 * DAY_BUCKETS; o += 6) {
			const a = o + (EDGES[k] as number);
			const b = o + (EDGES[k + 1] as number);
			if (b > cut) continue;
			const d0 = Math.floor(a / DAY_BUCKETS);
			const d1 = Math.floor((b - 1) / DAY_BUCKETS);
			if (skipDays.some((d) => d >= d0 && d <= d1)) continue;
			let U = 0;
			for (let i = a; i < b; i++) U += unit(i);
			sum += Math.log((U + 2) / (B * (b - a) + 2)) ** 2;
		}
	return sum;
}

describe("row-1 scoring skips targets on censored days (R3-3)", () => {
	// week 0 flat at 10, week 1 flat at 20; one censored bucket on day 10
	const CENSORED = 10 * DAY_BUCKETS + 100;
	const series = (day10: number) =>
		makeSeries(
			14,
			(i) =>
				i < 7 * DAY_BUCKETS
					? 10
					: Math.floor(i / DAY_BUCKETS) === 10
						? day10
						: 20,
			(i) => i === CENSORED,
		);
	const unit = (i: number) => (i < 7 * DAY_BUCKETS ? 10 : 20);

	test(
		"a row whose target touches a day with any censored bucket is not scored; E4 training is unchanged",
		() => {
			const state = fitPaceModel(series(20), at(14, 0), ONE_GROUP);
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
			const cut = 14 * DAY_BUCKETS;
			expect(state.oof?.units.length).toBe(2);
			expect(state.oof?.loss[0] as number).toBeCloseTo(
				want(unit, 7 * DAY_BUCKETS, 10, cut, [10]),
				6,
			);
			expect(state.oof?.loss[1] as number).toBeCloseTo(
				want(unit, 0, 0, cut, [10]),
				6,
			);
		},
		LONG,
	);

	test(
		"nested: the same exclusion, and the uncensored buckets of that day change no nested loss",
		() => {
			// E4 training keeps its bucket-level rule (R3-3), so the unnested fit,
			// which selects on every week, may change with day 10; each nested fit
			// trains without the held-out week's target days (here day 10 in both)
			const cut = 14 * DAY_BUCKETS;
			const na = nestedOof(series(20), at(14, 0), ONE_GROUP);
			expect(na.units.length).toBe(2);
			expect(na.loss[0] as number).toBeCloseTo(
				want(unit, 7 * DAY_BUCKETS, 10, cut, [10]),
				6,
			);
			expect(na.loss[1] as number).toBeCloseTo(want(unit, 0, 0, cut, [10]), 6);
			const nb = nestedOof(series(35), at(14, 0), ONE_GROUP);
			expect(nb).toEqual(na);
		},
		LONG,
	);
});

describe("nested out-of-fold loss (R3-2)", () => {
	test(
		"a flat history: zero loss on every held-out week, for any partition",
		() => {
			const s = makeSeries(36, () => 10);
			const present = nestedOof(s, at(35, 0));
			expect(present.units.length).toBe(5);
			expect(present.loss).toEqual([0, 0, 0, 0, 0]);
			expect(nestedOof(s, at(35, 0), [0, 0, 0, 0, 0, 1, 1])).toEqual(present);
		},
		LONG,
	);

	test(
		"week w is scored by a model fitted without week w's target days (hand-checked)",
		() => {
			// week 1's targets touch days 7..13: its model's baseline is days 0..6 (10 per bucket);
			// week 0's reach day 13: its model has no training day (baseline 0)
			const unit = (i: number) => (i < 7 * DAY_BUCKETS ? 10 : 20);
			const s = makeSeries(14, unit);
			const cut = 14 * DAY_BUCKETS;
			const r = nestedOof(s, at(14, 0), ONE_GROUP);
			expect(r.units.length).toBe(2);
			expect(r.loss[0] as number).toBeCloseTo(
				want(unit, 7 * DAY_BUCKETS, 10, cut),
				6,
			);
			expect(r.loss[1] as number).toBeCloseTo(want(unit, 0, 0, cut), 6);
		},
		LONG,
	);

	test(
		"one full E4 fit per held-out week, each on the series with that week's target days censored and nothing else changed",
		() => {
			const s = makeSeries(
				21,
				(i) => 10 + (i % 7),
				(i) => i === 3 * DAY_BUCKETS + 5,
			);
			const seen: { censored: Uint8Array; partition: unknown }[] = [];
			const spy = (
				series: PaceSeries,
				now: number,
				partition?: ArrayLike<number>,
				options?: { lean?: boolean },
			) => {
				expect(options).toEqual({ lean: true });
				seen.push({
					censored: Uint8Array.from(series.censored),
					partition: partition ? Array.from(partition) : undefined,
				});
				expect(series.units).toEqual(s.units);
				return fitPaceModel(series, now, partition, options);
			};
			const r = nestedOof(s, at(21, 0), [0, 0, 0, 0, 0, 1, 1], spy);
			// weeks start on days 0, 7, 14; each week's targets reach up to 13 days later, cut at day 21
			const masked = [
				[0, 13],
				[7, 20],
				[14, 20],
			];
			expect(seen.length).toBe(3);
			seen.forEach(({ censored, partition }, k) => {
				expect(partition).toEqual([0, 0, 0, 0, 0, 1, 1]);
				const [lo, hi] = masked[k] as [number, number];
				for (let i = 0; i < censored.length; i++) {
					const d = Math.floor(i / DAY_BUCKETS);
					const was = s.censored[i] as number;
					expect([i, censored[i]]).toEqual([i, d >= lo && d <= hi ? 1 : was]);
				}
			});
			expect(r.units.length).toBe(3);
		},
		LONG,
	);
});

describe("lean fit (nested fits serve only the model)", () => {
	test(
		"selection, cells and baseline equal the full fit; no out-of-fold loss or day-type diagnostic",
		() => {
			const s = makeSeries(
				28,
				(i) => 5 + ((i * 7919) % 13) + (i % 288 > 100 ? 10 : 0),
			);
			for (const p of [undefined, [0, 0, 0, 0, 0, 1, 1]]) {
				const full = fitPaceModel(s, at(28, 0), p);
				const lean = fitPaceModel(s, at(28, 0), p, { lean: true });
				expect(lean.bands).toEqual(full.bands);
				expect(lean.baseline).toEqual(full.baseline);
				expect(lean.selected).toEqual(full.selected);
				expect(lean.belowFloor).toEqual(full.belowFloor);
				expect(lean.oof).toEqual({ units: [], loss: [] });
				expect(lean.dayTypeComparison).toEqual([]);
			}
		},
		LONG,
	);
});
