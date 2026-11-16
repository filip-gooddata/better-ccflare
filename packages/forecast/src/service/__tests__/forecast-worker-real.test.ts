import { describe, expect, it } from "bun:test";
import type { DemandBucket } from "../../types";
import { createForecastWorkerRunner } from "../forecast-worker-runner";
import { createPaceRefitRunner } from "../pace-refit-runner";

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const BUCKET = 300_000;

/** The source forecast-worker.ts, not the embedded bundle: this tests the checkout. */
const sourceRunner = () =>
	createForecastWorkerRunner({ embeddedCode: async () => "" });

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
					{ timeoutMs: 600_000 },
				);
				expect(outcome.status).toBe("ok");
				expect(outcome.ms).toBeGreaterThanOrEqual(1_000);
				expect(ticks).toBeGreaterThanOrEqual(Math.floor(outcome.ms / 40));
				expect(maxGap).toBeLessThan(250);
			} finally {
				clearInterval(handle);
			}
		}, 660_000);
	},
);
