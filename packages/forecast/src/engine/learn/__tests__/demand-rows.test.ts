import { describe, expect, test } from "bun:test";
import { BUCKET_MS } from "../../../types";
import { DEMAND_LOOKBACK_MAX_DAYS } from "../../days";
import type { PaceSeries } from "../../pace/types";
import { presentDemand } from "..";
import type { LearnDay } from "../daily";
import { learnDays, lowoFolds } from "../daily";
import {
	crpsWeighted,
	type DemandSetting,
	demandDayLoss,
	demandLosses,
	gridPreference,
	learnDayType,
	mixtureWeights,
} from "../rows/demand-crps";
import { halflifeCandidates, scoreHalflife } from "../rows/halflife";
import { scoreJitter } from "../rows/jitter";
import { lookbackCandidates, scoreLookback } from "../rows/lookback";
import { POOL_CANDIDATES, scorePool } from "../rows/pool";
import type { LearnInput } from "../types";

/** A learn day on local day number `dayNo` (0 = a Monday), weekday 0 = Monday, Mon-Fri work days. */
function day(
	dayIndex: number,
	dayNo: number,
	total: number,
	censored = false,
): LearnDay {
	const weekday = ((dayNo % 7) + 7) % 7;
	return {
		dayIndex,
		startMs: dayNo * 86_400_000,
		isoWeek: dayNo - weekday,
		weekday,
		isWorkday: weekday < 5,
		censored,
		curve: new Float64Array(0),
		total,
		active: total > 0,
		firstActiveBucket: -1,
	};
}

const at = (
	pool: DemandSetting["pool"],
	lookbackDays = 84,
	halfLifeDays = Infinity,
) => ({
	pool,
	lookbackDays,
	halfLifeDays,
});

describe("crpsWeighted", () => {
	test("single point is the absolute error", () => {
		expect(crpsWeighted([3], [1], 7)).toBe(4);
	});
	test("hand-checked two-point values", () => {
		// E|X-y| = 1, E|X-X'|/2 = 0.5
		expect(crpsWeighted([1, 3], [0.5, 0.5], 2)).toBeCloseTo(0.5, 12);
		// E|X-y| = .25*4 + .75*6 = 5.5; E|X-X'|/2 = .25*.75*10 = 1.875
		expect(crpsWeighted([10, 0], [3, 1], 4)).toBeCloseTo(3.625, 12);
	});
	test("unnormalized weights are normalized; zero mass is NaN", () => {
		expect(crpsWeighted([1, 3], [2, 2], 2)).toBeCloseTo(0.5, 12);
		expect(crpsWeighted([1, 3], [0, 0], 2)).toBeNaN();
		expect(crpsWeighted([], [], 2)).toBeNaN();
	});
	test("matches the pairwise definition on unsorted input", () => {
		const xs = [5, 1, 9, 1, 4];
		const ws = [0.1, 0.3, 0.2, 0.15, 0.25];
		const y = 3.5;
		let a = 0;
		let b = 0;
		for (let i = 0; i < xs.length; i++) {
			a += (ws[i] as number) * Math.abs((xs[i] as number) - y);
			for (let j = 0; j < xs.length; j++)
				b +=
					(ws[i] as number) *
					(ws[j] as number) *
					Math.abs((xs[i] as number) - (xs[j] as number));
		}
		expect(crpsWeighted(xs, ws, y)).toBeCloseTo(a - b / 2, 12);
	});
});

