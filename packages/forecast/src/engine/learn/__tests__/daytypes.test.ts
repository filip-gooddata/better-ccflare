import { describe, expect, it } from "bun:test";
import { at, makeSeries } from "../../pace/__tests__/synth";
import type { PaceFitState } from "../../pace/types";
import { partitionKey } from "../partition";
import { scoreDaytypes } from "../rows/daytypes";
import { selectRow } from "../select";
import type { LearnInput, Partition } from "../types";

const fake = (oof: Record<string, [number[], number[]]>) => {
	const calls: string[] = [];
	const fitWithPartition = (p: Partition): PaceFitState => {
		const key = partitionKey(p);
		calls.push(key);
		const [units, loss] = oof[key] ?? [[], []];
		return { oof: { units, loss } } as unknown as PaceFitState;
	};
	return { calls, fitWithPartition };
};

const input = (
	days: number,
	fitWithPartition: LearnInput["fitWithPartition"],
) =>
	({
		series: makeSeries(days, () => 1),
		now: at(days - 1, 12),
		workDays: 5,
		historyLookbackDays: 84,
		historyHalfLifeDays: 14,
		workStartSharePct: 5,
		timeShiftMin: 30,
		fitWithPartition,
	}) as LearnInput;

describe("scoreDaytypes", () => {
	it("scores every family member by its fit's out-of-fold loss per week, present first", () => {
		const W = [-1, -8, -15]; // three week units
		const f = fake({
			"0111122": [W, [3, 4, 5]],
			"0111100": [W, [2, 4, 6]],
			"0000011": [W, [1, 1, 1]],
			"0111111": [W, [9, 9, 9]],
			"0000000": [W.slice(0, 2), [7, 7]],
		});
		const s = scoreDaytypes(input(22, f.fitWithPartition));
		expect(s.row).toBe("daytypes");
		expect(s.candidates.map(partitionKey)).toEqual([
			"0111122",
			"0111100",
			"0000011",
			"0111111",
			"0000000",
		]);
		expect(s.presentIndex).toBe(0);
		expect(s.preference).toEqual([0, 1, 2, 3, 4]);
		expect(f.calls.sort()).toEqual(
			["0111122", "0111100", "0000011", "0111111", "0000000"].sort(),
		);
		expect(s.units).toEqual([-15, -8, -1]);
		expect(s.loss.map((l) => Array.from(l))).toEqual([
			[5, 4, 3],
			[6, 4, 2],
			[1, 1, 1],
			[9, 9, 9],
			[Number.NaN, 7, 7],
		]);
	});

	it("passes the present partition as E4's present calendar", () => {
		const f = fake({});
		scoreDaytypes(input(8, f.fitWithPartition));
		expect(f.calls).toContain("0111122");
	});

	it("with no out-of-fold units scores nothing and selection serves present", () => {
		const f = fake({});
		const s = scoreDaytypes(input(3, f.fitWithPartition));
		expect(s.units).toEqual([]);
		for (const l of s.loss) expect(l.length).toBe(0);
		const c = selectRow(s);
		expect(partitionKey(c.served)).toBe("0111122");
		expect(c.on).toBe(false);
	});

	it("adds refinements only when the window holds 10 clean days per block", () => {
		// 140 days (20 weeks): every weekday holds 19-20 clean days, every split qualifies
		const f = fake({});
		const s = scoreDaytypes(input(140, f.fitWithPartition));
		expect(s.candidates.length).toBe(13);
		expect(f.calls.length).toBe(13);
	});
});
