import { describe, expect, test } from "bun:test";
import type { EpochMs, ForecastBlock } from "../../types";
import type { OutLimit } from "../model";
import {
	buildResponse,
	daysAtZeroForLevel,
	responseLevels,
	unavailableResponse,
} from "../response";
import {
	blockLines,
	DEFAULT_FAN,
	defaultAxis,
	HOUR,
	MIDNIGHT,
	MIN,
	MONDAY,
	makeCtx,
	makeSim,
	makeTrace,
	NOW,
	rng,
	settings,
} from "./fixtures-response";

const at = (h: number, m = 0) => MIDNIGHT + h * HOUR + m * MIN;
/** A planned opening at 18:00: every simulated day gets up to 100 points back at once. */
const JUMP = at(18);
const toMinute = (t: number) => Math.ceil(t / MIN) * MIN;

/**
 * 400 simulated days from a fresh pool (200 points each): the 5-hour pool
 * falls at a random rate, gains 100 at JUMP and can fall to 0 before and after
 * it; the weekly pool falls slower and reaches 0 in some days before weekEnd.
 */
function randomRun(now = NOW, jump = JUMP) {
	const ctx = makeCtx({ now });
	const axis = defaultAxis(ctx, [jump]);
	const random = rng(7);
	const traces = Array.from({ length: 400 }, () => {
		const rate = 10 + 70 * random();
		const weekRate = 0.5 + 2.5 * random();
		const outs: { account: number; at: EpochMs; limit: OutLimit }[] = [];
		const atJump = Math.max(0, 200 - (rate * (jump - now)) / HOUR);
		const restart = Math.min(200, atJump + 100);
		const firstZero = now + (200 / rate) * HOUR;
		const secondZero = jump + (restart / rate) * HOUR;
		const weekZero = now + (200 / weekRate) * HOUR;
		for (const [zero, limit] of [
			[firstZero, "five_hour"],
			[secondZero, "five_hour"],
			[weekZero, "seven_day"],
		] as const) {
			outs.push({ account: 0, at: toMinute(zero - 10 * MIN), limit });
			outs.push({ account: 1, at: toMinute(zero), limit });
		}
		const dayValue = (t: EpochMs, i: number) => {
			const after = t > jump || (t === jump && axis.times[i - 1] === jump);
			if (!after) return Math.max(0, 200 - (rate * (t - now)) / HOUR);
			return Math.max(0, restart - (rate * (t - jump)) / HOUR);
		};
		return makeTrace(axis, {
			day: dayValue,
			week: (t) => Math.max(0, 200 - (weekRate * (t - now)) / HOUR),
			unserved: (t, i) => (dayValue(t, i) === 0 ? 0.5 : 0),
			outs,
			fableOutAt: [null, null],
		});
	});
	const sim = makeSim(ctx, axis, traces);
	return { ctx, sim, response: buildResponse(ctx, sim) };
}

const run = randomRun();
const blocks: [string, ForecastBlock][] = [];
if (run.response.day) blocks.push(["day", run.response.day]);
if (run.response.week) blocks.push(["week", run.response.week]);

describe("level lines", () => {
	test("both blocks present with 41 lines", () => {
		expect(blocks.length).toBe(2);
		for (const [, block] of blocks) {
			expect(blockLines(block).length).toBe(41);
			expect(Object.keys(block.fan).length).toBe(38);
		}
	});

	test("every array has the length of times; times never go back", () => {
		for (const [, block] of blocks) {
			for (const line of blockLines(block))
				expect(line.values.length).toBe(block.times.length);
			for (let i = 1; i < block.times.length; i++)
				expect(block.times[i]).toBeGreaterThanOrEqual(block.times[i - 1]);
		}
	});

	test("all 41 lines ordered at every index, after rounding, inserted points included", () => {
		for (const [, block] of blocks) {
			const lines = blockLines(block);
			for (let i = 0; i < block.times.length; i++)
				for (let l = 1; l < lines.length; l++)
					expect(lines[l].values[i]).toBeLessThanOrEqual(
						lines[l - 1].values[i],
					);
		}
	});

	test("values rounded to one decimal", () => {
		for (const [, block] of blocks)
			for (const line of blockLines(block))
				for (const v of line.values)
					expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
	});

	test("a jump is two entries with the same time in times and in every level", () => {
		for (const [, block] of blocks) {
			const i = block.times.indexOf(JUMP);
			expect(block.times.filter((t) => t === JUMP).length).toBe(2);
			expect(block.times[i + 1]).toBe(JUMP);
		}
		const day = run.response.day;
		const i = day?.times.indexOf(JUMP) ?? -1;
		expect(day?.typical[i + 1] ?? 0).toBeGreaterThan(day?.typical[i] ?? 0);
		const week = run.response.week;
		const w = week?.times.indexOf(JUMP) ?? -1;
		expect(week?.typical[w + 1]).toBe(week?.typical[w]);
	});

	test("a level reaching 0 between samples gets its exact time, where it is 0", () => {
		for (const [, block] of blocks) {
			const extra = block.times.filter(
				(t, i) =>
					i > 0 &&
					t !== JUMP &&
					t !== run.ctx.horizon.weekEnd &&
					t % (5 * MIN) !== 0,
			);
			expect(extra.length).toBeGreaterThan(0);
			for (const t of extra) {
				const i = block.times.indexOf(t);
				expect(blockLines(block).some((l) => l.values[i] === 0)).toBe(true);
				expect(block.heavy[i]).toBe(0);
			}
		}
	});

	test("day: computedAt and every 5 minutes to the end of the local day", () => {
		const day = run.response.day;
		expect(day?.times[0]).toBe(NOW);
		expect(day?.times[day.times.length - 1]).toBe(run.ctx.horizon.dayEnd);
		for (let t = NOW + 10 * MIN; t <= run.ctx.horizon.dayEnd; t += 5 * MIN)
			expect(day?.times).toContain(t);
	});

	test("week: computedAt, then full hours to weekEnd, plus jumps and zero points", () => {
		const week = run.response.week;
		if (!week) throw new Error("week block expected");
		const { weekEnd } = run.ctx.horizon;
		expect(week.times[0]).toBe(NOW);
		expect(week.times[week.times.length - 1]).toBe(weekEnd);
		for (let t = Math.ceil(NOW / HOUR) * HOUR; t <= weekEnd; t += HOUR)
			expect(week.times).toContain(t);
		const hourly = week.times.filter((t) => t % HOUR === 0).length;
		expect(week.times.length).toBeLessThan(hourly + 50);
	});

	test("same input, same output", () => {
		expect(buildResponse(run.ctx, run.sim)).toEqual(run.response);
	});

	test("the zero-day count matches the quantile rule of levelLines", () => {
		expect(daysAtZeroForLevel(400, 90)).toBe(41);
		expect(daysAtZeroForLevel(400, 50)).toBe(201);
		expect(daysAtZeroForLevel(400, 10)).toBe(361);
		expect(daysAtZeroForLevel(1, 10)).toBe(1);
	});
});

