import { describe, expect, it } from "bun:test";
import {
	makePartitionFitter,
	type Partition,
	type PartitionFitter,
	PRESENT_PARTITION,
	partitionKey,
	type RowChoice,
	selectRow,
} from "../../engine/learn";
import { scoreDaytypes } from "../../engine/learn/rows/daytypes";
import { buildPaceSeries } from "../../engine/pace";
import type { PaceFitState, PaceSeries } from "../../engine/pace/types";
import type { DemandBucket, EpochMs } from "../../types";
import { daytypesJob, refitJob, type SeriesJobPayload } from "../forecast-jobs";

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const BUCKET = 300_000;
const SETTINGS = {
	workDays: 5,
	historyLookbackDays: 84,
	historyHalfLifeDays: 14,
	workStartSharePct: 5,
	timeShiftMin: 30,
};

/** Weekday office hours with deterministic noise, as forecast-worker-real.test.ts builds it. */
function synthetic(days: number): PaceSeries {
	const n = (days * 24 * 60 * 60_000) / BUCKET;
	const historyFrom = T0 - n * BUCKET;
	const history: DemandBucket[] = Array.from({ length: n }, (_, i) => {
		const at = historyFrom + i * BUCKET;
		const hour = new Date(at).getUTCHours();
		const day = new Date(at).getUTCDay();
		const work = day >= 1 && day <= 5 && hour >= 7 && hour < 17;
		const units = work ? 1 + ((i * 7919) % 13) / 13 : ((i * 104729) % 5) / 50;
		return { start: at, units, fableUnits: 0, requests: units > 0 ? 1 : 0 };
	});
	return buildPaceSeries({
		history,
		historyFrom,
		now: T0,
		readings: [],
		accounts: ["a", "b"],
		timeZone: "Europe/Prague",
	});
}

const payloadOf = (series: PaceSeries): SeriesJobPayload => ({
	...series,
	now: T0,
	...SETTINGS,
});

/** Counts every fit; each call returns a distinct tagged state. Not memoized, so calls are fits. */
function countingFitter() {
	const fits: string[] = [];
	const make = (_series: PaceSeries, _now: EpochMs): PartitionFitter => {
		return (p) => {
			fits.push(partitionKey(p));
			return { tag: partitionKey(p) } as unknown as PaceFitState;
		};
	};
	return { fits, make };
}

const MON_FRI: Partition = [0, 0, 0, 0, 0, 1, 1];

const storedChoice: RowChoice<Partition> = {
	row: "daytypes",
	m: 3,
	floor: 4,
	units: 6,
	present: PRESENT_PARTITION,
	chosen: MON_FRI,
	runnerUp: PRESENT_PARTITION,
	served: MON_FRI,
	presentLoss: 2,
	chosenLoss: 1,
	gain: 1,
	se: 0.25,
	p: 0.01,
	on: true,
	reason: "on",
};

describe("forecast jobs: the main refit job", () => {
	const series = synthetic(21);

	it("fits E4 once, with the stored row-1 partition, and serves that fit", () => {
		const { fits, make } = countingFitter();
		const out = refitJob(
			{ ...payloadOf(series), daytypes: storedChoice },
			make,
		);
		expect(fits).toEqual([partitionKey(MON_FRI)]);
		expect(out.pace).toEqual({ tag: partitionKey(MON_FRI) } as never);
		expect(out.learned.partition).toEqual(MON_FRI);
		expect(out.learned.choices[0]).toBe(storedChoice as RowChoice<unknown>);
		expect(out.learned.choices.map((c) => c.row)).toEqual([
			"daytypes",
			"pool",
			"lookback",
			"halflife",
			"wsshare",
			"wssample",
			"bandwidth",
			"jitter",
		]);
	});

	it("before any row-1 job: fits the present partition once and carries no row-1 choice", () => {
		const { fits, make } = countingFitter();
		const out = refitJob({ ...payloadOf(series), daytypes: null }, make);
		expect(fits).toEqual([partitionKey(PRESENT_PARTITION)]);
		expect(out.pace).toEqual({ tag: partitionKey(PRESENT_PARTITION) } as never);
		expect(out.learned.partition).toEqual(PRESENT_PARTITION);
		expect(out.learned.choices.map((c) => c.row)).toEqual([
			"pool",
			"lookback",
			"halflife",
			"wsshare",
			"wssample",
			"bandwidth",
			"jitter",
		]);
	});
});

describe("forecast jobs: the row-1 job", () => {
	it("returns the choice selectRow(scoreDaytypes) gives on the same input", () => {
		const series = synthetic(35);
		const expected = selectRow(
			scoreDaytypes({
				...SETTINGS,
				series,
				now: T0,
				fitWithPartition: makePartitionFitter(series, T0),
			}),
		);
		expect(expected.m).toBeGreaterThan(1);
		expect(daytypesJob(payloadOf(series))).toEqual(expected);
	}, 120_000);

	it("fits every candidate partition, the present one included", () => {
		const series = synthetic(35);
		const { fits, make } = countingFitter();
		const choice = daytypesJob(payloadOf(series), make);
		expect(fits.length).toBe(choice.m);
		expect(fits).toContain(partitionKey(PRESENT_PARTITION));
	});
});
