import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract";
import type { EpochMs, ForecastBlock } from "../../types";
import type { SimulationResult } from "../model";
import { levelLines } from "../percentile";
import { buildResponse } from "../response";
import { rankDays, serveDay } from "../served-day";
import {
	defaultAxis,
	HOUR,
	MIN,
	makeCtx,
	makeSim,
	makeTrace,
	NOW,
	rng,
} from "./fixtures-response";

const round1 = (v: number) => Math.max(0, Math.round(v * 10) / 10);

/** 61 days falling at random rates with a random swing: the days cross, so the clamp has work. */
function crossingRun() {
	const ctx = makeCtx();
	const axis = defaultAxis(ctx);
	const random = rng(23);
	const traces = Array.from({ length: 61 }, () => {
		const rate = 10 + 30 * random();
		const swing = 60 * random();
		const phase = 6 * random();
		return makeTrace(axis, {
			day: (t) =>
				Math.min(
					200,
					Math.max(
						0,
						200 -
							(rate * (t - NOW)) / HOUR +
							swing * Math.sin(phase + (t - NOW) / HOUR),
					),
				),
			week: (t) => Math.max(0, 200 - ((rate / 20) * (t - NOW)) / HOUR),
		});
	});
	return { ctx, sim: makeSim(ctx, axis, traces) };
}

/** Per block point, the axis index it samples, or null for an inserted zero point. */
function axisIndices(block: ForecastBlock, sim: SimulationResult) {
	const times = sim.axis.times;
	let i = 0;
	return block.times.map((t) => {
		if (i < times.length && times[i] === t) return i++;
		return null;
	});
}

describe("the typical day line is the served day", () => {
	const { ctx, sim } = crossingRun();
	const response = buildResponse(ctx, sim);
	const day = response.day as ForecastBlock;
	const served = serveDay(sim, ctx.horizon.dayEnd, "2026-11-12", null).day;

	test("without a held day the response serves the fresh pick", () => {
		const explicit = buildResponse(ctx, sim, served);
		expect(explicit.day).toEqual(day);
	});

	test("typical is the served trace except where clamped into [heavy, light]", () => {
		const trace = sim.traces[served].day;
		let own = 0;
		axisIndices(day, sim).forEach((i, k) => {
			expect(day.heavy[k]).toBeLessThanOrEqual(day.typical[k]);
			expect(day.typical[k]).toBeLessThanOrEqual(day.light[k]);
			if (i === null) return;
			if (day.typical[k] === round1(trace[i])) own++;
			else expect([day.heavy[k], day.light[k]]).toContain(day.typical[k]);
		});
		expect(own).toBeGreaterThan(day.times.length / 2);
	});

	test("a served day outside the band is clamped to heavy and light, never across them", () => {
		const ranking = rankDays(sim, ctx.horizon.dayEnd);
		for (const extreme of [ranking.order[0], ranking.order.at(-1) as number]) {
			const block = buildResponse(ctx, sim, extreme).day as ForecastBlock;
			let clamped = 0;
			block.typical.forEach((v, k) => {
				expect(block.heavy[k]).toBeLessThanOrEqual(v);
				expect(v).toBeLessThanOrEqual(block.light[k]);
				if (v === block.heavy[k] || v === block.light[k]) clamped++;
			});
			expect(clamped).toBeGreaterThan(0);
			// The pointwise lines do not depend on the served day.
			expect(block.light).toEqual(day.light);
			expect(block.heavy).toEqual(day.heavy);
			expect(block.fan).toEqual(day.fan);
		}
	});

	test("the week block stays pointwise and ignores the served day", () => {
		const week = response.week as ForecastBlock;
		const other = buildResponse(ctx, sim, (served + 1) % sim.traces.length);
		expect(other.week).toEqual(week);
		const times = sim.axis.times;
		const median = levelLines(
			sim.traces.map((t) => t.week),
			times.length,
			[50],
		)[0];
		week.times.forEach((t, k) => {
			const i = times.indexOf(t);
			if (i >= 0) expect(week.typical[k]).toBe(round1(median[i]));
		});
	});
});

describe("stops and shortfall of typical come from the served day", () => {
	// 41 non-crossing days from 200 at 20 + d points per hour. Day 20 reaches 0 at 18:20
	// (NOW + 5 h, a sample) and from then leaves 1 unit unserved per step; every other day
	// leaves `others` units per step at 0, except day 19, which leaves none.
	const ctx = makeCtx();
	const axis = defaultAxis(ctx);
	const ZERO = NOW + 5 * HOUR;
	const end = ctx.horizon.dayEnd;
	const steps = axis.times.filter((t) => t > ZERO && t <= end).length;
	const k5 = 2;
	const value = (d: number) => (t: EpochMs) =>
		Math.max(0, 200 - ((20 + d) * (t - NOW)) / HOUR);
	const run = (others: number) =>
		makeSim(
			ctx,
			axis,
			Array.from({ length: 41 }, (_, d) =>
				makeTrace(axis, {
					day: value(d),
					unserved: (t) =>
						value(d)(t) > 0 || d === 19 ? 0 : d === 20 ? 1 : others,
				}),
			),
		);
	const busy = run(0.5);
	const day = buildResponse(ctx, busy, 20).day as ForecastBlock;

	test("the typical stop is the served day's own", () => {
		expect(day.stops.heavy.length).toBeGreaterThan(0);
		expect(day.stops.typical).toEqual([{ start: ZERO, end }]);
		expect(validateForecastResponse(buildResponse(ctx, busy, 20))).toEqual([]);
	});

	test("shortfall is the served day's unserved demand inside its own first stop", () => {
		expect(day.shortfall?.stop).toEqual({ start: ZERO, end });
		expect(day.shortfall?.points).toBe(round1(k5 * steps));
		expect(steps).toBe((end - ZERO) / (5 * MIN));
	});

	test("a stop of the served day's own is dropped where no heavy stop encloses it", () => {
		// Only day 20 leaves demand unserved: the heavy level lists no stop.
		const lone = run(0);
		const response = buildResponse(ctx, lone, 20);
		const block = response.day as ForecastBlock;
		expect(block.stops.heavy).toEqual([]);
		expect(block.stops.typical).toEqual([]);
		expect(block.shortfall).toBeNull();
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("a zero run of typical that holds a light stop is a stop, even without the served day's own demand", () => {
		// Day 19 leaves nothing unserved, yet light lists a stop inside its zero run.
		const response = buildResponse(ctx, run(0.5), 19);
		const block = response.day as ForecastBlock;
		expect(block.stops.light.length).toBeGreaterThan(0);
		expect(block.stops.typical).toHaveLength(1);
		const [stop] = block.stops.typical;
		for (const light of block.stops.light) {
			expect(stop.start).toBeLessThanOrEqual(light.start);
			expect(light.end).toBeLessThanOrEqual(stop.end);
		}
		expect(block.shortfall?.points).toBe(0);
		expect(validateForecastResponse(response)).toEqual([]);
	});
});