describe("day types and pools", () => {
	test("learnDayType follows days.ts dayTypeOf", () => {
		expect(learnDayType(day(0, 0, 0))).toBe("monday");
		expect(learnDayType(day(0, 1, 0))).toBe("workday");
		expect(learnDayType(day(0, 5, 0))).toBe("weekend");
		expect(learnDayType({ ...day(0, 0, 0), isWorkday: false })).toBe("weekend");
	});

	// held-out Monday (day 14); A Monday d=7, B Tuesday d=6, C Monday d=7
	const held = day(3, 14, 5);
	const A = day(0, 7, 2);
	const B = day(1, 8, 4);
	const C = day(2, 21, 10);
	const train = [A, B, C];

	test("hard3: monday below 3 days pools with workdays (poolFor)", () => {
		const w = mixtureWeights(held, train, at("hard3"));
		expect([...w].map((x) => x / (w[0] as number))).toEqual([1, 1, 1]);
	});
	test("hard3: weekend stays alone, empty pool falls back to all days", () => {
		const sat = day(4, 19, 1);
		const sun = day(5, 20, 3);
		const wk = mixtureWeights(day(6, 26, 2), [A, sat, sun], at("hard3"));
		expect([...wk]).toEqual([0, 0.5, 0.5]);
		const empty = mixtureWeights(day(6, 26, 2), train, at("hard3"));
		for (const x of empty) expect(x).toBeCloseTo(1 / 3, 12);
	});
	test("tau mixture: w = n/(n+tau), tau 0 is own only, Infinity and n = 0 are all days", () => {
		const t0 = mixtureWeights(held, train, at(0));
		expect([...t0]).toEqual([0.5, 0, 0.5]);
		const t2 = mixtureWeights(held, train, at(2));
		expect(t2[0]).toBeCloseTo(5 / 12, 12);
		expect(t2[1]).toBeCloseTo(1 / 6, 12);
		expect(t2[2]).toBeCloseTo(5 / 12, 12);
		const inf = mixtureWeights(held, train, at(Infinity));
		for (const x of inf) expect(x).toBeCloseTo(1 / 3, 12);
		// n = 0: no Saturday in training, tau 0 still draws from all days
		const n0 = mixtureWeights(day(6, 19, 1), train, at(0));
		for (const x of n0) expect(x).toBeCloseTo(1 / 3, 12);
	});
	test("lookback keeps |distance| <= W; half-life weights 0.5^(|d|/h)", () => {
		const w6 = mixtureWeights(held, train, at("hard3", 6));
		expect([...w6]).toEqual([0, 1, 0]);
		expect([...mixtureWeights(held, train, at("hard3", 5))]).toEqual([0, 0, 0]);
		const h7 = mixtureWeights(held, train, at(Infinity, 84, 7));
		const raw = [0.5, 0.5 ** (6 / 7), 0.5];
		const s = raw.reduce((a, b) => a + b, 0);
		for (const [i, r] of raw.entries()) expect(h7[i]).toBeCloseTo(r / s, 12);
	});
});

describe("demandDayLoss: hand-checked CRPS", () => {
	const held = day(3, 14, 5);
	const train = [day(0, 7, 2), day(1, 8, 4), day(2, 21, 10)];
	test("hard3 pool {2,4,10} equal weights vs 5 = 11/9", () => {
		expect(demandDayLoss(held, train, at("hard3"))).toBeCloseTo(11 / 9, 12);
	});
	test("tau 0 own {2,10} vs 5 = 2; tau 2 = 14/9", () => {
		expect(demandDayLoss(held, train, at(0))).toBeCloseTo(2, 12);
		expect(demandDayLoss(held, train, at(2))).toBeCloseTo(14 / 9, 12);
	});
	test("lookback 6 keeps only the Tuesday; 5 keeps nothing (unscored)", () => {
		expect(demandDayLoss(held, train, at("hard3", 6))).toBeCloseTo(1, 12);
		expect(demandDayLoss(held, train, at("hard3", 5))).toBeNaN();
	});
});

describe("demandLosses: units and train rules", () => {
	// two ISO weeks plus a Monday: days 0..14, day 9 censored
	const days = Array.from({ length: 15 }, (_, i) => day(i, i, i + 1, i === 9));
	test("lowo: every uncensored day is a unit, scored against other weeks", () => {
		const r = demandLosses(days, [at("hard3"), at(Infinity)], "lowo");
		expect(r.units).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14]);
		expect(r.loss.length).toBe(2);
		expect(r.loss[0]?.length).toBe(14);
		for (const l of r.loss)
			for (const x of l) expect(Number.isFinite(x)).toBe(true);
		// day 14 (Monday, week 14) vs hard3 pool: monday+workday of weeks 0, 7 minus censored 9
		const pool = [0, 1, 2, 3, 4, 7, 8, 10, 11].map((i) => i + 1);
		const want = crpsWeighted(
			pool,
			pool.map(() => 1),
			15,
		);
		expect(r.loss[0]?.[13]).toBeCloseTo(want, 12);
	});
	test("forward: only earlier days outside the held-out ISO week", () => {
		const r = demandLosses(days, [at(Infinity)], "forward");
		// week 0 has no earlier days: unscored
		expect(
			[...(r.loss[0] as Float64Array)].slice(0, 7).every(Number.isNaN),
		).toBe(true);
		// day 7 (Monday week 7) trains on days 0..6
		const want = crpsWeighted([1, 2, 3, 4, 5, 6, 7], [1, 1, 1, 1, 1, 1, 1], 8);
		expect(r.loss[0]?.[7]).toBeCloseTo(want, 12);
	});
	test("no days: no units", () => {
		const r = demandLosses([], [at("hard3")], "lowo");
		expect(r.units).toEqual([]);
		expect(r.loss[0]?.length).toBe(0);
	});
});

