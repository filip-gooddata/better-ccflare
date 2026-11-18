import { describe, expect, it } from "bun:test";
import { threadCpuMs } from "../../engine/__tests__/fixtures-sim";
import type { PaceSeries } from "../../engine/pace/types";
import { daytypesJob, refitJob } from "../forecast-jobs";
import {
	createForecastWorkerRunner,
	type ForecastWorkerRunner,
} from "../forecast-worker-runner";
import {
	createPaceRefitRunner,
	type RefitDemandSettings,
} from "../pace-refit-runner";

const FIXTURE = new URL("./fixtures/test-forecast-worker.ts", import.meta.url)
	.href;
const T0 = Date.UTC(2026, 10, 16, 9, 0);

const fixtureRunner = (): ForecastWorkerRunner =>
	createForecastWorkerRunner({
		workerUrl: FIXTURE,
		embeddedCode: async () => "",
	});

const DEMAND: RefitDemandSettings = {
	workDays: 5,
	historyLookbackDays: 84,
	historyHalfLifeDays: 14,
	workStartSharePct: 5,
	timeShiftMin: 30,
};

const series = (timeZone: string, n = 24): PaceSeries => ({
	start: T0 - n * 300_000,
	units: new Float64Array(n).fill(1),
	censored: new Uint8Array(n),
	timeZone,
});

describe("forecast worker runner: the refit job", () => {
	it("returns the fitted state and transfers the series buffers", async () => {
		const s = series("Europe/Prague", 48);
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(
			s,
			T0,
			DEMAND,
			{
				timeoutMs: 10_000,
			},
		);
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.state.fittedAt).toBe(T0);
		expect(outcome.state.days).toBe(48);
		// the fixture echoes the demand settings it received as served values
		expect(outcome.learned).toMatchObject({
			poolTau: "hard3",
			lookbackDays: 84,
			halfLifeDays: 14,
			workStartSharePct: 5,
			jitterMin: 30,
		});
		expect(outcome.ms).toBeGreaterThanOrEqual(0);
		// transferred, not copied: the caller's buffers are detached
		expect(s.units.byteLength).toBe(0);
		expect(s.censored.byteLength).toBe(0);
	});

	it("reports a fit that throws as fit-error", async () => {
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(
			series("throw"),
			T0,
			DEMAND,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({ status: "error", reason: "fit-error" });
	});

	it("terminates a worker that runs past the timeout", async () => {
		const started = performance.now();
		const outcome = await createPaceRefitRunner(fixtureRunner()).run(
			series("hang"),
			T0,
			DEMAND,
			{ timeoutMs: 300 },
		);
		expect(outcome.status).toBe("timeout");
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("stops a running job when the signal aborts", async () => {
		const abort = new AbortController();
		const run = createPaceRefitRunner(fixtureRunner()).run(
			series("hang"),
			T0,
			DEMAND,
			{
				timeoutMs: 60_000,
				signal: abort.signal,
			},
		);
		setTimeout(() => abort.abort(), 100);
		expect(await run).toMatchObject({ status: "error", reason: "stopped" });
	});

	it("starts no second job of the same kind while one runs", async () => {
		const runner = createPaceRefitRunner(fixtureRunner());
		const first = runner.run(series("busy:400"), T0, DEMAND, {
			timeoutMs: 10_000,
		});
		const second = await runner.run(series("Europe/Prague"), T0, DEMAND, {
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
			DEMAND,
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
		const source = `self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: true, result: { pace: { fittedAt: e.data.payload.now, days: -1 }, learned: { lookbackDays: e.data.payload.historyLookbackDays } } });`;
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("./fixtures/no-such-worker.ts", import.meta.url).href,
			embeddedCode: async () => Buffer.from(source).toString("base64"),
		});
		const outcome = await createPaceRefitRunner(runner).run(
			series("Europe/Prague"),
			T0,
			DEMAND,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({
			status: "ok",
			state: { fittedAt: T0, days: -1 },
			learned: { lookbackDays: 84 },
		});
	});

	it("the real worker returns the E4 fit and the learned demand of the same job", async () => {
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("../forecast-worker.ts", import.meta.url).href,
			embeddedCode: async () => "",
		});
		const outcome = await createPaceRefitRunner(runner).run(
			series("Europe/Prague", 288 * 3),
			T0,
			DEMAND,
			{ timeoutMs: 60_000 },
		);
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.state.fittedAt).toBe(T0);
		expect(outcome.state.candidates).toBe(101);
		expect(outcome.learned).toMatchObject({
			partition: [1, 0, 0, 0, 0, 2, 2],
			poolTau: "hard3",
			lookbackDays: 84,
			halfLifeDays: 14,
			workStartSharePct: 5,
			workStartSample: 10,
			bandwidthK: 0,
			jitterMin: 30,
		});
		// No row-1 job has run: the main job carries no row-1 choice and fits the present partition.
		expect(outcome.learned.choices.map((c) => c.row)).toEqual([
			"pool",
			"lookback",
			"halflife",
			"wsshare",
			"wssample",
			"bandwidth",
			"jitter",
		]);
		expect(outcome.learned.ms).toBeGreaterThanOrEqual(0);
	});

	it("the real worker serves the stored row-1 partition's fit in the main job", async () => {
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("../forecast-worker.ts", import.meta.url).href,
			embeddedCode: async () => "",
		});
		const s = series("Europe/Prague", 288 * 3);
		const payload = { ...s, now: T0, ...DEMAND };
		const stored = daytypesJob({
			...payload,
			units: s.units.slice(),
			censored: s.censored.slice(),
		});
		const switched = { ...stored, served: [0, 0, 0, 0, 0, 1, 1] };
		const expectedPace = refitJob({
			...payload,
			units: s.units.slice(),
			censored: s.censored.slice(),
			daytypes: switched,
		}).pace;
		const outcome = await createPaceRefitRunner(runner).run(s, T0, DEMAND, {
			timeoutMs: 60_000,
			daytypes: switched,
		});
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.learned.partition).toEqual([0, 0, 0, 0, 0, 1, 1]);
		expect(outcome.learned.choices[0]).toEqual(switched);
		expect(outcome.state).toEqual(expectedPace);
	});

	it("the real worker answers the row-1 job with the choice the in-thread job gives", async () => {
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("../forecast-worker.ts", import.meta.url).href,
			embeddedCode: async () => "",
		});
		const s = series("Europe/Prague", 288 * 3);
		const expected = daytypesJob({
			...s,
			units: s.units.slice(),
			censored: s.censored.slice(),
			now: T0,
			...DEMAND,
			daytypes: null,
			pending: null,
		});
		const outcome = await createPaceRefitRunner(runner).runDaytypes(
			s,
			T0,
			DEMAND,
			{ timeoutMs: 60_000 },
		);
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.choice).toEqual(expected.choice);
		expect(outcome.pending).toEqual(expected.pending);
		expect(outcome.nested).toBe(false);
		expect(outcome.choice.row).toBe("daytypes");
		expect(s.units.byteLength).toBe(0);
	});

	it("reports a missing worker module as worker-error", async () => {
		const runner = createForecastWorkerRunner({
			workerUrl: new URL("./fixtures/no-such-worker.ts", import.meta.url).href,
			embeddedCode: async () => "",
		});
		const outcome = await createPaceRefitRunner(runner).run(
			series("Europe/Prague"),
			T0,
			DEMAND,
			{ timeoutMs: 10_000 },
		);
		expect(outcome).toMatchObject({ status: "error", reason: "worker-error" });
	});
});

