import { describe, expect, test } from "bun:test";
import { PACE_BANDS, paceMultiplierAt, plainPace } from "../bands";
import type { PaceNow } from "../types";

function paceWith(ms: number[]): PaceNow {
	const pace = plainPace("fitted", 0);
	pace.bands.forEach((b, k) => {
		b.m = ms[k] as number;
	});
	return pace;
}

const MS = [2, 1.5, 0.8, 1.2, 1, 1, 0.9, 1.1, 1.3];

describe("pace bands", () => {
	test("nine bands with the ruled centres", () => {
		expect(PACE_BANDS.map((b) => b.id)).toEqual([
			"0-1h",
			"1-2h",
			"2-4h",
			"4-8h",
			"8-16h",
			"16h-1d",
			"1-2d",
			"2-4d",
			"4-7d",
		]);
		expect(PACE_BANDS.map((b) => b.centreMin)).toEqual([
			30, 90, 180, 360, 720, 1200, 2160, 4320, 7920,
		]);
	});

	test("plain pace is m = 1 in every band with no feature", () => {
		const pace = plainPace("unfitted");
		expect(pace.status).toBe("unfitted");
		expect(pace.fittedAt).toBeNull();
		expect(pace.bands).toHaveLength(9);
		for (const b of pace.bands) {
			expect(b.m).toBe(1);
			expect(b.feature).toBeNull();
		}
		for (const ahead of [0, 30, 61, 500, 7920, 10080])
			expect(paceMultiplierAt(pace, ahead)).toBe(1);
	});

	test("flat before the first centre and after the last", () => {
		const pace = paceWith(MS);
		expect(paceMultiplierAt(pace, 0)).toBe(2);
		expect(paceMultiplierAt(pace, 30)).toBe(2);
		expect(paceMultiplierAt(pace, 7920)).toBeCloseTo(1.3, 12);
		expect(paceMultiplierAt(pace, 10080)).toBe(1.3);
	});

	test("equals the band value at each centre", () => {
		const pace = paceWith(MS);
		PACE_BANDS.forEach((b, k) => {
			expect(paceMultiplierAt(pace, b.centreMin)).toBeCloseTo(
				MS[k] as number,
				12,
			);
		});
	});

	test("linear in log between centres", () => {
		const pace = paceWith(MS);
		expect(paceMultiplierAt(pace, 60)).toBeCloseTo(Math.sqrt(2 * 1.5), 12);
		expect(paceMultiplierAt(pace, 45)).toBeCloseTo(
			Math.exp(0.75 * Math.log(2) + 0.25 * Math.log(1.5)),
			12,
		);
		expect(paceMultiplierAt(pace, 270)).toBeCloseTo(Math.sqrt(0.8 * 1.2), 12);
	});

	test("continuous at band edges and centres", () => {
		const pace = paceWith(MS);
		const eps = 1e-6;
		for (const at of [
			...PACE_BANDS.map((b) => b.centreMin),
			...PACE_BANDS.map((b) => b.toMin),
		]) {
			const left = paceMultiplierAt(pace, at - eps);
			const right = paceMultiplierAt(pace, at + eps);
			expect(Math.abs(left - right)).toBeLessThan(1e-6);
		}
	});

	test("an unestablished following band declines to 1 at its centre", () => {
		const pace = paceWith([2, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(paceMultiplierAt(pace, 90)).toBe(1);
		const mid = paceMultiplierAt(pace, 60);
		expect(mid).toBeGreaterThan(1);
		expect(mid).toBeLessThan(2);
	});
});
