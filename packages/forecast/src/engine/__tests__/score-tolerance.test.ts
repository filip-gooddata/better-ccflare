/**
 * Ties in the plan score (design amendment 5, E2, review round 1): two plans tie on a score item when
 * it differs by at most 0.5 points, wherever the values sit; the next item then decides.
 */
import { describe, expect, test } from "bun:test";
import {
	compareScores,
	decidingReason,
	openingBeam,
	openingEarns,
	type PlanScore,
} from "../planner";

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

describe("tolerance boundary at each score item", () => {
	// `up` is better by `by` points on one item and carries one departure; on a tie, `base` (no
	// departure) is chosen, else `up`.
	const items = [
		["S", (v: number) => ({ lowPoint: 10 + v, dayLowPoints: 10 + v })],
		[
			"the other limit's low",
			(v: number) => ({ otherLow: 50 + v, weekLowPoints: 50 + v }),
		],
		["the typical low", (v: number) => ({ typicalLow: 30 + v })],
	] as const;
	for (const [name, raise] of items) {
		test(`${name}: 0.49 and 0.5 points tie, 0.51 decides`, () => {
			const up = (by: number) => score({ ...raise(by), departures: 1 });
			expect(compareScores(base, up(0.49))).toBeLessThan(0);
			expect(compareScores(base, up(0.5))).toBeLessThan(0);
			expect(compareScores(up(0.51), base)).toBeLessThan(0);
		});

		test(`${name}: 0.02 points across a 0.5 multiple tie; 0.49 points between two multiples tie`, () => {
			const at = (v: number, departures: number) =>
				score({ ...raise(v), departures });
			// 9.99 and 10.01 (or 49.99 and 50.01, 29.99 and 30.01) sit on either side of a multiple of 0.5.
			expect(compareScores(at(-0.01, 0), at(0.01, 1))).toBeLessThan(0);
			expect(compareScores(at(0.01, 0), at(0.49, 1))).toBeLessThan(0);
		});
	}

	test("the gate for an opening still reads raw S: 0.99 points does not earn, 1 does", () => {
		expect(
			openingEarns(score({ lowPoint: 10.99 }), score({ lowPoint: 10 }), 1),
		).toBe(false);
		// The gain is the raw difference wherever the values sit, not a count of tolerance steps.
		expect(
			openingEarns(score({ lowPoint: 11.24 }), score({ lowPoint: 10.24 }), 1),
		).toBe(true);
	});
});

describe("2026-11-13 10:40 like-for-like (handoff flag)", () => {
	// Scores from lowpoint-evidence/REPORT.md section 3 (new engine at 72856fb0, with sessions):
	// on demand and the preference plan share S (five-hour) -488.16; weekly lows -47.55 and -47.38
	// (0.17 apart); typical lows -54.67 and -56.88; departures 0 and 1.
	const onDemand: PlanScore = {
		lowPoint: -488.16,
		otherLow: -47.55,
		dayLowPoints: -488.16,
		weekLowPoints: -47.55,
		typicalLow: -54.67,
		departures: 0,
		poolPoints: 200,
	};
	const preference: PlanScore = {
		...onDemand,
		otherLow: -47.38,
		weekLowPoints: -47.38,
		typicalLow: -56.88,
		departures: 1,
	};

	test("on demand wins: the weekly lows tie (0.17 < 0.5), the typical low decides by 2.21", () => {
		expect(compareScores(onDemand, preference)).toBeLessThan(0);
		expect(compareScores(preference, onDemand)).toBeGreaterThan(0);
		expect(decidingReason(onDemand, preference)).toBe("typical-low+2.2");
	});
});

describe("opening beam", () => {
	const up = (lowPoint: number, typicalLow = 30) =>
		score({ lowPoint, dayLowPoints: lowPoint, typicalLow, departures: 1 });

	test("the beam does not depend on the order of the singles", () => {
		// Two singles at 12 and 13 have the same score; the earlier opening goes first.
		const singles = [
			{ at: 13, score: up(10.2, 31) },
			{ at: 11, score: up(10.1, 33) },
			{ at: 12, score: up(10.2, 31) },
			{ at: 14, score: up(9.4, 40) },
		];
		const want = [11, 12, 13];
		const perms = (xs: typeof singles): (typeof singles)[] =>
			xs.length <= 1
				? [xs]
				: xs.flatMap((x, i) =>
						perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [
							x,
							...rest,
						]),
					);
		for (const order of perms(singles))
			expect(openingBeam(order, base, 5)).toEqual(want);
	});
});
