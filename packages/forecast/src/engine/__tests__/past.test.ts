import { describe, expect, test } from "bun:test";
import type { LimitReading, LimitWindow } from "../../types";
import { pastSeries, pastStops } from "../past";
import {
	account,
	HOUR,
	MIDNIGHT,
	MIN,
	MONDAY,
	makeCtx,
	NOW,
} from "./fixtures-response";

const MONDAY_NEXT = Date.UTC(2026, 10, 16, 8);

function reading(
	accountId: string,
	window: LimitWindow,
	at: number,
	usedPct: number,
	resetsAt: number | null,
): LimitReading {
	return { accountId, window, at, usedPct, resetsAt };
}

/** Local clock time on Thursday 2026-11-12 (CET = UTC+1). */
const at = (h: number, m = 0) => MIDNIGHT + h * HOUR + m * MIN;

describe("day.past", () => {
	// acct-a opens at 08:00 (reset 13:00) and fills by 12:00; acct-b's weekly
	// limit is used up, so it counts 0 in the 5-hour pool all day.
	const readings = [
		reading("acct-a", "five_hour", MIDNIGHT - 10 * MIN, 0, null),
		reading("acct-a", "seven_day", MIDNIGHT - 10 * MIN, 30, MONDAY_NEXT),
		reading("acct-b", "five_hour", MIDNIGHT - 10 * MIN, 0, null),
		reading("acct-b", "seven_day", MIDNIGHT - 10 * MIN, 100, MONDAY_NEXT),
		reading("acct-a", "five_hour", at(8), 5, at(13)),
		reading("acct-a", "five_hour", at(8, 30), 40, at(13)),
		reading("acct-a", "five_hour", at(10), 40, at(13)),
		reading("acct-a", "five_hour", at(12), 100, at(13)),
	];
	const ctx = makeCtx({
		readings,
		accounts: [
			account("acct-a", { weekly: { usedPct: 30, resetsAt: MONDAY_NEXT } }),
			account("acct-b", {
				weekly: { usedPct: 100, resetsAt: MONDAY_NEXT },
			}),
		],
	});

	test("one entry per change, flat stretches kept flat, reset as two entries, ends at now", () => {
		expect(pastSeries(ctx, "day")).toEqual({
			times: [MIDNIGHT, at(8), at(8, 30), at(10), at(12), at(13), at(13), NOW],
			values: [100, 95, 60, 60, 0, 0, 100, 100],
		});
	});

	test("pastStops: the interval in which every counted account was out", () => {
		expect(pastStops(ctx, "day")).toEqual([{ start: at(12), end: at(13) }]);
		expect(pastStops(ctx, "week")).toEqual([]);
	});

	test("starts later than midnight when there are no earlier readings", () => {
		const late = makeCtx({
			readings: readings
				.filter((r) => r.at >= MIDNIGHT)
				.concat([
					reading("acct-a", "seven_day", at(7), 30, MONDAY_NEXT),
					reading("acct-b", "five_hour", at(6), 0, null),
					reading("acct-b", "seven_day", at(6), 100, MONDAY_NEXT),
				]),
			accounts: ctx.accounts,
		});
		const past = pastSeries(late, "day");
		expect(past.times[0]).toBe(at(8));
		expect(past.values[0]).toBe(95);
	});

	test("no readings: only now, from the accounts as last read", () => {
		const empty = makeCtx({ accounts: ctx.accounts });
		expect(pastSeries(empty, "day")).toEqual({ times: [NOW], values: [100] });
		expect(pastStops(empty, "day")).toEqual([]);
	});

	test("a stop still running at the last reading is not a past stop", () => {
		const running = makeCtx({
			readings: [
				...readings,
				reading("acct-a", "five_hour", at(13, 5), 100, at(18)),
			],
			accounts: [
				account("acct-a", {
					fiveHour: { usedPct: 100, resetsAt: at(18) },
					weekly: { usedPct: 30, resetsAt: MONDAY_NEXT },
				}),
				ctx.accounts[1],
			],
		});
		expect(pastStops(running, "day")).toEqual([{ start: at(12), end: at(13) }]);
	});
});

describe("week.past", () => {
	// Flat hourly readings from Monday, then acct-a's weekly use rises one point
	// per 10-minute reading from Thursday 08:00.
	const readings: LimitReading[] = [
		reading("acct-b", "seven_day", MONDAY - 10 * MIN, 0, MONDAY_NEXT),
	];
	for (let t = MONDAY - 10 * MIN; t < at(8); t += HOUR)
		readings.push(reading("acct-a", "seven_day", t, 0, MONDAY_NEXT));
	let used = 1;
	for (let t = at(8); t <= NOW - 5 * MIN; t += 10 * MIN, used++)
		readings.push(reading("acct-a", "seven_day", t, used, MONDAY_NEXT));
	const ctx = makeCtx({
		readings,
		accounts: [
			account("acct-a", { weekly: { usedPct: 32, resetsAt: MONDAY_NEXT } }),
			account("acct-b", { weekly: { usedPct: 0, resetsAt: MONDAY_NEXT } }),
		],
	});
	const past = pastSeries(ctx, "week");

	test("from Monday 00:00 local to now", () => {
		expect(past.times[0]).toBe(MONDAY);
		expect(past.values[0]).toBe(200);
		expect(past.times[past.times.length - 1]).toBe(NOW);
		expect(past.values[past.values.length - 1]).toBe(168);
	});

	test("at most one entry per 30 minutes besides jumps and the last entry", () => {
		for (let i = 1; i < past.times.length - 1; i++)
			expect(past.times[i] - past.times[i - 1]).toBeGreaterThanOrEqual(
				30 * MIN,
			);
		expect(past.times.length).toBeGreaterThan(8);
	});

	test("a weekly reset inside the week shows as two entries", () => {
		const reset = at(9);
		const withReset = makeCtx({
			readings: [
				reading("acct-a", "seven_day", MONDAY, 80, reset),
				reading("acct-b", "seven_day", MONDAY, 50, MONDAY_NEXT),
			],
			accounts: [
				account("acct-a", {
					weekly: { usedPct: 0, resetsAt: reset + 7 * 24 * HOUR },
				}),
				account("acct-b", { weekly: { usedPct: 50, resetsAt: MONDAY_NEXT } }),
			],
		});
		expect(pastSeries(withReset, "week")).toEqual({
			times: [MONDAY, reset, reset, NOW],
			values: [70, 70, 150, 150],
		});
	});
});
