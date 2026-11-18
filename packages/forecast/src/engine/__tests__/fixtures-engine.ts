/**
 * Whole ForecastInput fixtures for the end-to-end engine tests: recorded days from an
 * hourly demand shape, per-account demand and usage readings consistent with fixed
 * calibrations (so ratio-of-sums calibration recovers them), and the accounts' state now.
 */
import {
	addLocalDays,
	atLocalMinute,
	localDayKey,
	localDayStart,
	localParts,
} from "../../time";
import type {
	AccountDemandBucket,
	AccountLimits,
	DemandBucket,
	EpochMs,
	ForecastInput,
	ForecastSettings,
	LimitReading,
	LiveSession,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { type ForecastEngineOptions, prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import { planSearchSize } from "../plan-job";
import { createRng } from "../rng";
import {
	chooseScenarioCount,
	prebuiltScenarioSource,
	SCENARIO_LADDER_TOP,
	type ScenarioCount,
} from "../scenario-count";
import { prague, settings, TZ } from "./fixtures-sim";

export { prague, TZ };

/** Fan levels of the default settings: with 10, 50 and 90 they make the 41 lines. */
export const DEFAULT_FAN_LEVELS = [
	...Array.from({ length: 19 }, (_, i) => 12 + 2 * i),
	...Array.from({ length: 19 }, (_, i) => 52 + 2 * i),
];

/** 5-hour points per demand unit of both accounts (2026-11-12: ~205 points for ~108 units by 13:56). */
export const K_FIVE_HOUR = 2;
/**
 * Weekly points per unit. Below the trace's ratio (weekly rose by about a fifth of the 5-hour
 * points, k ≈ 0.4) so that a recorded week of the fixture stays under 100 weekly points.
 */
export const K_WEEKLY = 0.15;
/** acct-a serves local hours before this one, acct-b from it on (calibration history). */
const SPLIT_HOUR = 13;

export function defaultSettings(
	over: Partial<ForecastSettings> = {},
): ForecastSettings {
	return settings({ fanLevels: DEFAULT_FAN_LEVELS, ...over });
}

const FIXTURE_DAYS = defaultSettings().simulatedDays;

/**
 * Engine options for tests not about the scenario-count rule: N fixed at the fixtures' simulated
 * days (one rung, the same days as before the rule) and an unbounded search, so their values
 * depend neither on the rule nor on the machine's load.
 */
export const FIXED_N_ENGINE: Pick<ForecastEngineOptions, "planJob"> = {
	planJob: {
		ladder: { start: FIXTURE_DAYS, top: FIXTURE_DAYS },
		budgetMs: Number.POSITIVE_INFINITY,
	},
};

/**
 * Engine options for the replay tests: the real ladder and SE target, the search unbounded, so the
 * climb is never stopped by the budget and the asserted plan does not depend on the machine's load.
 * The budget itself is tested with an injected clock in plan-job.test.ts.
 */
export const REPLAY_ENGINE: Pick<ForecastEngineOptions, "planJob"> = {
	planJob: { budgetMs: Number.POSITIVE_INFINITY },
};

/**
 * What the plan job plans on under REPLAY_ENGINE, without the worker: the ladder's top rung of
 * scenario days, then the scenario-count rule's N among them. For planner-level checks of a replay
 * that compute() answers at the same N.
 */
export async function integratedContext(
	input: ForecastInput,
): Promise<{ ctx: EngineContext; count: ScenarioCount }> {
	const top = await prepareEngineContext(
		{
			...input,
			settings: { ...input.settings, simulatedDays: SCENARIO_LADDER_TOP },
		},
		{ noise: true },
	);
	if (top === "insufficient_history")
		throw new Error("fixture has no forecast");
	const count = await chooseScenarioCount(
		top,
		prebuiltScenarioSource(top.scenarios),
		{ deadline: Number.POSITIVE_INFINITY, searchPlans: planSearchSize(top) },
	);
	return { ctx: count.ctx, count };
}

/** Units per local hour (24 entries) of the day with this key and ISO weekday. */
export type HourlyShape = (key: string, isoWeekday: number) => number[];

export interface EngineFixture {
	now: EpochMs;
	/** Recorded days before today. */
	historyDays: number;
	hourly: HourlyShape;
	/** Weekly resets now of acct-a and acct-b; earlier weeks are 7 days apart. */
	weeklyReset: { a: EpochMs; b: EpochMs };
	/** The accounts' 5-hour state now (weekly use comes from the history). */
	fiveHour: { a: AccountLimits["fiveHour"]; b: AccountLimits["fiveHour"] };
	/** Refusal cooldowns running now (default none). */
	blockedUntil?: { a?: EpochMs | null; b?: EpochMs | null };
	settings?: ForecastSettings;
	sessions?: LiveSession[];
	/**
	 * Jitter on every reading's resetsAt, as the upstream sends it (default true): 0.1 to
	 * 1.1 s either way, never whole seconds, seeded so every run sees the same numbers.
	 */
	resetJitter?: boolean;
}

interface Served {
	account: "acct-a" | "acct-b";
	from: EpochMs;
	to: EpochMs;
	units: number;
	/** First bucket with demand, or null. */
	first: EpochMs | null;
}

export function buildInput(f: EngineFixture): ForecastInput {
	const todayStart = localDayStart(f.now, TZ);
	const historyFrom = addLocalDays(todayStart, -f.historyDays, TZ);
	const history: DemandBucket[] = [];
	const accountHistory: AccountDemandBucket[] = [];
	const served: Served[] = [];

	for (let d = historyFrom; d <= todayStart; d = addLocalDays(d, 1, TZ)) {
		const next = addLocalDays(d, 1, TZ);
		const end =
			d === todayStart ? Math.floor(f.now / BUCKET_MS) * BUCKET_MS : next;
		const key = localDayKey(d, TZ);
		const parts = localParts(d, TZ);
		const shape = f.hourly(key, parts.isoWeekday);
		const split = atLocalMinute(d, SPLIT_HOUR * 60, TZ);
		const part = { a: 0, b: 0 };
		const first: { a: EpochMs | null; b: EpochMs | null } = {
			a: null,
			b: null,
		};
		for (let t = d; t < end; t += BUCKET_MS) {
			const hour = Math.floor(localParts(t, TZ).minuteOfDay / 60);
			const units = (shape[hour] ?? 0) / 12;
			if (units <= 0) continue;
			const accountId = t < split ? "acct-a" : "acct-b";
			history.push({ start: t, units, fableUnits: 0, requests: 1 });
			accountHistory.push({
				start: t,
				units,
				fableUnits: 0,
				requests: 1,
				accountId,
			});
			const side = accountId === "acct-a" ? "a" : "b";
			part[side] += units;
			first[side] ??= t;
		}
		served.push({
			account: "acct-a",
			from: d,
			to: Math.min(split, end),
			units: part.a,
			first: first.a,
		});
		if (end > split) {
			served.push({
				account: "acct-b",
				from: split,
				to: end,
				units: part.b,
				first: first.b,
			});
		}
	}

	const { readings, weeklyUsed } = readingsFor(served, f);
	const accounts: AccountLimits[] = [
		account(
			"acct-a",
			f.fiveHour.a,
			weeklyUsed.a,
			f.weeklyReset.a,
			f.now,
			f.blockedUntil?.a,
		),
		account(
			"acct-b",
			f.fiveHour.b,
			weeklyUsed.b,
			f.weeklyReset.b,
			f.now,
			f.blockedUntil?.b,
		),
	];
	return {
		now: f.now,
		settings: f.settings ?? defaultSettings(),
		pace: {
			timeZone: TZ,
			workDays: 5,
			fiveHourGuardPct: 95,
			idleMs: 10 * 60_000,
		},
		accounts,
		history,
		historyFrom,
		accountHistory,
		readings,
		sessions: f.sessions ?? [],
	};
}

function account(
	id: string,
	fiveHour: AccountLimits["fiveHour"],
	weeklyUsed: number,
	weeklyReset: EpochMs,
	now: EpochMs,
	blockedUntil: EpochMs | null = null,
): AccountLimits {
	return {
		accountId: id,
		name: id,
		counted: true,
		fiveHour,
		weekly: { usedPct: weeklyUsed, resetsAt: weeklyReset },
		fable: null,
		blockedUntil,
		blockedSince: null,
		readAt: now,
	};
}

/**
 * Readings consistent with K_FIVE_HOUR and K_WEEKLY: per served stretch of a recorded day, a
 * 5-hour reading at its start (0) and one hour in, and weekly readings at its start and end,
 * cumulative since that account's weekly reset.
 */
function readingsFor(
	served: Served[],
	f: EngineFixture,
): { readings: LimitReading[]; weeklyUsed: { a: number; b: number } } {
	const readings: LimitReading[] = [];
	const rng = createRng("fixtures-engine reset jitter");
	const jitter = (reset: EpochMs): EpochMs => {
		if (f.resetJitter === false) return reset;
		const ms = 100 + 1 + rng.int(999);
		return reset + (rng.uniform() < 0.5 ? -ms : ms);
	};
	const cum = { "acct-a": 0, "acct-b": 0 };
	const instance: Record<string, EpochMs> = {};
	const todayStart = localDayStart(f.now, TZ);
	for (const s of served) {
		const anchor = s.account === "acct-a" ? f.weeklyReset.a : f.weeklyReset.b;
		const weeks = Math.floor((anchor - s.from) / (7 * 86_400_000));
		const reset = anchor - weeks * 7 * 86_400_000;
		if (instance[s.account] !== reset) {
			instance[s.account] = reset;
			cum[s.account] = 0;
		}
		const before = cum[s.account];
		cum[s.account] += K_WEEKLY * s.units;
		if (s.units <= 0) continue;
		const weekly = (at: EpochMs, used: number): LimitReading => ({
			accountId: s.account,
			at,
			window: "seven_day",
			usedPct: Math.round(used),
			resetsAt: jitter(reset),
		});
		readings.push(
			weekly(s.from, before),
			weekly(s.to - 60_000, cum[s.account]),
		);
		if (s.from >= todayStart || s.first === null) continue;
		const opened = s.first;
		const firstHourEnd = opened + 3_600_000;
		const firstHour = unitsBetween(f, opened, firstHourEnd);
		readings.push(
			{
				accountId: s.account,
				at: opened,
				window: "five_hour",
				usedPct: 0,
				resetsAt: jitter(opened + 5 * 3_600_000),
			},
			{
				accountId: s.account,
				at: firstHourEnd,
				window: "five_hour",
				usedPct: Math.round(K_FIVE_HOUR * firstHour),
				resetsAt: jitter(opened + 5 * 3_600_000),
			},
		);
	}
	readings.sort((x, y) => x.at - y.at);
	return {
		readings,
		weeklyUsed: { a: Math.round(cum["acct-a"]), b: Math.round(cum["acct-b"]) },
	};
}

function unitsBetween(f: EngineFixture, from: EpochMs, to: EpochMs): number {
	let sum = 0;
	const key = localDayKey(from, TZ);
	const shape = f.hourly(key, localParts(from, TZ).isoWeekday);
	for (let t = from; t < to; t += BUCKET_MS) {
		sum += (shape[Math.floor(localParts(t, TZ).minuteOfDay / 60)] ?? 0) / 12;
	}
	return sum;
}

// ── the 2026-11-12 shape (research 17) ──────────────────────────────────

/**
 * Units per local hour of the 2026-11-12 day at K_FIVE_HOUR = 2, from the record (research 17):
 * one overnight request at 01:00 (acct-a's 00:50–05:50 window reached 3 %); demand from 06:00
 * that takes acct-a's window resetting at 11:00 to 60 points by 11:00 (60 % at 10:58:18); 88
 * points 11:00–13:00 and 48 per hour after, so acct-a's next window is full at about 13:15
 * (13:17:41); acct-b then takes 35 units per hour and is full at about 14:55 (refused 14:54:46);
 * little demand while both are out (31 refused requests until 15:55:37); 30 points
 * 16:00–16:30 (30 % at 16:29:56), tailing off in the evening.
 */
export const DAY_2026_11_12 = [
	0, 1, 0, 0, 0, 0, 2, 4, 6, 8, 10, 22, 22, 24, 35, 4, 30, 8, 3, 1, 0, 0, 0, 0,
];

/** Recorded days scale the 2026-11-12 shape by a fixed per-day factor (spread for the bandwidth). */
const REPLAY_SCALES = [
	0.92, 1.02, 0.96, 1.06, 1, 0.94, 1.08, 0.98, 1.04, 0.95, 1.03, 1,
];

/** Work days like 2026-11-12 (Mondays at 0.7), weekends nearly idle. */
export const replayHourly: HourlyShape = (key, isoWeekday) => {
	if (isoWeekday > 5) return DAY_2026_11_12.map((u) => u * 0.02);
	const day = Number(key.slice(8, 10)) + 31 * Number(key.slice(5, 7));
	const scale = REPLAY_SCALES[day % REPLAY_SCALES.length] ?? 1;
	return DAY_2026_11_12.map((u) => u * scale * (isoWeekday === 1 ? 0.7 : 1));
};

/**
 * Morning of 2026-11-12, 07:00: acct-a's window opened at 06:00 with the first demand and
 * resets at 11:00 (record: 0 % at 06:12:18), 4 points used in the 06:00 hour; acct-b has no
 * open window (record: none from 00:34 to 13:11).
 */
export function replayFixture(
	over: Partial<EngineFixture> = {},
): EngineFixture {
	return {
		now: prague(12, 7),
		historyDays: 28,
		hourly: replayHourly,
		weeklyReset: { a: prague(15, 15), b: prague(17, 3) },
		fiveHour: {
			a: { usedPct: 4, resetsAt: prague(12, 11) },
			b: { usedPct: 0, resetsAt: null },
		},
		...over,
	};
}

// ── the days up to 2026-11-13, 12:06 (flat-at-100 investigation) ─────────

/**
 * Pooled units per local hour of each recorded day from 2026-10-16 to 2026-11-13, summed from the
 * demand buckets the flat-at-100 investigation ran on (aggregated numbers only). On 2026-11-13
 * the record ends at 12:05, so the 12:00 hour holds twelve times the 10.3 units of its one bucket.
 */
export const DAYS_TO_2026_11_13: Record<string, number[]> = {
	"2026-10-16": [
		0.2, 0.1, 0, 0.4, 0.4, 0.2, 0.3, 0.1, 8, 12.5, 8.7, 5.6, 2.3, 2.5, 5.3,
		10.6, 0.2, 1, 0.4, 0.3, 0.2, 0.1, 0.2, 0.1,
	],
	"2026-10-17": [
		0.3, 0.4, 0.3, 0.1, 0.1, 0.3, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3,
		0.2, 0.1, 0.1, 0.1, 0.3, 0.1, 0.2, 0.1, 0.1,
	],
	"2026-10-18": [
		0.1, 0.3, 0.1, 0.1, 0.4, 0.4, 0, 0.1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0,
	],
	"2026-10-19": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	],
	"2026-10-20": [
		0, 0, 0, 1.3, 0.2, 0.3, 0.3, 0.3, 10.4, 8.3, 6, 8.5, 0, 14.7, 5.1, 8.5, 6.2,
		0, 0.9, 0.4, 0.3, 0.1, 0.1, 0,
	],
	"2026-10-21": [
		0, 0, 0.4, 0.2, 0.2, 0.1, 0.2, 0.2, 7.7, 7.2, 10.8, 9.1, 5.7, 0, 10.6, 11.7,
		7.3, 1.4, 0.6, 0.1, 0.5, 0.6, 0.1, 0.4,
	],
	"2026-10-22": [
		0.6, 0.3, 0.3, 0.4, 0.4, 0.4, 0.5, 0.2, 9.1, 15.1, 13.9, 19.2, 0.5, 1.9, 0,
		16.2, 5.4, 4.6, 0, 0.4, 0.1, 0.2, 0.1, 0.1,
	],
	"2026-10-23": [
		0, 0, 0, 0.2, 0.2, 0.1, 0.1, 0.1, 0.3, 0.1, 0.1, 0.3, 0.1, 0.3, 0, 0.1, 0,
		0, 0, 0, 0, 0, 0.4, 0,
	],
	"2026-10-24": [
		0.2, 0, 0.1, 0.2, 0.2, 0.2, 0, 0.1, 0, 0, 0.3, 0, 0, 0, 0.1, 0.1, 0, 0, 0.2,
		0, 0, 0, 0, 0,
	],
	"2026-10-25": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	],
	"2026-10-26": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 3.9, 6.3, 3, 7.4, 5, 8.6, 11.3, 0, 0, 0, 0, 0, 0,
		0, 0,
	],
	"2026-10-27": [
		0, 0, 0, 0.7, 0.6, 3.4, 1, 0.7, 3.4, 13.4, 9, 2.7, 4.6, 10.5, 7, 5.7, 7.5,
		5.4, 2.6, 4.6, 0.2, 0, 2.7, 3.7,
	],
	"2026-10-28": [
		0.9, 0.5, 0.7, 0.2, 0.6, 0.1, 0.1, 1.1, 0.4, 0.7, 0.5, 0.4, 0.1, 0.1, 0.1,
		0.2, 0.1, 0.1, 0.1, 0.1, 6.9, 8.8, 2.9, 0.5,
	],
	"2026-10-29": [
		0.6, 0.6, 0.5, 0.4, 1.1, 0.4, 0.2, 1.9, 0.3, 8.4, 14.4, 7.4, 11.5, 15.4,
		5.4, 0, 12.1, 14, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3,
	],
	"2026-10-30": [
		0, 0.1, 0.3, 0.3, 0.3, 0.1, 0.2, 0.1, 0.4, 6.1, 12.9, 7.3, 7.1, 7.5, 8.2,
		4.8, 7.6, 5.4, 2, 0.3, 0, 0, 0, 0,
	],
	"2026-10-31": [
		0, 0, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.3,
		0, 0,
	],
	"2026-11-01": [
		0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0, 0.1, 0, 0.2, 0.2, 0,
		0, 0, 0,
	],
	"2026-11-02": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 1, 0, 3.7, 2.9, 5.1, 5.8, 0.3, 0, 0, 0,
		0, 0, 0,
	],
	"2026-11-03": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 12.7, 18.1, 10.7, 0, 0, 19.2, 14.2, 6.1, 0, 0, 0,
		0, 0, 0, 0,
	],
	"2026-11-04": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 10.1, 9.5, 13.6, 8.5, 9.9, 16.7, 14.1, 12, 7.6,
		0, 0, 1.1, 0.3, 0, 0,
	],
	"2026-11-05": [
		0.8, 0.2, 0.2, 0.1, 0.3, 0.1, 0.2, 0.2, 0.1, 9.4, 11.3, 5.2, 8.1, 8.6, 5.5,
		10.7, 8.7, 6.7, 0.1, 0.8, 0.6, 0.5, 0.2, 0,
	],
	"2026-11-06": [
		0.5, 0.2, 0.2, 0.4, 0.1, 0.4, 0.5, 0.3, 0.2, 17.2, 28.5, 21.3, 4.2, 20.3,
		16.6, 11.8, 7.1, 6.2, 1.7, 2.6, 0, 0, 0.4, 0,
	],
	"2026-11-07": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	],
	"2026-11-08": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	],
	"2026-11-09": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4.4, 2.6, 1, 5.5, 0.8, 2, 3.4, 1.9, 0, 0, 0,
		0, 0, 0,
	],
	"2026-11-10": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 18.6, 25, 20.9, 0, 0, 16.7, 24.5, 15.8, 9.6, 0,
		0, 0, 0, 0, 0,
	],
	"2026-11-11": [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 13.6, 9.1, 9.9, 4.8, 4.2, 10.7, 16.9, 15.8, 13.6,
		0.2, 0.7, 0.5, 0.6, 0.4, 0.4,
	],
	"2026-11-12": [
		0.2, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 19.7, 15.1, 16.1, 26.3, 33.2,
		20.8, 0, 31.6, 18.7, 56.6, 0, 0, 63.1, 1.8, 16.1,
	],
	"2026-11-13": [
		20, 41.6, 25, 21.3, 16, 1.5, 0.2, 0.5, 11, 16.7, 17.6, 40.4, 123.6, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
	],
};