/**
 * Largest gap between ticks of a 20 ms interval while `work` runs, as wall
 * clock and as CPU time this thread spent in the gap. Limits are asserted on
 * the CPU time, which machine load cannot stretch; the clock is per thread,
 * so the worker spinning its own thread does not count.
 */
async function maxTickGap(work: () => Promise<unknown>) {
	let last = performance.now();
	let lastCpu = threadCpuMs();
	let maxGap = 0;
	let maxCpuGap = 0;
	let ticks = 0;
	const handle = setInterval(() => {
		const t = performance.now();
		const cpu = threadCpuMs();
		maxGap = Math.max(maxGap, t - last);
		maxCpuGap = Math.max(maxCpuGap, cpu - lastCpu);
		last = t;
		lastCpu = cpu;
		ticks++;
	}, 20);
	try {
		const started = performance.now();
		const result = await work();
		return {
			result,
			maxGap,
			maxCpuGap,
			ticks,
			ms: performance.now() - started,
		};
	} finally {
		clearInterval(handle);
	}
}

describe("forecast worker runner: off the main thread", () => {
	it("keeps the event loop ticking while the worker spins the CPU for 1.2 s", async () => {
		const { result, maxGap, maxCpuGap, ticks, ms } = await maxTickGap(() =>
			createPaceRefitRunner(fixtureRunner()).run(
				series("busy:1200"),
				T0,
				DEMAND,
				{
					timeoutMs: 10_000,
				},
			),
		);
		expect((result as { status: string }).status).toBe("ok");
		expect(ms).toBeGreaterThanOrEqual(1_200);
		console.info(
			`[worker runner] busy worker: longest slice wall ${maxGap.toFixed(1)} ms cpu ${maxCpuGap.toFixed(1)} ms, ${ticks} ticks`,
		);
		expect(ticks).toBeGreaterThanOrEqual(30);
		expect(maxCpuGap).toBeLessThan(250);
	});
});
