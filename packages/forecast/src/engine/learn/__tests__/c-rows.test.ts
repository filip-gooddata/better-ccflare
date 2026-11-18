import { describe, expect, test } from "bun:test";
import { BUCKET_MS, TIME_SHIFT_MIN_MAX } from "../../../types";
import { recencyWeight } from "../../calibration";
import type { RecordedDay } from "../../model";
import type { PaceSeries } from "../../pace/types";
import { scaleBandwidth, scaleKernel, scaleLogShift } from "../../scenarios";
import {
	BANDWIDTH_K,
	bandwidthLoss,
	bandwidthPreference,
	scoreBandwidth,
} from "../rows/bandwidth";
import { scenarioPools } from "../rows/c-scenario";
import { jitterGrid, jitterPreference, scoreJitter } from "../rows/jitter";
import type { LearnInput } from "../types";

const DAY = 288;
const DAY_MS = DAY * BUCKET_MS;
/** Monday 2026-01-05 00:00 UTC. */
const MONDAY = Date.UTC(2026, 0, 5);

function series(days: number): PaceSeries {
	return {
		start: MONDAY,
		units: new Float64Array(days * DAY),
		censored: new Uint8Array(days * DAY),
		timeZone: "UTC",
	};
}

function input(s: PaceSeries, over: Partial<LearnInput> = {}): LearnInput {
	const days = s.units.length / DAY;
	return {
		series: s,
		now: MONDAY + days * DAY_MS + 3_600_000,
		workDays: 5,
		historyLookbackDays: 84,
		historyHalfLifeDays: 14,
		workStartSharePct: 5,
		timeShiftMin: 30,
		fitWithPartition: () => {
			throw new Error("unused");
		},
		...over,
	};
}

function recorded(total: number, weight: number): RecordedDay {
	const units = new Float64Array(DAY);
	units[100] = total;
	return {
		key: "k",
		start: 0,
		type: "workday",
		weight,
		units,
		fable: new Float64Array(DAY),
		total,
		fableTotal: 0,
	};
}

const normalLogPdf = (x: number, mu: number, sd: number) =>
	-0.5 * ((x - mu) / sd) ** 2 - Math.log(sd) - 0.5 * Math.log(2 * Math.PI);

describe("row 18 bandwidth: grid and preference", () => {
	test("k = -4..4 with the present k = 0, preference by |k| then the smaller index", () => {
		expect(BANDWIDTH_K).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
		expect(bandwidthPreference()).toEqual([7, 5, 3, 1, 0, 2, 4, 6, 8]);
		const s = scoreBandwidth(input(series(7)));
		expect(s.row).toBe("bandwidth");
		expect(s.candidates).toEqual(BANDWIDTH_K);
		expect(s.presentIndex).toBe(4);
		expect(s.preference).toEqual([7, 5, 3, 1, 0, 2, 4, 6, 8]);
	});
});

