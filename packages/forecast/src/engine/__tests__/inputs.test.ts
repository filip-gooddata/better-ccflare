/**
 * The inputs the engine hands the service for the log line (amendment 4, D2), from a real
 * compute() on the 2026-11-12 replay fixture (fixtures-engine.ts), checked against the engine's
 * own context, the calibration evidence and an independent weighted quantile.
 */
import { describe, expect, test } from "bun:test";
import { calibrateWithEvidence } from "../calibration";
import { buildDayTable, poolFor } from "../days";
import { createForecastEngine, prepareEngineContext } from "../engine";
import { buildInput, replayFixture } from "./fixtures-engine";

const HOUR_BUCKETS = 12;

/** Smallest daily total whose share of the summed weight, counting it and every smaller total, reaches q. */
function lowerWeightedQuantile(
	days: Array<{ total: number; weight: number }>,
	q: number,
): number | null {
	const weighted = days.filter((d) => d.weight > 0);
	const sum = weighted.reduce((acc, d) => acc + d.weight, 0);
	if (!(sum > 0)) return null;
	const totals = [...new Set(weighted.map((d) => d.total))].sort(
		(x, y) => x - y,
	);
	for (const t of totals) {
		const below = weighted
			.filter((d) => d.total <= t)
			.reduce((acc, d) => acc + d.weight, 0);
		if (below / sum >= q - 1e-12) return t;
	}
	return totals.at(-1) ?? null;
}

describe("forecast inputs from the engine (amendment 4, D2)", () => {
	test("compute() carries the day factor, recent rate, pool quantiles, work start and every k with its evidence", async () => {
		const input = buildInput(replayFixture());
		const result = await createForecastEngine({ noise: false }).compute(input);
		if (!result.available) throw new Error(result.reason);
		const inputs = result.inputs;
		if (!inputs) throw new Error("no inputs on an available result");

		const ctx = await prepareEngineContext(input, { noise: false });
		if (ctx === "insufficient_history") throw new Error("no forecast");
		const diagnostics = ctx.scenarios.diagnostics;
		expect(inputs.dayFactor).toEqual(diagnostics.day);
		expect(inputs.dayFactor.a).toBe(diagnostics.dayFactor);
		expect(inputs.recentRatePerHour).toBeCloseTo(
			HOUR_BUCKETS * diagnostics.recentRate,
			9,
		);
		expect(inputs.workStartMinute).toBe(ctx.workStartMinute);

		const table = buildDayTable(input);
		const pool = poolFor(table, table.today.type);
		expect(inputs.pool.days).toBe(pool.length);
		expect(inputs.pool.medianUnits).not.toBeNull();
		expect(inputs.pool.medianUnits).toBe(lowerWeightedQuantile(pool, 0.5));
		expect(inputs.pool.p90Units).toBe(lowerWeightedQuantile(pool, 0.9));

		const counted = input.accounts.filter((a) => a.counted);
		const { evidence } = calibrateWithEvidence(input, counted);
		expect(inputs.limits.length).toBe(counted.length * 3);
		for (const l of inputs.limits) {
			const e = evidence.find(
				(x) => x.accountId === l.accountId && x.window === l.limit,
			);
			expect(l.instances).toBe(e?.instances ?? 0);
			expect(l.points).toBe(e?.points ?? 0);
			if (l.source === "own") expect(l.k).toBe(e?.ownK ?? Number.NaN);
			if (l.source === "none") expect(l.k).toBeNull();
		}
		const sources = new Set(inputs.limits.map((l) => l.source));
		expect(sources.has("own")).toBe(true);
		expect(sources.has("borrowed") || sources.has("none")).toBe(true);

		expect(Object.keys(result.response)).not.toContain("inputs");
		expect(JSON.stringify(result.response)).not.toContain('"inputs"');
	});
});
