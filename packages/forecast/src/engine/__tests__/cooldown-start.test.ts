import { describe, expect, test } from "bun:test";
import type { AccountLimits, EpochMs, LimitReading } from "../../types";
import { pastSeries, pastStops } from "../past";
import { stopNow } from "../stops";
import {
	account,
	HOUR,
	MIDNIGHT,
	MIN,
	makeCtx,
	NOW,
} from "./fixtures-response";

const STEP = 90_000;
const FROM = NOW - 3 * HOUR;
const A_RESET = NOW + 15 * MIN;
const B_RESET = NOW + 195 * MIN;
const B_FULL_FROM = NOW - 60 * MIN;

interface Scenario {
	/** A's five-hour reading is 100 from this time on (null: 82 throughout). */
	aFullFrom?: EpochMs | null;
	/** B's five-hour reading is 100 from this time on. */
	bFullFrom?: EpochMs;
	from?: EpochMs;
	blockedSince?: EpochMs | null;
	blockedUntil?: EpochMs | null;
}

/**
 * A = the account refused by upstream (82 % five-hour use, 90 % weekly), B =
 * the account out on its five-hour limit from bFullFrom. Readings every 90 s
 * up to 30 s before now.
 */
function readings(s: Scenario): LimitReading[] {
	const aFullFrom = s.aFullFrom ?? null;
	const bFullFrom = s.bFullFrom ?? B_FULL_FROM;
	const out: LimitReading[] = [];
	for (let t = s.from ?? FROM; t <= NOW - 30_000; t += STEP) {
		const aFull = aFullFrom !== null && t >= aFullFrom;
		out.push(
			{
				accountId: "A",
				window: "five_hour",
				at: t,
				usedPct: aFull ? 100 : 82,
				resetsAt: A_RESET,
			},
			{
				accountId: "A",
				window: "seven_day",
				at: t,
				usedPct: 90,
				resetsAt: NOW + 50 * HOUR,
			},
			{
				accountId: "B",
				window: "five_hour",
				at: t,
				usedPct: t >= bFullFrom ? 100 : 70,
				resetsAt: B_RESET,
			},
			{
				accountId: "B",
				window: "seven_day",
				at: t,
				usedPct: 50,
				resetsAt: NOW + 100 * HOUR,
			},
		);
	}
	return out;
}

function scenario(s: Scenario) {
	const rs = readings(s);
	const lastRead = rs[rs.length - 1].at;
	const aFull = s.aFullFrom != null;
	const a = account("A", {
		fiveHour: { usedPct: aFull ? 100 : 82, resetsAt: A_RESET },
		weekly: { usedPct: 90, resetsAt: NOW + 50 * HOUR },
		blockedUntil:
			s.blockedUntil === undefined ? NOW + 50 * HOUR : s.blockedUntil,
		blockedSince: s.blockedSince ?? null,
		readAt: lastRead,
	});
	const b = account("B", {
		fiveHour: { usedPct: 100, resetsAt: B_RESET },
		weekly: { usedPct: 50, resetsAt: NOW + 100 * HOUR },
		blockedUntil: null,
		blockedSince: null,
		readAt: lastRead,
	});
	return { ctx: makeCtx({ accounts: [a, b], readings: rs }), lastRead, rs };
}

/** The first reading time at or after t (the readings' grid). */
function firstReadingFrom(t: EpochMs, from = FROM): EpochMs {
	return from + Math.ceil((t - from) / STEP) * STEP;
}

