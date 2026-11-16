/**
 * Best-anchored tolerance selection (design amendment 5, E2, review round 1): at each score item the
 * plans within 0.5 points of the best value still in play stay; the rest drop. One rule ranks
 * candidate plans, the opening beam and the placement tiers.
 */
import { describe, expect, test } from "bun:test";
import {
	decidingReason,
	type PlanScore,
	rankTiers,
	selectBest,
} from "../planner";

const score = (
	lowPoint: number,
	otherLow: number,
	typicalLow = 30,
	departures = 0,
): PlanScore => ({
	lowPoint,
	otherLow,
	dayLowPoints: lowPoint,
	weekLowPoints: otherLow,
	typicalLow,
	departures,
	poolPoints: 200,
});

type Item = { name: string; score: PlanScore };
const scoreOf = (x: Item) => x.score;
const keyOf = (x: Item) => x.name;

function permutations<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs];
	return xs.flatMap((x, i) =>
		permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [
			x,
			...rest,
		]),
	);
}

const names = (tiers: { item: Item }[][]) =>
	tiers.map((t) => t.map((x) => x.item.name));

describe("no cycle (advisor point 3)", () => {
	// Pairwise "within 0.5" made A beat B (other low), B beat C (other low) and C beat A (S by 0.8).
	const a = { name: "A", score: score(0, 2) };
	const b = { name: "B", score: score(0.4, 1) };
	const c = { name: "C", score: score(0.8, 0) };

	test("S keeps B and C (within 0.5 of C's 0.8), A drops; the other low then picks B", () => {
		expect(selectBest([a, b, c], scoreOf, keyOf)).toBe(b);
		// Among A and C, S decides (0.8 against 0).
		expect(names(rankTiers([a, b, c], scoreOf, keyOf))).toEqual([
			["B"],
			["C"],
			["A"],
		]);
	});

	test("every input order gives the same choice and the same tiers", () => {
		for (const order of permutations([a, b, c])) {
			expect(selectBest(order, scoreOf, keyOf)).toBe(b);
			expect(names(rankTiers(order, scoreOf, keyOf))).toEqual([
				["B"],
				["C"],
				["A"],
			]);
		}
	});
});

describe("tiers", () => {
	const plans: Item[] = [
		{ name: "p", score: score(10.0, 50, 30, 1) },
		{ name: "q", score: score(10.3, 50, 30, 0) },
		{ name: "r", score: score(10.3, 50, 30, 0) },
		{ name: "s", score: score(9.9, 49.4, 30, 0) },
		{ name: "t", score: score(9.7, 50, 30, 0) },
	];

	test("a tier holds every plan within tolerance at each item; inside it fewer departures, exact values, then key", () => {
		// S: best 10.3, keep >= 9.8: p q r s (t drops). Other low: best 50, keep >= 49.5: p q r (s
		// drops). Typical ties. Inside: q and r (0 departures, equal values, key q < r), then p.
		// Next tier from s, t: S best 9.9, both within; other low best 50 (t), s at 49.4 drops.
		// droppedAt is the item on which a plan left the selection of the tier before its own.
		const tiers = rankTiers(plans, scoreOf, keyOf);
		expect(names(tiers)).toEqual([["q", "r", "p"], ["t"], ["s"]]);
		expect(tiers[1][0].droppedAt).toBe("low-point");
		expect(tiers[2][0].droppedAt).toBe("other-low");
		expect(tiers[0][0].droppedAt).toBeNull();
	});

	test("the tiers do not depend on the input order", () => {
		for (const order of permutations(plans))
			expect(names(rankTiers(order, scoreOf, keyOf))).toEqual([
				["q", "r", "p"],
				["t"],
				["s"],
			]);
	});

	test("empty input", () => {
		expect(rankTiers([], scoreOf, keyOf)).toEqual([]);
		expect(selectBest([], scoreOf, keyOf)).toBeNull();
	});
});

describe("the reason names the item that dropped the next plan", () => {
	test("a plan that dropped on the other low against a third plan is named by the other low", () => {
		// top's other low 50.0; next 49.4 dropped against the best other low 50.0 in play.
		const top = score(10.0, 50.0);
		const next = score(10.3, 49.4);
		expect(decidingReason(top, next, "other-low")).toBe("weekly-low+0.6");
		// Pairwise (no stage given) the same two compare the same way.
		expect(decidingReason(top, next)).toBe("weekly-low+0.6");
	});

	test("the stage is reported even when the two differ there by under the tolerance", () => {
		// next dropped against a third plan's other low 50.4; top (50.0) stayed, 0.2 above next.
		expect(decidingReason(score(10, 50.0), score(10, 49.8), "other-low")).toBe(
			"weekly-low+0.2",
		);
	});
});
