import { describe, expect, it } from "bun:test";
import type { PaceFitState } from "../../engine/pace/types";
import { paceRefitLine } from "../pace-refit-log";

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const MIN = 60_000;

const state: PaceFitState = {
	fittedAt: T0,
	days: 84,
	weeks: 12,
	candidates: 101,
	floor: 10,
	cellsEstablished: 41,
	cellsTotal: 189,
	belowFloor: [
		{ band: "0-1h", feature: "span-60", units: 7 },
		{ band: "1-2h", feature: "day-k1", units: 9 },
	],
	selected: [{ band: "0-1h", feature: "span-60" }],
	dayTypeComparison: [
		{ partition: "present", groups: 3, loss: 0.41234, se: 0.03111 },
		{ partition: "one", groups: 1, loss: 0.5, se: 0.04 },
		{ partition: "workday-weekend", groups: 2, loss: 0.42, se: 0.031 },
		{
			partition: "merged:Mon|TueWedThuFri|SatSun",
			groups: 3,
			loss: 0.40001,
			se: 0.02999,
		},
	],
};

describe("pace refit log line", () => {
	it("reports a successful refit with counts, cells and the day-type comparison", () => {
		expect(
			paceRefitLine({ status: "ok", state, ms: 4210.6 }, null, T0 + MIN),
		).toBe(
			"forecast e4 refit status=ok ms=4211 cadenceMin=60 days=84 weeks=12 cells=41/189 belowFloor=2 candidates=101 floor=10" +
				" daytypes present=0.4123/0.03111 one=0.5/0.04 workday-weekend=0.42/0.031 merged=Mon|TueWedThuFri|SatSun:0.4/0.02999",
		);
	});

	it("writes daytypes=none when the fit compared no partitions", () => {
		const line = paceRefitLine(
			{ status: "ok", state: { ...state, dayTypeComparison: [] }, ms: 10 },
			null,
			T0,
		);
		expect(line.endsWith(" daytypes=none")).toBe(true);
	});

	it("reports a timeout with the reason and the age of the state kept", () => {
		expect(
			paceRefitLine(
				{ status: "timeout", ms: 120_000 },
				state,
				T0 + 61 * MIN + 20_000,
			),
		).toBe(
			"forecast e4 refit status=timeout ms=120000 cadenceMin=60 reason=timeout keptAgeMin=61",
		);
	});

	it("reports an error before any fit as keptAgeMin=none", () => {
		expect(
			paceRefitLine({ status: "error", reason: "fit-error", ms: 3 }, null, T0),
		).toBe(
			"forecast e4 refit status=error ms=3 cadenceMin=60 reason=fit-error keptAgeMin=none",
		);
	});
});
