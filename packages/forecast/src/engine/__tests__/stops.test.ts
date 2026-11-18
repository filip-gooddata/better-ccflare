import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract";
import type { EpochMs, LimitReading } from "../../types";
import type { SampleAxis } from "../model";
import { buildResponse } from "../response";
import { FULL_POINTS } from "../simulate";
import { fillAtNow, spill } from "../stops";
import {
	account,
	defaultAxis,
	HOUR,
	MIDNIGHT,
	MIN,
	makeCtx,
	makeSim,
	makeTrace,
	NOW,
} from "./fixtures-response";

const at = (h: number, m = 0) => MIDNIGHT + h * HOUR + m * MIN;
const RESET_A = at(16);
const RESET_B = at(18, 10);
const MONDAY_NEXT = Date.UTC(2026, 10, 16, 8);

/** The second entry of a jump pair at `t`. */
const afterJump = (axis: SampleAxis, t: EpochMs, i: number) =>
	axis.times[i] > t || (axis.times[i] === t && axis.times[i - 1] === t);

/**
 * The spec example's state: acct-a at 94 % (reset 16:00), acct-b at 6 % (reset
 * 18:10). Simulated day s runs out at Z_s = 14:00 + ⌊0.3·s⌋ minutes (acct-a an
 * hour earlier), stays at 0 until acct-a's reset and leaves `units` unserved
 * per 5-minute step while at 0.
 */
function exampleRun(units: number, k = 2, minStopPoints = 1) {
	const ctx = makeCtx({
		accounts: [
			account("acct-a", { fiveHour: { usedPct: 94, resetsAt: RESET_A } }),
			account("acct-b", { fiveHour: { usedPct: 6, resetsAt: RESET_B } }),
		],
		settings: { minStopPoints },
		calibration: { fiveHour: { "acct-a": k, "acct-b": k } },
	});
	const axis = defaultAxis(ctx, [RESET_A, RESET_B]);
	const traces = Array.from({ length: 400 }, (_, s) => {
		const zero = at(14) + Math.floor(0.3 * s) * MIN;
		return makeTrace(axis, {
			day: (t, i) => {
				if (afterJump(axis, RESET_A, i)) return 100;
				if (t >= zero) return 0;
				return (100 * (zero - t)) / (zero - NOW);
			},
			unserved: (t, i) =>
				t > zero && t <= RESET_A && !afterJump(axis, RESET_A, i) ? units : 0,
			outs: [
				{ account: 0, at: zero - HOUR, limit: "five_hour" },
				{ account: 1, at: zero, limit: "five_hour" },
			],
		});
	});
	return buildResponse(ctx, makeSim(ctx, axis, traces));
}

describe("projected stops", () => {
	const day = exampleRun(1).day;
	if (day === null) throw new Error("day block expected");

	test("start at the level's zero point, end at the reset that brings quota back", () => {
		// p90 needs 41 of 400 days at 0 (type-7 index ⌈399·0.1⌉): day 40, 14:12.
		expect(day.stops.heavy).toEqual([{ start: at(14, 12), end: RESET_A }]);
		expect(day.stops.typical).toEqual([{ start: at(15), end: RESET_A }]);
		expect(day.stops.light).toEqual([{ start: at(15, 48), end: RESET_A }]);
		expect(day.times).toContain(at(14, 12));
		expect(day.heavy[day.times.indexOf(at(14, 12))]).toBe(0);
	});

	test("light stops lie inside typical stops, which lie inside heavy stops", () => {
		const inside = (
			inner: typeof day.stops.light,
			outer: typeof day.stops.light,
		) =>
			inner.every((i) =>
				outer.some((o) => o.start <= i.start && i.end <= o.end),
			);
		expect(inside(day.stops.light, day.stops.typical)).toBe(true);
		expect(inside(day.stops.typical, day.stops.heavy)).toBe(true);
	});

	test("listed only when the level leaves at least minStopPoints unserved", () => {
		expect(exampleRun(0.01).day?.stops).toEqual({
			light: [],
			typical: [],
			heavy: [],
		});
		// Heavy: 21.6 steps of 0.02 points = 0.432 (the 14:10-14:15 step counts its
		// 3 minutes inside the stop); typical: 12 steps = 0.24; light: 3 steps.
		const stops = exampleRun(0.01, 2, 0.3).day?.stops;
		expect(stops?.heavy).toEqual([{ start: at(14, 12), end: RESET_A }]);
		expect(stops?.typical).toEqual([]);
		expect(stops?.light).toEqual([]);
		// Just above 0.432: counting the whole 14:10-14:15 step (0.44) would list it.
		expect(exampleRun(0.01, 2, 0.435).day?.stops.heavy).toEqual([]);
	});

	test("zero quota at night with no demand is not a stop", () => {
		const ctx = makeCtx();
		const axis = defaultAxis(ctx);
		const traces = Array.from({ length: 50 }, () =>
			makeTrace(axis, { day: (t) => (t >= at(22) ? 0 : 150) }),
		);
		const night = buildResponse(ctx, makeSim(ctx, axis, traces)).day;
		expect(night?.heavy[night.heavy.length - 1]).toBe(0);
		expect(night?.stops).toEqual({ light: [], typical: [], heavy: [] });
	});
});

