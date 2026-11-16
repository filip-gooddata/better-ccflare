/**
 * The weekly cap in the planner's score S (spec section 3, amendment 5 E2). acct-a has 80 points
 * of 5-hour room but only 5 % weekly left; at r = k5 / kW = 10 its weekly headroom is 50 points, so
 * the pooled 5-hour line counts 50, not 80. acct-b is full on its 5-hour window until 13:00 with its
 * whole weekly quota left, so the weekly low stays far above the 5-hour low and S is the 5-hour low.
 * Demand of 0.25 units per minute from 08:00 to 10:00 (30 units, all served by acct-a) lowers both
 * acct-a lines by 30 points; the day's low is at 10:00.
 */
import { describe, expect, test } from "bun:test";
import { scorePlan } from "../planner";
import { onDemandPlan, simulate } from "../simulate";
import { account, HOUR, makeCtx, prague } from "./fixtures-sim";

const now = prague(12, 8);

function ctxOf(weekUsedA: number) {
	return makeCtx({
		now,
		days: 1,
		accounts: [
			account({
				id: "acct-a",
				fiveUsed: 20,
				fiveReset: now + 4 * HOUR,
				weekUsed: weekUsedA,
			}),
			account({ id: "acct-b", fiveUsed: 100, fiveReset: now + 5 * HOUR }),
		],
		k5: { "acct-a": 1, "acct-b": 1 },
		kW: { "acct-a": 0.1, "acct-b": 0.1 },
		rate: (_m, _w, at) => (at < now + 2 * HOUR ? 0.25 : 0),
	});
}

async function scoreOf(weekUsedA: number) {
	const ctx = ctxOf(weekUsedA);
	return scorePlan(ctx, await simulate(ctx, onDemandPlan(ctx)));
}

describe("weekly cap in the score S", () => {
	test("a weekly headroom below the 5-hour room at the day's low lowers S by the difference; the weekly low is unchanged", async () => {
		const capped = await scoreOf(95);
		// 5-hour room at 10:00 without the cap: 100 - 20 - 30 = 50.
		const fiveRoom = 100 - 20 - 30;
		// Weekly headroom at 10:00: (100 - 95 - 0.1 × 30) × 10 = 20.
		const headroom = (100 - 95 - 0.1 * 30) * 10;
		expect(capped.dayLowPoints).toBeCloseTo(headroom, 3);
		expect(capped.lowPoint).toBeCloseTo(headroom, 3);
		// Without the cap S would be the 5-hour room: the cap lowers S by 50 - 20 = 30 points.
		expect(fiveRoom - capped.lowPoint).toBeCloseTo(30, 3);
		// The weekly low is the pooled weekly quota left, untouched by the cap: 2 + 100.
		expect(capped.weekLowPoints).toBeCloseTo(100 - 95 - 0.1 * 30 + 100, 3);
		expect(capped.otherLow).toBeCloseTo(capped.weekLowPoints, 6);
	});

	test("control: with weekly headroom above the 5-hour room the same demand leaves S at the 5-hour room", async () => {
		// 50 % weekly used: headroom (100 - 50 - 3) × 10 = 470 > 50, so the cap does not bind.
		const free = await scoreOf(50);
		expect(free.dayLowPoints).toBeCloseTo(100 - 20 - 30, 3);
		expect(free.lowPoint).toBeCloseTo(50, 3);
	});
});
