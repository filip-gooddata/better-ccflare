/**
 * The planner's score S (design amendment 5, E2): the lowest point of the heavy day with unserved
 * demand counted below zero, per simulated day, the limit closer to zero counting.
 */
import { describe, expect, test } from "bun:test";
import type { EngineContext, SimulationResult } from "../model";
import {
	compareScores,
	openingEarns,
	type PlanScore,
	scorePlan,
} from "../planner";
import { onDemandPlan, simulate } from "../simulate";
import { account, HOUR, MIN, makeCtx, prague } from "./fixtures-sim";

const now = prague(12, 8);

/** Two accounts, mean 5-hour k 1 and mean weekly k 0.1: one unserved unit is 1 point of S. */
function ctxOf(): EngineContext {
	return makeCtx({
		now,
		days: 1,
		accounts: [account({ id: "acct-a" }), account({ id: "acct-b" })],
		k5: { "acct-a": 1, "acct-b": 1 },
		kW: { "acct-a": 0.1, "acct-b": 0.1 },
		rate: () => 0,
	});
}

/** A result with the given per-day 5-hour lines and unserved units; weekly lines stay far from zero. */
function resultOf(
	days: { day: number[]; unserved: number[] }[],
): SimulationResult {
	const length = days[0].day.length;
	return {
		axis: { times: Array.from({ length }, (_, i) => now + i * 5 * MIN) },
		accounts: ["acct-a", "acct-b"],
		traces: days.map((d) => ({
			day: Float32Array.from(d.day),
			week: new Float32Array(length).fill(150),
			unserved: Float32Array.from(d.unserved),
			outs: [],
			fableOutAt: [null, null],
			opens: [],
		})),
	};
}

function repeat<T>(count: number, make: (s: number) => T): T[] {
	return Array.from({ length: count }, (_, s) => make(s));
}

describe("score S: the unfloored low point (amendment 5, E2)", () => {
	test("equal stop length, 30 points short against 5 points short: S prefers the second by 25", () => {
		const ctx = ctxOf();
		const day = [200, 100, 0, 0, 50];
		const short30 = scorePlan(
			ctx,
			resultOf(repeat(10, () => ({ day, unserved: [0, 0, 0, 30, 0] }))),
		);
		const short5 = scorePlan(
			ctx,
			resultOf(repeat(10, () => ({ day, unserved: [0, 0, 0, 5, 0] }))),
		);
		expect(short30.lowPoint).toBeCloseTo(-30, 5);
		expect(short5.lowPoint).toBeCloseTo(-5, 5);
		expect(short5.lowPoint - short30.lowPoint).toBeCloseTo(25, 5);
		expect(compareScores(short5, short30)).toBeLessThan(0);
	});

	test("per day, not pointwise: ten days each 50 points short at a different time score -50 (the pointwise heavy line's low would be 40)", () => {
		const ctx = ctxOf();
		const days = repeat(10, (s) => {
			const day = new Array(12).fill(100);
			const unserved = new Array(12).fill(0);
			day[s + 1] = 0;
			unserved[s + 1] = 50;
			return { day, unserved };
		});
		const score = scorePlan(ctx, resultOf(days));
		expect(score.dayLowPoints).toBeCloseTo(-50, 5);
		expect(score.lowPoint).toBeCloseTo(-50, 5);
	});

	test("unserved demand is lost and stays counted: the line after the loss is lowered for the rest of the day", () => {
		const ctx = ctxOf();
		const score = scorePlan(
			ctx,
			resultOf(
				repeat(10, () => ({
					day: [100, 0, 100, 30],
					unserved: [0, 20, 0, 0],
				})),
			),
		);
		// 0 - 20 at the loss; later 30 - 20 = 10 is higher, so the low is -20.
		expect(score.lowPoint).toBeCloseTo(-20, 5);
		const later = scorePlan(
			ctx,
			resultOf(
				repeat(10, () => ({ day: [100, 0, 100, 10], unserved: [0, 20, 0, 0] })),
			),
		);
		expect(later.lowPoint).toBeCloseTo(-20, 5);
		const deeper = scorePlan(
			ctx,
			resultOf(
				repeat(10, () => ({ day: [100, 0, 100, 5], unserved: [0, 20, 0, 0] })),
			),
		);
		expect(deeper.dayLowPoints).toBeCloseTo(-20, 5);
	});

	test("a Fable-only shortage leaves S unchanged", async () => {
		const build = (fableUsed: number) =>
			makeCtx({
				now,
				days: 1,
				accounts: [
					account({
						id: "acct-a",
						fiveReset: now + 2 * HOUR,
						fableUsed,
						fableReset: now + 72 * HOUR,
					}),
					account({ id: "acct-b" }),
				],
				k5: { "acct-a": 1, "acct-b": 1 },
				kF: { "acct-a": 1, "acct-b": null },
				fableShare: 0.5,
				rate: (_m, _w, at) => (at < now + 2 * HOUR ? 0.2 : 0),
			});
		const short = build(95);
		const ample = build(0);
		const shortSim = await simulate(short, onDemandPlan(short));
		const ampleSim = await simulate(ample, onDemandPlan(ample));
		expect(shortSim.traces[0].fableOutAt[0]).not.toBeNull();
		expect(ampleSim.traces[0].fableOutAt[0]).toBeNull();
		expect(scorePlan(short, shortSim).lowPoint).toBe(
			scorePlan(ample, ampleSim).lowPoint,
		);
	});
});

