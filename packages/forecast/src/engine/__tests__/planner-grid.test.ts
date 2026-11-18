import { describe, expect, test } from "bun:test";
import { localParts } from "../../time";
import { localMarks, localPeaks, refineMarks } from "../opening-grid";
import {
	openingBeam,
	openingReason,
	type PlanScore,
	planForecast,
	REASON_MIN_GAIN_POINTS,
	REPORT_STEP_POINTS,
} from "../planner";
import type { SimulationResult } from "../model";
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
		const spy: typeof simulate = async (c, plan) => {
			const result = await simulate(c, plan);
			made.push(new WeakRef(result));
			return result;
		};
		const value = await planForecast(ctx, { simulate: spy });
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