describe("stopNow starts when the last account went out, a cooldown included (spec section 5)", () => {
	test("the last account out by a refusal cooldown: start = blockedSince", () => {
		const since = NOW - 38 * MIN;
		const { ctx } = scenario({ blockedSince: since });
		expect(stopNow(ctx, "day")).toEqual({ start: since, end: B_RESET });
	});

	test("the cooldown began before B ran out: start = B's out time", () => {
		const { ctx } = scenario({ blockedSince: NOW - 90 * MIN });
		expect(stopNow(ctx, "day")).toEqual({
			start: firstReadingFrom(B_FULL_FROM),
			end: B_RESET,
		});
	});

	test("one account out on its limit, then a cooldown with no gap: start = its limit-out time", () => {
		const aFullFrom = NOW - 50 * MIN;
		const { ctx } = scenario({ aFullFrom, blockedSince: NOW - 20 * MIN });
		expect(stopNow(ctx, "day")).toEqual({
			start: firstReadingFrom(aFullFrom),
			// A comes back when its last reason ends (the cooldown); B at its reset.
			end: B_RESET,
		});
	});

	test("a cooldown that began before the first reading: start = blockedSince, not the first reading", () => {
		const since = FROM - 2 * HOUR;
		const { ctx: two } = scenario({ blockedSince: since });
		const a = two.accounts[0];
		const ctx = makeCtx({
			accounts: [a],
			readings: two.input.readings.filter((r) => r.accountId === "A"),
		});
		expect(stopNow(ctx, "day")).toEqual({
			start: since,
			end: NOW + 50 * HOUR,
		});
	});

	test("blockedSince null keeps the last-read fallback", () => {
		const { ctx, lastRead } = scenario({ blockedSince: null });
		expect(stopNow(ctx, "day")).toEqual({ start: lastRead, end: B_RESET });
	});

	test("blockedSince after now or at/after blockedUntil is ignored", () => {
		const { ctx: plain } = scenario({ blockedSince: null });
		const expected = {
			stop: stopNow(plain, "day"),
			past: pastSeries(plain, "day"),
		};
		for (const s of [
			{ blockedSince: NOW + MIN },
			{ blockedSince: NOW + 50 * HOUR, blockedUntil: NOW + 50 * HOUR },
			{ blockedSince: NOW + 51 * HOUR, blockedUntil: NOW + 50 * HOUR },
		]) {
			const { ctx } = scenario(s);
			expect(stopNow(ctx, "day")).toEqual(expected.stop);
			expect(pastSeries(ctx, "day")).toEqual(expected.past);
		}
	});

	test("week.stopNow ignores blockedSince", () => {
		const { ctx: plain } = scenario({ blockedSince: null });
		const { ctx } = scenario({ blockedSince: NOW - 38 * MIN });
		expect(stopNow(ctx, "week")).toEqual(stopNow(plain, "week"));
		expect(stopNow(ctx, "week")).toBeNull();
	});
});

describe("day.past carries the running cooldown from its start (spec section 6)", () => {
	const since = NOW - 38 * MIN;

	test("unchanged before blockedSince", () => {
		const { ctx: plain } = scenario({ blockedSince: null });
		const { ctx } = scenario({ blockedSince: since });
		const before = (p: { times: number[]; values: number[] }) =>
			p.times.map((t, i) => [t, p.values[i]]).filter(([t]) => t < since);
		const past = pastSeries(ctx, "day");
		expect(before(past)).toEqual(before(pastSeries(plain, "day")));
		expect(before(past).length).toBeGreaterThan(2);
	});

	test("a jump pair at blockedSince, then the account counts 0 to computedAt", () => {
		const { ctx } = scenario({ blockedSince: since });
		const past = pastSeries(ctx, "day");
		const at = past.times.indexOf(since);
		expect(at).toBeGreaterThan(0);
		expect(past.times[at + 1]).toBe(since);
		// A has 18 five-hour points left (weekly 10 % left × r 4 = 40 does not bind); B is out.
		expect(past.values[at]).toBe(18);
		expect(past.values[at + 1]).toBe(0);
		expect(past.values.slice(at + 1).every((v) => v === 0)).toBe(true);
		expect(past.times.at(-1)).toBe(NOW);
	});

	test("a cooldown begun before local midnight holds the account at 0 from the first entry", () => {
		const from = MIDNIGHT - 2 * HOUR;
		const { ctx } = scenario({ from, blockedSince: MIDNIGHT - HOUR });
		const past = pastSeries(ctx, "day");
		expect(past.times[0]).toBe(MIDNIGHT);
		// Only B counts: 30 points left before it runs out, then 0.
		expect(past.values[0]).toBe(30);
		expect(past.values.every((v) => v <= 30)).toBe(true);
		expect(past.times.filter((t) => t === MIDNIGHT - HOUR)).toHaveLength(0);
	});

	test("no step at computedAt any more", () => {
		const { ctx } = scenario({ blockedSince: since });
		const past = pastSeries(ctx, "day");
		const n = past.values.length;
		expect(past.values[n - 1]).toBe(0);
		expect(past.values[n - 2]).toBe(0);
		const jumps = past.times.filter((t, i) => i > 0 && past.times[i - 1] === t);
		expect(jumps).toEqual([since]);
	});

	test("week.past ignores blockedSince", () => {
		const { ctx: plain } = scenario({ blockedSince: null });
		const { ctx } = scenario({ blockedSince: since });
		expect(pastSeries(ctx, "week")).toEqual(pastSeries(plain, "week"));
	});
});

