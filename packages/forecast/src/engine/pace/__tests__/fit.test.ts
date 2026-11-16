import { describe, expect, test } from "bun:test";
import { paceGrammar } from "../grammar";
import { applyPace, fitPaceModel, plainPace } from "../index";
import type { PaceFitState, PaceSeries } from "../types";
import { at, DAY_BUCKETS, makeSeries, plantedLevels, rng } from "./synth";

const LONG = 120_000;
const bandOf = (s: PaceFitState, id: string) =>
	s.selected.find((b) => b.band === id)?.feature ?? null;

describe("grammar", () => {
	test("the round-3 grammar has 101 candidates and floor 10", () => {
		const g = paceGrammar();
		expect(g.length).toBe(101);
		expect(new Set(g.map((c) => c.id)).size).toBe(101);
		expect(Math.ceil(Math.log2(g.length / 0.1))).toBe(10);
	});
	test("trailing 15, 30, 60 and 120 min spans are generated candidates", () => {
		const ids = paceGrammar().map((c) => c.id);
		for (const id of [
			"R:len15m:end0",
			"R:len30m:end0",
			"R:len1h:end0",
			"R:len2h:end0",
		])
			expect(ids).toContain(id);
	});
});

describe("fitPaceModel", () => {
	test(
		"1. flat history and a flat today give m = 1 in every band",
		() => {
			const s = makeSeries(36, () => 10);
			const state = fitPaceModel(s, at(35, 0));
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
			expect(state.cellsEstablished).toBe(0);
			const now = applyPace(state, s, at(35, 12), true);
			expect(now.status).toBe("fitted");
			expect(now.bands.map((b) => b.m)).toEqual(new Array(9).fill(1));
		},
		LONG,
	);

	let planted: { s: PaceSeries; state: PaceFitState } | null = null;
	const plantedFit = () => {
		if (!planted) {
			// day 37 (Wed), block 08-16 high; day 38 (Thu), block 08-16 low (the apply instants)
			const s = makeSeries(
				39,
				plantedLevels(39, 11, { "37/1": 20, "38/1": 5 }),
			);
			planted = { s, state: fitPaceModel(s, at(37, 0)) };
		}
		return planted;
	};

	test(
		"2. a planted predictor is selected and m is about 2 at 0-2 h",
		() => {
			const { s, state } = plantedFit();
			for (const band of ["0-1h", "1-2h"]) {
				const f = bandOf(state, band);
				expect(f).not.toBeNull();
				expect(f as string).toMatch(/^R:len.*:end0$/);
			}
			const high = applyPace(state, s, at(37, 12), true);
			const low = applyPace(state, s, at(38, 12), true);
			for (const k of [0, 1]) {
				expect(high.bands[k]?.m as number).toBeGreaterThan(1.6);
				expect(high.bands[k]?.m as number).toBeLessThan(2.5);
				expect(low.bands[k]?.m as number).toBeGreaterThan(0.4);
				expect(low.bands[k]?.m as number).toBeLessThan(0.625);
			}
			expect(high.bands[0]?.feature).toBe(bandOf(state, "0-1h"));
			expect(high.bands[0]?.coef).not.toBeNull();
			expect(high.bands[0]?.lambda).not.toBeNull();
		},
		LONG,
	);

	test(
		"pooled selection: one feature per band for every day type, coefficients per hour cell",
		() => {
			const { state } = plantedFit();
			expect(state.selected.map((b) => b.band)).toEqual([
				"0-1h",
				"1-2h",
				"2-4h",
				"4-8h",
				"8-16h",
				"16h-1d",
				"1-2d",
				"2-4d",
				"4-7d",
			]);
			const band0 = state.bands[0];
			expect(band0?.feature?.id).toBe(bandOf(state, "0-1h"));
			const cells = band0?.cells ?? [];
			const types = new Set(cells.map((c) => c.dayType));
			expect(types.size).toBe(3);
			const coefs = new Set(cells.map((c) => c.coef.toFixed(6)));
			expect(coefs.size).toBeGreaterThan(1);
			expect(state.cellsTotal).toBe(9 * 3 * 24);
			expect(state.cellsEstablished).toBe(
				state.bands.reduce((n, b) => n + b.cells.length, 0),
			);
		},
		LONG,
	);

	test(
		"the state is plain data: structuredClone and JSON round trips are equal; refit is deterministic",
		() => {
			const { s, state } = plantedFit();
			expect(structuredClone(state)).toEqual(state);
			expect(JSON.parse(JSON.stringify(state))).toEqual(state);
			expect(fitPaceModel(s, at(37, 0))).toEqual(state);
		},
		LONG,
	);

	test(
		"3. a planted non-predictor (independent noise) is not selected and m = 1",
		() => {
			const r = rng(5);
			const s = makeSeries(36, () => 5 + 10 * r());
			const state = fitPaceModel(s, at(35, 0));
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
			expect(
				applyPace(state, s, at(35, 12), true).bands.every((b) => b.m === 1),
			).toBe(true);
		},
		LONG,
	);

	test(
		"4a. censored targets are excluded: a daily cut-off does not read as low demand",
		() => {
			const cens = (i: number) => {
				const m = (i % DAY_BUCKETS) * 5;
				return m >= 13 * 60 && m < 15 * 60;
			};
			const s = makeSeries(36, (i) => (cens(i) ? 0 : 10), cens);
			const state = fitPaceModel(s, at(35, 0));
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
		},
		LONG,
	);

	test(
		"4b. a censored feature span gives m = 1 for that band",
		() => {
			const { s, state } = plantedFit();
			const now = at(37, 12);
			const o = (now - s.start) / 300_000;
			const censored = new Uint8Array(s.censored);
			for (let i = o - 24; i < o; i++) censored[i] = 1;
			const out = applyPace(state, { ...s, censored }, now, true);
			for (const k of [0, 1]) {
				expect(out.bands[k]?.m).toBe(1);
				expect(out.bands[k]?.feature).toBeNull();
			}
		},
		LONG,
	);

	const weekly = (weeks: number) => {
		const r = rng(3);
		const level = Array.from({ length: weeks + 1 }, () => (r() < 0.5 ? 5 : 20));
		return makeSeries(weeks * 7 + 1, (i) => {
			const w = Math.floor(i / (7 * DAY_BUCKETS));
			return level[w] as number;
		});
	};
	test(
		"5a. week-scale floor: with 6 weeks a perfect weekly relation is not selected",
		() => {
			const state = fitPaceModel(weekly(6), at(42, 0));
			expect(bandOf(state, "1-2d")).toBeNull();
		},
		LONG,
	);
	test(
		"below the floor: a relation that holds in every unit so far is reported with its units",
		() => {
			// 8 days of the planted predictor: every day gains, 8 day units < 10
			const s = makeSeries(9, plantedLevels(9, 11));
			const state = fitPaceModel(s, at(8, 0));
			expect(bandOf(state, "0-1h")).toBeNull();
			const below = state.belowFloor.find((b) => b.band === "0-1h");
			expect(below?.feature as string).toMatch(/^R:/);
			expect(below?.units as number).toBeGreaterThanOrEqual(2);
			expect(below?.units as number).toBeLessThan(10);
		},
		LONG,
	);
	test(
		"5b. week-scale floor: with 12 weeks it is selected",
		() => {
			const state = fitPaceModel(weekly(12), at(84, 0));
			expect(bandOf(state, "1-2d")).not.toBeNull();
			expect(state.weeks).toBeGreaterThanOrEqual(12);
		},
		LONG,
	);

	test(
		"6. clipping: a feature beyond its training range gives the multiplier at the range edge",
		() => {
			const { s, state } = plantedFit();
			const now = at(37, 12);
			const o = (now - s.start) / 300_000;
			const units = new Float64Array(s.units);
			for (let i = o - 48; i < o; i++) units[i] = 1000;
			const out = applyPace(state, { ...s, units }, now, true);
			const b = out.bands[0];
			expect(b?.clipped).toBe(true);
			const cell = state.bands[0]?.cells.find(
				(c) => c.dayType === "workday" && c.hour === 12,
			);
			expect(cell).toBeDefined();
			if (!cell) return;
			const edge = cell.coef * ((cell.hi - cell.mean) / cell.sd);
			expect(Math.log(b?.m as number)).toBeCloseTo(edge, 12);
		},
		LONG,
	);

	test(
		"7. bound: m never leaves the clip-box corner, an extreme today gives the corner",
		() => {
			const { s, state } = plantedFit();
			const now = at(37, 12);
			const o = (now - s.start) / 300_000;
			const corner = (k: number) => {
				const cell = state.bands[k]?.cells.find(
					(c) => c.dayType === "workday" && c.hour === 12,
				);
				if (!cell) return [0, 0];
				const e1 = (cell.coef * (cell.lo - cell.mean)) / cell.sd;
				const e2 = (cell.coef * (cell.hi - cell.mean)) / cell.sd;
				return [Math.min(e1, e2), Math.max(e1, e2)];
			};
			for (const level of [0, 0.5, 5, 20, 200, 1e6]) {
				const units = new Float64Array(s.units);
				for (let i = o - 4032; i < o; i++) units[i] = level;
				const out = applyPace(state, { ...s, units }, now, true);
				out.bands.forEach((b, k) => {
					const [lo, hi] = corner(k) as [number, number];
					const lm = Math.log(b.m);
					expect(lm).toBeGreaterThanOrEqual(lo - 1e-12);
					expect(lm).toBeLessThanOrEqual(hi + 1e-12);
				});
				if (level === 1e6) {
					const [, hi] = corner(0) as [number, number];
					expect(Math.log(out.bands[0]?.m as number)).toBeCloseTo(hi, 12);
				}
			}
		},
		LONG,
	);

	test(
		"8. unfitted gives m = 1 and status unfitted; off gives the plain lines",
		() => {
			const { s, state } = plantedFit();
			expect(applyPace(null, s, at(37, 12), true)).toEqual(
				plainPace("unfitted"),
			);
			expect(applyPace(null, s, at(37, 12), false)).toEqual(plainPace("off"));
			expect(applyPace(state, s, at(37, 12), false)).toEqual(plainPace("off"));
		},
		LONG,
	);

	test(
		"state counts: days, weeks, candidates, floor",
		() => {
			const { state } = plantedFit();
			expect(state.candidates).toBe(101);
			expect(state.floor).toBe(10);
			// complete days before the day of the last bucket before the cut (sandbox cutDay rule)
			expect(state.days).toBe(36);
			expect(state.weeks).toBe(6);
			expect(state.fittedAt).toBe(at(37, 0));
		},
		LONG,
	);
});
