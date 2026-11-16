/**
 * How fast the calibration follows a change by the provider: the points a limit charges
 * per demand unit change by a step, demand stays steady, and the computed k5, kW and
 * r = k5 / kW are read at times after the step. These tests document current behaviour.
 */
import { describe, expect, test } from "bun:test";
import type {
	AccountDemandBucket,
	AccountLimits,
	EpochMs,
	ForecastInput,
	ForecastSettings,
	LimitReading,
} from "../../types";
import { calibrate } from "../calibration";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const STEP_MS = 30 * 60_000;
const ID = "acct-a";
// a Monday 00:00 UTC; weekly windows start here, five-hour windows every 5 h from here
const ORIGIN = Date.UTC(2026, 8, 7);
const LOOKBACK_DAYS = 56;
const HALF_LIFE_DAYS = 14;
const UNITS_PER_STEP = 2.5;

const K5 = 0.4425;
const KW = 0.075;

interface Rates {
	k5Before: number;
	k5After: number;
	kWBefore: number;
	kWAfter: number;
}

function settings(): ForecastSettings {
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
		historyHalfLifeDays: HALF_LIFE_DAYS,
		historyLookbackDays: LOOKBACK_DAYS,
		recentTauMin: 60,
		sessionTurnoverMin: 60,
		workStartSharePct: 5,
	};
}

const ACCOUNT: AccountLimits = {
	accountId: ID,
	name: ID,
	counted: true,
	fiveHour: { usedPct: 0, resetsAt: null },
	weekly: { usedPct: 0, resetsAt: null },
	fable: null,
	blockedUntil: null,
	blockedSince: null,
	readAt: 0,
};

/**
 * Steady demand of UNITS_PER_STEP every 30 minutes from ORIGIN to `end`, read every 30
 * minutes on both limits. Each bucket charges its limit at the rate in force at its start.
 */
function world(
	stepAt: EpochMs,
	rates: Rates,
	end: EpochMs,
): { buckets: AccountDemandBucket[]; readings: LimitReading[] } {
	const buckets: AccountDemandBucket[] = [];
	const readings: LimitReading[] = [];
	const used = { five_hour: 0, seven_day: 0 };
	const span = { five_hour: 5 * HOUR, seven_day: 7 * DAY };
	for (let t = ORIGIN; t <= end; t += STEP_MS) {
		for (const window of ["five_hour", "seven_day"] as const) {
			const startOfWindow =
				ORIGIN + Math.floor((t - ORIGIN) / span[window]) * span[window];
			if (t === startOfWindow) used[window] = 0;
			readings.push({
				accountId: ID,
				window,
				at: t,
				usedPct: used[window],
				resetsAt: startOfWindow + span[window],
			});
		}
		buckets.push({
			accountId: ID,
			start: t,
			units: UNITS_PER_STEP,
			fableUnits: 0,
			requests: 1,
		});
		const after = t >= stepAt;
		used.five_hour += UNITS_PER_STEP * (after ? rates.k5After : rates.k5Before);
		used.seven_day += UNITS_PER_STEP * (after ? rates.kWAfter : rates.kWBefore);
	}
	return { buckets, readings };
}

function calibrationAt(
	w: { buckets: AccountDemandBucket[]; readings: LimitReading[] },
	now: EpochMs,
): { k5: number; kW: number; r: number } {
	const input = {
		now,
		settings: settings(),
		pace: { timeZone: "UTC", workDays: 5, fiveHourGuardPct: 90, idleMs: 0 },
		accounts: [],
		history: [],
		historyFrom: 0,
		accountHistory: w.buckets.filter((b) => b.start < now),
		readings: w.readings.filter((r) => r.at <= now),
		sessions: [],
	} satisfies ForecastInput;
	const c = calibrate(input, [ACCOUNT]);
	const k5 = c.fiveHour[ID] as number;
	const kW = c.weekly[ID] as number;
	return { k5, kW, r: k5 / kW };
}

