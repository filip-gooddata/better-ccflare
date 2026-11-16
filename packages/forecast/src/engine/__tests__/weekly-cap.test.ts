/**
 * The weekly cap on the day line (spec section 3) in the 13:45 state of 2026-11-13 without
 * acct-a's cooldown: acct-a (gooddata) at 82 % five-hour use with its reset at 14:00 and 90 %
 * weekly used; acct-b (gooddata-ai) full until 17:00 with 50 % weekly used. History, sessions
 * and weekly resets are the 12:06 fixture's. The calibration is the live one measured on
 * 2026-11-13 (k5 1.79, kW 0.31, r ≈ 5.8) instead of the fixture's r = 13.3: at the fixture's
 * ratio 10 % weekly is worth 133 points and the cap would not bind at 14:00. Without the cap
 * the line jumped to 100 at 14:00; with it acct-a counts only what its weekly limit pays for.
 * The figures are measured (weekly-cap DESIGN-A-B.md, A.8), not the live response.
 */
import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract";
import type { ForecastBlock } from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import { buildInput, prague, replay1113Fixture } from "./fixtures-engine";

const MIN = 60_000;
const A_RESET = prague(13, 14) + 663;
const B_RESET = prague(13, 17) + 11;
const LIVE_K5 = 1.79;
const LIVE_KW = 0.31;

function input1345(weekly: Record<string, number>) {
	const input = buildInput(
		replay1113Fixture({
			now: prague(13, 13, 45),
			fiveHour: {
				a: { usedPct: 82, resetsAt: A_RESET },
				b: { usedPct: 100, resetsAt: B_RESET },
			},
			blockedUntil: {},
		}),
	);
	for (const a of input.accounts)
		a.weekly = { ...a.weekly, usedPct: weekly[a.accountId] };
	return input;
}

async function compute() {
	const input = input1345({ "acct-a": 90, "acct-b": 50 });
	const ctx = await prepareEngineContext(input, { noiseMode: "shrunk" });
	if (ctx === "insufficient_history") throw new Error(ctx);
	for (const a of ctx.accounts) {
		ctx.calibration.fiveHour[a.accountId] = LIVE_K5;
		ctx.calibration.weekly[a.accountId] = LIVE_KW;
	}
	const { result } = await planForecast(ctx);
	return buildResponse(ctx, result);
}

/** Index of the second entry of the jump pair at t, or of the sample at t. */
function after(day: ForecastBlock, t: number): number {
	const i = day.times.lastIndexOf(t);
	if (i < 0) throw new Error(`no sample at ${t}`);
	return i;
}

function before(day: ForecastBlock, t: number): number {
	return day.times.indexOf(t);
}

describe("weekly cap: 2026-11-13 13:45 without the cooldown, live calibration", () => {
	test("after acct-a's 14:00 reset the line is its weekly cap, about 54, not 100", async () => {
		const response = await compute();
		const day = response.day as ForecastBlock;
		const b = before(day, A_RESET);
		const a = after(day, A_RESET);
		expect(a).toBe(b + 1);
		expect(day.typical[b]).toBeCloseTo(14.7, 1);
		expect(day.light[a]).toBeCloseTo(57.7, 1);
		expect(day.typical[a]).toBeCloseTo(54.4, 1);
		expect(day.heavy[a]).toBeCloseTo(48.5, 1);
		// acct-b's reset at 17:00 brings a full window: its 50 % weekly is worth about 290 points.
		const b17 = before(day, B_RESET);
		expect(day.light[b17]).toBeCloseTo(35.5, 1);
		expect(day.typical[after(day, B_RESET)]).toBe(100);
	});

	test("stops and shortfall are those without the cap", async () => {
		const day = (await compute()).day as ForecastBlock;
		const minute = (t: number) => Math.floor(t / MIN) * MIN;
		expect(
			day.stops.typical.map((s) => [minute(s.start), minute(s.end)]),
		).toEqual([[prague(13, 14, 43), prague(13, 17)]]);
		expect(
			day.stops.heavy.map((s) => [minute(s.start), minute(s.end)]),
		).toEqual([
			[prague(13, 14, 27), prague(13, 17)],
			[prague(13, 17, 52), prague(13, 22, 5)],
		]);
		// Measured without the cap, with this calibration in both the simulation and the
		// shortfall's points per unit (A.8's 176.6 priced unserved units at the fixture's k5 2).
		expect(day.shortfall?.points).toBeCloseTo(159.9, 1);
		expect(day.shortfall?.perAccount["acct-a"]).toBeCloseTo(82, 1);
		expect(day.shortfall?.perAccount["acct-b"]).toBeCloseTo(77.9, 1);
	});

	test("the response is valid and the past meets the levels at computedAt", async () => {
		const response = await compute();
		expect(validateForecastResponse(response)).toEqual([]);
		const day = response.day as ForecastBlock;
		expect(day.past.times.at(-1)).toBe(response.computedAt);
		expect(day.past.values.at(-1)).toBe(day.typical[0]);
		expect(day.past.values.at(-1)).toBe(18);
	});
});

describe("weekly cap in the forecast inputs", () => {
	test("each account carries r = k5 / kW and whether the cap binds at computedAt; each limit the age of its readings", async () => {
		// Fixture calibration r = 2 / 0.15: acct-a with 1 % weekly left counts 13.3 of its 18 left.
		const result = await createForecastEngine().compute(
			input1345({ "acct-a": 99, "acct-b": 50 }),
		);
		if (!result.available || !result.inputs) throw new Error("unavailable");
		const caps = result.inputs.caps;
		expect(caps.map((c) => c.accountId)).toEqual(["acct-a", "acct-b"]);
		const k = (id: string, limit: string) =>
			result.inputs?.limits.find((l) => l.accountId === id && l.limit === limit)
				?.k ?? Number.NaN;
		for (const c of caps) {
			// The calibrated k from the fixture's rounded readings: near 2 / 0.15, not exactly.
			expect(c.ratio).toBe(
				k(c.accountId, "five_hour") / k(c.accountId, "seven_day"),
			);
			expect(c.ratio).toBeGreaterThan(12);
			expect(c.ratio).toBeLessThan(14.5);
		}
		expect(caps.map((c) => c.binds)).toEqual([true, false]);
		// The current point: acct-a counts 1 weekly point × r (13.1 < its 18 left), acct-b 0.
		expect(result.response.day?.typical[0]).toBe(
			Math.round((caps[0].ratio ?? 0) * 10) / 10,
		);
		for (const l of result.inputs.limits) {
			if (l.instances === 0) {
				expect([l.oldestHoursAgo, l.newestHoursAgo]).toEqual([null, null]);
				continue;
			}
			expect(l.newestHoursAgo).toBeGreaterThanOrEqual(0);
			expect(l.oldestHoursAgo).toBeGreaterThanOrEqual(l.newestHoursAgo ?? 0);
			expect(l.oldestHoursAgo).toBeLessThanOrEqual(56 * 24);
		}
	});
});
