import { describe, expect, it } from "bun:test";
import { loadavg } from "node:os";
import type { DemandBucket } from "../../types";
import { formatF2DaytypesLine, formatF2LearnLine } from "../f2-learn-log";
import { createForecastWorkerRunner } from "../forecast-worker-runner";
import { paceRefitLine } from "../pace-refit-log";
import {
	createPaceRefitRunner,
	PACE_REFIT_TIMEOUT_MS,
} from "../pace-refit-runner";

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const BUCKET = 300_000;

/** The source forecast-worker.ts, not the embedded bundle: this tests the checkout. */
const sourceRunner = () =>
	createForecastWorkerRunner({ embeddedCode: async () => "" });

/** Demand settings sent with every refit request (the forecast defaults). */
const DEMAND = {
	workDays: 5,
	historyLookbackDays: 84,
	historyHalfLifeDays: 14,
	workStartSharePct: 5,
	timeShiftMin: 30,
};

describe("forecast worker: the real worker module", () => {
	it("answers a refit job with a fitted state or a fit error, never a worker failure", async () => {
		const n = 288;
		const outcome = await createPaceRefitRunner(sourceRunner()).run(
			{
				start: T0 - n * BUCKET,
				units: new Float64Array(n),
				censored: new Uint8Array(n),
				timeZone: "Europe/Prague",
			},
			T0,
			DEMAND,
			{ timeoutMs: 60_000 },
		);
		if (outcome.status === "error") expect(outcome.reason).toBe("fit-error");
		else {
			expect(outcome.status).toBe("ok");
			// No stored row-1 choice yet: the main job carries rows 2-8 only.
			expect(outcome.learned.choices.map((c) => c.row)).toEqual([
				"pool",
				"lookback",
				"halflife",
				"wsshare",
				"wssample",
				"bandwidth",
				"jitter",
			]);
		}
	});
});

describe("forecast worker: the default loader", () => {
	it("starts the built-in worker (embedded after a CLI build, else the source module)", async () => {
		const n = 12;
		const outcome = await createPaceRefitRunner().run(
			{
				start: T0 - n * BUCKET,
				units: new Float64Array(n),
				censored: new Uint8Array(n),
				timeZone: "Europe/Prague",
			},
			T0,
			DEMAND,
			{ timeoutMs: 60_000 },
		);
		if (outcome.status === "error") expect(outcome.reason).toBe("fit-error");
		else expect(outcome.status).toBe("ok");
	});
});

/**
 * Off-main-thread proof with the real fit. Needs the fitted pace model, so it
 * is off until the model part is integrated: run with PACE_REFIT_REAL_WORKER=1.
 */