describe("score order and gates (amendment 5, E2 and E3)", () => {
	const base: PlanScore = {
		lowPoint: 10,
		otherLow: 50,
		dayLowPoints: 10,
		weekLowPoints: 50,
		typicalLow: 30,
		departures: 0,
		poolPoints: 200,
	};
	const score = (over: Partial<PlanScore>): PlanScore => ({ ...base, ...over });

	test("S higher first when it differs by more than 0.5 points, whatever the rest", () => {
		const a = score({
			lowPoint: 10.6,
			otherLow: 0,
			typicalLow: 0,
			departures: 3,
		});
		expect(compareScores(a, base)).toBeLessThan(0);
	});

	test("S within 0.5 points: the other limit's low decides", () => {
		const a = score({ lowPoint: 10.4, otherLow: 49 });
		const b = score({ otherLow: 51 });
		expect(compareScores(b, a)).toBeLessThan(0);
	});

	test("S and the other low within 0.5 points: the typical day's unfloored low decides", () => {
		const a = score({ lowPoint: 10.4, otherLow: 50.4, typicalLow: 29 });
		expect(compareScores(base, a)).toBeLessThan(0);
	});

	test("then fewer departures from on demand", () => {
		const a = score({
			lowPoint: 10.4,
			otherLow: 50.4,
			typicalLow: 30.4,
			departures: 1,
		});
		expect(compareScores(base, a)).toBeLessThan(0);
		expect(compareScores(a, score({ departures: 2 }))).toBeLessThan(0);
	});

	test("openMinGainPoints gates an opening and a hold alike: the gain in S", () => {
		// A plan's opening time can be earlier (an opening) or later (a hold) than on demand; the gate
		// reads only S.
		expect(openingEarns(score({ lowPoint: 10.9 }), base, 1)).toBe(false);
		expect(openingEarns(score({ lowPoint: 11 }), base, 1)).toBe(true);
		expect(openingEarns(score({ lowPoint: 56 }), base, 50)).toBe(false);
		expect(openingEarns(score({ lowPoint: 60 }), base, 50)).toBe(true);
		// The other low, the typical low and departures never earn an opening.
		expect(
			openingEarns(
				score({ lowPoint: 10.4, otherLow: 90, typicalLow: 90 }),
				base,
				0.5,
			),
		).toBe(false);
	});
});

describe("score order is transitive (advisor point 3)", () => {
	const score = (lowPoint: number, otherLow: number): PlanScore => ({
		lowPoint,
		otherLow,
		dayLowPoints: lowPoint,
		weekLowPoints: otherLow,
		typicalLow: 30,
		departures: 0,
		poolPoints: 200,
	});
	// Pairwise "within 0.5" made A beat B (other low), B beat C (other low) and C beat A (S by 0.8).
	const a = score(0, 2);
	const b = score(0.4, 1);
	const c = score(0.8, 0);

	test("S by its 0.5-point bin: C (bin 1) first, then A before B (same bin, other low)", () => {
		expect(compareScores(c, a)).toBeLessThan(0);
		expect(compareScores(a, b)).toBeLessThan(0);
		expect(compareScores(c, b)).toBeLessThan(0);
	});

	test("every input order sorts to the same order", () => {
		const orders = [
			[a, b, c],
			[a, c, b],
			[b, a, c],
			[b, c, a],
			[c, a, b],
			[c, b, a],
		];
		for (const order of orders)
			expect([...order].sort(compareScores)).toEqual([c, a, b]);
	});
});
