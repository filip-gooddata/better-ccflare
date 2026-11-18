import { describe, expect, test } from "bun:test";
import { localParts } from "../../time";
import type { SimulationResult } from "../model";
import { localMarks, localPeaks, refineMarks } from "../opening-grid";
import {
	openingBeam,
	openingCombinationCount,
	openingCombinations,
	openingReason,
	type PlanScore,
	planForecast,
	REASON_MIN_GAIN_POINTS,
	REPORT_STEP_POINTS,
} from "../planner";
import { simulate } from "../simulate";
import { account, HOUR, MIN, makeCtx, prague, session } from "./fixtures-sim";

const PRAGUE = "Europe/Prague";

describe("local quarter-hour marks", () => {
	test("a fall-back day keeps both occurrences of the repeated hour", () => {
		// 2026-10-25 03:00 CEST becomes 02:00 CET (01:00 UTC); start at local midnight, 22:00 UTC.
		const from = Date.UTC(2026, 9, 24, 22);
		const marks = localMarks(from, from + 24 * HOUR - 1, 15, PRAGUE);
		expect(marks.length).toBe(96);
		expect(new Set(marks).size).toBe(96);
		const twoAm = marks.filter(
			(t) => Math.floor(localParts(t, PRAGUE).minuteOfDay / 60) === 2,
		);
		expect(twoAm.length).toBe(8);
		expect(twoAm[0]).toBe(Date.UTC(2026, 9, 25, 0));
		expect(twoAm[4]).toBe(Date.UTC(2026, 9, 25, 1));
		for (const t of marks)
			expect(localParts(t, PRAGUE).minuteOfDay % 15).toBe(0);
	});

	test("a spring-forward day invents no mark in the skipped hour", () => {
		// 2026-03-29 02:00 CET becomes 03:00 CEST (01:00 UTC); start at local midnight, 23:00 UTC.
		const from = Date.UTC(2026, 2, 28, 23);
		const marks = localMarks(from, from + 24 * HOUR - 1, 15, PRAGUE);
		expect(marks.length).toBe(96);
		expect(
			marks.filter(
				(t) => Math.floor(localParts(t, PRAGUE).minuteOfDay / 60) === 2,
			),
		).toEqual([]);
		expect(marks).toContain(Date.UTC(2026, 2, 29, 1));
	});

	test("marks start at the first whole minute and end inclusive", () => {
		const from = prague(12, 7, 0, 30);
		const marks = localMarks(from, prague(12, 8), 15, PRAGUE);
		expect(marks).toEqual([
			prague(12, 7, 15),
			prague(12, 7, 30),
			prague(12, 7, 45),
			prague(12, 8),
		]);
	});

	test("refinement adds the 5-minute marks within 10 minutes of a peak, inside [now, end)", () => {
		const now = prague(12, 7);
		const end = now + 24 * HOUR;
		expect(refineMarks(prague(12, 8, 30), now, end, PRAGUE)).toEqual([
			prague(12, 8, 20),
			prague(12, 8, 25),
			prague(12, 8, 35),
			prague(12, 8, 40),
		]);
		// At now: nothing before now.
		expect(refineMarks(now, now, end, PRAGUE)).toEqual([
			prague(12, 7, 5),
			prague(12, 7, 10),
		]);
		// At the last quarter mark before end: nothing at or after end.
		expect(refineMarks(end - 15 * MIN, now, end, PRAGUE)).toEqual([
			end - 25 * MIN,
			end - 20 * MIN,
			end - 10 * MIN,
			end - 5 * MIN,
		]);
		const odd = prague(12, 7, 2);
		expect(refineMarks(odd, odd, end, PRAGUE)).toEqual([
			prague(12, 7, 5),
			prague(12, 7, 10),
		]);
	});
});

describe("local peaks of a score curve", () => {
	test("a point ranked before both neighbours is a peak; edges compare one side", () => {
		const rank = new Map([
			[1, 6],
			[2, 3],
			[3, 4],
			[4, 5],
			[5, 0],
			[6, 2],
			[7, 1],
		]);
		expect(localPeaks([1, 2, 3, 4, 5, 6, 7], (x) => rank.get(x) ?? 0)).toEqual([
			2, 5, 7,
		]);
		expect(localPeaks([9], () => 0)).toEqual([9]);
		expect(localPeaks([], () => 0)).toEqual([]);
	});
});

