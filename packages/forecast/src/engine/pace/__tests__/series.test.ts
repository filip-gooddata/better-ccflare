import { describe, expect, test } from "bun:test";
import type { LimitReading } from "../../../types";
import { buildPaceSeries } from "../index";

const B5 = 300_000;
const T0 = Date.UTC(2026, 10, 2, 0, 0);
const read = (
	accountId: string,
	at: number,
	window: LimitReading["window"],
	usedPct: number,
	resetsAt: number | null,
): LimitReading => ({ accountId, at, window, usedPct, resetsAt });

describe("buildPaceSeries", () => {
	test("sums buckets from historyFrom to now; a missing bucket is 0; the bucket holding now is included", () => {
		const s = buildPaceSeries({
			history: [
				{ start: T0 - B5, units: 9, fableUnits: 0, requests: 1 },
				{ start: T0, units: 1, fableUnits: 0, requests: 1 },
				{ start: T0, units: 2, fableUnits: 1, requests: 1 },
				{ start: T0 + 2 * B5, units: 4, fableUnits: 0, requests: 1 },
			],
			historyFrom: T0,
			now: T0 + 3 * B5 + 1000,
			readings: [],
			accounts: ["a"],
			timeZone: "Europe/Prague",
		});
		expect(s.start).toBe(T0);
		expect(s.timeZone).toBe("Europe/Prague");
		expect([...s.units]).toEqual([3, 0, 4, 0]);
		expect([...s.censored]).toEqual([0, 0, 0, 0]);
	});

	test("censored only while every account is at 99.5 % or more on five_hour or seven_day; a reading holds until its reset; a reading before historyFrom carries in", () => {
		const s = buildPaceSeries({
			history: [],
			historyFrom: T0,
			now: T0 + 10 * B5,
			readings: [
				// b: weekly full from before the window until bucket 6 (reset)
				read("b", T0 - 3 * 86_400_000, "seven_day", 100, T0 + 6 * B5),
				// a: five-hour full from bucket 2 to 8
				read("a", T0 + 2 * B5, "five_hour", 99.5, T0 + 8 * B5),
				// a fable window does not count
				read("a", T0, "seven_day_fable", 100, null),
				read("b", T0, "seven_day_fable", 100, null),
			],
			accounts: ["a", "b"],
			timeZone: "UTC",
		});
		expect([...s.censored]).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
	});

	test("one account below the threshold or without a reading leaves the bucket uncensored", () => {
		const base = {
			history: [],
			historyFrom: T0,
			now: T0 + 4 * B5,
			timeZone: "UTC",
		};
		const one = buildPaceSeries({
			...base,
			readings: [
				read("a", T0, "five_hour", 100, null),
				read("b", T0, "five_hour", 99.4, null),
			],
			accounts: ["a", "b"],
		});
		expect([...one.censored]).toEqual([0, 0, 0, 0]);
		const missing = buildPaceSeries({
			...base,
			readings: [read("a", T0, "five_hour", 100, null)],
			accounts: ["a", "b"],
		});
		expect([...missing.censored]).toEqual([0, 0, 0, 0]);
	});
});
