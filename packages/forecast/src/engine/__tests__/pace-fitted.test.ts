/**
 * The fitted E4 path end to end: the real fitPaceModel on a planted history, its state as
 * input.demandModel, and the engine's own currentPace (the real buildPaceSeries and applyPace,
 * no seam) scaling the simulated days, against the same input with paceConditioning off.
 */
import { describe, expect, test } from "bun:test";
import type { ForecastInput } from "../../types";
import { prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import {
	applyPace,
	buildPaceSeries,
	fitPaceModel,
	type PaceNow,
	paceMultiplierAt,
} from "../pace";
import {
	buildInput,
	defaultSettings,
	type EngineFixture,
	prague,
	TZ,
} from "./fixtures-engine";

const BUCKET = 5 * 60_000;
const LONG = 60_000;

/** Deterministic 0..1 from a string key (FNV-1a). */
function hash01(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/**
 * Planted predictor in local time: each 8-hour block of each day has 6 or 24 units per hour at
 * random (seeded by day key and block), so the last hours predict the next ones within a block.
 * Today's 08-16 block is high, so the fitted multiplier at 10:00 is above 1.
 */
const planted: EngineFixture["hourly"] = (key) =>
	Array.from({ length: 24 }, (_, h) => {
		const block = Math.floor(h / 8);
		if (key === "2026-11-13" && block === 1) return 24;
		return hash01(`${key}/${block}`) < 0.5 ? 6 : 24;
	});

const NOW = prague(13, 10);

function plantedInput(): ForecastInput {
	return buildInput({
		now: NOW,
		historyDays: 28,
		hourly: planted,
		weeklyReset: { a: prague(15, 15), b: prague(17, 3) },
		fiveHour: {
			a: { usedPct: 0, resetsAt: null },
			b: { usedPct: 0, resetsAt: null },
		},
	});
}

async function context(input: ForecastInput): Promise<EngineContext> {
	const ctx = await prepareEngineContext(input, { noise: false });
	if (ctx === "insufficient_history") throw new Error("insufficient_history");
	return ctx;
}

function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Each simulated day's units from the bucket holding now to the end of the simulation. */
function totals(ctx: EngineContext, buckets: number): number[] {
	return ctx.scenarios.units.map((u) => {
		let t = 0;
		for (let j = 0; j < buckets; j++) t += u[j] as number;
		return t;
	});
}

describe("E4 fitted path through the engine", () => {
	test(
		"the real fit's state scales the simulated days by applyPace's multipliers; off gives the plain lines",
		async () => {
			const input = plantedInput();
			const series = buildPaceSeries({
				history: input.history,
				historyFrom: input.historyFrom,
				now: input.now,
				readings: input.readings,
				accounts: input.accounts.map((a) => a.accountId),
				timeZone: TZ,
			});
			const state = fitPaceModel(series, input.now);
			const expected = applyPace(state, series, input.now, true);
			expect(expected.status).toBe("fitted");
			expect(expected.bands.some((b) => b.feature !== null && b.m > 1)).toBe(
				true,
			);

			const on = await context({ ...input, demandModel: state });
			const off = await context({
				...input,
				demandModel: state,
				settings: defaultSettings({ paceConditioning: false }),
			});
			const pace: PaceNow = on.scenarios.diagnostics.pace;
			expect(pace.status).toBe("fitted");
			expect(pace.bands).toEqual(expected.bands);
			expect(on.inputs.pace).toEqual(expected);
			expect(on.inputs.paceModel?.cellsEstablished).toBe(
				state.cellsEstablished,
			);
			expect(off.scenarios.diagnostics.pace.status).toBe("off");

			// every simulated bucket is the plain one times m(minutes from now to its start)
			expect(on.scenarios.units.length).toBe(off.scenarios.units.length);
			on.scenarios.units.forEach((u, s) => {
				const plain = off.scenarios.units[s] as Float32Array;
				for (let j = 0; j < on.scenarios.bucketCount; j++) {
					const ahead =
						Math.max(0, on.scenarios.start + j * BUCKET - NOW) / 60_000;
					const m = paceMultiplierAt(pace, ahead);
					expect(u[j] as number).toBeCloseTo((plain[j] as number) * m, 4);
				}
			});

			// the typical rest-of-today total moves with the near-band multipliers
			const toMidnight = Math.round(
				(prague(14, 0) - on.scenarios.start) / BUCKET,
			);
			const typicalOn = median(totals(on, toMidnight));
			const typicalOff = median(totals(off, toMidnight));
			expect(typicalOn).toBeGreaterThan(typicalOff);
		},
		LONG,
	);
});