describe("opening beam: every peak of the single-opening curve", () => {
	const base: PlanScore = {
		lowPoint: 0,
		otherLow: 180,
		dayLowPoints: 0,
		weekLowPoints: 180,
		typicalLow: 40,
		departures: 0,
		poolPoints: 200,
	};
	const at = (t: number, lowPoint: number) => ({
		at: t,
		score: { ...base, lowPoint, dayLowPoints: lowPoint },
	});
	// S by time: 1, 3, 2, 2, 5, 4, 4.5. Peaks at 2, 5 and 7, best single first.
	const singles = [
		at(1, 1),
		at(2, 3),
		at(3, 2),
		at(4, 2),
		at(5, 5),
		at(6, 4),
		at(7, 4.5),
	];

	test("the beam is every local peak in order of single score, whatever the input order", () => {
		expect(openingBeam(singles, base, 10)).toEqual([5, 7, 2]);
		expect(openingBeam([...singles].reverse(), base, 10)).toEqual([5, 7, 2]);
	});

	test("an opening that earns its place alone joins when no peak earns", () => {
		// Only opening 5 earns at 5 points, and it is a peak: nothing joins.
		expect(openingBeam(singles, base, 5)).toEqual([5, 7, 2]);
		// A plateau: the earliest of equal scores is the peak.
		const flat = [at(1, 2), at(2, 2), at(3, 2)];
		expect(openingBeam(flat, base, 10)).toEqual([1]);
	});
});

describe("row 53: the placement-reason threshold comes from the reported step", () => {
	test("the threshold is half the reported step, so a named gain never prints as 0.0", () => {
		expect(REPORT_STEP_POINTS).toBe(0.1);
		expect(REASON_MIN_GAIN_POINTS).toBe(REPORT_STEP_POINTS / 2);
		for (let g = REASON_MIN_GAIN_POINTS; g < 1; g += 0.001)
			expect(openingReason(g)).not.toBe("open-ahead+0.0");
		expect(openingReason(REASON_MIN_GAIN_POINTS)).toBe("open-ahead+0.1");
		expect(openingReason(REASON_MIN_GAIN_POINTS - 1e-6)).toBeNull();
	});
});

/** Three accounts: acct-a open with two warm sessions, acct-b and acct-c closed; a heavy afternoon. */
function threeAccounts() {
	const now = prague(12, 7, 30);
	const weekReset = prague(13, 20);
	return makeCtx({
		now,
		days: 20,
		spread: 0.1,
		accounts: [
			account({
				id: "acct-a",
				fiveUsed: 40,
				fiveReset: prague(12, 10),
				weekUsed: 10,
				weekReset,
			}),
			account({ id: "acct-b", weekUsed: 10, weekReset }),
			account({ id: "acct-c", weekUsed: 10, weekReset }),
		],
		rate: (m, w) => {
			if (w > 5) return 0;
			if (m >= 480 && m < 795) return 0.9;
			if (m >= 795 && m < 960) return 1.4;
			return 0;
		},
		sessions: [
			session({
				sessionId: "s1",
				accountId: "acct-a",
				lastRequestAt: now - MIN,
				recentUnits: 5,
			}),
			session({
				sessionId: "s2",
				accountId: "acct-a",
				lastRequestAt: now - 2 * MIN,
				recentUnits: 3,
			}),
		],
		settings: { prewarm: true },
		workStartMinute: 480,
	});
}

