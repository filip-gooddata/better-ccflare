import { describe, expect, test } from "bun:test";
import type { SimulationResult } from "../model";
import {
	compareScores,
	decidingReason,
	dueRoutingOpening,
	openingBeam,
	openingEarns,
	openingGrid,
	openingReason,
	type PlanScore,
	placementOf,
	planForecast,
	scorePlan,
} from "../planner";
import { onDemandPlan, type SimPlan, simulate } from "../simulate";
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
			`baseline: low point ${baseline.score.lowPoint.toFixed(1)}; plan: low point ${score.lowPoint.toFixed(1)}, openAt ${JSON.stringify(
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
		// Day 360 of 400 is the heavy (p90) day: first account full 13:19, second 14:54. The idle
		// acct-b opens at the second demand step, 11:05 (amendment 5, E1), so acct-a fills later.
		expect(baseOuts.slice(0, 2)).toEqual([
			{ account: 0, at: prague(12, 13, 19), limit: "five_hour" },
			{ account: 1, at: prague(12, 14, 54), limit: "five_hour" },
		]);
		// The heavy day is 62.4 points short (unserved demand counted below zero, amendment 5 E2).
		expect(baseline.score.lowPoint).toBeCloseTo(-62.4, 1);
		// The plan opens both windows ahead of work, staggered: acct-b at 08:00, acct-a at 09:30 (resets
		// 13:00, 14:30). Neither 09:30 nor 08:00 is a peak of an account's single-opening curve (flat
		// 08:20 to 09:00); coordinate refinement finds the pair.
		expect(plan.openAt).toEqual({
			"acct-a": prague(12, 9, 30),
			"acct-b": prague(12, 8),
		});
		expect(score.dayLowPoints).toBeCloseTo(104.5, 1);
		expect(score.lowPoint).toBeCloseTo(104.5, 1);
		expect(plan.placement).toEqual({
			tiers: [["acct-b"], ["acct-a"]],
			// New sessions now (07:30) go to acct-b, whose window the plan opens at 08:00, not now.
			rule: "forecast-lookahead",
			// The gain of S over on demand: 104.5 - (-62.4).
			reason: "open-ahead+166.9",
		});
		expect(plan.computedAt).toBe(ctx.now);
		expect(plan.workStartMinute).toBe(660);
		expect(plan.moves).toEqual([]);
		expect(compareScores(score, baseline.score)).toBeLessThan(0);
		expect(longestMs).toBeLessThan(60);
	}, 300_000);

	test("with pre-warm off nothing opens ahead: no demand before 11:00, so no opening gains openMinGainPoints", async () => {
		const { plan, score, baseline } = await planForecast(nov12(false));
		expect(plan.openAt).toEqual({ "acct-a": null, "acct-b": null });
		expect(score.dayLowPoints).toBe(baseline.score.dayLowPoints);
	}, 30_000);

	test("the grid is now and every local quarter hour to the fine horizon, across the night, pre-warm on or off", () => {
		const ctx = makeCtx({
			now: prague(12, 18),
			days: 1,
			accounts: [account({ id: "acct-a" })],
			rate: () => 0,
			settings: { prewarm: true },
			workStartMinute: 540,
		});
		const grid = openingGrid(ctx);
		expect(grid.length).toBe(96);
		expect(grid[0]).toBe(prague(12, 18));
		expect(grid[1]).toBe(prague(12, 18, 15));
		expect(grid[95]).toBe(prague(13, 17, 45));
		expect(grid).toContain(prague(13, 4));
		expect(grid).toContain(prague(13, 8));
		const off = openingGrid({
			...ctx,
			input: {
				...ctx.input,
				settings: { ...ctx.input.settings, prewarm: false },
			},
		});
		expect(off).toEqual(grid);
		// now off a quarter mark: now itself, then the marks after it
		const odd = openingGrid({ ...ctx, now: prague(12, 18, 7) });
		expect(odd[0]).toBe(prague(12, 18, 7));
		expect(odd[1]).toBe(prague(12, 18, 15));
	});
});

describe("planForecast: an early opening that serves more of the day (amendment A2, scored by S)", () => {
	test("opens ahead when the earlier window leaves less demand unserved", async () => {
		// One closed account; work 09:00–16:00 needs twice what a window holds (a window fills in an hour).
		// On demand the window opens at 09:00; opened at 05:00 instead, it resets at 10:00 and serves a
		// third hour of the day: 100 points less unserved, so S rises from -500 to -400.
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
		expect(baseline.score.lowPoint).toBeCloseTo(-500, 3);
		expect(score.lowPoint).toBeCloseTo(-400, 3);
		expect(plan.openAt).toEqual({ "acct-a": prague(12, 5) });
	}, 30_000);

	const base: PlanScore = {
		lowPoint: 0,
		otherLow: 180,
		dayLowPoints: 0,
		weekLowPoints: 180,
		typicalLow: 40,
		departures: 0,
		poolPoints: 200,
	};

	test("the beam keeps an opening that earns its place alone when the best-scored ones do not", () => {
		const up = (at: number, points: number, typical = 40) => ({
			at,
			score: { ...base, lowPoint: points, typicalLow: typical },
		});
		// Within 0.5 points of S the typical low ranks first, so openings 1 to 4 outrank opening 5,
		// which alone gains openMinGainPoints (0.45 against 0.4 and less); all five share S's 0.5 bin.
		const singles = [
			up(1, 0.4, 90),
			up(2, 0.3, 80),
			up(3, 0.2, 70),
			up(4, 0.1, 60),
			up(5, 0.45),
		];
		// By time the curve falls from opening 1 (ranked first) to 5, so 1 is its one peak; 5 joins.
		expect(openingBeam(singles, base, 0.45)).toEqual([1, 5]);
		// When a peak already earns its place, the beam is the peaks alone.
		expect(openingBeam([up(0, 1.5), ...singles], base, 0.45)).toEqual([0]);
	});

	test("reason tokens: the gain of S, when worth naming", () => {
		expect(openingReason(85.46)).toBe("open-ahead+85.5");
		expect(openingReason(0.3)).toBe("open-ahead+0.3");
		expect(openingReason(0.01)).toBeNull();
		expect(openingReason(-2)).toBeNull();
	});
});

describe("planForecast: pre-warm off, a routing-opening whose time has come", () => {
	// 10:00 of the 2026-11-12 shape: acct-a's window is 60 % used and resets at 11:00, acct-b is closed.
	// Opening acct-b now through the next new session moves its reset to 15:00, inside the afternoon.
	function at10(b: { blockedUntil?: number; weekUsed?: number } = {}) {
		const now = prague(12, 10);
		const weekReset = prague(13, 20);
		return makeCtx({
			now,
			spread: 0.1,
			accounts: [
				account({
					id: "acct-a",
					fiveUsed: 60,
					fiveReset: prague(12, 11),
					weekUsed: 10,
					weekReset,
				}),
				account({
					id: "acct-b",
					weekUsed: b.weekUsed ?? 10,
					weekReset,
					blockedUntil: b.blockedUntil,
				}),
			],
			kW: { "acct-a": 0.05, "acct-b": 0.05 },
			rate: (m, w) => {
				if (w > 5) return 0;
				if (m >= 600 && m < 795) return 0.68;
				if (m >= 795 && m < 960) return 0.945;
				return 0;
			},
			settings: { prewarm: false },
			workStartMinute: 600,
		});
	}

	test("on demand already opens acct-b now (amendment 5, E1); the placement sends new sessions there (forecast-open)", async () => {
		const ctx = at10();
		const { plan, score, baseline, result } = await planForecast(ctx);
		expect(plan.openAt).toEqual({ "acct-b": null });
		expect(score.lowPoint).toBe(baseline.score.lowPoint);
		for (const trace of result.traces)
			expect(trace.opens[0]).toEqual({ account: 1, at: ctx.now });
		expect(plan.placement).toEqual({
			tiers: [["acct-b"], ["acct-a"]],
			rule: "forecast-open",
			reason: "no-preference",
		});
	}, 30_000);

	test("only an account that can take work now is a due routing-opening, and only with pre-warm off", () => {
		const plan = (ctx: ReturnType<typeof at10>) => ({
			...onDemandPlan(ctx),
			openAt: [null, ctx.now],
		});
		const free = at10();
		expect(dueRoutingOpening(free, plan(free))).toBe(1);
		const later = at10();
		expect(
			dueRoutingOpening(later, {
				...plan(later),
				openAt: [null, later.now + MIN],
			}),
		).toBe(-1);
		const blocked = at10({ blockedUntil: prague(12, 10, 30) });
		expect(dueRoutingOpening(blocked, plan(blocked))).toBe(-1);
		const weeklyOut = at10({ weekUsed: 100 });
		expect(dueRoutingOpening(weeklyOut, plan(weeklyOut))).toBe(-1);
		const prewarm = at10();
		prewarm.input.settings.prewarm = true;
		expect(dueRoutingOpening(prewarm, plan(prewarm))).toBe(-1);
	});
});

describe("placement reason tokens (amendment 2 B4, scored by S)", () => {
	const score = (over: Partial<PlanScore>): PlanScore => ({
		lowPoint: 80,
		otherLow: 160,
		dayLowPoints: 80,
		weekLowPoints: 160,
		typicalLow: 100,
		departures: 0,
		poolPoints: 200,
		...over,
	});

	test("B4: the placement reason names the deciding score item and its gain", () => {
		expect(decidingReason(score({ lowPoint: 92.4 }), score({}))).toBe(
			"low-point+12.4",
		);
		// The other limit is the weekly low point when that is the larger.
		expect(decidingReason(score({ otherLow: 160.6 }), score({}))).toBe(
			"weekly-low+0.6",
		);
		expect(
			decidingReason(
				score({
					lowPoint: 60,
					otherLow: 120.6,
					dayLowPoints: 120.6,
					weekLowPoints: 60,
				}),
				score({
					lowPoint: 60,
					otherLow: 120,
					dayLowPoints: 120,
					weekLowPoints: 60,
				}),
			),
		).toBe("five-hour-low+0.6");
		expect(decidingReason(score({ typicalLow: 101.2 }), score({}))).toBe(
			"typical-low+1.2",
		);
		// Within the tolerance the order holds too: a small S gain is named before a larger typical one.
		expect(
			decidingReason(score({ lowPoint: 80.3, typicalLow: 100.4 }), score({})),
		).toBe("low-point+0.3");
		// Departures alone name nothing.
		expect(decidingReason(score({}), score({ departures: 1 }))).toBeNull();
		expect(decidingReason(score({}), score({}))).toBeNull();
	});

	test("B4: a gain too small for one decimal keeps one significant digit instead of +0.0", () => {
		expect(decidingReason(score({ lowPoint: 80.004 }), score({}))).toBe(
			"low-point+0.004",
		);
		expect(decidingReason(score({ typicalLow: 100.03 }), score({}))).toBe(
			"typical-low+0.03",
		);
	});

	test("equal scores compare equal", () => {
		expect(compareScores(score({}), score({}))).toBe(0);
		expect(openingEarns(score({}), score({}), 1)).toBe(false);
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
	test("zero quota without demand scores 0, not below", async () => {
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
		expect(s.lowPoint).toBe(0);
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
		// One closed account: the baseline, 96 quarter hours and their refinement, the peaks, a refinement
		// scan and the preferences; the deadline, not a list, bounds the search in service.
		expect(value.candidates).toBe(109);
		expect(longestMs).toBeLessThan(60);
		expect(wallMs).toBeLessThan(5000);
	}, 300_000);
});

describe("placement: a held account goes behind every unheld one (amendment 5, E3)", () => {
	test("idle acct-a heads, open acct-c follows, held acct-b is last although its plan scores better", () => {
		const now = prague(12, 7);
		const ctx = makeCtx({
			now,
			accounts: [
				account({ id: "acct-a" }),
				account({ id: "acct-b" }),
				account({ id: "acct-c", fiveUsed: 20, fiveReset: prague(12, 9) }),
			],
			rate: () => 0,
			settings: { prewarm: false },
		});
		const score = (lowPoint: number): PlanScore => ({
			lowPoint,
			otherLow: 100,
			dayLowPoints: lowPoint,
			weekLowPoints: 100,
			typicalLow: 50,
			departures: 0,
			poolPoints: 300,
		});
		const plan: SimPlan = {
			openAt: [null, now + 60 * MIN, null],
			preferred: null,
			move: null,
		};
		const evaluated = (lowPoint: number) => ({
			plan,
			result: null as unknown as SimulationResult,
			score: score(lowPoint),
		});
		const advice = placementOf(
			ctx,
			[evaluated(30), evaluated(40), evaluated(20)],
			evaluated(30),
			evaluated(30),
		);
		expect(advice?.tiers).toEqual([["acct-a"], ["acct-c"], ["acct-b"]]);
		expect(advice?.rule).toBe("forecast-open");
	});

	test("with the held account moved out from between them, the reason names the item that dropped the second account", () => {
		const now = prague(12, 7);
		const ctx = makeCtx({
			now,
			accounts: [
				account({ id: "acct-a", fiveUsed: 20, fiveReset: prague(12, 10) }),
				account({ id: "acct-b" }),
				account({ id: "acct-c", fiveUsed: 20, fiveReset: prague(12, 9) }),
			],
			rate: () => 0,
			settings: { prewarm: false },
		});
		const plan: SimPlan = {
			openAt: [null, now + 60 * MIN, null],
			preferred: null,
			move: null,
		};
		const evaluated = (
			lowPoint: number,
			otherLow: number,
			typicalLow: number,
		) => ({
			plan,
			result: null as unknown as SimulationResult,
			score: {
				lowPoint,
				otherLow,
				dayLowPoints: lowPoint,
				weekLowPoints: otherLow,
				typicalLow,
				departures: 0,
				poolPoints: 300,
			},
		});
		// Tiers by score: a (10.1, 50, 100); b (10.4, 50.4, 90), dropped on the typical low; c (10.3,
		// 49.8, 100), dropped on the weekly low against a and b. b is held, so c comes second; a ranks
		// ahead of c by the weekly low (0.2), not by S, where c is 0.2 higher.
		const a = evaluated(10.1, 50, 100);
		const advice = placementOf(
			ctx,
			[a, evaluated(10.4, 50.4, 90), evaluated(10.3, 49.8, 100)],
			a,
			a,
		);
		expect(advice?.tiers).toEqual([["acct-a"], ["acct-c"], ["acct-b"]]);
		expect(advice?.reason).toBe("weekly-low+0.2");
	});
});

describe("reason within one tier follows the exact order", () => {
	test("an S advantage below SCORE_EPS that ranks first is the one named", () => {
		const s = (over: Partial<PlanScore>): PlanScore => ({
			lowPoint: 80,
			otherLow: 160,
			dayLowPoints: 80,
			weekLowPoints: 160,
			typicalLow: 100,
			departures: 0,
			poolPoints: 200,
			...over,
		});
		expect(
			decidingReason(s({ lowPoint: 80 + 5e-10 }), s({ typicalLow: 100.3 })),
		).toBe("low-point+5e-10");
	});
});
