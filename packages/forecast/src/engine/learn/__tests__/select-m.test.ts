import { describe, expect, it } from "bun:test";
import { floorOf, Q } from "../../pace/fit";
import { selectRow } from "../select";
import type { RowScores } from "../types";

/** Two candidates, the second better on every one of n units by a varying margin. */
const two = (n: number, m?: number): RowScores<string> => ({
	row: "t",
	candidates: ["present", "x"],
	presentIndex: 0,
	preference: [0, 1],
	units: Array.from({ length: n }, (_, u) => u),
	loss: [
		Float64Array.from({ length: n }, (_, u) => 3 + (u % 3)),
		Float64Array.from({ length: n }, () => 1),
	],
	...(m === undefined ? {} : { m }),
});

describe("selectRow with a family size m (R3-2 nested confirmation)", () => {
	it("without m: m, floor and BH count the candidates", () => {
		const c = selectRow(two(10));
		expect(c.m).toBe(2);
		expect(c.floor).toBe(floorOf(2));
		expect(c.on).toBe(true);
	});

	it("m sets the floor: units enough for 2 candidates but below floorOf(m) stay present", () => {
		const n = floorOf(2);
		const m = 2 ** 6;
		expect(floorOf(m)).toBeGreaterThan(n);
		expect(selectRow(two(n)).on).toBe(true);
		const c = selectRow(two(n, m));
		expect(c.m).toBe(m);
		expect(c.floor).toBe(floorOf(m));
		expect(c.reason).toBe("below-floor");
		expect(c.served).toBe("present");
	});

	it("m counts m - 1 hypotheses in BH: a p that passes alone fails at Q / (m - 1)", () => {
		const n = 10;
		const alone = selectRow(two(n));
		expect(alone.on).toBe(true);
		// smallest m whose BH threshold for the single real hypothesis drops below its p
		const m = Math.ceil(Q / alone.p) + 2;
		expect(floorOf(m)).toBeLessThanOrEqual(n);
		const c = selectRow(two(n, m));
		expect(c.p).toBe(alone.p);
		expect(c.reason).toBe("bh");
		expect(c.on).toBe(false);
	});

	it("m no larger than the candidates changes nothing", () => {
		expect(selectRow(two(10, 2))).toEqual(selectRow(two(10)));
	});
});
