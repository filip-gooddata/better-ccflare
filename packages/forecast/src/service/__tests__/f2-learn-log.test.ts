import { describe, expect, it } from "bun:test";
import {
	type LearnedDemand,
	type LearnInput,
	learnDemand,
	presentDemand,
	type RowChoice,
} from "../../engine/learn";
import type { PaceSeries } from "../../engine/pace/types";
import { formatF2LearnLine } from "../f2-learn-log";

const SETTINGS = {
	historyLookbackDays: 84,
	historyHalfLifeDays: 14,
	workStartSharePct: 5,
	timeShiftMin: 30,
};

const choice = <V>(c: Partial<RowChoice<V>> & { row: string; present: V }) =>
	({
		m: 1,
		floor: 4,
		units: 0,
		chosen: c.present,
		runnerUp: null,
		served: c.present,
		presentLoss: Number.NaN,
		chosenLoss: Number.NaN,
		gain: 0,
		se: 0,
		p: 1,
		on: false,
		reason: "no-units",
		...c,
	}) as RowChoice<unknown>;

const learned = (choices: RowChoice<unknown>[]): LearnedDemand => ({
	...presentDemand(SETTINGS),
	choices,
});

describe("forecast f2 learn log line", () => {
	it("prints every stub row at its present value in registry order", () => {
		const input: LearnInput = {
			series: {
				start: 0,
				units: new Float64Array(0),
				censored: new Uint8Array(0),
				timeZone: "UTC",
			} as PaceSeries,
			now: 0,
			workDays: 5,
			...SETTINGS,
			fitWithPartition: () => {
				throw new Error("stub rows fit nothing");
			},
		};
		expect(formatF2LearnLine(learnDemand(input), 1234.4)).toBe(
			"forecast f2 learn ms=1234 rows=" +
				"daytypes:0111122/0111122/na/na/na/0/0/0/4/0," +
				"pool:h3/h3/na/na/na/0/0/0/4/0," +
				"lookback:84/84/na/na/na/0/0/0/4/0," +
				"halflife:14/14/na/na/na/0/0/0/4/0," +
				"wsshare:5/5/na/na/na/0/0/0/4/0," +
				"wssample:10/10/na/na/na/0/0/0/4/0," +
				"bandwidth:0/0/na/na/na/0/0/0/4/0," +
				"jitter:30/30/na/na/na/0/0/0/4/0",
		);
	});

	it("prints rows= with nothing after it for presentDemand", () => {
		expect(formatF2LearnLine(presentDemand(SETTINGS), 7.6)).toBe(
			"forecast f2 learn ms=8 rows=",
		);
	});

	it("prints a switched row with its losses, gain and SE in compact form", () => {
		const line = formatF2LearnLine(
			learned([
				choice({
					row: "halflife",
					m: 7,
					floor: 7,
					units: 64,
					present: 14,
					chosen: 28,
					runnerUp: Number.POSITIVE_INFINITY,
					served: 28,
					presentLoss: 0.123456,
					chosenLoss: 0.1,
					gain: 0.023456,
					se: 0.004,
					p: 0.001,
					on: true,
					reason: "on",
				}),
			]),
			250,
		);
		expect(line).toBe(
			"forecast f2 learn ms=250 rows=halflife:28/28/inf/0.1235/0.1/0.02346/0.004/64/7/1",
		);
	});

	it("normalizes partitions, writes infinity as inf, hard 3 as h3 and missing values as na", () => {
		const line = formatF2LearnLine(
			learned([
				choice({
					row: "daytypes",
					present: [1, 0, 0, 0, 0, 2, 2],
					chosen: [2, 2, 2, 2, 2, 5, 5],
					runnerUp: null,
					served: [1, 0, 0, 0, 0, 2, 2],
					presentLoss: Number.NaN,
					chosenLoss: Number.NaN,
					gain: -0.5,
					se: 0.25,
					units: 12,
					floor: 6,
				}),
				choice({
					row: "pool",
					present: "hard3",
					chosen: Number.POSITIVE_INFINITY,
					runnerUp: "hard3",
					served: "hard3",
					presentLoss: 1.5,
					chosenLoss: 1.25,
					gain: 0.25,
					se: 0.5,
					units: 30,
					floor: 7,
				}),
			]),
			3,
		);
		expect(line).toBe(
			"forecast f2 learn ms=3 rows=" +
				"daytypes:0111122/0000011/na/na/na/-0.5/0.25/12/6/0," +
				"pool:h3/inf/h3/1.5/1.25/0.25/0.5/30/7/0",
		);
	});

	it("writes no free text: unknown string values and odd row ids are masked", () => {
		const line = formatF2LearnLine(
			learned([choice({ row: "bad row=x", present: "secret" })]),
			1,
		);
		expect(line).toBe(
			"forecast f2 learn ms=1 rows=bad_row_x:na/na/na/na/na/0/0/0/4/0",
		);
	});
});