describe("row 18 bandwidth: loss", () => {
	test("-log density of the served shrunk mixture, zero-total days carrying weight, hand formula", () => {
		const pool = [
			recorded(Math.exp(0), 1),
			recorded(Math.exp(1), 0.5),
			recorded(Math.exp(2), 0.25),
			recorded(0, 0.25),
		];
		const h0 = scaleBandwidth(pool);
		expect(h0).toBeGreaterThan(0);
		// weighted mean and variance of the positive log totals, by hand
		const m = (0 * 1 + 1 * 0.5 + 2 * 0.25) / 1.75;
		const s2 = (1 * m ** 2 + 0.5 * (1 - m) ** 2 + 0.25 * (2 - m) ** 2) / 1.75;
		const y = 1.3;
		const mults = BANDWIDTH_K.map((k) => 2 ** (k / 2));
		const got = bandwidthLoss(pool, y, mults);
		expect(got).not.toBeNull();
		mults.forEach((mult, c) => {
			const h = h0 * mult;
			const cc = Math.sqrt(1 + (h * h) / s2);
			let f = 0;
			for (const [L, w] of [
				[0, 1],
				[1, 0.5],
				[2, 0.25],
			] as const)
				f += (w / 2) * Math.exp(normalLogPdf(y, m + (L - m) / cc, h / cc));
			expect(got?.[c]).toBeCloseTo(-Math.log(f), 10);
		});
	});

	test("row 19: the density uses the served noise formula with the candidate h", () => {
		const pool = [
			recorded(10, 1),
			recorded(20, 0.7),
			recorded(25, 0.4),
			recorded(60, 0.2),
		];
		const base = scaleKernel(pool);
		const y = Math.log(30);
		const mults = BANDWIDTH_K.map((k) => 2 ** (k / 2));
		const got = bandwidthLoss(pool, y, mults) as number[];
		mults.forEach((mult, c) => {
			// Part A threads 2^(k/2) into the kernel bandwidth; scaleLogShift is the served draw
			const kernel = { ...base, bandwidth: base.bandwidth * mult };
			let f = 0;
			let sw = 0;
			for (const d of pool) {
				const L = Math.log(d.total);
				const mu = L + scaleLogShift(kernel, L, 0, "shrunk");
				const sd = L + scaleLogShift(kernel, L, 1, "shrunk") - mu;
				f += d.weight * Math.exp(normalLogPdf(y, mu, sd));
				sw += d.weight;
			}
			expect(got[c]).toBeCloseTo(-Math.log(f / sw), 10);
		});
	});

	test("Silverman h = 0 (equal or single positive totals) leaves the day unscored", () => {
		const mults = [1, 2];
		expect(
			bandwidthLoss([recorded(5, 1), recorded(5, 0.5)], 1, mults),
		).toBeNull();
		expect(
			bandwidthLoss([recorded(5, 1), recorded(0, 1)], 1, mults),
		).toBeNull();
		expect(bandwidthLoss([], 1, mults)).toBeNull();
	});

	test("units are uncensored days with positive total; a degenerate series serves present", () => {
		const s = series(21);
		for (let d = 0; d < 21; d++) {
			if (d === 9) continue; // a zero-total day
			s.units[d * DAY + 100] = 1 + ((d * 7) % 5);
		}
		s.censored[3 * DAY + 5] = 1; // day 3 censored
		const sc = scoreBandwidth(input(s));
		expect(sc.units).not.toContain(3);
		expect(sc.units).not.toContain(9);
		expect(sc.units.length).toBe(19);
		for (const l of sc.loss) expect(l.length).toBe(19);
		const scored = sc.loss[4] as Float64Array;
		expect([...scored].some(Number.isFinite)).toBe(true);

		// each unit's loss is bandwidthLoss on the pool scenarioPools builds for that day
		const pools = scenarioPools(input(s));
		const u = sc.units.indexOf(10);
		const held = pools.held.find((h) => h.day.dayIndex === 10);
		expect(held).toBeDefined();
		const ref = bandwidthLoss(
			held?.pool ?? [],
			Math.log(held?.day.total ?? 1),
			BANDWIDTH_K.map((k) => 2 ** (k / 2)),
		) as number[];
		sc.loss.forEach((l, c) => {
			expect(l[u]).toBeCloseTo(ref[c] as number, 12);
		});

		const flat = series(21);
		for (let d = 0; d < 21; d++) flat.units[d * DAY + 100] = 4;
		const f = scoreBandwidth(input(flat));
		for (const l of f.loss) expect([...l].every(Number.isNaN)).toBe(true);
		const empty = scoreBandwidth(input(series(0)));
		expect(empty.units).toEqual([]);
		expect(empty.candidates).toEqual(BANDWIDTH_K);
	});
});

