import { expect, test } from "bun:test";
import { quantile } from "simple-statistics";

test("simple-statistics is installed and computes a known quantile", () => {
	expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
});
