import { describe, expect, test } from "bun:test";
import {
	DEFAULT_FAN_LEVELS,
	FIXED_PERCENTILES,
	fanLevelsForCount,
	MAX_FAN_LEVEL_COUNT,
} from "../levels";

const EVERY_2_POINTS = [
	12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48,
	52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88,
];

describe("DEFAULT_FAN_LEVELS", () => {
	test("is the six levels PaceBar's three usage bands are drawn from", () => {
		expect([...DEFAULT_FAN_LEVELS]).toEqual([12, 24, 38, 62, 76, 88]);
	});
});

describe("fanLevelsForCount", () => {
	test("38 gives every 2 points 12…48 and 52…88", () => {
		expect(fanLevelsForCount(38)).toEqual(EVERY_2_POINTS);
	});

	test("6 gives 20, 30, 40, 60, 70, 80, not the default list", () => {
		expect(fanLevelsForCount(6)).toEqual([20, 30, 40, 60, 70, 80]);
	});

	test("0 gives no fan, 2 the midpoints of each half", () => {
		expect(fanLevelsForCount(0)).toEqual([]);
		expect(fanLevelsForCount(2)).toEqual([30, 70]);
	});

	test("rounds the lower half to whole points and mirrors it", () => {
		expect(fanLevelsForCount(4)).toEqual([23, 37, 63, 77]);
		expect(fanLevelsForCount(30)).toEqual([
			13, 15, 18, 20, 23, 25, 28, 30, 33, 35, 38, 40, 43, 45, 48, 52, 55, 57,
			60, 62, 65, 67, 70, 72, 75, 77, 80, 82, 85, 87,
		]);
	});

	test("the largest count is every whole point between the named levels", () => {
		expect(MAX_FAN_LEVEL_COUNT).toBe(78);
		expect(fanLevelsForCount(78)).toEqual([
			...Array.from({ length: 39 }, (_, i) => 11 + i),
			...Array.from({ length: 39 }, (_, i) => 51 + i),
		]);
	});

	test("every allowed count gives that many distinct, sorted, symmetric levels inside 10…90", () => {
		for (let n = 0; n <= MAX_FAN_LEVEL_COUNT; n += 2) {
			const levels = fanLevelsForCount(n);
			expect(levels).toHaveLength(n);
			for (let i = 1; i < levels.length; i++)
				expect(levels[i]).toBeGreaterThan(levels[i - 1] as number);
			for (const p of levels) {
				expect(Number.isInteger(p)).toBe(true);
				expect(p).toBeGreaterThan(10);
				expect(p).toBeLessThan(90);
				expect(FIXED_PERCENTILES).not.toContain(p);
			}
			expect(levels.map((p) => 100 - p).reverse()).toEqual(levels);
		}
	});

	test.each([
		[-2],
		[1],
		[7],
		[80],
		[6.5],
		[Number.NaN],
	])("rejects the count %p", (n) => {
		expect(() => fanLevelsForCount(n)).toThrow(RangeError);
	});
});
