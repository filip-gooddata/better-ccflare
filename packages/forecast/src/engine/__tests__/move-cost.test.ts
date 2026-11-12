import { describe, expect, test } from "bun:test";
import { moveCostUnits } from "../move-cost";
import { planForecast } from "../planner";
import { account, HOUR, MIN, makeCtx, prague, session } from "./fixtures-sim";

describe("moveCostUnits", () => {
	test("contextTokens × (cache write − cache read) × model factor ÷ 1e6", () => {
		const s = session({
			sessionId: "s",
			accountId: "acct-a",
			contextTokens: 100_000,
		});
		expect(moveCostUnits(s)).toBeCloseTo((100_000 * (2 - 0.1)) / 1e6, 12);
		expect(moveCostUnits({ ...s, family: "fable" })).toBeCloseTo(
			(2 * 100_000 * 1.9) / 1e6,
			12,
		);
	});

	test("a 5-minute-lifetime session costs less to move than a 1-hour one of the same size", () => {
		const oneHour = session({
			sessionId: "h",
			accountId: "acct-a",
			cacheTtlMs: HOUR,
		});
		const fiveMin = { ...oneHour, cacheTtlMs: 5 * MIN };
		expect(moveCostUnits(fiveMin)).toBeCloseTo(
			(100_000 * (1.25 - 0.1)) / 1e6,
			12,
		);
		expect(moveCostUnits(fiveMin)).toBeLessThan(moveCostUnits(oneHour));
	});

	test("an unknown lifetime is priced at the 1-hour weight", () => {
		const s = session({
			sessionId: "u",
			accountId: "acct-a",
			cacheTtlMs: null,
		});
		expect(moveCostUnits(s)).toBe(moveCostUnits({ ...s, cacheTtlMs: HOUR }));
	});
});

/**
 * acct-a: 30 % used, window resets late. acct-b: 20 % used, window resets in 30 minutes. One live
 * session on acct-a carries all demand (1 point a minute on either account, for 60 minutes).
 * Staying: the low point is 110 (10 + 100 at the end). Moving to acct-b uses quota that would be
 * lost at its reset: low point 120 − cost (just before acct-b's reset). The move gains 10 points
 * before its cost.
 */
function moveCase(contextTokens: number, coldAt: number | null = null) {
	const now = prague(12, 9);
	return makeCtx({
		now,
		days: 20,
		accounts: [
			account({
				id: "acct-a",
				fiveUsed: 30,
				fiveReset: now + 4 * HOUR + 50 * MIN,
			}),
			account({ id: "acct-b", fiveUsed: 20, fiveReset: now + 30 * MIN }),
		],
		k5: { "acct-a": 10, "acct-b": 10 },
		kW: { "acct-a": 0.01, "acct-b": 0.01 },
		rate: (_m, _w, at) => (at >= now && at < now + 60 * MIN ? 0.1 : 0),
		sessions: [
			session({
				sessionId: "s1",
				accountId: "acct-a",
				lastRequestAt: now - MIN,
				coldAt: coldAt ?? now + HOUR,
				contextTokens,
				recentUnits: 2,
			}),
		],
		settings: { sessionTurnoverMin: 1e9 },
	});
}

describe("planner moves", () => {
	test("a move that gains less than its cost is not advised", async () => {
		// 800k tokens: 1.52 units × k 10 = 15.2 points > 10 points gained.
		const { plan, score, baseline } = await planForecast(moveCase(800_000));
		expect(plan.moves).toEqual([]);
		expect(score.dayLowPoints).toBeCloseTo(110, 3);
		expect(baseline.score.dayLowPoints).toBeCloseTo(110, 3);
	});

	test("a move that gains more than its cost is advised, cost charged inside the simulation", async () => {
		// 50k tokens: 0.095 units × k 10 = 0.95 points < 10 points gained.
		const { plan, score, baseline } = await planForecast(moveCase(50_000));
		expect(baseline.score.dayLowPoints).toBeCloseTo(110, 3);
		expect(score.dayLowPoints).toBeCloseTo(120 - 0.95, 3);
		expect(plan.moves).toHaveLength(1);
		const [move] = plan.moves;
		expect(move).toMatchObject({
			sessionId: "s1",
			from: "acct-a",
			to: "acct-b",
			rule: "forecast-move",
			costPoints: 1,
			gainPoints: 9.1,
		});
		expect(move.reason).toBe("low-point+9.1");
	});

	test("no move to an account that cannot take work now", async () => {
		const ctx = moveCase(50_000);
		ctx.accounts[1].blockedUntil = ctx.now + 2 * HOUR;
		const { plan } = await planForecast(ctx);
		expect(plan.moves).toEqual([]);
	});

	test("a cold session is never in moves", async () => {
		const now = prague(12, 9);
		const { plan } = await planForecast(moveCase(50_000, now));
		expect(plan.moves).toEqual([]);
	});
});
