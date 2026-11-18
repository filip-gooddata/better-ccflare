/**
 * The inputs the engine hands the service for the log line (amendment 4, D2), from a real
 * compute() on the 2026-11-12 replay fixture (fixtures-engine.ts), checked against the engine's
 * own context, the calibration evidence and an independent weighted quantile.
 */
import { describe, expect, test } from "bun:test";
import { localDayStart } from "../../time";
import { calibrateWithEvidence } from "../calibration";
import { buildDayTable, poolFor } from "../days";
import { createForecastEngine, prepareEngineContext } from "../engine";
import { presentDemand } from "../learn";
import { plainPace } from "../pace";
import { datePool } from "../scenarios";
import { buildInput, defaultSettings, replayFixture } from "./fixtures-engine";

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
	test("compute() carries the pace, pool quantiles, work start and every k with its evidence", async () => {
		const input = buildInput(replayFixture());
		const result = await createForecastEngine({ noise: false }).compute(input);
		if (!result.available) throw new Error(result.reason);
		const inputs = result.inputs;
		if (!inputs) throw new Error("no inputs on an available result");

		const ctx = await prepareEngineContext(input, { noise: false });
		if (ctx === "insufficient_history") throw new Error("no forecast");
		const diagnostics = ctx.scenarios.diagnostics;
		expect(inputs.pace).toEqual(diagnostics.pace);
		expect(inputs.pace).toEqual(plainPace("unfitted"));
		expect(inputs.paceModel).toBeNull();
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

describe("forecast inputs: the served scenario pool (R3-1, R3-8)", () => {
	const today = (input: ReturnType<typeof buildInput>) =>
		localDayStart(input.now, input.pace.timeZone);

	test("the pool diagnostic reports the served pool after rows 2, 4 and 5, not the settings table", async () => {
		const input = buildInput(replayFixture());
		const learnedDemand = {
			...presentDemand(input.settings),
			poolTau: Number.POSITIVE_INFINITY,
			lookbackDays: 21,
			halfLifeDays: 7,
		};
		const result = await createForecastEngine({ noise: false }).compute({
			...input,
			learnedDemand,
		});
		if (!result.available || !result.inputs) throw new Error("no inputs");
		const table = buildDayTable(input, { lookbackDays: 21, halfLifeDays: 7 });
		const pool = datePool(table, today(input), input.pace, learnedDemand);
		expect(pool.length).toBe(21);
		const settingsTable = buildDayTable(input);
		expect(poolFor(settingsTable, settingsTable.today.type).length).not.toBe(
			21,
		);
		expect(result.inputs.pool.days).toBe(pool.length);
		expect(result.inputs.pool.medianUnits).toBe(
			lowerWeightedQuantile(pool, 0.5),
		);
		expect(result.inputs.pool.p90Units).toBe(lowerWeightedQuantile(pool, 0.9));
	});

	test("the pool diagnostic uses the served E4 partition, as the scenarios draw (R3-4)", async () => {
		const input = buildInput(replayFixture());
		const engine = createForecastEngine({ noise: false });
		const present = await engine.compute({
			...input,
			demandModel: null,
			learnedDemand: presentDemand(input.settings),
		});
		const unserved = await engine.compute({
			...input,
			demandModel: null,
			learnedDemand: {
				...presentDemand(input.settings),
				partition: [0, 0, 0, 0, 0, 0, 0],
			},
		});
		if (!present.inputs || !unserved.inputs) throw new Error("no inputs");
		const table = buildDayTable(input);
		expect(
			datePool(table, today(input), input.pace, {
				partition: [0, 0, 0, 0, 0, 0, 0],
			}).length,
		).not.toBe(present.inputs.pool.days);
		expect(unserved.inputs.pool).toEqual(present.inputs.pool);
	});

	test("a lookback setting above 84 serves an 84-day scenario table on every path; calibration keeps the setting", async () => {
		const input = buildInput(
			replayFixture({
				historyDays: 130,
				settings: defaultSettings({ historyLookbackDays: 365 }),
			}),
		);
		const engine = createForecastEngine({ noise: false });
		const capped = buildDayTable(input, {
			lookbackDays: 84,
			halfLifeDays: input.settings.historyHalfLifeDays,
		});
		const want = poolFor(capped, capped.today.type);
		const raw = buildDayTable(input);
		expect(poolFor(raw, raw.today.type).length).toBeGreaterThan(want.length);
		for (const learnedDemand of [
			undefined,
			null,
			presentDemand(input.settings),
			{ ...presentDemand(input.settings), lookbackDays: 365 },
		]) {
			const result = await engine.compute({ ...input, learnedDemand });
			if (!result.available || !result.inputs) throw new Error("no inputs");
			expect(result.inputs.pool.days).toBe(want.length);
			expect(result.inputs.pool.medianUnits).toBe(
				lowerWeightedQuantile(want, 0.5),
			);
		}
		const ctx = await prepareEngineContext(input, { noise: false });
		if (ctx === "insufficient_history") throw new Error("no forecast");
		const counted = input.accounts.filter((a) => a.counted);
		expect(ctx.calibration).toEqual(
			calibrateWithEvidence(input, counted).calibration,
		);
	});
});
