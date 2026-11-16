import { describe, expect, it } from "bun:test";
import type { PaceSeries } from "../../engine/pace/types";
import {
	createForecastWorkerRunner,
	type ForecastWorkerRunner,
} from "../forecast-worker-runner";
import { createPaceRefitRunner } from "../pace-refit-runner";

const FIXTURE = new URL("./fixtures/test-forecast-worker.ts", import.meta.url)
	.href;
const T0 = Date.UTC(2026, 10, 16, 9, 0);

const fixtureRunner = (): ForecastWorkerRunner =>
	createForecastWorkerRunner({
		workerUrl: FIXTURE,
		embeddedCode: async () => "",
	});

const series = (timeZone: string, n = 24): PaceSeries => ({
	start: T0 - n * 300_000,
	units: new Float64Array(n).fill(1),
	censored: new Uint8Array(n),
	timeZone,
});

describe("forecast worker runner: the refit job", () => {
	it("returns the fitted state and transfers the series buffers", async () => {
		const s = series("Europe/Prague", 48);
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(s, T0, {
			timeoutMs: 10_000,
		});
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.state.fittedAt).toBe(T0);
		expect(outcome.state.days).toBe(48);
		expect(outcome.ms).toBeGreaterThanOrEqual(0);
		// transferred, not copied: the caller's buffers are detached
		expect(s.units.byteLength).toBe(0);
		expect(s.censored.byteLength).toBe(0);
	});

	it("reports a fit that throws as fit-error", async () => {
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(
			series("throw"),
			T0,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({ status: "error", reason: "fit-error" });
	});

	it("terminates a worker that runs past the timeout", async () => {
		const started = performance.now();
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(
			series("hang"),
			T0,
			{ timeoutMs: 300 },
		);
		expect(outcome.status).toBe("timeout");
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("stops a running job when the signal aborts", async () => {
		const abort = new AbortController();
		const run = createPaceRefitRunner(fixtureRunner()).run(series("hang"), T0, {
			timeoutMs: 60_000,
			signal: abort.signal,
		});
		setTimeout(() => abort.abort(), 100);
		expect(await run).toMatchObject({ status: "error", reason: "stopped" });
	});

	it("starts no second job of the same kind while one runs", async () => {
		const runner = createPaceRefitRunner(fixtureRunner());
		const first = runner.run(series("busy:400"), T0, { timeoutMs: 10_000 });
		const second = await runner.run(series("Europe/Prague"), T0, {
			timeoutMs: 10_000,
		});
		expect(second).toMatchObject({ status: "error", reason: "busy" });
		expect((await first).status).toBe("ok");
	});

	it("starts no worker when the signal aborts while the code loads", async () => {
		const abort = new AbortController();
		let started = false;
		const runner = createForecastWorkerRunner({
			workerUrl: FIXTURE,
			embeddedCode: async () => {
				abort.abort();
				started = true;
				return "";
			},
		});
		const started0 = performance.now();
		const outcome = await createPaceRefitRunner(runner).run(
			series("hang"),
			T0,
			{
				timeoutMs: 60_000,
				signal: abort.signal,
			},
		);
		expect(started).toBe(true);
		expect(outcome).toMatchObject({ status: "error", reason: "stopped" });
		expect(performance.now() - started0).toBeLessThan(1_000);
	});

	it("runs embedded code from a blob when the build embedded a worker", async () => {
		const source = `self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: true, result: { fittedAt: e.data.payload.now, days: -1 } });`;
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("./fixtures/no-such-worker.ts", import.meta.url).href,
			embeddedCode: async () => Buffer.from(source).toString("base64"),
		});
		const outcome = await createPaceRefitRunner(runner).run(
			series("Europe/Prague"),
			T0,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({
			status: "ok",
			state: { fittedAt: T0, days: -1 },
		});
	});

	it("reports a missing worker module as worker-error", async () => {
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("./fixtures/no-such-worker.ts", import.meta.url).href,
			embeddedCode: async () => "",
		});
		const outcome = await createPaceRefitRunner(runner).run(
			series("Europe/Prague"),
			T0,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({ status: "error", reason: "worker-error" });
	});
});

/** Largest gap between ticks of a 20 ms interval while `work` runs. */
async function maxTickGap(work: () => Promise<unknown>) {
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
		const started = performance.now();
		const result = await work();
		return { result, maxGap, ticks, ms: performance.now() - started };
	} finally {
		clearInterval(handle);
	}
}

describe("forecast worker runner: off the main thread", () => {
	it("keeps the event loop ticking while the worker spins the CPU for 1.2 s", async () => {
		const { result, maxGap, ticks, ms } = await maxTickGap(() =>
			createPaceRefitRunner(fixtureRunner()).run(series("busy:1200"), T0, {
				timeoutMs: 10_000,
			}),
		);
		expect((result as { status: string }).status).toBe("ok");
		expect(ms).toBeGreaterThanOrEqual(1_200);
		expect(ticks).toBeGreaterThanOrEqual(30);
		expect(maxGap).toBeLessThan(250);
	});
});
