import { describe, expect, test } from "bun:test";
import {
	compareScores,
	OPEN_MIN_STOP_GAIN_MIN,
	openingEarns,
	openingGrid,
	openingReason,
	type PlanScore,
	planForecast,
	scorePlan,
} from "../planner";
import { onDemandPlan, simulate } from "../simulate";
import {
	account,
	HOUR,
	MIN,
	makeCtx,
	measureYield,
	prague,
} from "./fixtures-sim";

/**
 * 2026-11-12 shape (research 17), heavy day: both windows closed in the morning; work starts at
 * 11:00 and fills the first account by about 13:17; the afternoon is heavier and fills the second
 * by about 14:55; demand runs to 16:00. Weekly limits are far from the line.
 * Units per minute with k 1 point per unit; days spread ±10 % so the heavy (p90) day is ~8 % above
 * the profile.
 */
function nov12(prewarm = true) {
	const now = prague(12, 7, 30);
	const weekReset = prague(13, 20);
	return makeCtx({
		now,
		spread: 0.1,
		accounts: [
			account({ id: "acct-a", weekUsed: 10, weekReset }),
			account({ id: "acct-b", weekUsed: 10, weekReset }),
		],
		kW: { "acct-a": 0.05, "acct-b": 0.05 },
		rate: (m, w) => {
			if (w > 5) return 0;
			if (m >= 660 && m < 795) return 0.68;
			if (m >= 795 && m < 960) return 0.945;
			return 0;
		},
		settings: { prewarm },
		workStartMinute: 660,
	});
}

describe("planForecast: 2026-11-12 shape", () => {
	test("opening a window early lifts the heavy low point and removes the heavy stop", async () => {
		const ctx = nov12(true);
		const { value, wallMs, longestMs, turns } = await measureYield(() =>
			planForecast(ctx),
		);
		const { plan, score, baseline, candidates } = value;
		console.log(
			`planForecast 400 days: wall ${wallMs.toFixed(0)} ms, ${candidates} candidates, longest slice ${longestMs.toFixed(1)} ms, ${turns} turns`,
		);
		console.log(
			`baseline: day low ${baseline.score.dayLowPoints.toFixed(1)}, stop ${baseline.score.stopMinutes} min; plan: day low ${score.dayLowPoints.toFixed(1)}, stop ${score.stopMinutes} min, openAt ${JSON.stringify(
				Object.fromEntries(
					Object.entries(plan.openAt).map(([k, v]) => [
						k,
						v && new Date(v).toISOString(),
					]),
				),
			)}, placement ${JSON.stringify(plan.placement)}`,
		);
		// On demand: the first account fills about 13:17, the second about 14:55 → stop to 16:00.
		const baseOuts = baseline.result.traces[360].outs;
		// Day 360 of 400 is the heavy (p90) day: first account full 13:16, second 14:54.
		expect(baseOuts.slice(0, 2)).toEqual([
			{ account: 0, at: prague(12, 13, 16), limit: "five_hour" },
			{ account: 1, at: prague(12, 14, 54), limit: "five_hour" },
		]);
		expect(baseline.score.dayLowPoints).toBe(0);
		expect(baseline.score.stopMinutes).toBe(60);
		// The plan opens both windows ahead of work: acct-a at 08:30, acct-b at 09:30 (resets 13:30, 14:30).
		expect(plan.openAt).toEqual({
			"acct-a": prague(12, 8, 30),
			"acct-b": prague(12, 9, 30),
		});
		expect(score.dayLowPoints).toBeCloseTo(85.5, 1);
		expect(score.stopMinutes).toBe(0);
		expect(plan.placement).toEqual({
			tiers: [["acct-a"], ["acct-b"]],
			// New sessions now (07:30) go to acct-a, whose window the plan opens at 08:30, not now.
			rule: "forecast-lookahead",
			reason: "open-ahead+85.5",
		});
		expect(plan.computedAt).toBe(ctx.now);
		expect(plan.workStartMinute).toBe(660);
		expect(plan.moves).toEqual([]);
		expect(compareScores(score, baseline.score)).toBeLessThan(0);
		expect(longestMs).toBeLessThan(60);
	}, 30_000);

	test("with pre-warm off nothing opens ahead: no demand before 11:00, so no opening gains openMinGainPoints", async () => {
		const { plan, score, baseline } = await planForecast(nov12(false));
		expect(plan.openAt).toEqual({ "acct-a": null, "acct-b": null });
		expect(score.dayLowPoints).toBe(baseline.score.dayLowPoints);
	}, 30_000);

	test("with pre-warm on the grid reaches across the night to before the work start", () => {
		const ctx = makeCtx({
			now: prague(12, 18),
			days: 1,
			accounts: [account({ id: "acct-a" })],
			rate: () => 0,
			settings: { prewarm: true },
			workStartMinute: 540,
		});
		const grid = openingGrid(ctx);
		expect(grid).toContain(prague(13, 4));
		expect(grid).toContain(prague(13, 8));
		const off = openingGrid({
			...ctx,
			input: {
				...ctx.input,
				settings: { ...ctx.input.settings, prewarm: false },
			},
		});
		expect(off.every((t) => t <= prague(12, 22))).toBe(true);
	});
});