/**
 * 2026-11-13, 12:06:02.785 (flat-at-100 investigation): acct-a's window is at 79 % and resets
 * at 14:00:00.663, but upstream refused it with a cooldown until 2026-11-15 14:59:59, one
 * second before its weekly reset; acct-b's window is at 21 % and resets at 17:00:00.011.
 */
export function replay1113Fixture(
	over: Partial<EngineFixture> = {},
): EngineFixture {
	return {
		now: prague(13, 12, 6, 2) + 785,
		historyDays: 28,
		hourly: (key) => DAYS_TO_2026_11_13[key] ?? new Array<number>(24).fill(0),
		weeklyReset: { a: prague(15, 15) + 664, b: prague(17, 3) + 11 },
		fiveHour: {
			a: { usedPct: 79, resetsAt: prague(13, 14) + 663 },
			b: { usedPct: 21, resetsAt: prague(13, 17) + 11 },
		},
		blockedUntil: { a: prague(15, 14, 59, 59) },
		...over,
	};
}

// ── aggregated usage profile (research 14-usage-profile) ────────────────

/**
 * Mean weighted tokens per local hour by ISO weekday (Mon..Sun), in millions: `grid_w_avg` of
 * research 14-usage-profile/results.json (aggregated numbers only).
 */
const PROFILE_HOURLY = [
	[
		0, 0, 0, 0, 0, 0, 0, 0, 0, 1.65, 2.49, 1.77, 2.29, 3.3, 3.09, 4.17, 2.28,
		0.63, 0.01, 0.02, 0.06, 0.02, 0.06, 0.01,
	],
	[
		0.02, 0.01, 0.02, 0.14, 0.33, 0.63, 0.24, 0.18, 0.62, 9.67, 10.55, 7.13,
		2.5, 2.11, 10.73, 11.6, 8.2, 3.57, 0.45, 0.94, 0.12, 0.06, 0.48, 0.65,
	],
	[
		0.17, 0.1, 0.14, 0.11, 0.14, 0.07, 0.06, 0.23, 0.12, 6.53, 5.5, 6.29, 4.03,
		6.73, 6.01, 9.19, 7.94, 4.92, 0.42, 0.32, 1.48, 1.77, 0.75, 0.19,
	],
	[
		0.37, 0.31, 0.3, 0.18, 0.42, 0.23, 0.19, 0.5, 0.12, 8.13, 10.37, 7.36,
		11.14, 9.39, 2.46, 1.87, 6.34, 5.84, 1.7, 0.73, 0.21, 0.27, 0.14, 0.07,
	],
	[
		0.18, 0.1, 0.12, 0.16, 0.21, 0.19, 0.19, 0.13, 0.15, 6.44, 11.24, 7.66,
		3.51, 6.18, 5.6, 4.5, 5.26, 2.63, 1.1, 0.67, 0.07, 0.05, 0.1, 0.11,
	],
	[
		0.02, 0.1, 0.08, 0.07, 0.09, 0.06, 0.1, 0.05, 0.04, 0.02, 0.03, 0.12, 0.02,
		0.03, 0.05, 0.08, 0.13, 0.04, 0.03, 0.06, 0.07, 0.07, 0.05, 0.02,
	],
	[
		0.03, 0.08, 0.06, 0.01, 0.01, 0.08, 0.09, 0.01, 0.01, 0.11, 0, 0.01, 0.05,
		0, 0, 0, 0.01, 0, 0.05, 0.05, 0, 0, 0, 0,
	],
];

