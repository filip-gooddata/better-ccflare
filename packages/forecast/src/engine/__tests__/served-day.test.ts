import { describe, expect, test } from "bun:test";
import type { EpochMs } from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { SimulationResult } from "../model";
import { planForecast } from "../planner";
import {
	bandDepths,
	MEDIAN_DAY_WINDOW,
	missedQuota,
	rankDays,
	serveDay,
} from "../served-day";
import { buildInput, prague, replay1113Fixture } from "./fixtures-engine";
import {
	defaultAxis,
	HOUR,
	makeCtx,
	makeSim,
	makeTrace,
	NOW,
	rng,
} from "./fixtures-response";

const ctx = makeCtx();
const axis = defaultAxis(ctx);
const DAY_END = ctx.horizon.dayEnd;
const TODAY = "2026-11-12";
const HALF = (MEDIAN_DAY_WINDOW - 1) / 2;

function lastDayIndex(times: EpochMs[]): number {
	let last = 0;
	while (last + 1 < times.length && times[last + 1] <= DAY_END) last++;
	return last;
}

function simOf(days: ((t: EpochMs, i: number) => number)[]): SimulationResult {
	return makeSim(
		ctx,
		axis,
		days.map((day) => makeTrace(axis, { day })),
	);
}

/** Modified band depth by its definition: the share of (pair, point) where the day lies in the pair's band. */
function bruteDepth(sim: SimulationResult): number[] {
	const last = lastDayIndex(sim.axis.times);
	const days = sim.traces.map((t) => t.day);
	const n = days.length;
	return days.map((x) => {
		let inside = 0;
		for (let a = 0; a < n; a++)
			for (let b = a + 1; b < n; b++)
				for (let i = 0; i <= last; i++) {
					const lo = Math.min(days[a][i], days[b][i]);
					const hi = Math.max(days[a][i], days[b][i]);
					if (x[i] >= lo && x[i] <= hi) inside++;
				}
		return inside / (((n * (n - 1)) / 2) * (last + 1));
	});
}

function deepestAmong(depth: number[], days: number[]): number {
	let best = days[0];
	for (const d of days) if (depth[d] > depth[best] + 1e-12) best = d;
	return best;
}

/** 61 days falling at random rates with a random swing, so quota missed and centrality disagree. */
function randomSim(seed: number): SimulationResult {
	const random = rng(seed);
	return simOf(
		Array.from({ length: 61 }, () => {
			const rate = 10 + 30 * random();
			const swing = 60 * random();
			const phase = 6 * random();
			return (t: EpochMs) =>
				Math.min(
					200,
					Math.max(
						0,
						200 -
							(rate * (t - NOW)) / HOUR +
							swing * Math.sin(phase + (t - NOW) / HOUR),
					),
				);
		}),
	);
}

describe("quota missed until local midnight", () => {
	test("is the area under the pooled line in point-hours; a jump pair adds none", () => {
		const times = [0, HOUR, HOUR, 2 * HOUR];
		expect(missedQuota([200, 0, 200, 200], times, 3, 200)).toBe(100);
		expect(missedQuota([200, 0, 200, 200], times, 1, 200)).toBe(100);
		expect(missedQuota([200, 200, 200, 200], times, 3, 200)).toBe(0);
		expect(missedQuota([100, 100, 0, 0], times, 3, 200)).toBe(300);
	});
});

describe("band depth", () => {
	test("equals the modified band depth by its definition (J = 2, averaged over the points)", () => {
		const sim = randomSim(3);
		const last = lastDayIndex(sim.axis.times);
		const fast = bandDepths(
			sim.traces.map((t) => t.day),
			last + 1,
		);
		const brute = bruteDepth(sim);
		brute.forEach((d, s) => {
			expect(fast[s]).toBeCloseTo(d, 12);
		});
	});
});

