import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract/validate";
import type { EpochMs, ForecastBlock } from "../../types";
import type {
	EngineContext,
	OutLimit,
	SimTrace,
	SimulationResult,
} from "../model";
import { buildResponse } from "../response";
import { stopNow, zeroPoints } from "../stops";
import {
	account,
	defaultAxis,
	HOUR,
	MIDNIGHT,
	MIN,
	makeCtx,
	makeSim,
	makeTrace,
	NOW,
	rng,
} from "./fixtures-response";

const at = (h: number, m = 0) => MIDNIGHT + h * HOUR + m * MIN;
type Key = "day" | "week";

function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The reference reading (line-h/explain/likely.md): the engine's whole response
 * rebuilt on a simulation holding one day, its first listed typical stop being
 * that day's first stop.
 */
function reference(ctx: EngineContext, sim: SimulationResult, key: Key) {
	const firsts = sim.traces
		.map((trace) => buildResponse(ctx, { ...sim, traces: [trace] })[key])
		.map((block) => block?.stops.typical[0] ?? null)
		.filter((s) => s !== null);
	const stopChance =
		Math.round((firsts.length / sim.traces.length) * 100) / 100;
	const likelyStop =
		stopChance >= 0.5
			? {
					start: Math.round(median(firsts.map((s) => s.start))),
					minutes: Math.max(
						1,
						Math.round(median(firsts.map((s) => s.end - s.start)) / MIN),
					),
				}
			: null;
	return { stopChance, likelyStop, stopping: firsts.length };
}

/**
 * Days that each go to 0 for `minutes` at their own time, spread over the
 * afternoon so that few are out together; the rest never reach 0.
 */
function scattered(options: {
	days?: number;
	stopping: number;
	minutes?: number;
	unserved?: number;
	/** Quota left during a stopping day's out window (0: fully out). */
	left?: number;
}) {
	const {
		days = 400,
		stopping,
		minutes = 60,
		unserved = 0.5,
		left = 0,
	} = options;
	const ctx = makeCtx();
	const axis = defaultAxis(ctx);
	const traces: SimTrace[] = Array.from({ length: days }, (_, d) => {
		if (d >= stopping) return makeTrace(axis, { day: () => 100 });
		const from = at(14) + (d % 24) * 15 * MIN;
		const to = from + minutes * MIN;
		const out = (t: EpochMs) => t >= from && t < to;
		const outs: { account: number; at: EpochMs; limit: OutLimit }[] = [
			{ account: 0, at: from - 10 * MIN, limit: "five_hour" },
			{ account: 1, at: from, limit: "five_hour" },
		];
		return makeTrace(axis, {
			day: (t) => (out(t) ? left : 100),
			unserved: (t) => (out(t) ? unserved : 0),
			outs,
		});
	});
	const sim = makeSim(ctx, axis, traces);
	return { ctx, sim, response: buildResponse(ctx, sim) };
}

/** randomRun of response.test.ts: falling pools, a jump at 18:00, 400 days. */
function randomRun() {
	const ctx = makeCtx();
	const jump = at(18);
	const axis = defaultAxis(ctx, [jump]);
	const random = rng(7);
	const toMinute = (t: number) => Math.ceil(t / MIN) * MIN;
	const traces = Array.from({ length: 400 }, () => {
		const rate = 10 + 70 * random();
		const weekRate = 0.5 + 2.5 * random();
		const atJump = Math.max(0, 200 - (rate * (jump - NOW)) / HOUR);
		const restart = Math.min(200, atJump + 100);
		const outs: { account: number; at: EpochMs; limit: OutLimit }[] = [];
		for (const [zero, limit] of [
			[NOW + (200 / rate) * HOUR, "five_hour"],
			[jump + (restart / rate) * HOUR, "five_hour"],
			[NOW + (200 / weekRate) * HOUR, "seven_day"],
		] as const) {
			outs.push({ account: 0, at: toMinute(zero - 10 * MIN), limit });
			outs.push({ account: 1, at: toMinute(zero), limit });
		}
		const dayValue = (t: EpochMs, i: number) => {
			const after = t > jump || (t === jump && axis.times[i - 1] === jump);
			if (!after) return Math.max(0, 200 - (rate * (t - NOW)) / HOUR);
			return Math.max(0, restart - (rate * (t - jump)) / HOUR);
		};
		return makeTrace(axis, {
			day: dayValue,
			week: (t) => Math.max(0, 200 - (weekRate * (t - NOW)) / HOUR),
			unserved: (t, i) => (dayValue(t, i) === 0 ? 0.5 : 0),
			outs,
		});
	});
	const sim = makeSim(ctx, axis, traces);
	return { ctx, sim, response: buildResponse(ctx, sim) };
}

function block(response: ReturnType<typeof buildResponse>, key: Key) {
	const b = response[key];
	if (!b) throw new Error(`no ${key} block`);
	return b as ForecastBlock;
}