describe("grids and preference orders", () => {
	test("gridPreference: by grid distance, ties to smaller index or to the longer end", () => {
		expect(gridPreference(8, 3, false)).toEqual([5, 3, 1, 0, 2, 4, 6, 7]);
		expect(gridPreference(6, 2, true)).toEqual([4, 2, 0, 1, 3, 5]);
	});
	test("row 2: tau grid with hard3 between 2 and 4; hard3 then 2, 4", () => {
		expect(POOL_CANDIDATES).toEqual([0, 1, 2, "hard3", 4, 8, 16, Infinity]);
	});
	test("row 4: 14k from 28 up to the setting, setting always present, never above", () => {
		expect(lookbackCandidates(84)).toEqual([28, 42, 56, 70, 84]);
		expect(lookbackCandidates(60)).toEqual([28, 42, 56, 60]);
		expect(lookbackCandidates(100)).toEqual([28, 42, 56, 70, 84, 98, 100]);
		expect(lookbackCandidates(20)).toEqual([20]);
	});
	test("row 5: doubling grid with the setting inserted", () => {
		expect(halflifeCandidates(14)).toEqual([3.5, 7, 14, 28, 56, Infinity]);
		expect(halflifeCandidates(10)).toEqual([3.5, 7, 10, 14, 28, 56, Infinity]);
		expect(halflifeCandidates(Infinity)).toEqual([
			3.5,
			7,
			14,
			28,
			56,
			Infinity,
		]);
	});
});

describe("scorers on a series", () => {
	// Mon 2026-10-05 00:00 UTC .. now Wed 2026-11-18 10:00 UTC
	const start = Date.UTC(2026, 9, 5);
	const now = Date.UTC(2026, 10, 18, 10);
	const n = (now - start) / BUCKET_MS;
	const series: PaceSeries = {
		start,
		units: new Float64Array(n),
		censored: new Uint8Array(n),
		timeZone: "UTC",
	};
	for (let i = 0; i < n; i += 37) series.units[i] = (i % 11) + 1;
	series.censored[288 * 10 + 4] = 1;
	const input: LearnInput = {
		series,
		now,
		workDays: 5,
		historyLookbackDays: 84,
		historyHalfLifeDays: 14,
		workStartSharePct: 5,
		timeShiftMin: 30,
		fitWithPartition: () => {
			throw new Error("not used");
		},
	};
	const days = learnDays(series, now, 5);
	const unitsWant = lowoFolds(days).flatMap((f) => f.heldOut);

	test("row 2", () => {
		const s = scorePool(input);
		expect(s.row).toBe("pool");
		expect(s.candidates).toEqual(POOL_CANDIDATES);
		expect(s.presentIndex).toBe(3);
		expect(s.preference).toEqual([5, 3, 1, 0, 2, 4, 6, 7]);
		expect(s.units).toEqual(unitsWant);
		expect(s.units).not.toContain(10);
		expect(s.loss.every((l) => l.length === unitsWant.length)).toBe(true);
	});
	test("row 4", () => {
		const s = scoreLookback(input);
		expect(s.row).toBe("lookback");
		expect(s.candidates).toEqual([28, 42, 56, 70, 84]);
		expect(s.presentIndex).toBe(4);
		expect(s.preference).toEqual([4, 3, 2, 1, 0]);
		expect(s.units).toEqual(unitsWant);
	});
	test("row 5", () => {
		const s = scoreHalflife(input);
		expect(s.row).toBe("halflife");
		expect(s.candidates).toEqual([3.5, 7, 14, 28, 56, Infinity]);
		expect(s.presentIndex).toBe(2);
		expect(s.preference).toEqual([5, 4, 0, 3, 2, 1]);
		expect(s.units).toEqual(unitsWant);
		for (const l of s.loss)
			for (const x of l) expect(Number.isFinite(x)).toBe(true);
	});
	test("row 5 preference: present, then the longer half-life first (R3-6)", () => {
		const s = scoreHalflife({ ...input, historyHalfLifeDays: 10 });
		expect(s.candidates).toEqual([3.5, 7, 10, 14, 28, 56, Infinity]);
		expect(s.preference).toEqual([6, 5, 0, 4, 3, 2, 1]);
		const inf = scoreHalflife({ ...input, historyHalfLifeDays: Infinity });
		expect(inf.preference).toEqual([5, 4, 3, 2, 1, 0]);
	});
	test("row 4: a setting above 84 searches and serves at most 84 (R3-1)", () => {
		for (const setting of [120, 365]) {
			const s = scoreLookback({ ...input, historyLookbackDays: setting });
			expect(s.candidates).toEqual([28, 42, 56, 70, 84]);
			expect(s.presentIndex).toBe(4);
		}
		const s60 = scoreLookback({ ...input, historyLookbackDays: 60 });
		expect(s60.candidates).toEqual([28, 42, 56, 60]);
		expect(s60.presentIndex).toBe(3);
	});
	test("too short a series: no units, present only scored nothing", () => {
		const short = {
			...input,
			series: {
				...series,
				units: series.units.slice(0, 100),
				censored: series.censored.slice(0, 100),
			},
		};
		for (const s of [
			scorePool(short),
			scoreLookback(short),
			scoreHalflife(short),
		]) {
			expect(s.units).toEqual([]);
			expect(s.loss.every((l) => l.length === 0)).toBe(true);
		}
	});
});