describe.skipIf(!process.env.PACE_REFIT_REAL_WORKER)(
	"forecast worker: the real refit off the main thread",
	() => {
		it("keeps a 20 ms interval ticking while an 84-day refit runs", async () => {
			const { buildPaceSeries } = await import("../../engine/pace");
			const days = 84;
			const n = (days * 24 * 60 * 60_000) / BUCKET;
			const historyFrom = T0 - n * BUCKET;
			const history: DemandBucket[] = Array.from({ length: n }, (_, i) => {
				const at = historyFrom + i * BUCKET;
				const hour = new Date(at).getUTCHours();
				const day = new Date(at).getUTCDay();
				const work = day >= 1 && day <= 5 && hour >= 7 && hour < 17;
				const units = work
					? 1 + ((i * 7919) % 13) / 13
					: ((i * 104729) % 5) / 50;
				return { start: at, units, fableUnits: 0, requests: units > 0 ? 1 : 0 };
			});
			const series = buildPaceSeries({
				history,
				historyFrom,
				now: T0,
				readings: [],
				accounts: ["a", "b"],
				timeZone: "Europe/Prague",
			});
			const row1Series = {
				...series,
				units: series.units.slice(),
				censored: series.censored.slice(),
			};
			let last = performance.now();
			let maxGap = 0;
			let ticks = 0;
			const handle = setInterval(() => {
				const t = performance.now();
				maxGap = Math.max(maxGap, t - last);
				last = t;
				ticks++;
			}, 20);
			try {
				const outcome = await createPaceRefitRunner(sourceRunner()).run(
					series,
					T0,
					DEMAND,
					{ timeoutMs: 600_000 },
				);
				expect(outcome.status).toBe("ok");
				expect(outcome.ms).toBeGreaterThanOrEqual(1_000);
				console.info(
					`real refit ms=${Math.round(outcome.ms)} ticks=${ticks} maxGapMs=${maxGap.toFixed(1)}`,
				);
				console.info(paceRefitLine(outcome, null, T0));
				if (outcome.status === "ok")
					console.info(
						formatF2LearnLine(outcome.learned, outcome.ms, { mainJob: true }),
					);
				expect(ticks).toBeGreaterThanOrEqual(Math.floor(outcome.ms / 40));
				expect(maxGap).toBeLessThan(250);
				// The main job fits E4 once (row 1 runs in its own job): far inside the timeout.
				expect(outcome.ms).toBeLessThan(PACE_REFIT_TIMEOUT_MS / 4);
				console.info(
					`load after main job ${loadavg()
						.map((x) => x.toFixed(2))
						.join(" ")}`,
				);
				const row1Started = performance.now();
				const row1 = await createPaceRefitRunner(sourceRunner()).runDaytypes(
					row1Series,
					T0,
					DEMAND,
					{ timeoutMs: 600_000 },
				);
				expect(row1.status).toBe("ok");
				console.info(
					`real daytypes ms=${Math.round(row1.ms)} wallMs=${Math.round(performance.now() - row1Started)} maxGapMs=${maxGap.toFixed(1)}`,
				);
				console.info(formatF2DaytypesLine(row1, null, T0));
				console.info(
					`load after row-1 job ${loadavg()
						.map((x) => x.toFixed(2))
						.join(" ")}`,
				);
				expect(maxGap).toBeLessThan(250);
			} finally {
				clearInterval(handle);
			}
		}, 660_000);

		it("runs the nested row-1 confirmation job on 84 days inside the refit timeout", async () => {
			const { buildPaceSeries } = await import("../../engine/pace");
			const days = 84;
			const n = (days * 24 * 60 * 60_000) / BUCKET;
			const historyFrom = T0 - n * BUCKET;
			const history: DemandBucket[] = Array.from({ length: n }, (_, i) => {
				const at = historyFrom + i * BUCKET;
				const hour = new Date(at).getUTCHours();
				const day = new Date(at).getUTCDay();
				const work = day >= 1 && day <= 5 && hour >= 7 && hour < 17;
				const units = work
					? 1 + ((i * 7919) % 13) / 13
					: ((i * 104729) % 5) / 50;
				return { start: at, units, fableUnits: 0, requests: units > 0 ? 1 : 0 };
			});
			const series = buildPaceSeries({
				history,
				historyFrom,
				now: T0,
				readings: [],
				accounts: ["a", "b"],
				timeZone: "Europe/Prague",
			});
			const loadBefore = loadavg()
				.map((x) => x.toFixed(2))
				.join(" ");
			const outcome = await createPaceRefitRunner(sourceRunner()).runDaytypes(
				series,
				T0,
				DEMAND,
				{ timeoutMs: 600_000, daytypes: null, pending: [0, 0, 0, 0, 0, 1, 1] },
			);
			expect(outcome.status).toBe("ok");
			if (outcome.status === "ok") expect(outcome.nested).toBe(true);
			console.info(
				`real nested daytypes ms=${Math.round(outcome.ms)} loadBefore=${loadBefore} loadAfter=${loadavg()
					.map((x) => x.toFixed(2))
					.join(" ")}`,
			);
			console.info(formatF2DaytypesLine(outcome, null, T0));
			expect(outcome.ms).toBeLessThan(PACE_REFIT_TIMEOUT_MS);
		}, 660_000);
	},
);
