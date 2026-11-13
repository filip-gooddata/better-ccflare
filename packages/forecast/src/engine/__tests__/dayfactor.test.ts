/**
 * Day factor with an evidence weight (design amendment 4, D1/D3) through the real engine:
 * a night burst on a work day whose pool has almost no demand before the morning, the same
 * day once the pool's day is a quarter done, and a Saturday on the weekend pool. Synthetic
 * fixtures of the 2026-11-12 shape (fixtures-engine.ts).
 */
import { describe, expect, test } from "bun:test";
import { atLocalMinute, localParts } from "../../time";
import {
	BUCKET_MS,
	type ForecastBlock,
	type ForecastInput,
	type Interval,
} from "../../types";
import { poolFor } from "../days";
import { prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import {
	DAY_FACTOR_MAX,
	DAY_FACTOR_MIN,
	DAY_FACTOR_PRIOR_SHARE,
} from "../scenarios";
import {
	buildInput,
	DAY_2026_11_12,
	type EngineFixture,
	prague,
	replayFixture,
	replayHourly,
} from "./fixtures-engine";

const TODAY = "2026-11-12";
const NIGHT_UNITS_PER_HOUR = 60;

/** Today's hours 00–02 carry a burst of NIGHT_UNITS_PER_HOUR each; 03:00 is idle (no recent rate). */
function nightHourly(burst: boolean) {
	return (key: string, isoWeekday: number): number[] => {
		const shape = replayHourly(key, isoWeekday);
		if (key !== TODAY) return shape;
		return shape.map((u, h) =>
			h < 3 ? (burst ? NIGHT_UNITS_PER_HOUR : 0) : h === 3 ? 0 : u,
		);
	};
}

function fixture(
	burst: boolean,
	over: Partial<EngineFixture> = {},
): EngineFixture {
	return replayFixture({
		now: prague(12, 4),
		hourly: nightHourly(burst),
		fiveHour: {
			a: { usedPct: 0, resetsAt: null },
			b: { usedPct: 0, resetsAt: null },
		},
		...over,
	});
}

async function contextOf(input: ForecastInput): Promise<EngineContext> {
	const ctx = await prepareEngineContext(input, { noise: true });
	if (ctx === "insufficient_history")
		throw new Error("fixture has no forecast");
	return ctx;
}

/** Y, M, c and the D1 factor recomputed from the day table, independently of scenarios.ts. */
function expected(ctx: EngineContext) {
	const { table, now, timeZone } = ctx;
	const pool = poolFor(table, table.today.type);
	const minute = localParts(now, timeZone).minuteOfDay;
	expect(minute % 5).toBe(0);
	let weight = 0;
	let total = 0;
	let span = 0;
	for (const d of pool) {
		weight += d.weight;
		total += d.weight * d.total;
		// the same clock time on that day (a 25-hour day has an extra hour before it)
		const slots =
			(atLocalMinute(d.start, minute, timeZone) - d.start) / BUCKET_MS;
		let prefix = 0;
		for (let i = 0; i < slots; i++) prefix += d.units[i] ?? 0;
		span += d.weight * prefix;
	}
	const y = table.today.unitsSoFar;
	const c = (DAY_FACTOR_PRIOR_SHARE * total) / weight;
	const m = span / weight;
	const raw = (y + c) / (m + c);
	const clamped = Math.min(DAY_FACTOR_MAX, Math.max(DAY_FACTOR_MIN, raw));
	const w = Math.min(1, m / c);
	return { pool, y, m, c, raw, clamped, w, a: 1 + (clamped - 1) * w };
}

async function typicalStops(ctx: EngineContext): Promise<Interval[]> {
	const { baseline } = await planForecast(ctx);
	const day = buildResponse(ctx, baseline.result).day as ForecastBlock;
	return day.stops.typical;
}

function iso(stops: Interval[]): Array<[string, string]> {
	return stops.map((s) => [
		new Date(s.start).toISOString(),
		new Date(s.end).toISOString(),
	]);
}

describe("day factor with an evidence weight (amendment 4)", () => {
	test("night burst at 04:00: the factor stays within 0.15 of 1 and the typical line gains no stop", async () => {
		const night = await contextOf(buildInput(fixture(true)));
		const quiet = await contextOf(buildInput(fixture(false)));
		const e = expected(night);
		// the case the amendment fixes: Y far above M, the raw ratio beyond the clamp
		expect(e.y).toBeCloseTo(3 * NIGHT_UNITS_PER_HOUR, 6);
		expect(e.y).toBeGreaterThan(50 * e.m);
		expect(e.clamped).toBe(DAY_FACTOR_MAX);
		expect(e.w).toBeLessThan(0.05);

		const a = night.scenarios.diagnostics.dayFactor;
		expect(a).toBeCloseTo(e.a, 12);
		expect(a).toBeCloseTo(1 + (DAY_FACTOR_MAX - 1) * e.w, 12);
		expect(Math.abs(a - 1)).toBeLessThanOrEqual(0.15);
		// the deployed rule gave 4 here; M = 1.01, c = 45.51
		expect(a).toBeCloseTo(1.0667, 4);

		const withNight = await typicalStops(night);
		const without = await typicalStops(quiet);
		// the same single stop, both ends pinned (Prague time): 14:50-16:00 with the night,
		// 15:09-15:55 without
		expect(iso(without)).toEqual([
			["2026-11-12T14:09:00.000Z", "2026-11-12T14:55:00.000Z"],
		]);
		expect(iso(withNight)).toEqual([
			["2026-11-12T13:50:00.000Z", "2026-11-12T15:00:00.000Z"],
		]);
	});

	test("the diagnostics carry a_raw, a_cl, w, a, Y, M and c", async () => {
		const ctx = await contextOf(buildInput(fixture(true)));
		const e = expected(ctx);
		const d = ctx.scenarios.diagnostics.day;
		expect(d.y).toBeCloseTo(e.y, 9);
		expect(d.m).toBeCloseTo(e.m, 9);
		expect(d.c).toBeCloseTo(e.c, 9);
		expect(d.raw).toBeCloseTo(e.raw, 9);
		expect(d.clamped).toBe(e.clamped);
		expect(d.weight).toBeCloseTo(e.w, 12);
		expect(d.a).toBe(ctx.scenarios.diagnostics.dayFactor);
	});

	test("full weight once the pool's day is a quarter done: exactly the clamped ratio, upward and downward", async () => {
		// 14:00: the pool's mean day has passed a quarter of its total (M ≥ c)
		const at = prague(12, 14);
		const busy = await contextOf(buildInput(fixture(true, { now: at })));
		const eb = expected(busy);
		expect(eb.m).toBeGreaterThanOrEqual(eb.c);
		expect(eb.w).toBe(1);
		expect(busy.scenarios.diagnostics.dayFactor).toBe(eb.clamped);
		expect(busy.scenarios.diagnostics.dayFactor).toBeGreaterThan(1);

		// a quiet day: nothing at all today; the afternoon is still lowered
		const idle = (key: string, isoWeekday: number) =>
			key === TODAY
				? DAY_2026_11_12.map(() => 0)
				: replayHourly(key, isoWeekday);
		const calm = await contextOf(
			buildInput(fixture(false, { now: at, hourly: idle })),
		);
		const ec = expected(calm);
		expect(ec.w).toBe(1);
		expect(calm.scenarios.diagnostics.dayFactor).toBe(ec.clamped);
		expect(calm.scenarios.diagnostics.dayFactor).toBeLessThan(1);
	});

	test("on a weekend day the weekend pool's own M and c are used", async () => {
		// Saturday 2026-11-14 09:00 with a busy morning on the nearly idle weekend pool
		const saturday = (key: string, isoWeekday: number) =>
			key === "2026-11-14"
				? DAY_2026_11_12.map((u, h) => (h >= 7 && h < 9 ? 6 : u * 0.02))
				: replayHourly(key, isoWeekday);
		const ctx = await contextOf(
			buildInput(
				replayFixture({
					now: prague(14, 9),
					hourly: saturday,
					fiveHour: {
						a: { usedPct: 0, resetsAt: null },
						b: { usedPct: 0, resetsAt: null },
					},
				}),
			),
		);
		expect(ctx.table.today.type).toBe("weekend");
		const e = expected(ctx);
		expect(e.pool.length).toBeGreaterThan(0);
		expect(e.pool.every((d) => d.type === "weekend")).toBe(true);
		const d = ctx.scenarios.diagnostics.day;
		expect(d.c).toBeCloseTo(e.c, 9);
		expect(d.m).toBeCloseTo(e.m, 9);
		// the workday pool's c is far larger: it is not the one used
		const workday = poolFor(ctx.table, "workday");
		const workdayC =
			(DAY_FACTOR_PRIOR_SHARE *
				workday.reduce((s, x) => s + x.weight * x.total, 0)) /
			workday.reduce((s, x) => s + x.weight, 0);
		expect(workdayC).toBeGreaterThan(10 * e.c);
		expect(ctx.scenarios.diagnostics.dayFactor).toBeCloseTo(e.a, 12);
	});
});
