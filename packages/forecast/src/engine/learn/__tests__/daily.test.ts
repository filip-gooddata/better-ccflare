import { describe, expect, test } from "bun:test";
import { BUCKET_MS } from "../../../types";
import type { PaceSeries } from "../../pace/types";
import { learnDays, lowoFolds } from "../daily";

const DAY = 288;

function series(start: number, n: number, timeZone = "UTC"): PaceSeries {
	return {
		start,
		units: new Float64Array(n),
		censored: new Uint8Array(n),
		timeZone,
	};
}

describe("learnDays", () => {
	// Mon 2026-11-02 12:00 UTC; now Wed 2026-11-18 10:00 UTC
	const start = Date.UTC(2026, 10, 2, 12);
	const now = Date.UTC(2026, 10, 18, 10);
	const n = (now - start) / BUCKET_MS;

	test("only complete local days before now's local day", () => {
		const days = learnDays(series(start, n), now, 5);
		expect(days.length).toBe(15);
		expect(days[0]?.startMs).toBe(Date.UTC(2026, 10, 3));
		expect(days[14]?.startMs).toBe(Date.UTC(2026, 10, 17));
		expect(days.map((d) => d.dayIndex)).toEqual([...Array(15).keys()]);
		expect(days.every((d) => d.curve.length === DAY)).toBe(true);
	});

	test("weekday, work days and ISO week key", () => {
		const days = learnDays(series(start, n), now, 5);
		expect(days[0]?.weekday).toBe(1); // Tue
		expect(days[4]?.weekday).toBe(5); // Sat
		expect(days.map((d) => d.isWorkday).slice(0, 7)).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
			true,
		]);
		const weekOf = (i: number) => days[i]?.isoWeek;
		expect(weekOf(0)).toBe(weekOf(5)); // Tue..Sun same week
		expect(weekOf(6)).not.toBe(weekOf(5)); // Mon starts the next
		expect(weekOf(6)).toBe((weekOf(5) as number) + 7);
		expect(learnDays(series(start, n), now, 6)[4]?.isWorkday).toBe(true);
	});

	test("curve, total, active, first active bucket, censored", () => {
		const s = series(start, n);
		const d0 = (Date.UTC(2026, 10, 3) - start) / BUCKET_MS;
		s.units[d0 + 100] = 2;
		s.units[d0 + 120] = 3;
		s.censored[d0 + DAY + 5] = 1;
		const days = learnDays(s, now, 5);
		expect(days[0]?.total).toBe(5);
		expect(days[0]?.active).toBe(true);
		expect(days[0]?.firstActiveBucket).toBe(100);
		expect(days[0]?.curve[120]).toBe(3);
		expect(days[0]?.censored).toBe(false);
		expect(days[1]?.censored).toBe(true);
		expect(days[1]?.active).toBe(false);
		expect(days[1]?.firstActiveBucket).toBe(-1);
	});

	test("a DST day has its real bucket count", () => {
		// Europe/Prague leaves summer time on Sun 2026-10-25: a 25-hour day
		const start2 = Date.UTC(2026, 9, 22, 22); // Fri 23 Oct 00:00 local (UTC+2)
		const now2 = Date.UTC(2026, 9, 27, 11);
		const s = series(start2, (now2 - start2) / BUCKET_MS, "Europe/Prague");
		const days = learnDays(s, now2, 5);
		expect(days.map((d) => d.curve.length)).toEqual([DAY, DAY, 300, DAY]);
		expect(days[3]?.startMs).toBe(Date.UTC(2026, 9, 25, 23));
		expect(days[2]?.weekday).toBe(6);
	});

	test("a series ending at local midnight keeps its last day", () => {
		const end = Date.UTC(2026, 10, 10);
		const days = learnDays(series(start, (end - start) / BUCKET_MS), end, 5);
		expect(days[days.length - 1]?.startMs).toBe(Date.UTC(2026, 10, 9));
	});
});

describe("lowoFolds", () => {
	test("one fold per ISO week; censored days neither held out nor trained on", () => {
		const start = Date.UTC(2026, 10, 2, 12);
		const now = Date.UTC(2026, 10, 18, 10);
		const s = series(start, (now - start) / BUCKET_MS);
		const d0 = (Date.UTC(2026, 10, 3) - start) / BUCKET_MS;
		s.censored[d0 + 7 * DAY] = 1; // Tue 10 Nov, dayIndex 7
		const days = learnDays(s, now, 5);
		const folds = lowoFolds(days);
		expect(folds.map((f) => f.week)).toEqual([
			days[0]?.isoWeek,
			days[6]?.isoWeek,
			days[13]?.isoWeek,
		]);
		expect(folds[0]?.heldOut).toEqual([0, 1, 2, 3, 4, 5]);
		expect(folds[1]?.heldOut).toEqual([6, 8, 9, 10, 11, 12]);
		expect(folds[1]?.train).toEqual([0, 1, 2, 3, 4, 5, 13, 14]);
		expect(folds[2]?.train).not.toContain(7);
	});
});