/** Probe times after the step: every hour for two days, then every 6 hours to 42 days. */
const PROBES_H: number[] = [];
for (let h = 1; h <= 48; h++) PROBES_H.push(h);
for (let h = 54; h <= 42 * 24; h += 6) PROBES_H.push(h);

interface Crossing {
	halfH: number | null;
	ninetyH: number | null;
}

/** First probe (hours after the step) at which `value` has moved half-way and 90 % of the way from `from` to `to`, and stays there. */
function crossings(
	series: { h: number; value: number }[],
	from: number,
	to: number,
): Crossing {
	const frac = series.map((p) => ({
		h: p.h,
		f: (p.value - from) / (to - from),
	}));
	const first = (level: number): number | null => {
		for (let i = 0; i < frac.length; i++)
			if (frac.slice(i).every((p) => p.f >= level))
				return (frac[i] as { h: number }).h;
		return null;
	};
	return { halfH: first(0.5), ninetyH: first(0.9) };
}

function run(stepAt: EpochMs, rates: Rates) {
	const end = stepAt + 42 * DAY;
	const w = world(stepAt, rates, end);
	const k5: { h: number; value: number }[] = [];
	const kW: { h: number; value: number }[] = [];
	const r: { h: number; value: number }[] = [];
	const before = calibrationAt(w, stepAt);
	for (const h of PROBES_H) {
		const c = calibrationAt(w, stepAt + h * HOUR);
		k5.push({ h, value: c.k5 });
		kW.push({ h, value: c.kW });
		r.push({ h, value: c.r });
	}
	return { before, k5, kW, r };
}

const EIGHT_WEEKS = ORIGIN + 8 * 7 * DAY;
const MID_WEEK = EIGHT_WEEKS + 3.5 * DAY;

describe("a step in the weekly points per unit (kW x 1.5, k5 steady)", () => {
	const rates: Rates = {
		k5Before: K5,
		k5After: K5,
		kWBefore: KW,
		kWAfter: KW * 1.5,
	};
	const rBefore = K5 / KW;
	const rAfter = K5 / (KW * 1.5);

	// [label, step time, kW half-way h, kW 90 % h, r half-way h, r 90 % h]
	for (const [label, stepAt, kWHalf, kWNinety, rHalf, rNinety] of [
		["at the start of a weekly window", EIGHT_WEEKS, 318, 942, 240, 828],
		["half-way through a weekly window", MID_WEEK, 324, 924, 246, 822],
	] as const) {
		test(`step ${label}: kW and r follow in days to weeks, k5 does not move`, () => {
			const { before, k5, kW, r } = run(stepAt, rates);
			expect(before.kW).toBeCloseTo(KW, 9);
			expect(before.r).toBeCloseTo(rBefore, 9);
			for (const p of k5) expect(p.value).toBeCloseTo(K5, 9);
			expect(crossings(kW, KW, KW * 1.5)).toEqual({
				halfH: kWHalf,
				ninetyH: kWNinety,
			});
			expect(crossings(r, rBefore, rAfter)).toEqual({
				halfH: rHalf,
				ninetyH: rNinety,
			});
		});
	}
});

describe("a step in the five-hour points per unit (k5 x 1.5, kW steady)", () => {
	const rates: Rates = {
		k5Before: K5,
		k5After: K5 * 1.5,
		kWBefore: KW,
		kWAfter: KW,
	};

	test("k5 and r follow the five-hour step, kW does not move", () => {
		const { before, k5, kW, r } = run(MID_WEEK, rates);
		expect(before.k5).toBeCloseTo(K5, 9);
		for (const p of kW) expect(p.value).toBeCloseTo(KW, 9);
		expect(crossings(k5, K5, K5 * 1.5)).toEqual({ halfH: 312, ninetyH: 906 });
		expect(crossings(r, K5 / KW, (K5 * 1.5) / KW)).toEqual({
			halfH: 312,
			ninetyH: 906,
		});
	});
});