describe("scenario pools (rows 18, 20)", () => {
	test("held-out day pool: other ISO weeks, present day type, half-life weights on distance", () => {
		const s = series(21);
		const p = scenarioPools(input(s));
		// Wednesday of week 0: workday pool = Tue-Fri of weeks 1 and 2
		const wed = p.held.find((h) => h.day.dayIndex === 2);
		expect(wed?.pool.length).toBe(8);
		const starts = (wed?.pool ?? [])
			.map((d) => (d.start - MONDAY) / DAY_MS)
			.sort((a, b) => a - b);
		expect(starts).toEqual([8, 9, 10, 11, 15, 16, 17, 18]);
		const w9 = wed?.pool.find((d) => d.start === MONDAY + 9 * DAY_MS);
		expect(w9?.weight).toBeCloseTo(recencyWeight(7, 14), 12);
		// Monday: only 2 other Mondays (< 3), so monday and workday pool together
		const mon = p.held.find((h) => h.day.dayIndex === 7);
		expect(mon?.pool.length).toBe(10);
		// Saturday: weekend stays alone
		const sat = p.held.find((h) => h.day.dayIndex === 5);
		expect(sat?.pool.length).toBe(4);
		// lookback bounds the distance: Tue and Wed of week 1 (< 3), so the Monday joins them
		const short = scenarioPools(input(s, { historyLookbackDays: 7 }));
		const wed2 = short.held.find((h) => h.day.dayIndex === 2);
		expect(
			wed2?.pool.map((d) => (d.start - MONDAY) / DAY_MS).sort((a, b) => a - b),
		).toEqual([7, 8, 9]);
	});

	test("an empty day-type pool falls back to every training day", () => {
		// a 1-week series has no training days at all
		const p = scenarioPools(input(series(7)));
		for (const h of p.held) expect(h.pool.length).toBe(0);
		// week 1 weekend censored: Saturday of week 0 has no weekend day to train on
		const s = series(14);
		s.censored[12 * DAY] = 1;
		s.censored[13 * DAY] = 1;
		const q = scenarioPools(input(s));
		const sat = q.held.find((h) => h.day.dayIndex === 5);
		expect(sat?.pool.length).toBe(5);
		// with both weekend days present it stays alone at 2 (weekend never pools)
		const r = scenarioPools(input(series(14)));
		expect(r.held.find((h) => h.day.dayIndex === 5)?.pool.length).toBe(2);
	});
});

