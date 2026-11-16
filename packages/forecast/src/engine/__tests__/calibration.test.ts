import { describe, expect, test } from "bun:test";
import type {
	AccountDemandBucket,
	AccountLimits,
	EpochMs,
	ForecastInput,
	ForecastSettings,
	LimitReading,
	LimitWindow,
} from "../../types";
import { BUCKET_MS } from "../../types";
import {
	calibrate,
	MIN_CALIBRATION_POINTS,
	recencyWeight,
} from "../calibration";

const TZ = "Europe/Prague";
// Thursday 2026-11-12 10:00 CET
const NOW = Date.UTC(2026, 10, 12, 9, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

function settings(over: Partial<ForecastSettings> = {}): ForecastSettings {
	return {
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 1,
		simulatedDays: 400,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: [],
		minStopPoints: 1,
		moveMinGainPoints: 1,
		openMinGainPoints: 1,
		// effectively no recency decay, so ratios are exact
		historyHalfLifeDays: 1e12,
		historyLookbackDays: 28,
		recentTauMin: 60,
		sessionTurnoverMin: 60,
		workStartSharePct: 5,
		...over,
	};
}

function account(id: string): AccountLimits {
	return {
		accountId: id,
		name: id,
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 0, resetsAt: null },
		fable: null,
		blockedUntil: null,
		blockedSince: null,
		readAt: NOW,
	};
}

function reading(
	accountId: string,
	window: LimitWindow,
	at: EpochMs,
	usedPct: number,
	resetsAt: EpochMs | null,
): LimitReading {
	return { accountId, window, at, usedPct, resetsAt };
}

function bucket(
	accountId: string,
	start: EpochMs,
	units: number,
	fableUnits = 0,
): AccountDemandBucket {
	return { accountId, start, units, fableUnits, requests: 1 };
}

function input(over: Partial<ForecastInput>): ForecastInput {
	return {
		now: NOW,
		settings: settings(),
		pace: { timeZone: TZ, workDays: 5, fiveHourGuardPct: 90, idleMs: 0 },
		accounts: [],
		history: [],
		historyFrom: 0,
		accountHistory: [],
		readings: [],
		sessions: [],
		...over,
	};
}

const T0 = NOW - 6 * HOUR;
const T1 = NOW - 3 * HOUR;
const R0 = T0 + 4 * HOUR;
const R1 = T1 + 4 * HOUR;

/** Two five-hour instances of acct-a: +10 points on 1 unit, +2 points on 9 units. */
function twoInstances(id: string): {
	readings: LimitReading[];
	buckets: AccountDemandBucket[];
} {
	return {
		readings: [
			reading(id, "five_hour", T0, 10, R0),
			reading(id, "five_hour", T0 + 30 * 60_000, 15, R0),
			reading(id, "five_hour", T0 + HOUR, 20, R0),
			reading(id, "five_hour", T1, 5, R1),
			reading(id, "five_hour", T1 + HOUR, 7, R1),
		],
		buckets: [bucket(id, T0, 1), bucket(id, T1, 9)],
	};
}

describe("recencyWeight", () => {
	test("halves every half-life", () => {
		expect(recencyWeight(0, 14)).toBe(1);
		expect(recencyWeight(14, 14)).toBeCloseTo(0.5, 12);
		expect(recencyWeight(28, 14)).toBeCloseTo(0.25, 12);
		expect(recencyWeight(7, 14)).toBeCloseTo(Math.SQRT1_2, 12);
	});
});

