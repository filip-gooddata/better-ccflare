/**
 * The four instants of DESIGN-E4 §12 through the engine (§11 item 10): frozen light, typical and
 * heavy rest-of-today totals with the frozen fitted state and without a demand model.
 *
 * Inputs reuse committed data only: the fitted states and the last 16 local days of 5-minute
 * pooled usage from pace/__tests__/fixtures/instants.json, and before those days the hourly
 * replay days of fixtures-engine.ts (DAYS_TO_2026_11_13, the same record summed per hour). The
 * accounts' readings and calibration are the fixture's own (K_FIVE_HOUR, K_WEEKLY) with no open
 * 5-hour window, so no bucket is censored here; the fitted states saw the record's censoring.
 * Rest of today: per simulated day the units from the bucket holding now to local midnight;
 * light, typical and heavy are its 10th, 50th and 90th percentiles (nearest rank on the sorted
 * simulated days), noise on as served.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemandBucket, ForecastInput } from "../../types";
import { prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import type { PaceFitState } from "../pace";
import {
	buildInput,
	defaultSettings,
	prague,
	replay1113Fixture,
} from "./fixtures-engine";

const BUCKET = 5 * 60_000;
const LONG = 60_000;

type Fixture = {
	label: string;
	now: number;
	series: {
		start: number;
		units: number[];
		censored: number[];
		timeZone: string;
	};
	state: PaceFitState;
};

const fixtures = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"..",
			"pace",
			"__tests__",
			"fixtures",
			"instants.json",
		),
		"utf8",
	),
) as Fixture[];

/**
 * Light / typical / heavy rest-of-today units with the fitted state and plain (paceConditioning
 * off), rounded to 0.1, and the band multipliers m (0-1h ... 4-7d) the engine applied, to 1e-4:
 * equal to pace/__tests__ instants.test.ts expected m, so the engine sees the same pace.
 */
const FROZEN: Record<
	string,
	{ fitted: number[]; plain: number[]; m: number[] }
> = {
	"Thu 2026-11-12 10:00": {
		fitted: [23.8, 111.7, 176.7],
		plain: [22, 70.2, 111.1],
		m: [2.2893, 1.8116, 2.3568, 1, 1, 1, 1, 1, 1],
	},
	"Thu 2026-11-12 13:00": {
		fitted: [21.4, 97, 157],
		plain: [19.9, 44, 69.5],
		m: [2.4421, 2.0164, 2.8638, 1, 1, 1, 1, 1, 1],
	},
	"Fri 2026-11-13 10:40": {
		fitted: [30.3, 95.4, 174],
		plain: [29.6, 67.1, 121.9],
		m: [1.0517, 1.7644, 2.2183, 1, 1, 1, 1, 1, 1],
	},
	"Fri 2026-11-13 12:06": {
		fitted: [30.1, 124.9, 217.3],
		plain: [23.9, 55, 91.9],
		m: [4.2369, 2.1552, 3.0683, 1, 1, 1, 1, 1, 1],
	},
};

function instantInput(f: Fixture): ForecastInput {
	const day = new Date(f.now).getUTCDate();
	const base = buildInput(
		replay1113Fixture({
			now: f.now,
			historyDays: day === 12 ? 27 : 28,
			fiveHour: {
				a: { usedPct: 0, resetsAt: null },
				b: { usedPct: 0, resetsAt: null },
			},
			blockedUntil: {},
		}),
	);
	const history: DemandBucket[] = base.history.filter(
		(b) => b.start < f.series.start,
	);
	f.series.units.forEach((units, i) => {
		const start = f.series.start + i * BUCKET;
		if (units > 0 && start < f.now)
			history.push({ start, units, fableUnits: 0, requests: 1 });
	});
	return { ...base, history };
}

async function context(input: ForecastInput): Promise<EngineContext> {
	const ctx = await prepareEngineContext(input, { noise: true });
	if (ctx === "insufficient_history") throw new Error("insufficient_history");
	return ctx;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function lines(ctx: EngineContext, midnight: number): number[] {
	const n = Math.round((midnight - ctx.scenarios.start) / BUCKET);
	const totals = ctx.scenarios.units
		.map((u) => {
			let t = 0;
			for (let j = 0; j < n; j++) t += u[j] as number;
			return t;
		})
		.sort((a, b) => a - b);
	const at = (q: number) =>
		totals[
			Math.min(totals.length - 1, Math.ceil(q * totals.length) - 1)
		] as number;
	return [at(0.1), at(0.5), at(0.9)].map(round1);
}

describe("frozen instants through the engine", () => {
	test("the four instants are the pace fixtures' four", () => {
		expect(fixtures.map((f) => f.label)).toEqual(Object.keys(FROZEN));
	});
	for (const f of fixtures)
		test(
			f.label,
			async () => {
				const input = instantInput(f);
				const midnight = prague(new Date(f.now).getUTCDate() + 1, 0);
				const fitted = await context({ ...input, demandModel: f.state });
				const plain = await context({
					...input,
					settings: defaultSettings({ paceConditioning: false }),
				});
				const pace = fitted.scenarios.diagnostics.pace;
				expect(pace.status).toBe("fitted");
				const got = {
					fitted: lines(fitted, midnight),
					plain: lines(plain, midnight),
					m: pace.bands.map((b) => Math.round(b.m * 1e4) / 1e4),
				};
				expect(got).toEqual(FROZEN[f.label] as typeof got);
			},
			LONG,
		);
});
