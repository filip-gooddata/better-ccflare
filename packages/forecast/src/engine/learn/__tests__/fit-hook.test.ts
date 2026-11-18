import { describe, expect, test } from "bun:test";
import { fitPaceModel } from "../../pace";
import { at, makeSeries, plantedLevels } from "../../pace/__tests__/synth";
import { makePartitionFitter } from "../fit-hook";

describe("makePartitionFitter", () => {
	test("fits every partition once, memoized by normalized partition; present is today's fit", () => {
		const s = makeSeries(30, plantedLevels(30, 7));
		const now = at(29, 0);
		const fit = makePartitionFitter(s, now);
		const present = fit([1, 0, 0, 0, 0, 2, 2]);
		expect(fit([0, 1, 1, 1, 1, 2, 2])).toBe(present);
		expect(present).toEqual(fitPaceModel(s, now));
		const two = fit([5, 5, 5, 5, 5, 9, 9]);
		expect(fit([0, 0, 0, 0, 0, 1, 1])).toBe(two);
		expect(two.dayTypes?.group).toEqual([0, 0, 0, 0, 0, 1, 1]);
		expect(fit([0, 0, 0, 0, 0, 0, 0]).dayTypes?.names).toEqual(["all"]);
	}, 240_000);
});
