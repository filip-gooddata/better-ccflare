import { describe, expect, test } from "bun:test";
import type {
	AccountDemandBucket,
	AccountLimits,
	EpochMs,
	ForecastInput,
	LimitReading,
} from "../../types";
import * as calibration from "../calibration";
import { createForecastEngine } from "../engine";
import { buildInput, replayFixture } from "./fixtures-engine";
import { settings } from "./fixtures-sim";
import { FULL_GRID_TIMEOUT_MS } from "./plan-timeout";

const { calibrate } = calibration;

// Thursday 2026-11-12 10:00 CET
const NOW = Date.UTC(2026, 10, 12, 9, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const ID = "acct-a";

function account(): AccountLimits {
	return {
		accountId: ID,
		name: ID,
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 0, resetsAt: null },
		fable: null,
		blockedUntil: null,
		blockedSince: null,
		readAt: NOW,
	};
}

function five(at: EpochMs, usedPct: number, resetsAt: EpochMs | null) {
	return {
		accountId: ID,
		window: "five_hour",
		at,
		usedPct,
		resetsAt,
	} satisfies LimitReading;
}

function bucket(start: EpochMs, units: number): AccountDemandBucket {
	return { accountId: ID, start, units, fableUnits: 0, requests: 1 };
}

function kOf(
	readings: LimitReading[],
	buckets: AccountDemandBucket[],
): number | undefined {
	const input: ForecastInput = {
		now: NOW,
		// effectively no recency decay, so ratios are exact
		settings: { ...settings(), historyHalfLifeDays: 1e12 },
		pace: {
			timeZone: "Europe/Prague",
			workDays: 5,
			fiveHourGuardPct: 90,
			idleMs: 0,
		},
		accounts: [],
		history: [],
		historyFrom: 0,
		accountHistory: buckets,
		readings,
		sessions: [],
	};
	return calibrate(input, [account()]).fiveHour[ID];
}

const A = NOW - 8 * HOUR;
const R = A + 4 * HOUR;

describe("window instance (amendment 3, C1)", () => {
	test("the tolerance is a named constant of 60 s", () => {
		expect(calibration.RESET_TIME_TOLERANCE_MS).toBe(60_000);
	});

	test("sub-second jitter on every reset time gives the same instances and k as exact times", () => {
		const T1 = A + 3 * HOUR;
		const R1 = R + 3 * HOUR;
		const exact = [
			five(A, 10, R),
			five(A + 30 * MIN, 15, R),
			five(A + HOUR, 20, R),
			five(T1, 5, R1),
			five(T1 + HOUR, 7, R1),
		];
		// 0.1 to 1.1 s either way, never whole seconds, as the upstream sends them
		const offsets = [137, -412, 1093, -288, 706];
		const jittered = exact.map((r, i) => ({
			...r,
			resetsAt: (r.resetsAt as number) + (offsets[i] as number),
		}));
		const buckets = [bucket(A, 1), bucket(T1, 9)];
		expect(kOf(exact, buckets)).toBeCloseTo(1.2, 9);
		expect(kOf(jittered, buckets)).toBeCloseTo(1.2, 9);
	});

	test("a fall inside one window splits it: 50 → 99 → 0 → 14 is a rise of 49 + 14 on the units of each part", () => {
		const readings = [
			five(A, 50, R),
			five(A + 30 * MIN, 99, R),
			five(A + 60 * MIN, 0, R),
			five(A + 90 * MIN, 14, R),
		];
		const buckets = [
			bucket(A, 3),
			// between 99 and 0: belongs to neither part
			bucket(A + 35 * MIN, 100),
			bucket(A + 60 * MIN, 4),
		];
		expect(kOf(readings, buckets)).toBeCloseTo(63 / 7, 9);
	});

	test("two real windows whose reset times differ by hours stay two instances", () => {
		const R2 = R + 5 * HOUR;
		const readings = [
			five(A, 10, R),
			five(A + 30 * MIN, 20, R),
			five(A + 5 * HOUR, 30, R2),
			five(A + 5 * HOUR + 30 * MIN, 35, R2),
		];
		const buckets = [
			bucket(A, 1),
			bucket(A + 2 * HOUR, 100),
			bucket(A + 5 * HOUR, 2),
		];
		expect(kOf(readings, buckets)).toBeCloseTo(15 / 3, 9);
	});

	test("a reset time more than the tolerance from the run's first splits; exactly the tolerance does not", () => {
		const readings = (second: EpochMs) => [
			five(A, 10, R),
			five(A + 30 * MIN, 20, R),
			five(A + 60 * MIN, 30, second),
			five(A + 90 * MIN, 35, second),
		];
		const buckets = [
			bucket(A, 1),
			bucket(A + 35 * MIN, 100),
			bucket(A + 60 * MIN, 2),
		];
		expect(kOf(readings(R + 60_001), buckets)).toBeCloseTo(15 / 3, 9);
		expect(kOf(readings(R + 60_000), buckets)).toBeCloseTo(25 / 103, 9);
	});

	test("a slow drift is compared with the run's first reading, not chained", () => {
		const readings = [
			five(A, 10, R),
			five(A + 30 * MIN, 15, R + 40_000),
			five(A + 60 * MIN, 20, R + 80_000),
			five(A + 90 * MIN, 25, R + 80_000),
		];
		const buckets = [
			bucket(A, 1),
			bucket(A + 35 * MIN, 100),
			bucket(A + 60 * MIN, 1),
		];
		expect(kOf(readings, buckets)).toBeCloseTo(10 / 2, 9);
	});

	test("a null resetsAt between two runs ends the first and belongs to neither", () => {
		const readings = [
			five(A, 10, R),
			five(A + 30 * MIN, 15, R + 300),
			five(A + 60 * MIN, 15, null),
			five(A + 90 * MIN, 20, R - 500),
			five(A + 120 * MIN, 25, R + 700),
		];
		const buckets = [
			bucket(A, 1),
			bucket(A + 60 * MIN, 100),
			bucket(A + 90 * MIN, 1),
		];
		expect(kOf(readings, buckets)).toBeCloseTo(10 / 2, 9);
	});
});

describe("engine with jittered reset times (amendment 3, C3)", () => {
	const engine = createForecastEngine();

	test(
		"the replay fixture with exact reset times has a forecast",
		async () => {
			const result = await engine.compute(
				buildInput({ ...replayFixture(), resetJitter: false }),
			);
			expect(result.available).toBe(true);
		},
		FULL_GRID_TIMEOUT_MS,
	);

	test("the same fixture with jittered reset times has one too", async () => {
		const input = buildInput(replayFixture());
		const jittered = input.readings.filter(
			(r) => r.resetsAt !== null && r.resetsAt % 1000 !== 0,
		);
		expect(jittered.length).toBe(
			input.readings.filter((r) => r.resetsAt !== null).length,
		);
		const result = await engine.compute(input);
		expect(result.available ? "available" : result.reason).toBe("available");
	});
});