describe("the served day", () => {
	test("is the deepest day of the selection window around the median of quota missed", () => {
		const sim = randomSim(11);
		const ranking = rankDays(sim, DAY_END);
		const n = sim.traces.length;
		const m = Math.round(0.5 * (n - 1));
		expect(ranking.first).toBe(m - HALF);
		expect(ranking.last).toBe(m + HALF);
		const windowDays = ranking.order.slice(ranking.first, ranking.last + 1);
		expect(windowDays).toHaveLength(MEDIAN_DAY_WINDOW);
		const pick = serveDay(sim, DAY_END, TODAY, null);
		expect(pick).toEqual({
			date: TODAY,
			day: deepestAmong(bruteDepth(sim), windowDays),
		});
		// Not simply the median of quota missed.
		expect(pick.day).not.toBe(ranking.order[m]);
	});

	test("ranks by quota missed ascending, ties by day index", () => {
		const times = axis.times;
		const last = lastDayIndex(times);
		const days = Array.from({ length: 41 }, (_, i) => () => 100 + i);
		days.push(() => 120);
		const sim = simOf(days);
		const ranking = rankDays(sim, DAY_END);
		const missed = sim.traces.map((t) => missedQuota(t.day, times, last, 200));
		for (let p = 1; p < ranking.order.length; p++) {
			const a = ranking.order[p - 1];
			const b = ranking.order[p];
			expect(missed[a] < missed[b] || (missed[a] === missed[b] && a < b)).toBe(
				true,
			);
		}
		expect(ranking.order.indexOf(20)).toBe(20);
		expect(ranking.order.indexOf(41)).toBe(21);
	});

	test("on equal depth the day earlier in the ranking wins", () => {
		const days = Array.from({ length: 41 }, (_, i) => () => 100 + i);
		days.push(() => 120);
		const sim = simOf(days);
		const ranking = rankDays(sim, DAY_END);
		expect(ranking.depth[20]).toBe(ranking.depth[41]);
		expect(serveDay(sim, DAY_END, TODAY, null).day).toBe(20);
	});

	test("ignores days outside the window, however deep", () => {
		// Ten calm days near 150 miss the least quota; 51 wild days swing between 0 and 200.
		const calm = Array.from({ length: 10 }, (_, c) => () => 150 + 0.1 * c);
		const wild = Array.from(
			{ length: 51 },
			(_, w) => (_t: EpochMs, i: number) =>
				(i + w) % 2 === 0 ? 200 - 0.1 * w : 0.1 * w,
		);
		const sim = simOf([...calm, ...wild]);
		const ranking = rankDays(sim, DAY_END);
		const calmIds = calm.map((_, c) => c);
		for (const c of calmIds)
			expect(ranking.order.indexOf(c)).toBeLessThan(ranking.first);
		const brute = bruteDepth(sim);
		const all = brute.map((_, s) => s);
		expect(calmIds).toContain(deepestAmong(brute, all));
		const windowDays = ranking.order.slice(ranking.first, ranking.last + 1);
		const pick = serveDay(sim, DAY_END, TODAY, null).day;
		expect(calmIds).not.toContain(pick);
		expect(pick).toBe(deepestAmong(brute, windowDays));
	});

	test("is deterministic for one simulation", () => {
		const sim = randomSim(5);
		const copy = structuredClone(sim);
		expect(serveDay(copy, DAY_END, TODAY, null)).toEqual(
			serveDay(sim, DAY_END, TODAY, null),
		);
		expect(rankDays(copy, DAY_END)).toEqual(rankDays(sim, DAY_END));
	});
});

