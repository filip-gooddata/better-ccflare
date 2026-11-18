import { describe, expect, test } from "bun:test";
import { type FitOptions, fitPaceModel, nestedOof } from "../fit";
import { lr, prefix, type SpanSums } from "../grammar";
import type {
	PaceBandFit,
	PaceCandidate,
	PaceFitState,
	PaceSeries,
} from "../types";
import { at, DAY_BUCKETS, makeSeries, rng } from "./synth";

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
		"one full E4 fit per held-out week, on the unchanged series with that week's target days excluded",
		() => {
			const s = makeSeries(
				21,
				(i) => 10 + (i % 7),
				(i) => i === 3 * DAY_BUCKETS + 5,
			);
			const seen: { excluded: number[]; partition: unknown }[] = [];
			const spy = (
				series: PaceSeries,
				now: number,
				partition?: ArrayLike<number>,
				options?: FitOptions,
			) => {
				expect(series).toBe(s);
				expect(options?.lean).toBe(true);
				seen.push({
					excluded: [...(options?.excludeDays ?? [])].sort((a, b) => a - b),
					partition: partition ? Array.from(partition) : undefined,
				});
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
			seen.forEach(({ excluded, partition }, k) => {
				expect(partition).toEqual([0, 0, 0, 0, 0, 1, 1]);
				const [lo, hi] = masked[k] as [number, number];
				expect(excluded).toEqual(
					Array.from({ length: hi - lo + 1 }, (_, j) => lo + j),
				);
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

describe("outer-fold exclusion (R3-2: held-out days never train)", () => {
	const range = (lo: number, hi: number) =>
		new Set(Array.from({ length: hi - lo + 1 }, (_, j) => lo + j));

	test("a span touching an excluded bucket has no log ratio, whatever its censor share", () => {
		// review r2 probe: 42 days at 10 per bucket, held-out days 14..27; the
		// target day 11 00:30 .. day 14 00:30 overlaps them by 6 of 864 buckets
		const n = 42 * DAY_BUCKETS;
		const a = 11 * DAY_BUCKETS + 6;
		const b = 14 * DAY_BUCKETS + 6;
		const units = new Float64Array(n).fill(10);
		const sums = (u: Float64Array, excluded?: (i: number) => boolean) => {
			const P: SpanSums = {
				PU: prefix(u),
				PC: new Float64Array(n + 1),
				PB: prefix(new Float64Array(n).fill(10)),
			};
			if (excluded)
				P.PX = prefix(Float64Array.from(u, (_, i) => (excluded(i) ? 1 : 0)));
			return P;
		};
		const held = (i: number) => {
			const d = Math.floor(i / DAY_BUCKETS);
			return d >= 14 && d <= 27;
		};
		const altered = Float64Array.from(units, (v, i) =>
			i >= 14 * DAY_BUCKETS && i < b ? 10000 : v,
		);
		expect(lr(sums(units), a, b)).toBe(0);
		expect(lr(sums(altered), a, b)).toBeCloseTo(2.071396072121089, 9);
		expect(lr(sums(units, held), a, b)).toBeNaN();
		expect(lr(sums(altered, held), a, b)).toBeNaN();
		// a span ending at the first held-out bucket does not touch it
		expect(lr(sums(altered, held), a, 14 * DAY_BUCKETS)).toBe(0);
	});

	// whole-day levels 5 or 20: every band up to 8-16h selects a feature, and
	// 8-16h targets (96 buckets) can overlap the excluded days by 6 buckets
	const planted = () => {
		const r = rng(7);
		const level = Array.from({ length: 28 }, () => (r() < 0.5 ? 5 : 20));
		return makeSeries(
			28,
			(i) => level[Math.floor(i / DAY_BUCKETS)] as number,
		);
	};
	const NOW = at(28, 0);
	const comparable = (s: PaceFitState) => ({
		bands: s.bands,
		baseline: s.baseline,
		selected: s.selected,
		belowFloor: s.belowFloor,
	});

	test(
		"the lean fit does not depend on any unit of an excluded day, including rows overlapping them by a few buckets",
		() => {
			const s = planted();
			const excludeDays = range(14, 20);
			const changed: PaceSeries = {
				...s,
				units: Float64Array.from(s.units, (v, i) => {
					const d = Math.floor(i / DAY_BUCKETS);
					return d >= 14 && d <= 20 ? 10000 + (i % 37) * 100 : v;
				}),
			};
			const base = fitPaceModel(s, NOW, undefined, {
				lean: true,
				excludeDays,
			});
			expect(base.selected.find((b) => b.band === "8-16h")?.feature).not.toBeNull();
			expect(
				comparable(
					fitPaceModel(changed, NOW, undefined, { lean: true, excludeDays }),
				),
			).toEqual(comparable(base));
			// ordinary censoring of the same days keeps the overlapping rows (the r2 defect)
			const mask = (x: PaceSeries): PaceSeries => ({
				...x,
				censored: Uint8Array.from(x.censored, (v, i) => {
					const d = Math.floor(i / DAY_BUCKETS);
					return d >= 14 && d <= 20 ? 1 : v;
				}),
			});
			expect(
				comparable(fitPaceModel(mask(changed), NOW, undefined, { lean: true })),
			).not.toEqual(
				comparable(fitPaceModel(mask(s), NOW, undefined, { lean: true })),
			);
		},
		LONG,
	);

	test(
		"no exclusion, an empty exclusion and one past the cut give the identical fit",
		() => {
			const s = planted();
			for (const p of [undefined, [0, 0, 0, 0, 0, 1, 1]]) {
				const plain = fitPaceModel(s, NOW, p);
				expect(fitPaceModel(s, NOW, p, { excludeDays: new Set() })).toEqual(
					plain,
				);
				expect(
					fitPaceModel(s, NOW, p, { excludeDays: new Set([28, 40]) }),
				).toEqual(plain);
			}
		},
		LONG,
	);
});

describe("nested scorer: established-cell prediction (hand-checked)", () => {
	test(
		"target group and origin hour pick the cell; the feature is clipped and standardized",
		() => {
			// flat 10 per bucket and baseline 10: every target log ratio is 0 and
			// R:12:0 is 0; one cell (band 0-1h, hour 3) with lo 0.2 predicts
			// 1 * (0.2 - 0.5) / 2 = -0.15 for origins rounding to hour 3 (2:30, 3:00)
			const s = makeSeries(14, () => 10);
			const r12: PaceCandidate = {
				id: "R:test",
				family: "R",
				long: false,
				len: 12,
				end: 0,
			};
			const controlled = (
				series: PaceSeries,
				now: number,
				partition?: ArrayLike<number>,
				options?: FitOptions,
			): PaceFitState => {
				const state = fitPaceModel(series, now, partition, options);
				const name = Object.keys(state.baseline)[0] as string;
				const baseline = Object.fromEntries(
					Object.keys(state.baseline).map((k) => [
						k,
						Array.from({ length: DAY_BUCKETS }, () => 10),
					]),
				) as PaceFitState["baseline"];
				const bands = state.bands.map(
					(band, i): PaceBandFit =>
						i === 0
							? {
									...band,
									feature: r12,
									cells: [
										{
											dayType: name as PaceBandFit["cells"][number]["dayType"],
											hour: 3,
											lambda: 0,
											r2: 0.5,
											mean: 0.5,
											sd: 2,
											lo: 0.2,
											hi: 1,
											coef: 1,
											y0: 0,
											rows: 100,
										},
									],
								}
							: { ...band, feature: null, cells: [] },
				);
				return { ...state, baseline, bands };
			};
			const r = nestedOof(s, at(14, 0), ONE_GROUP, controlled);
			// 7 days x 2 origins per held-out week
			expect(r.units.length).toBe(2);
			for (const l of r.loss) expect(l).toBeCloseTo(14 * 0.15 ** 2, 9);
		},
		LONG,
	);
});