describe("planForecast search bounded by a deadline", () => {
	test("unbounded: the grid, its refinement, every combination and every move are searched", async () => {
		const { search } = await planForecast(threeAccounts());
		expect(search.stage1).toBe(96);
		expect(search.stage2).toBeGreaterThan(0);
		expect(Object.keys(search.peaks).sort()).toEqual(["acct-b", "acct-c"]);
		expect(search.peaks["acct-b"]).toBeGreaterThan(0);
		expect(search.combos.evaluated).toBe(search.combos.available);
		// Both closed accounts carry at least one peak, so combinations of two openings exist.
		expect(search.combos.available).toBeGreaterThanOrEqual(3);
		// Two warm sessions, each movable to the two closed accounts.
		expect(search.moves).toEqual({ evaluated: 4, available: 4 });
		// Refinement's first pass scans every closed account's full grid (and no opening as well).
		expect(search.refine.passes).toBeGreaterThanOrEqual(1);
		expect(search.refine.evaluated).toBeGreaterThanOrEqual(
			2 * (search.stage1 + 1),
		);
		expect(search.cutByDeadline).toBe(false);
		expect(search.elapsedMs).toBeGreaterThanOrEqual(0);
	}, 60_000);

	test("a passed deadline cuts multi-opening combinations and moves; the plan stays valid", async () => {
		const ctx = threeAccounts();
		const unbounded = await planForecast(ctx);
		let clock = 0;
		const bounded = await planForecast(ctx, {
			now: () => clock++,
			deadline: 0,
		});
		const { search } = bounded;
		expect(search.cutByDeadline).toBe(true);
		expect(search.stage1).toBe(unbounded.search.stage1);
		expect(search.stage2).toBe(unbounded.search.stage2);
		expect(search.peaks).toEqual(unbounded.search.peaks);
		// Single openings always complete; no combination of two or more is simulated.
		const singleRows = Object.values(search.peaks).reduce(
			(sum, p) => sum + p,
			0,
		);
		expect(search.combos.evaluated).toBeLessThan(search.combos.available);
		expect(search.combos.evaluated).toBeLessThanOrEqual(singleRows + 2);
		expect(search.moves).toEqual({ evaluated: 0, available: 4 });
		expect(search.refine.evaluated).toBe(0);
		expect(search.elapsedMs).toBeGreaterThan(0);
		// A valid plan: every closed account named, placement and no move.
		expect(Object.keys(bounded.plan.openAt).sort()).toEqual([
			"acct-b",
			"acct-c",
		]);
		expect(bounded.plan.placement.tiers.flat().sort()).toEqual([
			"acct-a",
			"acct-b",
			"acct-c",
		]);
		expect(bounded.plan.moves).toEqual([]);
		const opened = Object.values(bounded.plan.openAt).filter((v) => v != null);
		if (opened.length > 0)
			expect(
				bounded.score.lowPoint - bounded.baseline.score.lowPoint,
			).toBeGreaterThanOrEqual(ctx.input.settings.openMinGainPoints - 1e-9);
	}, 60_000);

	test("a deadline far ahead cuts nothing", async () => {
		const ctx = threeAccounts();
		const { search } = await planForecast(ctx, {
			deadline: performance.now() + 3_600_000,
		});
		expect(search.cutByDeadline).toBe(false);
		expect(search.combos.evaluated).toBe(search.combos.available);
		expect(search.moves.evaluated).toBe(search.moves.available);
	}, 60_000);
});

describe("the search keeps scores, not simulations", () => {
	test("after a full-grid plan only the baseline and the chosen plan's simulations stay reachable", async () => {
		const ctx = makeCtx({
			now: prague(12, 7, 30),
			days: 5,
			accounts: [
				account({ id: "acct-a", fiveUsed: 40, fiveReset: prague(12, 10) }),
				account({ id: "acct-b" }),
			],
			rate: (m, w) => (w <= 5 && m >= 480 && m < 960 ? 0.9 : 0),
		});
		const made: WeakRef<SimulationResult>[] = [];
		let aliveMidSearch = Number.NaN;
		const spy: typeof simulate = async (c, plan) => {
			if (made.length === 60) {
				// mid-search, before the 61st simulation: earlier ones the search no longer needs are gone
				Bun.gc(true);
				aliveMidSearch = made.filter((ref) => ref.deref() !== undefined).length;
			}
			const result = await simulate(c, plan);
			made.push(new WeakRef(result));
			return result;
		};
		const value = await planForecast(ctx, { simulate: spy });
		expect(aliveMidSearch).toBeLessThanOrEqual(4);
		// One simulation per candidate, and one more for the chosen plan unless it is the baseline.
		expect(value.candidates).toBeGreaterThan(value.search.stage1);
		expect(made.length).toBeGreaterThanOrEqual(value.candidates);
		Bun.gc(true);
		const alive = made.filter((ref) => ref.deref() !== undefined).length;
		// The two the result returns (baseline and chosen), with slack for references the collector
		// scans conservatively. Keeping every candidate would leave about a hundred reachable.
		expect(alive).toBeLessThanOrEqual(4);
		expect(value.result.traces.length).toBe(5);
		expect(value.baseline.result.traces.length).toBe(5);
	}, 60_000);
});