/**
 * The exampleRun state with every simulated day alike: the line falls from its
 * value at NOW to `after(t)` from `fill`, both accounts out by `fill`, and
 * `units` unserved per step from `fill` to acct-a's reset.
 */
function alikeRun(
	fill: EpochMs,
	after: (t: EpochMs) => number,
	units = 1,
): ReturnType<typeof buildResponse> {
	const ctx = makeCtx({
		accounts: [
			account("acct-a", { fiveHour: { usedPct: 94, resetsAt: RESET_A } }),
			account("acct-b", { fiveHour: { usedPct: 6, resetsAt: RESET_B } }),
		],
		calibration: { fiveHour: { "acct-a": 2, "acct-b": 2 } },
	});
	const axis = defaultAxis(ctx, [RESET_A, RESET_B]);
	const traces = Array.from({ length: 50 }, () =>
		makeTrace(axis, {
			day: (t, i) => {
				if (afterJump(axis, RESET_A, i)) return 100;
				if (t >= fill) return after(t);
				return (100 * (fill - t)) / (fill - NOW);
			},
			unserved: (t, i) =>
				t > fill && t <= RESET_A && !afterJump(axis, RESET_A, i) ? units : 0,
			outs: [
				{ account: 0, at: fill - HOUR, limit: "five_hour" },
				{ account: 1, at: fill, limit: "five_hour" },
			],
		}),
	);
	return buildResponse(ctx, makeSim(ctx, axis, traces));
}

/** Quota left of an account filled to 100 − residue by many small additions, as the simulation fills it. */
function filledLeft(residue: number, additions: number): number {
	const step = (100 - residue) / additions;
	let used = 0;
	for (let i = 0; i < additions; i++) used = Math.min(100, used + step);
	return 100 - used;
}

