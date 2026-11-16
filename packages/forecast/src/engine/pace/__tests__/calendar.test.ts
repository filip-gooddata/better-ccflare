import { describe, expect, test } from "bun:test";
import { buildCalendar } from "../calendar";
import { GrammarContext, paceGrammar, type SpanSums } from "../grammar";

const byId = new Map(paceGrammar().map((c) => [c.id, c]));
const cand = (id: string) => {
	const c = byId.get(id);
	if (!c) throw new Error(id);
	return c;
};
const none: SpanSums = {
	PU: new Float64Array(1),
	PC: new Float64Array(1),
	PB: new Float64Array(1),
};

describe("target-calendar features beyond the data and across boundaries", () => {
	test("a target crossing Sunday midnight splits its weekday and hour shares", () => {
		// Sun 2026-11-15 22:30 UTC; band 1-2h covers Sun 23:30 to Mon 00:30
		const start = Date.UTC(2026, 10, 15, 0, 0);
		const o = (22 * 60 + 30) / 5;
		const cal = buildCalendar(start, o + 2016 + 1, "UTC");
		const ctx = new GrammarContext(cal);
		const a = o + 12;
		const b = o + 24;
		expect(ctx.value(cand("T:wd-Sun"), none, o, a, b)).toBeCloseTo(0.5, 12);
		expect(ctx.value(cand("T:wd-Mon"), none, o, a, b)).toBeCloseTo(0.5, 12);
		expect(ctx.value(cand("T:hr-23"), none, o, a, b)).toBeCloseTo(0.5, 12);
		expect(ctx.value(cand("T:hr-00"), none, o, a, b)).toBeCloseTo(0.5, 12);
		expect(ctx.value(cand("T:hr-12"), none, o, a, b)).toBe(0);
	});

	test("the 4-7 d band of a live origin reads the calendar past now", () => {
		// origin Mon 00:00; 4-7 d = Fri 00:00 to Mon 00:00: Fri, Sat, Sun one third each
		const start = Date.UTC(2026, 10, 16, 0, 0);
		const cal = buildCalendar(start, 2016 + 1, "UTC");
		const ctx = new GrammarContext(cal);
		const a = 1152;
		const b = 2016;
		for (const wd of ["Fri", "Sat", "Sun"])
			expect(ctx.value(cand(`T:wd-${wd}`), none, 0, a, b)).toBeCloseTo(
				1 / 3,
				12,
			);
		expect(ctx.value(cand("T:wd-Mon"), none, 0, a, b)).toBe(0);
		expect(ctx.value(cand("T:hr-05"), none, 0, a, b)).toBeCloseTo(1 / 24, 12);
	});

	test("the fall-back day in Europe/Prague has 300 buckets, two of them hours 02", () => {
		// local Sun 2026-10-25: 03:00 CEST becomes 02:00 CET
		const start = Date.UTC(2026, 9, 23, 22, 0); // local Sat 2026-10-24 00:00 CEST
		const cal = buildCalendar(start, 3 * 288 + 12, "Europe/Prague");
		expect(cal.days.map((d) => d.end - d.first).slice(0, 2)).toEqual([
			288, 300,
		]);
		const sunday = cal.days[1] as { first: number; end: number; wd: number };
		expect(sunday.wd).toBe(6);
		let hour2 = 0;
		for (let i = sunday.first; i < sunday.end; i++)
			if (Math.floor((cal.minute[i] as number) / 60) === 2) hour2++;
		expect(hour2).toBe(24);
		const ctx = new GrammarContext(cal);
		expect(
			ctx.value(cand("T:hr-02"), none, sunday.first, sunday.first, sunday.end),
		).toBeCloseTo(24 / 300, 12);
	});
});
