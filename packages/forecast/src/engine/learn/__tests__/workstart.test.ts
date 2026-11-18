import { describe, expect, test } from "bun:test";
import { BUCKET_MS } from "../../../types";
import type { PaceSeries } from "../../pace/types";
import { scoreWorkstartSample } from "../rows/workstart-sample";
import { scoreWorkstartShare } from "../rows/workstart-share";
import type { LearnInput } from "../types";

const DAY = 288;
const MON_NOV_2 = Date.UTC(2026, 10, 2);

/**
 * Three ISO weeks from Mon 2026-11-02 00:00 UTC; now Mon 2026-11-23 10:00 UTC,
 * so days Nov 2..22 are complete (dayIndex 0..20).
 * W1 work days: 2 units at 02:00 (stray) and 100 at 09:00.
 * W2 work days: 100 at 09:00. W3 work days: 100 at 08:00.
 * Sat Nov 7: 50 units at 00:30 (weekend: neither unit nor training).
 */
function fixture(): { series: PaceSeries; now: number } {
	const now = Date.UTC(2026, 10, 23, 10);
	const n = (now - MON_NOV_2) / BUCKET_MS;
	const units = new Float64Array(n);
	for (let d = 0; d < 21; d++) {
		const wd = d % 7;
		const base = d * DAY;
		if (wd >= 5) continue;
		if (d < 7) {
			units[base + 24] = 2;
			units[base + 108] = 100;
		} else if (d < 14) units[base + 108] = 100;
		else units[base + 96] = 100;
	}
	units[5 * DAY + 6] = 50;
	return {
		series: {
			start: MON_NOV_2,
			units,
			censored: new Uint8Array(n),
			timeZone: "UTC",
		},
		now,
	};
}

function input(
	series: PaceSeries,
	now: number,
	workStartSharePct = 5,
): LearnInput {
	return {
		series,
		now,
		workDays: 5,
		historyLookbackDays: 28,
		historyHalfLifeDays: 14,
		workStartSharePct,
		timeShiftMin: 30,
		fitWithPartition: () => {
			throw new Error("not used by row 16");
		},
	};
}

const WORKDAY_UNITS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18];
const rep = (v: number, k: number) => Array<number>(k).fill(v);

describe("row 16 share grid and preference", () => {
	const { series, now } = fixture();
	test("setting 5 joins the grid and ranks by grid distance, ties to the smaller index", () => {
		const s = scoreWorkstartShare(input(series, now, 5));
		expect(s.row).toBe("wsshare");
		expect(s.candidates).toEqual([1, 2, 4, 5, 8, 16]);
		expect(s.presentIndex).toBe(3);
		expect(s.preference).toEqual([5, 3, 1, 0, 2, 4]);
	});
	test("a setting on the grid is not duplicated", () => {
		const s = scoreWorkstartShare(input(series, now, 4));
		expect(s.candidates).toEqual([1, 2, 4, 8, 16]);
		expect(s.presentIndex).toBe(2);
		expect(s.preference).toEqual([3, 1, 0, 2, 4]);
	});
	test("a setting past the grid end is its end", () => {
		const s = scoreWorkstartShare(input(series, now, 20));
		expect(s.candidates).toEqual([1, 2, 4, 8, 16, 20]);
		expect(s.presentIndex).toBe(5);
		expect(s.preference).toEqual([5, 4, 3, 2, 1, 0]);
	});
});

describe("row 16 sample grid and preference", () => {
	test("{5,10,20} with present 10", () => {
		const { series, now } = fixture();
		const s = scoreWorkstartSample(input(series, now));
		expect(s.row).toBe("wssample");
		expect(s.candidates).toEqual([5, 10, 20]);
		expect(s.presentIndex).toBe(1);
		expect(s.preference).toEqual([1, 0, 2]);
	});
});

describe("row 16 units and loss", () => {
	test("units are the uncensored active work days; weekend demand is neither unit nor training", () => {
		const { series, now } = fixture();
		expect(scoreWorkstartShare(input(series, now)).units).toEqual(
			WORKDAY_UNITS,
		);
		expect(scoreWorkstartSample(input(series, now)).units).toEqual(
			WORKDAY_UNITS,
		);
	});

	test("a censored or inactive work day is not a unit", () => {
		const { series, now } = fixture();
		series.censored[2 * DAY + 200] = 1; // Wed Nov 4 censored
		series.units[8 * DAY + 108] = 0; // Tue Nov 10 inactive
		const s = scoreWorkstartShare(input(series, now));
		expect(s.units).toEqual(WORKDAY_UNITS.filter((u) => u !== 2 && u !== 8));
	});

	test("share loss at sample 10, hand-checked", () => {
		const { series, now } = fixture();
		const s = scoreWorkstartShare(input(series, now));
		const at = (share: number) => [
			...(s.loss[s.candidates.indexOf(share)] as Float64Array),
		];
		// share 5: W1 held out -> median(540 x5, 480 x5) = 510 vs 120;
		// W2 -> 510 vs 540; W3 -> 540 vs 480
		expect(at(5)).toEqual([...rep(390, 5), ...rep(30, 5), ...rep(60, 5)]);
		// share 1 catches the W1 stray at 02:00: W2 -> median(120 x5, 480 x5) = 300;
		// W3 -> median(120 x5, 540 x5) = 330
		expect(at(1)).toEqual([...rep(390, 5), ...rep(240, 5), ...rep(150, 5)]);
		expect(s.loss).toHaveLength(6);
		for (const l of s.loss) expect(l).toHaveLength(15);
	});

	test("sample loss at share 5 uses the nearest training days, ties to the earlier day", () => {
		const { series, now } = fixture();
		const s = scoreWorkstartSample(input(series, now));
		// sample 5: W1 -> nearest are W2 (540); W2 Mon..Wed -> mostly W1 (540),
		// Thu/Fri -> mostly W3 (480); W3 -> W2 (540)
		expect([...(s.loss[0] as Float64Array)]).toEqual([
			...rep(420, 5),
			0,
			0,
			0,
			60,
			60,
			...rep(60, 5),
		]);
		const ten = [...rep(390, 5), ...rep(30, 5), ...rep(60, 5)];
		expect([...(s.loss[1] as Float64Array)]).toEqual(ten);
		// only 10 training work days exist: sample 20 uses what exists
		expect([...(s.loss[2] as Float64Array)]).toEqual(ten);
	});
});

describe("row 16 degenerate cases", () => {
	test("no demand: no units", () => {
		const { series, now } = fixture();
		series.units.fill(0);
		for (const s of [
			scoreWorkstartShare(input(series, now)),
			scoreWorkstartSample(input(series, now)),
		]) {
			expect(s.units).toEqual([]);
			for (const l of s.loss) expect(l).toHaveLength(0);
		}
	});

	test("one ISO week: no training work days, every unit unscored", () => {
		const { series } = fixture();
		const now = Date.UTC(2026, 10, 9, 10);
		const s = scoreWorkstartShare(input(series, now));
		expect(s.units).toEqual([0, 1, 2, 3, 4]);
		for (const l of s.loss) expect([...l].every(Number.isNaN)).toBe(true);
	});
});
