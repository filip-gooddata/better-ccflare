import { describe, expect, test } from "bun:test";
import {
	addLocalDays,
	atLocalMinute,
	localDayKey,
	localDayStart,
	localParts,
	localWeekStart,
} from "../time";

const PRAGUE = "Europe/Prague";
const KOLKATA = "Asia/Kolkata";
const UTC = "UTC";
const H = 3_600_000;
const z = (iso: string) => Date.parse(iso);

describe("UTC", () => {
	test("parts, day start, key, week start", () => {
		const at = z("2026-11-12T09:47:31Z"); // Thursday
		expect(localParts(at, UTC)).toEqual({
			year: 2026,
			month: 11,
			day: 12,
			isoWeekday: 4,
			minuteOfDay: 9 * 60 + 47,
		});
		expect(localDayStart(at, UTC)).toBe(z("2026-11-12T00:00:00Z"));
		expect(localDayKey(at, UTC)).toBe("2026-11-12");
		expect(localWeekStart(at, UTC)).toBe(z("2026-11-09T00:00:00Z"));
		expect(addLocalDays(z("2026-11-12T00:00:00Z"), -12, UTC)).toBe(
			z("2026-10-31T00:00:00Z"),
		);
		expect(atLocalMinute(z("2026-11-12T00:00:00Z"), 1439, UTC)).toBe(
			z("2026-11-12T23:59:00Z"),
		);
	});

	test("Sunday is ISO weekday 7 and its week starts the Monday before", () => {
		const sunday = z("2026-11-15T23:59:59Z");
		expect(localParts(sunday, UTC).isoWeekday).toBe(7);
		expect(localWeekStart(sunday, UTC)).toBe(z("2026-11-09T00:00:00Z"));
	});
});

describe("Europe/Prague spring forward, 2026-03-29", () => {
	const dayStart = z("2026-03-28T23:00:00Z");

	test("the day is 23 hours long", () => {
		expect(localDayStart(z("2026-03-29T12:00:00Z"), PRAGUE)).toBe(dayStart);
		expect(addLocalDays(dayStart, 1, PRAGUE)).toBe(z("2026-03-29T22:00:00Z"));
		expect(addLocalDays(dayStart, 1, PRAGUE) - dayStart).toBe(23 * H);
		expect(addLocalDays(z("2026-03-29T22:00:00Z"), -1, PRAGUE)).toBe(dayStart);
	});

	test("wall-clock minutes around the gap", () => {
		expect(atLocalMinute(dayStart, 60, PRAGUE)).toBe(z("2026-03-29T00:00:00Z"));
		expect(atLocalMinute(dayStart, 180, PRAGUE)).toBe(
			z("2026-03-29T01:00:00Z"),
		);
		// 02:30 does not exist; it moves forward by the gap to 03:30 CEST.
		expect(atLocalMinute(dayStart, 150, PRAGUE)).toBe(
			z("2026-03-29T01:30:00Z"),
		);
		expect(atLocalMinute(dayStart, 12 * 60, PRAGUE)).toBe(
			z("2026-03-29T10:00:00Z"),
		);
	});

	test("parts across the change", () => {
		expect(localParts(z("2026-03-29T00:59:00Z"), PRAGUE).minuteOfDay).toBe(119);
		expect(localParts(z("2026-03-29T01:00:00Z"), PRAGUE).minuteOfDay).toBe(180);
		expect(localParts(z("2026-03-29T12:00:00Z"), PRAGUE).isoWeekday).toBe(7);
	});

	test("week start spans the change", () => {
		expect(localWeekStart(z("2026-03-29T12:00:00Z"), PRAGUE)).toBe(
			z("2026-03-22T23:00:00Z"),
		);
		expect(localWeekStart(z("2026-03-30T10:00:00Z"), PRAGUE)).toBe(
			z("2026-03-29T22:00:00Z"),
		);
	});
});

describe("Europe/Prague fall back, 2026-10-25", () => {
	const dayStart = z("2026-10-24T22:00:00Z");

	test("the day is 25 hours long", () => {
		expect(localDayStart(z("2026-10-25T12:00:00Z"), PRAGUE)).toBe(dayStart);
		expect(addLocalDays(dayStart, 1, PRAGUE)).toBe(z("2026-10-25T23:00:00Z"));
		expect(addLocalDays(dayStart, 1, PRAGUE) - dayStart).toBe(25 * H);
		expect(localDayKey(z("2026-10-25T22:59:59Z"), PRAGUE)).toBe("2026-10-25");
		expect(localDayKey(z("2026-10-25T23:00:00Z"), PRAGUE)).toBe("2026-10-26");
	});

	test("a repeated wall-clock minute resolves to the earlier instant", () => {
		expect(atLocalMinute(dayStart, 150, PRAGUE)).toBe(
			z("2026-10-25T00:30:00Z"),
		);
		expect(atLocalMinute(dayStart, 240, PRAGUE)).toBe(
			z("2026-10-25T03:00:00Z"),
		);
		expect(localParts(z("2026-10-25T00:30:00Z"), PRAGUE).minuteOfDay).toBe(150);
		expect(localParts(z("2026-10-25T01:30:00Z"), PRAGUE).minuteOfDay).toBe(150);
	});
});

describe("Asia/Kolkata, half-hour offset", () => {
	test("day start and parts", () => {
		const at = z("2026-06-15T20:00:00Z"); // 01:30 on 16 June, a Tuesday
		expect(localParts(at, KOLKATA)).toEqual({
			year: 2026,
			month: 6,
			day: 16,
			isoWeekday: 2,
			minuteOfDay: 90,
		});
		expect(localDayStart(at, KOLKATA)).toBe(z("2026-06-15T18:30:00Z"));
		expect(localDayKey(at, KOLKATA)).toBe("2026-06-16");
		expect(localWeekStart(at, KOLKATA)).toBe(z("2026-06-14T18:30:00Z"));
		expect(atLocalMinute(z("2026-06-15T18:30:00Z"), 600, KOLKATA)).toBe(
			z("2026-06-16T04:30:00Z"),
		);
	});
});

describe("invariants over a year", () => {
	for (const zone of [
		PRAGUE,
		KOLKATA,
		UTC,
		"America/Santiago",
		"Australia/Lord_Howe",
		"America/New_York",
	]) {
		test(zone, () => {
			let at = z("2026-01-01T00:00:00Z");
			const end = z("2027-01-01T00:00:00Z");
			while (at < end) {
				const start = localDayStart(at, zone);
				const next = addLocalDays(start, 1, zone);
				expect(start).toBeLessThanOrEqual(at);
				expect(next).toBeGreaterThan(at);
				expect(localDayKey(start, zone)).toBe(localDayKey(at, zone));
				expect(localDayKey(start - 1000, zone)).not.toBe(localDayKey(at, zone));
				expect(addLocalDays(next, -1, zone)).toBe(start);
				const week = localWeekStart(at, zone);
				expect(localParts(week, zone).isoWeekday).toBe(1);
				expect(at - week).toBeLessThan(7 * 24 * H + 2 * H);
				const noon = atLocalMinute(start, 720, zone);
				expect(localParts(noon, zone).minuteOfDay).toBe(720);
				expect(localDayKey(noon, zone)).toBe(localDayKey(at, zone));
				at += 7 * H + 13 * 60_000;
			}
		});
	}
});