describe("calibrate", () => {
	test("ratio of sums, not mean of ratios", () => {
		const a = twoInstances("acct-a");
		const cal = calibrate(
			input({ readings: a.readings, accountHistory: a.buckets }),
			[account("acct-a")],
		);
		// Σ Δpoints / Σ units = 12 / 10; the mean of ratios would be (10 + 2/9) / 2 ≈ 5.11
		expect(cal.fiveHour["acct-a"]).toBeCloseTo(1.2, 9);
	});

	test("recency weights enter numerator and denominator", () => {
		const a = twoInstances("acct-a");
		const cal = calibrate(
			input({
				readings: a.readings,
				accountHistory: a.buckets,
				settings: settings({ historyHalfLifeDays: 1 }),
			}),
			[account("acct-a")],
		);
		const w0 = recencyWeight((NOW - (T0 + HOUR)) / DAY, 1);
		const w1 = recencyWeight((NOW - (T1 + HOUR)) / DAY, 1);
		expect(cal.fiveHour["acct-a"]).toBeCloseTo(
			(w0 * 10 + w1 * 2) / (w0 * 1 + w1 * 9),
			9,
		);
	});

	test("units count by proportional overlap of buckets with the instance", () => {
		const s = T0 + 2 * 60_000;
		const e = T0 + 12 * 60_000;
		const cal = calibrate(
			input({
				readings: [
					reading("acct-a", "seven_day", s, 40, R0),
					reading("acct-a", "seven_day", e, 46, R0),
				],
				accountHistory: [
					bucket("acct-a", T0, 1),
					bucket("acct-a", T0 + BUCKET_MS, 1),
					bucket("acct-a", T0 + 2 * BUCKET_MS, 1),
				],
			}),
			[account("acct-a")],
		);
		// overlap 3/5 + 1 + 2/5 = 2 units for 6 points
		expect(cal.weekly["acct-a"]).toBeCloseTo(3, 9);
	});

	test("below the minimum evidence an account has no k; the other account's k is used", () => {
		expect(MIN_CALIBRATION_POINTS).toBe(5);
		const b = twoInstances("acct-b");
		const cal = calibrate(
			input({
				readings: [
					reading("acct-a", "five_hour", T0, 10, R0),
					reading("acct-a", "five_hour", T0 + HOUR, 14, R0),
					...b.readings,
				],
				accountHistory: [bucket("acct-a", T0, 2), ...b.buckets],
			}),
			[account("acct-a"), account("acct-b")],
		);
		expect(cal.fiveHour["acct-b"]).toBeCloseTo(1.2, 9);
		expect(cal.fiveHour["acct-a"]).toBeCloseTo(1.2, 9);
	});

	test("no units: no k of its own; no account with evidence: the key is missing", () => {
		const cal = calibrate(
			input({
				readings: [
					reading("acct-a", "five_hour", T0, 10, R0),
					reading("acct-a", "five_hour", T0 + HOUR, 30, R0),
				],
			}),
			[account("acct-a"), account("acct-b")],
		);
		expect("acct-a" in cal.fiveHour).toBe(false);
		expect("acct-b" in cal.fiveHour).toBe(false);
		expect("acct-a" in cal.weekly).toBe(false);
	});

	test("a change of resetsAt starts a new instance; a drop never counts negative", () => {
		const cal = calibrate(
			input({
				readings: [
					reading("acct-a", "five_hour", T0, 90, R0),
					// window reset: new resetsAt, lower reading; not a negative delta
					reading("acct-a", "five_hour", T0 + HOUR, 2, R1),
					reading("acct-a", "five_hour", T0 + 2 * HOUR, 12, R1),
					// same resetsAt but a lower reading (correction): clamped to 0
					reading("acct-a", "seven_day", T0, 50, R1),
					reading("acct-a", "seven_day", T0 + HOUR, 49, R1),
				],
				accountHistory: [bucket("acct-a", T0 + HOUR, 5)],
			}),
			[account("acct-a")],
		);
		expect(cal.fiveHour["acct-a"]).toBeCloseTo(10 / 5, 9);
		expect("acct-a" in cal.weekly).toBe(false);
	});

	test("Fable: k from the Fable part; null when it cannot be established", () => {
		const cal = calibrate(
			input({
				readings: [
					reading("acct-a", "seven_day_fable", T0, 10, R0),
					reading("acct-a", "seven_day_fable", T0 + HOUR, 18, R0),
				],
				accountHistory: [bucket("acct-a", T0, 10, 4)],
			}),
			[account("acct-a"), account("acct-b")],
		);
		expect(cal.fable["acct-a"]).toBeCloseTo(2, 9);
		// acct-b has no Fable evidence: falls back to acct-a's
		expect(cal.fable["acct-b"]).toBeCloseTo(2, 9);
		const none = calibrate(input({}), [account("acct-a")]);
		expect(none.fable["acct-a"]).toBeNull();
	});

	test("more than two accounts: the fallback is the largest k among the others", () => {
		const b = twoInstances("acct-b");
		const cal = calibrate(
			input({
				readings: [
					...b.readings,
					reading("acct-c", "five_hour", T0, 0, R0),
					reading("acct-c", "five_hour", T0 + HOUR, 30, R0),
				],
				accountHistory: [...b.buckets, bucket("acct-c", T0, 10)],
			}),
			[account("acct-a"), account("acct-b"), account("acct-c")],
		);
		expect(cal.fiveHour["acct-a"]).toBeCloseTo(3, 9);
		expect(cal.fiveHour["acct-b"]).toBeCloseTo(1.2, 9);
	});

	test("only counted accounts passed in are calibrated; readings outside the lookback are ignored", () => {
		const a = twoInstances("acct-a");
		const old = NOW - 40 * DAY;
		const cal = calibrate(
			input({
				readings: [
					reading("acct-b", "five_hour", old, 0, old + HOUR),
					reading("acct-b", "five_hour", old + HOUR, 50, old + HOUR),
					...a.readings,
				],
				accountHistory: [bucket("acct-b", old, 1), ...a.buckets],
			}),
			[account("acct-b")],
		);
		expect("acct-a" in cal.fiveHour).toBe(false);
		expect("acct-b" in cal.fiveHour).toBe(false);
	});
});