describe("row 20 jitter: grid and preference", () => {
	test("{0,10,20,40,80,120} plus the setting, preference by grid distance from it", () => {
		expect(jitterGrid(30)).toEqual([0, 10, 20, 30, 40, 80, 120]);
		expect(jitterGrid(40)).toEqual([0, 10, 20, 40, 80, 120]);
		expect(jitterGrid(0)).toEqual([0, 10, 20, 40, 80, 120]);
		expect(jitterGrid(120)).toEqual([0, 10, 20, 40, 80, 120]);
		expect(jitterGrid(7)).toEqual([0, 7, 10, 20, 40, 80, 120]);
		// the cap is the timeShiftMin setting maximum, not its own literal (R3-7)
		expect(TIME_SHIFT_MIN_MAX).toBe(120);
		expect(jitterGrid(30).at(-1)).toBe(TIME_SHIFT_MIN_MAX);
		expect(jitterGrid(TIME_SHIFT_MIN_MAX)).toEqual([0, 10, 20, 40, 80, 120]);
		expect(jitterPreference(7, 3)).toEqual([5, 3, 1, 0, 2, 4, 6]);
		expect(jitterPreference(6, 0)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(jitterPreference(6, 5)).toEqual([5, 4, 3, 2, 1, 0]);
		const s = scoreJitter(input(series(7)));
		expect(s.row).toBe("jitter");
		expect(s.candidates).toEqual([0, 10, 20, 30, 40, 80, 120]);
		expect(s.presentIndex).toBe(3);
	});
});

describe("row 20 jitter: loss", () => {
	test("hand-checked CRPS: identical spike days, W = 0 / 10 / 20 minutes", () => {
		const s = series(21);
		for (let d = 0; d < 21; d++) s.units[d * DAY + 100] = 1;
		const sc = scoreJitter(input(s));
		expect(sc.units.length).toBe(21);
		const at = (min: number) =>
			sc.loss[sc.candidates.indexOf(min)] as Float64Array;
		for (let u = 0; u < 21; u++) {
			expect(at(0)[u]).toBeCloseTo(0, 12);
			// 5 shifts: buckets 98..101 deviate by 1/5, 2/5, 2/5, 1/5
			expect(at(10)[u]).toBeCloseTo(10 / 25 / DAY, 12);
			// 9 shifts: 2·(1+4+9+16)/81
			expect(at(20)[u]).toBeCloseTo(60 / 81 / DAY, 12);
		}
	});

	test("shifts past either end of the day read 0, and weights follow the pool", () => {
		// one spike in the last bucket of every training day: a shift later moves it past midnight
		const s = series(14);
		for (let d = 0; d < 14; d++) s.units[d * DAY + (DAY - 1)] = 2;
		const sc = scoreJitter(input(s));
		const at10 = sc.loss[sc.candidates.indexOf(10)] as Float64Array;
		// shifts -2..+2: earlier shifts bring the spike to buckets 285 (1/5) and 286 (2/5) where
		// 0 is observed; at 287 (observed 2) the later shifts (2/5) pushed it past midnight
		for (let u = 0; u < sc.units.length; u++)
			expect(at10[u]).toBeCloseTo((2 * (1 + 4 + 4)) / 25 / DAY, 12);
	});

	test("matches a brute-force weighted CRPS on a varied series", () => {
		const s = series(21);
		let x = 7;
		for (let i = 0; i < s.units.length; i++) {
			x = (x * 1103515245 + 12345) % 2147483648;
			if (x % 13 === 0) s.units[i] = (x % 7) + 1;
		}
		const inp = input(s);
		const sc = scoreJitter(inp);
		const pools = scenarioPools(inp);
		const held = pools.held.find((h) => h.day.dayIndex === 11);
		expect(held).toBeDefined();
		const u = sc.units.indexOf(11);
		const c = sc.candidates.indexOf(20);
		const W = 4;
		const pool = held?.pool ?? [];
		const sw = pool.reduce((a, d) => a + d.weight, 0);
		const obs = held?.day.curve as Float64Array;
		let total = 0;
		let yc = 0;
		const cums = pool.map((d) => {
			const shifted: number[][] = [];
			for (let sh = -W; sh <= W; sh++) {
				const row: number[] = [];
				let acc = 0;
				for (let b = 0; b < DAY; b++) {
					const from = b - sh;
					if (from >= 0 && from < DAY) acc += d.units[from] as number;
					row.push(acc);
				}
				shifted.push(row);
			}
			return shifted;
		});
		for (let b = 0; b < DAY; b++) {
			yc += obs[b] as number;
			const xs: number[] = [];
			const ps: number[] = [];
			pool.forEach((d, i) => {
				for (let k = 0; k <= 2 * W; k++) {
					xs.push(cums[i]?.[k]?.[b] as number);
					ps.push(d.weight / sw / (2 * W + 1));
				}
			});
			let a = 0;
			let bb = 0;
			for (let i = 0; i < xs.length; i++) {
				a += (ps[i] as number) * Math.abs((xs[i] as number) - yc);
				for (let j = 0; j < xs.length; j++)
					bb +=
						(ps[i] as number) *
						(ps[j] as number) *
						Math.abs((xs[i] as number) - (xs[j] as number));
			}
			total += a - bb / 2;
		}
		expect((sc.loss[c] as Float64Array)[u]).toBeCloseTo(total / DAY, 9);
	});

	test("a DST day is laid by wall-clock slot: constant demand scores 0 at W = 0", () => {
		// Monday 2026-03-16 00:00 Europe/Prague; Sunday 2026-03-29 has 276 buckets
		const start = Date.UTC(2026, 2, 15, 23);
		const n = 21 * DAY - 12;
		const s: PaceSeries = {
			start,
			units: new Float64Array(n).fill(1),
			censored: new Uint8Array(n),
			timeZone: "Europe/Prague",
		};
		const sc = scoreJitter(
			input(s, { now: start + n * BUCKET_MS + 3_600_000 }),
		);
		const days = scenarioPools(
			input(s, { now: start + n * BUCKET_MS + 3_600_000 }),
		).days;
		const dst = days.find((d) => d.curve.length === DAY - 12);
		expect(dst).toBeDefined();
		const u = sc.units.indexOf(dst?.dayIndex ?? -1);
		expect(u).toBeGreaterThanOrEqual(0);
		expect((sc.loss[0] as Float64Array)[u]).toBeCloseTo(0, 12);
		for (const l of sc.loss) expect([...l].every(Number.isFinite)).toBe(true);
	});

	test("units are uncensored active days; no training days leaves them unscored", () => {
		const s = series(21);
		for (let d = 0; d < 21; d++) if (d !== 4) s.units[d * DAY + 50] = 1;
		s.censored[12 * DAY] = 1;
		const sc = scoreJitter(input(s));
		expect(sc.units).not.toContain(4);
		expect(sc.units).not.toContain(12);
		expect(sc.units.length).toBe(19);
		const one = series(7);
		for (let d = 0; d < 7; d++) one.units[d * DAY + 50] = 1;
		const o = scoreJitter(input(one));
		for (const l of o.loss) expect([...l].every(Number.isNaN)).toBe(true);
	});
});