describe("demand lookback cap (R3-1)", () => {
	test("the bound is 84 days; presentDemand caps the setting, keeps a shorter one", () => {
		expect(DEMAND_LOOKBACK_MAX_DAYS).toBe(84);
		const base = {
			historyLookbackDays: 84,
			historyHalfLifeDays: 14,
			workStartSharePct: 5,
			timeShiftMin: 30,
		};
		expect(
			presentDemand({ ...base, historyLookbackDays: 365 }).lookbackDays,
		).toBe(84);
		expect(
			presentDemand({ ...base, historyLookbackDays: 120 }).lookbackDays,
		).toBe(84);
		expect(
			presentDemand({ ...base, historyLookbackDays: 60 }).lookbackDays,
		).toBe(60);
	});

	test("on a 130-day series, every demand row scores a setting of 365 or 120 as 84", () => {
		const start = Date.UTC(2026, 6, 6);
		const now = start + 130 * 86_400_000 + 3_600_000;
		const n = 130 * 288;
		const long: PaceSeries = {
			start,
			units: new Float64Array(n),
			censored: new Uint8Array(n),
			timeZone: "UTC",
		};
		for (let i = 0; i < n; i += 29) long.units[i] = (i % 13) + 1;
		const at84: LearnInput = {
			series: long,
			now,
			workDays: 5,
			historyLookbackDays: 84,
			historyHalfLifeDays: 14,
			workStartSharePct: 5,
			timeShiftMin: 30,
			fitWithPartition: () => {
				throw new Error("not used");
			},
		};
		// the series reaches past 84 days: a raw 120-day lookback scores differently
		const days = learnDays(long, now, 5);
		const raw = (lookbackDays: number) =>
			demandLosses(
				days,
				[{ pool: "hard3", lookbackDays, halfLifeDays: 14 }],
				"lowo",
			).loss[0];
		expect(raw(120)).not.toEqual(raw(84));
		for (const setting of [120, 365]) {
			const over = { ...at84, historyLookbackDays: setting };
			expect(scorePool(over)).toEqual(scorePool(at84));
			expect(scoreLookback(over)).toEqual(scoreLookback(at84));
			expect(scoreHalflife(over)).toEqual(scoreHalflife(at84));
			expect(scoreJitter(over)).toEqual(scoreJitter(at84));
		}
	}, 60_000);
});