describe("pastStops", () => {
	test("a running stop that began with a cooldown is in stopNow only, not in pastStops", () => {
		const { ctx } = scenario({ blockedSince: NOW - 38 * MIN });
		expect(stopNow(ctx, "day")).not.toBeNull();
		expect(pastStops(ctx, "day")).toEqual([]);
	});

	test("an ended stop that a still-running cooldown helped to complete is listed", () => {
		// A refused since 13:07 and still blocked; B out on its five-hour limit
		// until 17:00; now 17:30. Fixture clock: now = NOW.
		const since = NOW - 263 * MIN;
		const bReset = NOW - 30 * MIN;
		const from = NOW - 6 * HOUR;
		const bFullFrom = NOW - 5 * HOUR;
		const rs: LimitReading[] = [];
		for (let t = from; t <= NOW - 30_000; t += STEP) {
			const bBack = t >= bReset;
			rs.push(
				{
					accountId: "A",
					window: "five_hour",
					at: t,
					usedPct: 40,
					resetsAt: NOW + 2 * HOUR,
				},
				{
					accountId: "A",
					window: "seven_day",
					at: t,
					usedPct: 30,
					resetsAt: NOW + 50 * HOUR,
				},
				{
					accountId: "B",
					window: "five_hour",
					at: t,
					usedPct: bBack ? 5 : t >= bFullFrom ? 100 : 70,
					resetsAt: bBack ? NOW + 270 * MIN : bReset,
				},
				{
					accountId: "B",
					window: "seven_day",
					at: t,
					usedPct: 50,
					resetsAt: NOW + 100 * HOUR,
				},
			);
		}
		const lastRead = rs[rs.length - 1].at;
		const accounts: AccountLimits[] = [
			account("A", {
				fiveHour: { usedPct: 40, resetsAt: NOW + 2 * HOUR },
				weekly: { usedPct: 30, resetsAt: NOW + 50 * HOUR },
				blockedUntil: NOW + HOUR,
				blockedSince: since,
				readAt: lastRead,
			}),
			account("B", {
				fiveHour: { usedPct: 5, resetsAt: NOW + 270 * MIN },
				weekly: { usedPct: 50, resetsAt: NOW + 100 * HOUR },
				blockedUntil: null,
				blockedSince: null,
				readAt: lastRead,
			}),
		];
		const ctx = makeCtx({ accounts, readings: rs });
		expect(stopNow(ctx, "day")).toBeNull();
		expect(pastStops(ctx, "day")).toEqual([{ start: since, end: bReset }]);
		expect(pastSeries(ctx, "day").values.at(-1)).toBe(95);
	});

	test("an ended cooldown (blockedUntil null) leaves no past stop and no step", () => {
		const { ctx: plain } = scenario({ blockedSince: null, blockedUntil: null });
		const { ctx } = scenario({
			blockedSince: NOW - 38 * MIN,
			blockedUntil: null,
		});
		expect(pastStops(ctx, "day")).toEqual([]);
		expect(stopNow(ctx, "day")).toBeNull();
		expect(pastSeries(ctx, "day")).toEqual(pastSeries(plain, "day"));
		expect(pastSeries(ctx, "day").values.at(-1)).toBe(18);
	});
});
