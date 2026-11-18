/**
 * E4 wiring in the engine: which pace a computation uses (off, unfitted, or the fitted state
 * applied to the series up to now), what the pace model is given, and that the pace reaches
 * the scenarios and the inputs detail for the log.
 */
import { describe, expect, test } from "bun:test";
import type { ForecastInput } from "../../types";
import {
	createForecastEngine,
	currentPace,
	prepareEngineContext,
} from "../engine";
import {
	type PaceFitState,
	type PaceNow,
	type PaceSeries,
	type PaceSeriesInput,
	plainPace,
} from "../pace";
import {
	buildInput,
	defaultSettings,
	FIXED_N_ENGINE,
	replayFixture,
} from "./fixtures-engine";
import { FULL_GRID_TIMEOUT_MS } from "./plan-timeout";

const STATE: PaceFitState = {
	fittedAt: 1_000,
	days: 84,
	weeks: 12,
	candidates: 101,
	floor: 10,
	cellsEstablished: 3,
	cellsTotal: 216,
	belowFloor: [],
	selected: [],
};

const SERIES: PaceSeries = {
	start: 0,
	units: new Float64Array(0),
	censored: new Uint8Array(0),
	timeZone: "UTC",
};

const APPLIED: PaceNow = {
	...plainPace("fitted", STATE.fittedAt),
	bands: plainPace("fitted").bands.map((b, i) => ({ ...b, m: 1 + i / 10 })),
};

function fakeFit() {
	const built: PaceSeriesInput[] = [];
	const applied: unknown[][] = [];
	return {
		built,
		applied,
		fit: {
			buildPaceSeries(input: PaceSeriesInput): PaceSeries {
				built.push(input);
				return SERIES;
			},
			applyPace(...args: Parameters<typeof import("../pace").applyPace>) {
				applied.push(args);
				return APPLIED;
			},
		},
	};
}

function input(over: Partial<ForecastInput> = {}): ForecastInput {
	return { ...buildInput(replayFixture()), ...over };
}

function off(): ForecastInput["settings"] {
	return defaultSettings({ paceConditioning: false });
}

describe("currentPace", () => {
	test("off ignores a fitted state: the plain lines, and the pace model is not run", () => {
		const f = fakeFit();
		const pace = currentPace(
			input({ settings: off(), demandModel: STATE }),
			f.fit,
		);
		expect(pace).toEqual(plainPace("off"));
		expect(f.built).toEqual([]);
		expect(f.applied).toEqual([]);
	});

	test("no state yet (absent or null) is unfitted: the plain lines, and the pace model is not run", () => {
		const f = fakeFit();
		expect(currentPace(input(), f.fit)).toEqual(plainPace("unfitted"));
		expect(currentPace(input({ demandModel: null }), f.fit)).toEqual(
			plainPace("unfitted"),
		);
		expect(f.built).toEqual([]);
		expect(f.applied).toEqual([]);
	});

	test("a fitted state is applied, enabled, to the series of the pooled history and every account's readings up to now", () => {
		const base = input();
		const first = base.accounts[0];
		if (!first) throw new Error("fixture has no account");
		const paused = { ...first, accountId: "paused", counted: false };
		const withPaused = input({
			accounts: [...base.accounts, paused],
			demandModel: STATE,
		});
		const f = fakeFit();
		expect(currentPace(withPaused, f.fit)).toBe(APPLIED);
		expect(f.built.length).toBe(1);
		const seriesInput = f.built[0] as PaceSeriesInput;
		expect(seriesInput.history).toBe(withPaused.history);
		expect(seriesInput.historyFrom).toBe(withPaused.historyFrom);
		expect(seriesInput.now).toBe(withPaused.now);
		expect(seriesInput.readings).toBe(withPaused.readings);
		expect(seriesInput.timeZone).toBe(withPaused.pace.timeZone);
		// censoring needs every account, also one that cannot take work now
		expect(seriesInput.accounts).toEqual([
			...base.accounts.map((a) => a.accountId),
			"paused",
		]);
		expect(f.applied).toEqual([[STATE, SERIES, withPaused.now, true]]);
	});
});

describe("the pace in the engine", () => {
	test("unfitted: the scenarios and the inputs detail carry the plain pace", async () => {
		const ctx = await prepareEngineContext(input(), { noise: false });
		if (ctx === "insufficient_history") throw new Error("no forecast");
		expect(ctx.scenarios.diagnostics.pace).toEqual(plainPace("unfitted"));
		expect(ctx.inputs?.pace).toBe(ctx.scenarios.diagnostics.pace);
		expect(ctx.inputs?.paceModel).toBeNull();
	});

	test("off with a state passed in: plain lines marked off, the state summarised for the log", async () => {
		const result = await createForecastEngine({
			...FIXED_N_ENGINE,
			noise: false,
		}).compute(input({ settings: off(), demandModel: STATE }));
		if (!result.available) throw new Error(result.reason);
		expect(result.inputs?.pace).toEqual(plainPace("off"));
		expect(result.inputs?.paceModel).toEqual({
			fittedAt: STATE.fittedAt,
			days: 84,
			weeks: 12,
			cellsEstablished: 3,
			cellsTotal: 216,
			belowFloor: [],
		});
	});

	test(
		"off gives exactly the unfitted forecast",
		async () => {
			const engine = createForecastEngine({ ...FIXED_N_ENGINE, noise: false });
			const a = await engine.compute(input());
			const b = await engine.compute(
				input({ settings: off(), demandModel: STATE }),
			);
			if (!a.available || !b.available) throw new Error("no forecast");
			expect(b.response).toEqual(a.response);
			expect(b.plan).toEqual(a.plan);
		},
		FULL_GRID_TIMEOUT_MS,
	);
});