describe("planForecast: an early opening for a shorter heavy stop (amendment A2)", () => {
	test("opens ahead when the heavy low point stays 0 but the heavy stop gets shorter", async () => {
		// One closed account; work 09:00–16:00 needs twice what a window holds (a window fills in an hour).
		// On demand the window opens at 09:00; opened at 06:00 instead, it resets at 11:00 and serves a
		// third hour of the day. The heavy lowest point is 0 either way; the weekly line barely moves.
		const ctx = makeCtx({
			now: prague(12, 4),
			days: 20,
			accounts: [account({ id: "acct-a", weekUsed: 10 })],
			k5: { "acct-a": 100 / 60 },
			kW: { "acct-a": 0.0001 },
			rate: (m, w) => (w <= 5 && m >= 540 && m < 960 ? 1 : 0),
			settings: { prewarm: true },
			workStartMinute: 540,
		});
		const { plan, score, baseline } = await planForecast(ctx);
		expect(baseline.score.dayLowPoints).toBe(0);
		expect(score.dayLowPoints).toBe(0);
		expect(item1And2(score)).toEqual(item1And2(baseline.score));
		expect(baseline.score.stopMinutes).toBe(830);
		expect(score.stopMinutes).toBe(655);
		expect(plan.openAt).toEqual({ "acct-a": prague(12, 6) });
	}, 30_000);

	function item1And2(s: PlanScore): number[] {
		return [s.item1, s.item2].map((v) => Math.round(v * 1e4) / 1e4);
	}

	const base: PlanScore = {
		item1: 0,
		item2: 0.9,
		stopMinutes: 120,
		typicalShare: 0.2,
		dayLowPoints: 0,
		weekLowPoints: 180,
		poolPoints: 200,
	};

	test("a tie on items 1 and 2 earns the opening when the stop falls by one 5-minute step", () => {
		expect(OPEN_MIN_STOP_GAIN_MIN).toBe(5);
		expect(openingEarns({ ...base, stopMinutes: 115 }, base, 1)).toBe(true);
		// Items 1 and 2 within the tier tolerance (0.5 points of a 200-point pool) still tie.
		expect(
			openingEarns(
				{ ...base, item2: base.item2 - 0.4 / 200, stopMinutes: 100 },
				base,
				1,
			),
		).toBe(true);
	});

	test("a tie on items 1 and 2 does not earn the opening when the stop falls by less than a step", () => {
		expect(openingEarns({ ...base, stopMinutes: 116 }, base, 1)).toBe(false);
		expect(openingEarns(base, base, 1)).toBe(false);
		// A shorter stop does not buy a lower item 2 beyond the tolerance.
		expect(
			openingEarns(
				{ ...base, item2: base.item2 - 0.6 / 200, stopMinutes: 60 },
				base,
				1,
			),
		).toBe(false);
	});

	test("a gain of item 1 by openMinGainPoints earns the opening as before", () => {
		const up = { ...base, item1: base.item1 + 1 / 200, stopMinutes: 130 };
		expect(openingEarns(up, base, 1)).toBe(true);
		expect(openingEarns(up, base, 2)).toBe(false);
	});

	test("reason tokens: item 1 gain first, else the stop minutes cut", () => {
		expect(openingReason(85.46, 60)).toBe("open-ahead+85.5");
		expect(openingReason(0, 175)).toBe("open-ahead-stop-175min");
		expect(openingReason(0.01, 5)).toBe("open-ahead-stop-5min");
		expect(openingReason(0.01, 4)).toBeNull();
	});
});

