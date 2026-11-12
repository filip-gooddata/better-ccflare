import { describe, expect, test } from "bun:test";
import type { AccountLimits } from "../../types";
import { computeHorizon } from "../horizon";
import { levelLines, levelOf } from "../percentile";

const TZ = "Europe/Prague";

function account(weeklyReset: number | null): AccountLimits {
	return {
		accountId: "acct-a",
		name: "a",
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 10, resetsAt: weeklyReset },
		fable: null,
		blockedUntil: null,
		readAt: 0,
	};
}

describe("computeHorizon", () => {
	// Thursday 2026-11-12 10:00 CET
	const now = Date.UTC(2026, 10, 12, 9, 0);
	test("week ends Friday 24:00 local when resets are earlier", () => {
		const h = computeHorizon(now, [account(Date.UTC(2026, 10, 13, 12))], TZ);
		expect(h.dayEnd).toBe(Date.UTC(2026, 10, 12, 23, 0));
		expect(h.weekEnd).toBe(Date.UTC(2026, 10, 13, 23, 0));
		expect(h.fineEnd).toBe(now + 86_400_000);
		expect(h.simEnd).toBe(h.weekEnd);
	});
	test("a later weekly reset extends the week, capped at 7 days", () => {
		const reset = Date.UTC(2026, 10, 16, 8);
		expect(computeHorizon(now, [account(reset)], TZ).weekEnd).toBe(reset);
		const far = now + 9 * 86_400_000;
		expect(computeHorizon(now, [account(far)], TZ).weekEnd).toBe(
			now + 7 * 86_400_000,
		);
	});
	test("on a Saturday the week ends at a weekly reset later that day", () => {
		// Saturday 2026-11-14 10:00 CET, reset at 12:00 CET
		const sat = Date.UTC(2026, 10, 14, 9, 0);
		const reset = Date.UTC(2026, 10, 14, 11, 0);
		const h = computeHorizon(sat, [account(reset)], TZ);
		expect(h.weekEnd).toBe(reset);
		expect(h.weekEnd).toBeLessThan(h.dayEnd);
		expect(h.simEnd).toBe(sat + 86_400_000);
	});
	test("on a Saturday with no reset ahead the week ends next Friday 24:00", () => {
		const sat = Date.UTC(2026, 10, 14, 9, 0);
		const h = computeHorizon(sat, [account(null)], TZ);
		expect(h.weekEnd).toBe(Date.UTC(2026, 10, 20, 23, 0));
	});
});

describe("levelLines", () => {
	test("levels are ordered at every index and match levelOf", () => {
		const series = Array.from({ length: 50 }, (_, s) =>
			Float32Array.from([s, 100 - s, (s * 37) % 50]),
		);
		const levels = [10, 12, 50, 88, 90];
		const lines = levelLines(series, 3, levels);
		for (let i = 0; i < 3; i++) {
			for (let l = 1; l < levels.length; l++)
				expect(lines[l][i]).toBeLessThanOrEqual(lines[l - 1][i]);
			expect(lines[4][i]).toBe(
				levelOf(
					series.map((x) => x[i]),
					90,
				),
			);
		}
		expect(lines[0][0]).toBeGreaterThan(lines[4][0]);
	});
	test("pNN of demand is the (100 - NN)th percentile of quota left", () => {
		// 10 simulated days with quota left 0..90; simple-statistics interpolates linearly at (n - 1)·p
		// (type 7): p 0.9 -> 81, p 0.5 -> 45, p 0.1 -> 9.
		const series = Array.from({ length: 10 }, (_, s) =>
			Float32Array.from([s * 10]),
		);
		const [light, typical, heavy] = levelLines(series, 1, [10, 50, 90]);
		expect(light[0]).toBeCloseTo(81, 9);
		expect(typical[0]).toBeCloseTo(45, 9);
		expect(heavy[0]).toBeCloseTo(9, 9);
	});
});
