import { describe, expect, test } from "bun:test";
import { localDayStart } from "../../time";
import type {
	ForecastBlock,
	ForecastInput,
	ForecastResponse,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { poolFor } from "../days";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { EngineContext } from "../model";
import { planForecast } from "../planner";
import { buildResponse } from "../response";
import {
	buildInput,
	DEFAULT_FAN_LEVELS,
	prague,
	replayFixture,
	TZ,
} from "./fixtures-engine";
import { measureYield } from "./fixtures-sim";

const engine = createForecastEngine();

function lines(block: ForecastBlock): { level: number; values: number[] }[] {
	return [
		{ level: 10, values: block.light },
		{ level: 50, values: block.typical },
		{ level: 90, values: block.heavy },
		...Object.entries(block.fan).map(([key, values]) => ({
			level: Number(key.slice(1)),
			values,
		})),
	].sort((a, b) => a.level - b.level);
}

async function computed(input: ForecastInput): Promise<ForecastResponse> {
	const result = await engine.compute(input);
	if (!result.available) throw new Error(result.reason);
	return result.response;
}

async function contextOf(
	input: ForecastInput,
	noise: boolean,
): Promise<EngineContext> {
	const ctx = await prepareEngineContext(input, { noise });
	if (ctx === "insufficient_history") throw new Error("no forecast");
	return ctx;
}

function expectNoForecast(
	result: Awaited<ReturnType<typeof engine.compute>>,
	reason: "insufficient_history" | "error",
) {
	expect(result.available).toBe(false);
	if (result.available) return;
	expect(result.reason).toBe(reason);
	expect(result.plan).toBeNull();
	expect(result.response.available).toBe(false);
	expect(result.response.reason).toBe(reason);
	expect(result.response.day).toBeNull();
	expect(result.response.week).toBeNull();
}

describe("insufficient history through compute()", () => {
	test("fewer than 5 recorded days", async () => {
		expectNoForecast(
			await engine.compute(buildInput(replayFixture({ historyDays: 4 }))),
			"insufficient_history",
		);
	});

	test("today's pool under 3 days: a Saturday with one recorded weekend day", async () => {
		const input = buildInput(
			replayFixture({ now: prague(14, 7), historyDays: 6 }),
		);
		expectNoForecast(await engine.compute(input), "insufficient_history");
	});

	test("no counted account", async () => {
		const input = buildInput(replayFixture());
		input.accounts = input.accounts.map((a) => ({ ...a, counted: false }));
		expectNoForecast(await engine.compute(input), "insufficient_history");
		const result = await engine.compute(input);
		expect(result.response.accounts).toEqual([]);
	});

	test("no calibration: no readings", async () => {
		const input = buildInput(replayFixture());
		input.readings = [];
		const result = await engine.compute(input);
		expectNoForecast(result, "insufficient_history");
		expect(result.response.accounts).toEqual(["acct-a", "acct-b"]);
	});

	test("empty arrays everywhere", async () => {
		const input = buildInput(replayFixture());
		Object.assign(input, {
			accounts: [],
			history: [],
			accountHistory: [],
			readings: [],
			sessions: [],
		});
		expectNoForecast(await engine.compute(input), "insufficient_history");
	});
});

describe("compute() never throws", () => {
	const cases: [string, (input: ForecastInput) => void][] = [
		["now NaN", (i) => Object.assign(i, { now: Number.NaN })],
		[
			"usedPct NaN",
			(i) => {
				const [first] = i.accounts;
				if (first) first.fiveHour.usedPct = Number.NaN;
			},
		],
		["history not an array", (i) => Object.assign(i, { history: null })],
		["settings missing", (i) => Object.assign(i, { settings: undefined })],
		[
			"unknown time zone",
			(i) => {
				i.pace.timeZone = "Nowhere/Nothing";
			},
		],
		[
			"zero simulated days",
			(i) => {
				i.settings.simulatedDays = 0;
			},
		],
		[
			"a getter that throws",
			(i) => {
				Object.defineProperty(i, "readings", {
					get() {
						throw new Error("boom-secret-detail");
					},
				});
			},
		],
	];
	for (const [name, mutate] of cases) {
		test(name, async () => {
			const input = buildInput(replayFixture());
			mutate(input);
			const result = await engine.compute(input);
			expectNoForecast(result, "error");
			expect(JSON.stringify(result)).not.toContain("boom");
		});
	}

	test("accounts behind a throwing getter still give the spec's no-forecast shape", async () => {
		const input = buildInput(replayFixture());
		Object.defineProperty(input, "accounts", {
			get() {
				throw new Error("boom");
			},
		});
		const result = await engine.compute(input);
		expectNoForecast(result, "error");
		expect(result.response.accounts).toEqual([]);
		expect(result.response.computedAt).toBe(prague(12, 7));
	});
});

describe("determinism", () => {
	test("same input, same output", async () => {
		const a = await computed(buildInput(replayFixture()));
		const b = await computed(buildInput(replayFixture()));
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test("another local day draws differently", async () => {
		const ctxA = await contextOf(buildInput(replayFixture()), true);
		const input = buildInput(replayFixture());
		const later = buildInput(replayFixture({ now: prague(13, 7) }));
		later.history = input.history;
		later.historyFrom = input.historyFrom;
		const ctxB = await contextOf(later, true);
		const [a] = ctxA.scenarios.units;
		const [b] = ctxB.scenarios.units;
		if (!a || !b) throw new Error("no simulated days");
		const shift = (ctxB.scenarios.start - ctxA.scenarios.start) / BUCKET_MS;
		let differ = 0;
		for (let i = 0; i < 288; i++) if (a[i + shift] !== b[i]) differ++;
		expect(differ).toBeGreaterThan(0);
	});
});

describe("response shape (spec sections 3 to 6) on a real compute", () => {
	test("41 lines ordered at every index for day and week, rounded to one decimal", async () => {
		const response = await computed(buildInput(replayFixture()));
		for (const block of [response.day, response.week]) {
			expect(block).not.toBeNull();
			const all = lines(block as ForecastBlock);
			expect(all).toHaveLength(41);
			expect(all.map((l) => l.level)).toEqual(
				[10, 50, 90, ...DEFAULT_FAN_LEVELS].sort((a, b) => a - b),
			);
			const n = (block as ForecastBlock).times.length;
			for (const line of all) {
				expect(line.values).toHaveLength(n);
				for (const v of line.values) {
					expect(Math.round(v * 10) / 10).toBe(v);
				}
			}
			for (let i = 0; i < n; i++) {
				for (let j = 1; j < all.length; j++) {
					expect(all[j]?.values[i] ?? Number.NaN).toBeLessThanOrEqual(
						all[j - 1]?.values[i] ?? Number.NaN,
					);
				}
			}
		}
	});

	test("times ascending, jumps twice, past series paired, fable per account", async () => {
		const response = await computed(buildInput(replayFixture()));
		expect(response.available).toBe(true);
		expect(response.reason).toBeNull();
		expect(response.accounts).toEqual(["acct-a", "acct-b"]);
		expect(response.levels).toEqual({ light: 10, typical: 50, heavy: 90 });
		expect(Object.keys(response.fable).sort()).toEqual(["acct-a", "acct-b"]);
		const day = response.day as ForecastBlock;
		const week = response.week as ForecastBlock;
		for (const block of [day, week]) {
			for (let i = 1; i < block.times.length; i++) {
				expect(block.times[i] ?? Number.NaN).toBeGreaterThanOrEqual(
					block.times[i - 1] ?? Number.NaN,
				);
			}
			expect(block.past.times).toHaveLength(block.past.values.length);
		}
		expect(day.times.filter((t) => t === prague(12, 11))).toHaveLength(2);
		expect(week.times.filter((t) => t === prague(15, 15))).toHaveLength(2);
		expect(week.times.at(-1)).toBe(prague(17, 3));
	});
});

describe("smoothed bootstrap through the engine", () => {
	test("noise off: compute equals the stages run by hand, and every later-date day is one recorded day", async () => {
		const input = buildInput(replayFixture());
		const result = await createForecastEngine({ noise: false }).compute(input);
		if (!result.available) throw new Error(result.reason);

		const ctx = await contextOf(input, false);
		const { result: sim } = await planForecast(ctx);
		expect(JSON.stringify(result.response)).toBe(
			JSON.stringify(buildResponse(ctx, sim)),
		);

		const tomorrow = localDayStart(prague(13, 12), TZ);
		const offset = (tomorrow - ctx.scenarios.start) / BUCKET_MS;
		const pool = poolFor(ctx.table, "workday");
		const matches = (day: Float32Array) =>
			pool.some((rec) =>
				rec.units.every(
					(u, i) =>
						Math.abs(u - (day[offset + i] ?? Number.NaN)) <= 1e-5 * (1 + u),
				),
			);
		expect(ctx.scenarios.units.every(matches)).toBe(true);

		const noisy = await contextOf(input, true);
		expect(noisy.scenarios.units.every(matches)).toBe(false);
	});
});

describe("cost", () => {
	test("yields to the event loop; no synchronous slice much longer than 25 ms", async () => {
		const input = buildInput(replayFixture());
		const { value, longestMs, turns, wallMs } = await measureYield(() =>
			engine.compute(input),
		);
		expect(value.available).toBe(true);
		console.info(
			`[engine] compute: wall ${wallMs.toFixed(0)} ms, longest slice ${longestMs.toFixed(1)} ms, ${turns} event-loop turns`,
		);
		expect(turns).toBeGreaterThan(20);
		// design target about 25 ms; slack for a loaded test machine
		expect(longestMs).toBeLessThan(40);
	});

	test("REPORT: median wall time and response sizes", async () => {
		const input = buildInput(replayFixture());
		const times: number[] = [];
		for (let i = 0; i < 7; i++) {
			const t = performance.now();
			await engine.compute(input);
			times.push(performance.now() - t);
		}
		times.sort((a, b) => a - b);
		const replayBytes = JSON.stringify(await computed(input)).length;
		const monday = buildInput(
			replayFixture({
				now: prague(16, 7),
				weeklyReset: { a: prague(22, 15), b: prague(17, 3) },
				fiveHour: {
					a: { usedPct: 0, resetsAt: null },
					b: { usedPct: 0, resetsAt: null },
				},
			}),
		);
		const mondayResponse = await computed(monday);
		const mondayBytes = JSON.stringify(mondayResponse).length;
		console.info(
			`[engine] REPORT median compute ${times[3]?.toFixed(0)} ms (runs ${times.map((t) => t.toFixed(0)).join(",")}); response bytes: replay ${replayBytes}, Monday 07:00 ${mondayBytes}`,
		);
		expect(mondayResponse.week?.times.at(-1)).toBe(prague(22, 15));
	});
});