describe("holding the served day between polls", () => {
	// 61 flat days: day i misses (100 − i)·hours, so day i sits at position 60 − i.
	const sim = simOf(Array.from({ length: 61 }, (_, i) => () => 100 + i));
	const ranking = rankDays(sim, DAY_END);
	const fresh = serveDay(sim, DAY_END, TODAY, null);
	const dayAt = (position: number) => ranking.order[position];

	test("the flat fixture's fresh pick is the median day", () => {
		expect(fresh).toEqual({ date: TODAY, day: 30 });
	});

	test("keeps a held day while its rank stays inside the selection window", () => {
		for (const position of [ranking.first, ranking.last]) {
			const held = { date: TODAY, day: dayAt(position) };
			expect(serveDay(sim, DAY_END, TODAY, held)).toEqual(held);
		}
	});

	test("replaces a held day whose rank left the window", () => {
		for (const position of [ranking.first - 1, ranking.last + 1]) {
			const held = { date: TODAY, day: dayAt(position) };
			expect(serveDay(sim, DAY_END, TODAY, held)).toEqual(fresh);
		}
		expect(serveDay(sim, DAY_END, TODAY, { date: TODAY, day: 61 })).toEqual(
			fresh,
		);
	});

	test("clears on a new local date", () => {
		const held = { date: "2026-11-11", day: dayAt(ranking.first) };
		expect(serveDay(sim, DAY_END, TODAY, held)).toEqual(fresh);
	});
});

describe("ranking on the engine's pooled five-hour line", () => {
	/** 2026-11-13 13:45 (weekly-cap.test.ts): acct-a at 82 % five-hour use, reset at 14:00. */
	async function servedAt(weeklyUsedA: number) {
		const input = buildInput(
			replay1113Fixture({
				now: prague(13, 13, 45),
				fiveHour: {
					a: { usedPct: 82, resetsAt: prague(13, 14) + 663 },
					b: { usedPct: 100, resetsAt: prague(13, 17) + 11 },
				},
				blockedUntil: {},
			}),
		);
		for (const a of input.accounts)
			a.weekly = {
				...a.weekly,
				usedPct: a.accountId === "acct-a" ? weeklyUsedA : 50,
			};
		const ctx = await prepareEngineContext(input, { noiseMode: "shrunk" });
		if (ctx === "insufficient_history") throw new Error(ctx);
		for (const a of ctx.accounts) {
			ctx.calibration.fiveHour[a.accountId] = 1.79;
			ctx.calibration.weekly[a.accountId] = 0.31;
		}
		const { result } = await planForecast(ctx);
		const ranking = rankDays(result, ctx.horizon.dayEnd);
		return {
			ranking,
			served: serveDay(result, ctx.horizon.dayEnd, "2026-11-13", null).day,
		};
	}

	test("the weekly cap on acct-a changes which day is served", async () => {
		const capped = await servedAt(90);
		const uncapped = await servedAt(10);
		expect(capped.ranking.order).not.toEqual(uncapped.ranking.order);
		expect(capped.served).not.toBe(uncapped.served);
	});
});

describe("the engine serves and reports the day", () => {
	const input = () =>
		buildInput(
			replay1113Fixture({
				now: prague(13, 13, 45),
				fiveHour: {
					a: { usedPct: 82, resetsAt: prague(13, 14) + 663 },
					b: { usedPct: 100, resetsAt: prague(13, 17) + 11 },
				},
				blockedUntil: {},
			}),
		);

	test("reports the served day of the local date; a held day of another date is dropped", async () => {
		const engine = createForecastEngine();
		const fresh = await engine.compute(input());
		if (!fresh.available) throw new Error(fresh.reason);
		expect(fresh.servedDay?.date).toBe("2026-11-13");
		const again = await engine.compute({
			...input(),
			heldDay: fresh.servedDay,
		});
		if (!again.available) throw new Error(again.reason);
		expect(again.servedDay).toEqual(fresh.servedDay);
		const stale = await engine.compute({
			...input(),
			heldDay: { date: "2026-11-12", day: (fresh.servedDay?.day ?? 0) + 1 },
		});
		if (!stale.available) throw new Error(stale.reason);
		expect(stale.servedDay).toEqual(fresh.servedDay);
		expect(stale.response).toEqual(fresh.response);
	});
});