/** Weighted tokens per local day in millions (= demand units), 2026-10-06..11-12, from `days[].weighted`. */
const PROFILE_DAILY: Record<string, number> = {
	"2026-10-06": 1.2,
	"2026-10-07": 4.5,
	"2026-10-08": 14.8,
	"2026-10-09": 8.7,
	"2026-10-10": 0,
	"2026-10-11": 0,
	"2026-10-12": 20.3,
	"2026-10-13": 50.9,
	"2026-10-14": 68.7,
	"2026-10-15": 23.4,
	"2026-10-16": 59.9,
	"2026-10-17": 3.8,
	"2026-10-18": 1.8,
	"2026-10-19": 0,
	"2026-10-20": 71.9,
	"2026-10-21": 74.8,
	"2026-10-22": 90.2,
	"2026-10-23": 2.5,
	"2026-10-24": 1.9,
	"2026-10-25": 0.1,
	"2026-10-26": 45.6,
	"2026-10-27": 89.5,
	"2026-10-28": 26.1,
	"2026-10-29": 96.3,
	"2026-10-30": 71,
	"2026-10-31": 1.4,
	"2026-11-01": 1.3,
	"2026-11-02": 18.9,
	"2026-11-03": 81,
	"2026-11-04": 103.4,
	"2026-11-05": 78.6,
	"2026-11-06": 140.6,
	"2026-11-07": 0,
	"2026-11-08": 0,
	"2026-11-09": 24.5,
	"2026-11-10": 131.1,
	"2026-11-11": 101.5,
	"2026-11-12": 108.5,
};

/** Each day's total spread over its weekday's mean hourly shape. */
export const profileHourly: HourlyShape = (key, isoWeekday) => {
	const shape = PROFILE_HOURLY[isoWeekday - 1] ?? [];
	const sum = shape.reduce((s, v) => s + v, 0);
	const total = PROFILE_DAILY[key] ?? 0;
	return shape.map((v) => (sum > 0 ? (total * v) / sum : 0));
};

/**
 * 2026-11-12 07:00 with the recorded days of the aggregated profile. The account snapshot is the
 * one this fixture had before the replay was rebuilt (acct-a open at 0 %, resets 11:00; acct-b
 * closed), kept so the profile report stays comparable; it is not the replay's 4 % morning.
 */
export function profileFixture(): EngineFixture {
	return replayFixture({
		historyDays: 37,
		hourly: profileHourly,
		fiveHour: {
			a: { usedPct: 0, resetsAt: prague(12, 11) },
			b: { usedPct: 0, resetsAt: null },
		},
	});
}