describe("planForecast: quota about to reset", () => {
	test("unattached demand prefers the window that resets first when that raises the low point", async () => {
		const now = prague(12, 9);
		const ctx = makeCtx({
			now,
			days: 20,
			accounts: [
				account({ id: "acct-a", fiveUsed: 30, fiveReset: now + 20 * MIN }),
				account({ id: "acct-b", fiveUsed: 30, fiveReset: now + 4 * HOUR }),
			],
			k5: { "acct-a": 10, "acct-b": 10 },
			kW: { "acct-a": 0.01, "acct-b": 0.01 },
			rate: (_m, _w, at) => (at < now + 2 * HOUR ? 0.1 : 0),
		});
		const { plan, score } = await planForecast(ctx);
		const preferB = scorePlan(
			ctx,
			await simulate(ctx, { ...onDemandPlan(ctx), preferred: 1 }),
		);
		expect(score.dayLowPoints).toBeGreaterThan(preferB.dayLowPoints + 10);
		expect(plan.placement?.tiers[0]).toEqual(["acct-a"]);
		expect(plan.placement?.rule).toBe("forecast-lookahead");
		expect(plan.placement?.reason).toBe("reset-soon");
	});
});

describe("scorePlan", () => {
	test("no stop minutes for zero quota without demand", async () => {
		const now = prague(12, 20);
		const ctx = makeCtx({
			now,
			days: 5,
			accounts: [
				account({ id: "acct-a", fiveUsed: 100, fiveReset: now + 3 * HOUR }),
			],
			rate: () => 0,
		});
		const s = scorePlan(ctx, await simulate(ctx, onDemandPlan(ctx)));
		expect(s.dayLowPoints).toBe(0);
		expect(s.stopMinutes).toBe(0);
	});
});

describe("planForecast cost", () => {
	test("400 days, 2 accounts, Monday morning to Friday 24:00: bounded and yielding", async () => {
		const now = prague(9, 7, 30);
		const ctx = makeCtx({
			now,
			spread: 0.3,
			accounts: [
				account({ id: "acct-a" }),
				account({ id: "acct-b", fiveUsed: 20, fiveReset: now + HOUR }),
			],
			kW: { "acct-a": 0.05, "acct-b": 0.05 },
			rate: (m, w) => (w <= 5 && m >= 540 && m < 1080 ? 0.6 : 0),
			settings: { prewarm: true },
			workStartMinute: 540,
		});
		const { value, wallMs, longestMs, turns } = await measureYield(() =>
			planForecast(ctx),
		);
		console.log(
			`planForecast week horizon: ${value.result.axis.times.length} samples, wall ${wallMs.toFixed(0)} ms, ${value.candidates} candidates, longest slice ${longestMs.toFixed(1)} ms, ${turns} turns`,
		);
		expect(value.candidates).toBeLessThanOrEqual(40);
		expect(longestMs).toBeLessThan(60);
		expect(wallMs).toBeLessThan(5000);
	}, 30_000);
});