describe("response shape", () => {
	test("levels: light, typical, heavy and the fan, ascending, deduplicated", () => {
		const levels = responseLevels(settings());
		expect(levels.length).toBe(41);
		expect(levels[0]).toBe(10);
		expect(levels[40]).toBe(90);
		expect(responseLevels(settings({ fanLevels: [50, 30, 30, 70] }))).toEqual([
			10, 30, 50, 70, 90,
		]);
	});

	test("available response: counted ids, named levels, no prewarm", () => {
		const r = run.response;
		expect(r.contractVersion).toBe(1);
		expect(r.computedAt).toBe(NOW);
		expect(r.available).toBe(true);
		expect(r.reason).toBeNull();
		expect(r.accounts).toEqual(["acct-a", "acct-b"]);
		expect(r.levels).toEqual({ light: 10, typical: 50, heavy: 90 });
		expect("prewarm" in r).toBe(false);
		expect(Object.keys(r.day?.fan ?? {})).toEqual(
			DEFAULT_FAN.map((l) => `p${l}`),
		);
	});

	test("unavailableResponse is the spec's no-forecast shape", () => {
		expect(unavailableResponse(NOW, "insufficient_history", [])).toEqual({
			contractVersion: 1,
			computedAt: NOW,
			available: false,
			reason: "insufficient_history",
			accounts: [],
			levels: { light: 10, typical: 50, heavy: 90 },
			day: null,
			week: null,
			fable: {},
		});
	});
});

describe("fable outAt", () => {
	test("median over the simulated days, never counting as latest, down to the hour; null when half never", () => {
		const ctx = makeCtx();
		const axis = defaultAxis(ctx);
		const traces = Array.from({ length: 400 }, (_, s) =>
			makeTrace(axis, {
				day: () => 200,
				// acct-a: 250 days reach it at 14:00 + s minutes; acct-b: exactly half never.
				fableOutAt: [
					s < 250 ? at(14) + s * MIN : null,
					s < 200 ? at(15) : null,
				],
			}),
		);
		const r = buildResponse(ctx, makeSim(ctx, axis, traces));
		// Median of days 199 and 200 = 17:19:30, down to 17:00 local.
		expect(r.fable).toEqual({
			"acct-a": { outAt: at(17) },
			"acct-b": { outAt: null },
		});
	});
});

describe("size and time at defaults", () => {
	test.each([
		["Thursday 13:20", run],
		[
			"Monday 00:05 (full day, 7-day week)",
			randomRun(MONDAY + 5 * MIN, MONDAY + 18 * HOUR),
		],
	])("400 simulated days, 2 accounts, %s", (_, r) => {
		const started = performance.now();
		const response = buildResponse(r.ctx, r.sim);
		const ms = performance.now() - started;
		const bytes = JSON.stringify(response).length;
		console.log(
			`buildResponse: ${ms.toFixed(1)} ms, ${bytes} bytes JSON, day ${response.day?.times.length} points, week ${response.week?.times.length} points, axis ${r.sim.axis.times.length}`,
		);
		expect(bytes).toBeLessThan(400_000);
	});
});

describe("week zero points on samples between full hours", () => {
	test("a weekly line reaching 0 exactly at 14:35 keeps that time and its stop starts there", () => {
		const ctx = makeCtx();
		const axis = defaultAxis(ctx);
		const zero = at(14, 35);
		const traces = Array.from({ length: 20 }, () =>
			makeTrace(axis, {
				day: () => 150,
				week: (t) => (t >= zero ? 0 : 100),
				unserved: (t) => (t > zero ? 0.5 : 0),
				outs: [{ account: 1, at: zero, limit: "seven_day" }],
			}),
		);
		const week = buildResponse(ctx, makeSim(ctx, axis, traces)).week;
		expect(week?.times).toContain(zero);
		expect(week?.heavy[week.times.indexOf(zero)]).toBe(0);
		expect(week?.heavy[week.times.indexOf(zero) - 1]).toBe(100);
		expect(week?.stops.heavy[0]?.start).toBe(zero);
	});
});