describe("zero cutoff: accounts × (100 − FULL_POINTS)", () => {
	const stopAt = (start: EpochMs) => ({
		light: [{ start, end: RESET_A }],
		typical: [{ start, end: RESET_A }],
		heavy: [{ start, end: RESET_A }],
	});

	test("a fill that leaves float residue on both accounts is one stop from the fill time", () => {
		const leftA = filledLeft(5e-10, 4000);
		const leftB = filledLeft(5e-10, 7000);
		// Both accounts are full by the simulation's own test, yet not at exactly 0.
		expect(100 - leftA).toBeGreaterThanOrEqual(FULL_POINTS);
		expect(100 - leftB).toBeGreaterThanOrEqual(FULL_POINTS);
		expect(leftA + leftB).toBeGreaterThan(0);
		const day = alikeRun(at(14), () => leftA + leftB).day;
		expect(day?.stops).toEqual(stopAt(at(14)));
		expect(day?.heavy[day.times.indexOf(at(14))]).toBe(0);
		expect(
			validateForecastResponse(alikeRun(at(14), () => leftA + leftB)),
		).toEqual([]);
	});

	test("two accounts each exactly at the full threshold are 0; more left than that is not", () => {
		const full = 100 - FULL_POINTS;
		expect(alikeRun(at(14), () => full + full).day?.stops).toEqual(
			stopAt(at(14)),
		);
		expect(alikeRun(at(14), () => 3 * full).day?.stops).toEqual({
			light: [],
			typical: [],
			heavy: [],
		});
	});

	test("a quiet line at 1e-12 with no demand lists no stop", () => {
		const ctx = makeCtx();
		const axis = defaultAxis(ctx);
		const traces = Array.from({ length: 50 }, () =>
			makeTrace(axis, { day: (t) => (t >= at(22) ? 1e-12 : 150) }),
		);
		const night = buildResponse(ctx, makeSim(ctx, axis, traces)).day;
		expect(night?.heavy[night.heavy.length - 1]).toBe(0);
		expect(night?.stops).toEqual({ light: [], typical: [], heavy: [] });
	});

	test("a line above the cutoff that would round to 0.0 is not a stop and prints 0.1", () => {
		const response = alikeRun(at(13, 30), (t) => (t < at(14) ? 0.03 : 0));
		const day = response.day;
		expect(day?.stops).toEqual(stopAt(at(14)));
		expect(day?.heavy[day.times.indexOf(at(13, 30))]).toBe(0.1);
		expect(day?.heavy[day.times.indexOf(at(13, 55))]).toBe(0.1);
		expect(day?.heavy[day.times.indexOf(at(14))]).toBe(0);
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("a stop that ends on a small positive value ends there, which prints 0.1", () => {
		const response = alikeRun(at(14), (t) => (t < at(15) ? 0 : 0.03));
		const day = response.day;
		expect(day?.stops.heavy).toEqual([{ start: at(14), end: at(15) }]);
		expect(day?.heavy[day.times.indexOf(at(14, 55))]).toBe(0);
		expect(day?.heavy[day.times.indexOf(at(15))]).toBe(0.1);
		expect(validateForecastResponse(response)).toEqual([]);
	});
});

describe("shortfall: spill rule", () => {
	test("last account up to its fill, the rest to the others", () => {
		// Median day: 12 steps × 1 unit × k 2 = 24 points in the typical stop.
		expect(exampleRun(1).day?.shortfall).toEqual({
			stop: { start: at(15), end: RESET_A },
			points: 24,
			lastAccount: "acct-b",
			perAccount: { "acct-a": 18, "acct-b": 6 },
		});
	});

	test("leftover beyond every fill goes to the last account", () => {
		const s = exampleRun(1, 20).day?.shortfall;
		expect(s?.points).toBe(240);
		expect(s?.perAccount).toEqual({ "acct-a": 94, "acct-b": 146 });
	});

	test("others in reverse order of running out, parts sum exactly in tenths", () => {
		// last = 0 (fill 5); 2 ran out after 1, so 2 fills before 1.
		expect(spill(333, 0, [5, 50, 20], [100, 200, 300])).toEqual([50, 83, 200]);
		expect(spill(1001, 1, [10, 30], [0, 0])).toEqual([100, 901]);
	});
});

describe("stopNow", () => {
	const readings: LimitReading[] = [
		{
			accountId: "acct-a",
			window: "seven_day",
			at: at(6),
			usedPct: 40,
			resetsAt: MONDAY_NEXT,
		},
		{
			accountId: "acct-b",
			window: "seven_day",
			at: at(6),
			usedPct: 40,
			resetsAt: MONDAY_NEXT,
		},
		{
			accountId: "acct-a",
			window: "five_hour",
			at: at(11),
			usedPct: 60,
			resetsAt: RESET_A,
		},
		{
			accountId: "acct-a",
			window: "five_hour",
			at: at(12),
			usedPct: 100,
			resetsAt: RESET_A,
		},
		{
			accountId: "acct-b",
			window: "five_hour",
			at: at(13),
			usedPct: 80,
			resetsAt: RESET_B,
		},
		{
			accountId: "acct-b",
			window: "five_hour",
			at: at(13, 5),
			usedPct: 100,
			resetsAt: RESET_B,
		},
	];
	const ctx = makeCtx({
		readings,
		accounts: [
			account("acct-a", {
				fiveHour: { usedPct: 100, resetsAt: RESET_A },
				weekly: { usedPct: 40, resetsAt: MONDAY_NEXT },
			}),
			account("acct-b", {
				fiveHour: { usedPct: 100, resetsAt: RESET_B },
				weekly: { usedPct: 40, resetsAt: MONDAY_NEXT },
			}),
		],
	});
	const axis = defaultAxis(ctx, [RESET_A, RESET_B]);
	const traces = Array.from({ length: 100 }, () =>
		makeTrace(axis, {
			day: (_, i) => (afterJump(axis, RESET_A, i) ? 100 : 0),
			unserved: (t, i) =>
				t <= RESET_A && !afterJump(axis, RESET_A, i) ? 0.5 : 0,
		}),
	);
	const day = buildResponse(ctx, makeSim(ctx, axis, traces)).day;

	test("from the last account going out to the first coming back", () => {
		expect(day?.stopNow).toEqual({ start: at(13, 5), end: RESET_A });
	});

	test("a stop that has begun is not repeated in the stops lists", () => {
		expect(day?.stops).toEqual({ light: [], typical: [], heavy: [] });
		expect(day?.pastStops).toEqual([]);
	});

	test("shortfall of the running stop counts from computedAt; the one that went out last takes it", () => {
		// 13:20 to 16:00 = 32 steps × 0.5 units × k 2.
		expect(day?.shortfall).toEqual({
			stop: { start: at(13, 5), end: RESET_A },
			points: 32,
			lastAccount: "acct-b",
			perAccount: { "acct-a": 0, "acct-b": 32 },
		});
	});

	test("week: every counted account at 100 % weekly", () => {
		const weekOut = makeCtx({
			accounts: [
				account("acct-a", { weekly: { usedPct: 100, resetsAt: MONDAY_NEXT } }),
				account("acct-b", { weekly: { usedPct: 100, resetsAt: at(20) } }),
			],
		});
		const wAxis = defaultAxis(weekOut);
		const week = buildResponse(
			weekOut,
			makeSim(weekOut, wAxis, [
				makeTrace(wAxis, { day: () => 0, week: () => 0 }),
			]),
		).week;
		expect(week?.stopNow).toEqual({ start: NOW, end: at(20) });
		expect(week?.stops.heavy).toEqual([]);
	});
});

describe("fill for the spill rule", () => {
	test("day: use of the open 5-hour window, 0 with no open window", () => {
		expect(
			fillAtNow(
				account("a", { fiveHour: { usedPct: 94, resetsAt: RESET_A } }),
				"day",
				NOW,
			),
		).toBe(94);
		expect(fillAtNow(account("a"), "day", NOW)).toBe(0);
		expect(
			fillAtNow(
				account("a", { fiveHour: { usedPct: 70, resetsAt: at(12) } }),
				"day",
				NOW,
			),
		).toBe(0);
		// A used-up weekly limit leaves no 5-hour quota: the fill is 100 (spec section 6).
		expect(
			fillAtNow(
				account("a", { weekly: { usedPct: 100, resetsAt: MONDAY_NEXT } }),
				"day",
				NOW,
			),
		).toBe(100);
	});
	test("day: 100 minus the capped quota left, the weekly cap included", () => {
		// 93 % weekly used at r = 6: 7 weekly points are worth 42 five-hour points.
		const weekly = { usedPct: 93, resetsAt: MONDAY_NEXT };
		expect(
			fillAtNow(
				account("a", { fiveHour: { usedPct: 0, resetsAt: RESET_A }, weekly }),
				"day",
				NOW,
				6,
			),
		).toBeCloseTo(58, 9);
		expect(fillAtNow(account("a", { weekly }), "day", NOW, 6)).toBeCloseTo(
			58,
			9,
		);
		// The cap does not bind: the open window's use, as before.
		expect(
			fillAtNow(
				account("a", { fiveHour: { usedPct: 94, resetsAt: RESET_A }, weekly }),
				"day",
				NOW,
				6,
			),
		).toBe(94);
		// No ratio (impossible calibration): no cap.
		expect(fillAtNow(account("a", { weekly }), "day", NOW, null)).toBe(0);
		// A running cooldown does not enter the fill.
		expect(
			fillAtNow(
				account("a", {
					fiveHour: { usedPct: 30, resetsAt: RESET_A },
					blockedUntil: RESET_A,
				}),
				"day",
				NOW,
				6,
			),
		).toBe(30);
	});
	test("week: weekly use", () => {
		expect(
			fillAtNow(
				account("a", { weekly: { usedPct: 37, resetsAt: MONDAY_NEXT } }),
				"week",
				NOW,
			),
		).toBe(37);
	});
});