describe("stopChance and likelyStop: the engine's stop rule on each simulated day", () => {
	const run = randomRun();
	for (const key of ["day", "week"] as const) {
		test(`${key}: equal the one-day rebuild of the whole response`, () => {
			const b = block(run.response, key);
			const ref = reference(run.ctx, run.sim, key);
			expect(ref.stopping).toBeGreaterThan(0);
			expect(b.stopChance).toBe(ref.stopChance);
			expect(b.likelyStop).toEqual(ref.likelyStop);
		});
	}

	test("the random run exercises both sides: the day mostly stops, the week has a share", () => {
		const day = block(run.response, "day");
		const week = block(run.response, "week");
		expect(day.stopChance).toBeGreaterThanOrEqual(0.5);
		expect(day.likelyStop).not.toBeNull();
		expect(week.stopChance).toBeGreaterThan(0);
		expect(week.stopChance).toBeLessThanOrEqual(1);
	});

	test("scattered stops: no typical stop, yet 55% of days stop; likelyStop is their median stop", () => {
		const { ctx, sim, response } = scattered({ stopping: 220 });
		const day = block(response, "day");
		expect(day.stops.typical).toEqual([]);
		expect(day.stopNow).toBeNull();
		expect(day.stopChance).toBe(0.55);
		// 220 days at 14:00 + (d mod 24) * 15 min; the 110th and 111th of them
		// sorted fall on offsets 11 and 11 (220 = 9 full cycles of 24 + 4).
		const ref = reference(ctx, sim, "day");
		expect(day.likelyStop).toEqual(ref.likelyStop);
		expect(day.likelyStop?.minutes).toBe(60);
		expect(day.likelyStop?.start).toBe(at(14) + 11 * 15 * MIN);
		expect(
			validateForecastResponse(JSON.parse(JSON.stringify(response))),
		).toEqual([]);
	});

	test("below one half: likelyStop is null", () => {
		const day = block(scattered({ stopping: 180 }).response, "day");
		expect(day.stopChance).toBe(0.45);
		expect(day.likelyStop).toBeNull();
	});

	test("exactly one half (rounded) carries likelyStop", () => {
		const day = block(scattered({ stopping: 200 }).response, "day");
		expect(day.stopChance).toBe(0.5);
		expect(day.likelyStop).not.toBeNull();
	});

	test("the rounding boundary: 197 of 400 days is 0.49 without likelyStop, 198 is 0.50 with it", () => {
		const below = block(scattered({ stopping: 197 }).response, "day");
		expect(below.stopChance).toBe(0.49);
		expect(below.likelyStop).toBeNull();
		const { ctx, sim, response } = scattered({ stopping: 198 });
		const half = block(response, "day");
		expect(half.stopChance).toBe(0.5);
		expect(half.likelyStop).not.toBeNull();
		expect(half.likelyStop).toEqual(reference(ctx, sim, "day").likelyStop);
	});

	test("minStopPoints: days at 0 with too little unserved demand do not count", () => {
		const day = block(
			scattered({ stopping: 300, unserved: 0 }).response,
			"day",
		);
		expect(day.stopChance).toBe(0);
		expect(day.likelyStop).toBeNull();
	});

	test("the zero cutoff is derived from the accounts: a residue up to it is 0, any quota above it is not", () => {
		const cutoff = zeroPoints(makeCtx().accounts.length);
		const above = block(
			scattered({ stopping: 300, left: 0.01 }).response,
			"day",
		);
		expect(cutoff).toBeLessThan(0.01);
		expect(above.stopChance).toBe(0);
		expect(above.likelyStop).toBeNull();
		const residue = block(
			scattered({ stopping: 300, left: cutoff }).response,
			"day",
		);
		expect(residue.stopChance).toBe(0.75);
		expect(residue.likelyStop).not.toBeNull();
	});

	test("no stop on any day: 0 and null", () => {
		const { response } = scattered({ stopping: 0 });
		for (const key of ["day", "week"] as const) {
			expect(block(response, key).stopChance).toBe(0);
			expect(block(response, key).likelyStop).toBeNull();
		}
	});

	test("two decimals", () => {
		const day = block(scattered({ stopping: 123 }).response, "day");
		expect(day.stopChance).toBe(0.31);
	});

	test("a running stop: stopChance 1, likelyStop null (PaceBar shows stopNow)", () => {
		const ctx = makeCtx({
			accounts: [
				account("acct-a", {
					fiveHour: { usedPct: 100, resetsAt: NOW + 2 * HOUR },
				}),
				account("acct-b", {
					fiveHour: { usedPct: 100, resetsAt: NOW + 3 * HOUR },
				}),
			],
		});
		expect(stopNow(ctx, "day")).not.toBeNull();
		const axis = defaultAxis(ctx);
		const traces = Array.from({ length: 50 }, () =>
			makeTrace(axis, { day: () => 100 }),
		);
		const day = block(buildResponse(ctx, makeSim(ctx, axis, traces)), "day");
		expect(day.stopNow).not.toBeNull();
		expect(day.stopChance).toBe(1);
		expect(day.likelyStop).toBeNull();
	});
});
