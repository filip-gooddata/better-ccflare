import { describe, expect, it } from "bun:test";
import { PRESENT_PARTITION, partitionKey } from "../partition";
import {
	cleanDaysByWeekday,
	pairDistance,
	partitionFamily,
} from "../partition-family";

// four weeks: any split leaves a block of one weekday (4) or two (8) below 10
const FEW = [4, 4, 4, 4, 4, 4, 4];
const MANY = [12, 12, 12, 12, 12, 12, 12];

describe("pairDistance", () => {
	it("counts weekday pairs whose same-group relation differs, ignoring labels", () => {
		expect(pairDistance([1, 0, 0, 0, 0, 2, 2], [0, 1, 1, 1, 1, 2, 2])).toBe(0);
		// Mon joins Tue-Fri: 4 pairs change
		expect(pairDistance(PRESENT_PARTITION, [0, 0, 0, 0, 0, 1, 1])).toBe(4);
		// Tue-Fri joins Sat-Sun: 8 pairs
		expect(pairDistance(PRESENT_PARTITION, [0, 1, 1, 1, 1, 1, 1])).toBe(8);
		// Sat-Sun joins Mon: 2 pairs
		expect(pairDistance(PRESENT_PARTITION, [0, 1, 1, 1, 1, 0, 0])).toBe(2);
		// one group: 21 pairs minus the 7 already together
		expect(pairDistance(PRESENT_PARTITION, [0, 0, 0, 0, 0, 0, 0])).toBe(14);
	});
});

describe("partitionFamily", () => {
	it("today (no block reaches 10 clean days): P, three adjacent merges and one group, present first", () => {
		const f = partitionFamily(FEW);
		expect(f.candidates.map(partitionKey)).toEqual([
			"0111122",
			"0111100", // Sat-Sun+Mon, distance 2
			"0000011", // Mon+Tue-Fri, distance 4
			"0111111", // Tue-Fri+Sat-Sun, distance 8
			"0000000", // one group, distance 14
		]);
		expect(f.presentIndex).toBe(0);
		expect(f.preference).toEqual([0, 1, 2, 3, 4]);
	});

	it("always holds the present partition, even with no data", () => {
		const f = partitionFamily([0, 0, 0, 0, 0, 0, 0]);
		expect(partitionKey(f.candidates[f.presentIndex] ?? [])).toBe("0111122");
		expect(f.candidates.length).toBe(5);
	});

	it("adds every contiguous split of one present group whose blocks each hold >= 10 clean days", () => {
		const f = partitionFamily(MANY);
		const keys = f.candidates.map(partitionKey);
		// Tue-Fri splits into 2..4 contiguous blocks: 2^3 - 1 = 7; Sat|Sun: 1; Mon cannot split
		expect(keys.length).toBe(5 + 7 + 1);
		expect(keys).toContain("0122233"); // Tue | Wed-Fri
		expect(keys).toContain("0123455"); // Tue | Wed | Thu | Fri
		expect(keys).toContain("0111123"); // Sat | Sun
		// no refinement combined with a coarsening, no two groups split at once
		expect(keys).not.toContain("0122234");
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("gates each block on its own weekdays' clean days", () => {
		// Wed and Sun hold 9 clean days: any block that is Wed alone or Sun alone fails
		const f = partitionFamily([12, 12, 9, 12, 12, 12, 9]);
		const keys = f.candidates.map(partitionKey).sort();
		expect(keys).toEqual(
			[
				"0111122",
				"0111100",
				"0000011",
				"0111111",
				"0000000",
				"0122233", // Tue | Wed-Fri (12 | 33)
				"0112233", // Tue-Wed | Thu-Fri (21 | 24)
				"0111233", // Tue-Thu | Fri (33 | 12)
				"0122344", // Tue | Wed-Thu | Fri (12 | 21 | 12)
				"0112344", // Tue-Wed | Thu | Fri (21 | 12 | 12)
			].sort(),
		);
	});

	it("ranks by pair distance from present, ties to fewer groups", () => {
		const f = partitionFamily(MANY);
		const rank = new Map(
			f.candidates.map((c, i) => [partitionKey(c), f.preference[i]]),
		);
		// Sat | Sun: distance 1; Tue | Wed-Fri: distance 3; Tue-Wed | Thu-Fri: distance 4 (3 groups +1)
		expect(rank.get("0111122")).toBe(0);
		expect(rank.get("0111123")).toBe(1);
		expect(rank.get("0111100")).toBe(2);
		expect(rank.get("0122233")).toBe(3);
		// distance 4: Mon+Tue-Fri (2 groups) ranks before Tue-Wed | Thu-Fri (4 groups)
		expect(rank.get("0000011") as number).toBeLessThan(
			rank.get("0112233") as number,
		);
		const order = f.candidates.map((c) => pairDistance(PRESENT_PARTITION, c));
		for (let i = 1; i < order.length; i++)
			expect(order[i] as number).toBeGreaterThanOrEqual(order[i - 1] as number);
	});
});

describe("cleanDaysByWeekday", () => {
	it("counts uncensored days per weekday", () => {
		const day = (weekday: number, censored: boolean) => ({ weekday, censored });
		expect(
			cleanDaysByWeekday([
				day(0, false),
				day(0, true),
				day(6, false),
				day(6, false),
			]),
		).toEqual([1, 0, 0, 0, 0, 0, 2]);
	});
});