describe("opening combinations are generated lazily, in order of single score", () => {
	/** The order before the generator: the whole product, sorted. */
	function sortedProduct(lens: number[]): number[][] {
		let rows: number[][] = [[]];
		for (const len of lens)
			rows = rows.flatMap((row) =>
				[-1, ...Array.from({ length: len }, (_, i) => i)].map((i) => [
					...row,
					i,
				]),
			);
		const opened = (row: number[]) => row.filter((i) => i >= 0).length;
		const rankSum = (row: number[]) =>
			row.reduce((sum, i) => sum + (i >= 0 ? i : 0), 0);
		return rows
			.filter((row) => opened(row) > 0)
			.sort(
				(a, b) =>
					Math.min(opened(a), 2) - Math.min(opened(b), 2) ||
					rankSum(a) - rankSum(b) ||
					a.reduce((d, i, x) => d || i - b[x], 0),
			);
	}
	const beamsOf = (lens: number[]) =>
		lens.map((len) => Array.from({ length: len }, (_, i) => 1000 + i));

	test("the same rows in the same order as sorting the whole product", () => {
		for (const lens of [[1], [3], [2, 3], [3, 1, 4], [2, 2, 2], [1, 1, 1, 1]]) {
			const beams = beamsOf(lens);
			expect([...openingCombinations(beams)]).toEqual(sortedProduct(lens));
			expect(openingCombinationCount(beams)).toBe(sortedProduct(lens).length);
		}
		expect([...openingCombinations([])]).toEqual([]);
		expect(openingCombinationCount([])).toBe(0);
	});

	test("six accounts with eight peaks each: the first rows come without building the product", () => {
		const beams = beamsOf([8, 8, 8, 8, 8, 8]);
		expect(openingCombinationCount(beams)).toBe(9 ** 6 - 1);
		const first: number[][] = [];
		for (const row of openingCombinations(beams)) {
			first.push(row);
			if (first.length === 60) break;
		}
		// 48 single rows, then the two-opening rows with position sum 0, last two accounts first
		expect(first.slice(0, 2)).toEqual([
			[-1, -1, -1, -1, -1, 0],
			[-1, -1, -1, -1, 0, -1],
		]);
		expect(first[48]).toEqual([-1, -1, -1, -1, 0, 0]);
		expect(first[49]).toEqual([-1, -1, -1, 0, -1, 0]);
	});
});

/** The 2026-11-12 shape on few days: both accounts closed, work from 11:00, a heavier afternoon. */
function nov12Few() {
	const now = prague(12, 7, 30);
	const weekReset = prague(13, 20);
	return makeCtx({
		now,
		days: 5,
		spread: 0.1,
		accounts: [
			account({ id: "acct-a", weekUsed: 10, weekReset }),
			account({ id: "acct-b", weekUsed: 10, weekReset }),
		],
		kW: { "acct-a": 0.05, "acct-b": 0.05 },
		rate: (m, w) => {
			if (w > 5) return 0;
			if (m >= 660 && m < 795) return 0.68;
			if (m >= 795 && m < 960) return 0.945;
			return 0;
		},
		settings: { prewarm: true },
		workStartMinute: 660,
	});
}

describe("a deadline that passes during refinement", () => {
	test("keeps the best of the part already scanned", async () => {
		const ctx = nov12Few();
		// A clock that advances one tick per reading: the search reads it once at the start, before
		// each combination of two or more openings, each refinement candidate and each move, and at
		// the end, so the same context gives the same readings.
		const counting = () => {
			let reads = 0;
			return () => reads++;
		};
		const full = await planForecast(ctx, { now: counting() });
		expect(full.search.refine.improved).toBeGreaterThanOrEqual(1);
		expect(full.search.moves.evaluated).toBe(0);
		const multiRows =
			full.search.elapsedMs + 1 - 2 - full.search.refine.evaluated;
		const cutAt = async (refineCandidates: number) =>
			planForecast(ctx, {
				now: counting(),
				deadline: multiRows + 1 + refineCandidates,
			});
		const none = await cutAt(0);
		expect(none.search.refine.evaluated).toBe(0);
		expect(none.search.cutByDeadline).toBe(true);
		const part = await cutAt(60);
		expect(part.search.refine.evaluated).toBe(60);
		expect(part.search.cutByDeadline).toBe(true);
		expect(part.search.refine.improved).toBe(1);
		expect(part.score.lowPoint).toBeGreaterThan(none.score.lowPoint);
		expect(Object.keys(part.plan.openAt).sort()).toEqual(["acct-a", "acct-b"]);
	}, 60_000);
});

describe("moves: every warm session with recent use, not the first three", () => {
	test("five warm sessions on the open account give ten move candidates, all tried", async () => {
		const ctx = threeAccounts();
		const now = ctx.now;
		const sessions = [5, 4, 3, 2, 1].map((units, i) =>
			session({
				sessionId: `s${i + 1}`,
				accountId: "acct-a",
				lastRequestAt: now - (i + 1) * 10_000,
				recentUnits: units,
			}),
		);
		const { search } = await planForecast({
			...ctx,
			input: { ...ctx.input, sessions },
		});
		expect(search.moves).toEqual({ evaluated: 10, available: 10 });
	}, 60_000);
});
