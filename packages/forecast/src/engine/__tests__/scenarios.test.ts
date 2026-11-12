import { describe, expect, test } from "bun:test";
import { interquartileRange, sampleStandardDeviation } from "simple-statistics";
import {
	addLocalDays,
	localDayKey,
	localDayStart,
	localParts,
} from "../../time";
import type {
	AccountLimits,
	DemandBucket,
	EpochMs,
	ForecastInput,
	ForecastSettings,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { buildDayTable, poolFor } from "../days";
import { computeHorizon } from "../horizon";
import type { DayTable, RecordedDay } from "../model";
import {
	buildScenarios,
	DAY_FACTOR_MAX,
	DAY_FACTOR_MIN,
	dayFactor,
	scaleBandwidth,
} from "../scenarios";

const TZ = "Europe/Prague";
// Thursday 2026-11-12 10:00 CET
const NOW = Date.UTC(2026, 10, 12, 9, 0);
const DAY = 86_400_000;

function settings(over: Partial<ForecastSettings> = {}): ForecastSettings {
	return {
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 1,
		simulatedDays: 400,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: [],
		minStopPoints: 1,
		moveMinGainPoints: 1,
		openMinGainPoints: 1,
		historyHalfLifeDays: 14,
		historyLookbackDays: 28,
		recentTauMin: 60,
		sessionTurnoverMin: 60,
		...over,
	};
}

function account(weeklyReset: EpochMs): AccountLimits {
	return {
		accountId: "acct-a",
		name: "a",
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 10, resetsAt: weeklyReset },
		fable: null,
		blockedUntil: null,
		readAt: NOW,
	};
}

/** Work-hours demand, a different level every day and a tiny per-bucket ramp so each recorded day is unique. */
function syntheticHistory(from: EpochMs, to: EpochMs): DemandBucket[] {
	const out: DemandBucket[] = [];
	for (let t = from; t < to; t += BUCKET_MS) {
		const p = localParts(t, TZ);
		const level = 0.004 + 0.002 * ((p.day * 7) % 11);
		const work = p.minuteOfDay >= 8 * 60 && p.minuteOfDay < 18 * 60;
		const units = (work ? level : 0.0002) + p.minuteOfDay * 1e-7;
		out.push({ start: t, units, fableUnits: units * 0.3, requests: 1 });
	}
	return out;
}

function makeInput(
	now: EpochMs,
	over: Partial<ForecastSettings> = {},
): ForecastInput {
	const from = addLocalDays(localDayStart(now, TZ), -35, TZ);
	return {
		now,
		settings: settings(over),
		pace: { timeZone: TZ, workDays: 5, fiveHourGuardPct: 90, idleMs: 0 },
		accounts: [account(now + 7 * DAY)],
		history: syntheticHistory(from, now),
		historyFrom: from,
		accountHistory: [],
		readings: [],
		sessions: [],
	};
}

function poolOfTotals(totals: number[]): RecordedDay[] {
	return totals.map((total, i) => ({
		key: `d${i}`,
		start: 0,
		type: "workday" as const,
		weight: 1,
		units: new Float64Array(288),
		fable: new Float64Array(288),
		total,
		fableTotal: 0,
	}));
}

function normalReference(totals: number[]): number {
	const logs = totals.filter((x) => x > 0).map(Math.log);
	const s = Math.min(
		sampleStandardDeviation(logs),
		interquartileRange(logs) / 1.34,
	);
	return 1.06 * s * logs.length ** -0.2;
}

/** A recorded day's values by local clock slot (5-minute slot of the wall clock); a repeated hour keeps its first pass. */
function clockAligned(d: RecordedDay, values: Float64Array): Float64Array {
	if (values.length === 288) return values;
	const out = new Float64Array(288);
	const seen = new Set<number>();
	for (let i = 0; i < values.length; i++) {
		const slot = Math.floor(
			localParts(d.start + i * BUCKET_MS, TZ).minuteOfDay / 5,
		);
		if (seen.has(slot)) continue;
		seen.add(slot);
		out[slot] = values[i] as number;
	}
	return out;
}

describe("scaleBandwidth", () => {
	test("comes from the data: two pools of different spread, normal-reference rule", () => {
		const narrow = [10, 12, 9, 11, 10, 13, 11];
		const wide = [2, 20, 5, 40, 8, 15, 30];
		const hn = scaleBandwidth(poolOfTotals(narrow));
		const hw = scaleBandwidth(poolOfTotals(wide));
		expect(hn).toBeCloseTo(normalReference(narrow), 12);
		expect(hw).toBeCloseTo(normalReference(wide), 12);
		expect(hw).toBeGreaterThan(hn * 3);
	});

	test("zero-total days are left out; no spread or under 2 days gives 0", () => {
		expect(scaleBandwidth(poolOfTotals([0, 10, 12, 9, 11]))).toBeCloseTo(
			normalReference([10, 12, 9, 11]),
			12,
		);
		expect(scaleBandwidth(poolOfTotals([5, 5, 5, 5]))).toBe(0);
		expect(scaleBandwidth(poolOfTotals([5, 0]))).toBe(0);
		expect(scaleBandwidth([])).toBe(0);
	});

	test("zero IQR with a positive spread falls back to the standard deviation", () => {
		const totals = [5, 5, 5, 5, 5, 5, 50];
		const logs = totals.map(Math.log);
		expect(scaleBandwidth(poolOfTotals(totals))).toBeCloseTo(
			1.06 * sampleStandardDeviation(logs) * logs.length ** -0.2,
			12,
		);
	});
});

describe("dayFactor", () => {
	function flatTable(unitsSoFar: number): {
		table: DayTable;
		pool: RecordedDay[];
	} {
		const todayStart = localDayStart(NOW, TZ);
		const pool: RecordedDay[] = [1, 2, 3, 4, 5].map((i) => ({
			key: `d${i}`,
			start: addLocalDays(todayStart, -i, TZ),
			type: "workday",
			weight: 1 / i,
			units: new Float64Array(288).fill(0.01),
			fable: new Float64Array(288),
			total: 2.88,
			fableTotal: 0,
		}));
		return {
			pool,
			table: {
				days: pool,
				today: {
					key: "2026-11-12",
					start: todayStart,
					type: "workday",
					unitsSoFar,
					recentRate: 0,
					recentFableRate: 0,
				},
			},
		};
	}

	test("a = (Y + c) / (M + c), c a quarter of the weighted mean daily total", () => {
		const { table, pool } = flatTable(2.4);
		// 10:00: M = 120 buckets × 0.01 = 1.2; c = 0.72
		expect(dayFactor(table, pool, NOW, TZ)).toBeCloseTo(3.12 / 1.92, 12);
		// mid-bucket: 10:02:30 → M = 120.5 × 0.01
		expect(dayFactor(table, pool, NOW + 150_000, TZ)).toBeCloseTo(
			3.12 / (1.205 + 0.72),
			12,
		);
	});

	test("clamped to the named range", () => {
		expect(DAY_FACTOR_MIN).toBeLessThan(1);
		expect(DAY_FACTOR_MAX).toBeGreaterThan(1);
		const high = flatTable(100);
		expect(dayFactor(high.table, high.pool, NOW, TZ)).toBe(DAY_FACTOR_MAX);
		const low = flatTable(0);
		// 22:00: M = 2.64, a = 0.72 / 3.36 ≈ 0.21 → clamped
		const late = Date.UTC(2026, 10, 12, 21, 0);
		expect(dayFactor(low.table, low.pool, late, TZ)).toBe(
			Math.max(DAY_FACTOR_MIN, 0.72 / 3.36),
		);
	});

	test("an empty pool gives 1", () => {
		const { table } = flatTable(1);
		expect(dayFactor(table, [], NOW, TZ)).toBe(1);
	});
});

describe("buildScenarios", () => {
	function setup(now: EpochMs, over: Partial<ForecastSettings> = {}) {
		const input = makeInput(now, over);
		const table = buildDayTable(input);
		const horizon = computeHorizon(now, input.accounts, TZ);
		return { input, table, horizon };
	}

	/** [first, end) bucket indices of the local date `key` in the scenarios. */
	function dateRange(
		start: EpochMs,
		key: string,
		dayStart: EpochMs,
	): [number, number] {
		expect(localDayKey(dayStart, TZ)).toBe(key);
		const end = addLocalDays(dayStart, 1, TZ);
		return [(dayStart - start) / BUCKET_MS, (end - start) / BUCKET_MS];
	}

	test("shape, bucket 0 holds now, diagnostics", async () => {
		const { input, table, horizon } = setup(NOW, { simulatedDays: 20 });
		const sc = await buildScenarios(input, table, horizon, { noise: true });
		expect(sc.start).toBe(Math.floor(NOW / BUCKET_MS) * BUCKET_MS);
		expect(sc.bucketCount).toBe(
			Math.floor((horizon.simEnd - 1 - sc.start) / BUCKET_MS) + 1,
		);
		expect(sc.units.length).toBe(20);
		expect(sc.fable.length).toBe(20);
		for (const u of sc.units) expect(u.length).toBe(sc.bucketCount);
		expect(sc.diagnostics.noise).toBe(true);
		expect(sc.diagnostics.recentRate).toBe(table.today.recentRate);
		expect(Object.keys(sc.diagnostics.bandwidths).sort()).toEqual([
			"2026-11-12",
			"2026-11-13",
			"2026-11-14",
			"2026-11-15",
			"2026-11-16",
			"2026-11-17",
			"2026-11-18",
			"2026-11-19",
		]);
		const workPool = poolFor(table, "workday");
		expect(sc.diagnostics.bandwidths["2026-11-13"]).toBeCloseTo(
			scaleBandwidth(workPool),
			12,
		);
		expect(sc.diagnostics.dayFactor).toBeCloseTo(
			dayFactor(table, poolFor(table, "workday"), NOW, TZ),
			12,
		);
		// bucket 0 is 0 minutes ahead: pure last-hour rate
		expect(sc.units[0]?.[0]).toBeCloseTo(table.today.recentRate, 6);
	});

	test("noise off: every later-date simulated day is one recorded day of its pool, bucket for bucket", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 60,
			recentTauMin: 0.001,
		});
		const sc = await buildScenarios(input, table, horizon, { noise: false });
		expect(sc.diagnostics.noise).toBe(false);
		const todayStart = localDayStart(NOW, TZ);
		const checks: [string, number, RecordedDay[]][] = [
			["2026-11-13", 1, poolFor(table, "workday")],
			["2026-11-14", 2, poolFor(table, "weekend")],
			["2026-11-16", 4, poolFor(table, "monday")],
		];
		for (const [key, offset, pool] of checks) {
			const [b0, b1] = dateRange(
				sc.start,
				key,
				addLocalDays(todayStart, offset, TZ),
			);
			const drawn = new Set<string>();
			for (let s = 0; s < sc.units.length; s++) {
				const u = sc.units[s] as Float32Array;
				const f = sc.fable[s] as Float32Array;
				const match = pool.find((d) => {
					const du = clockAligned(d, d.units);
					const df = clockAligned(d, d.fable);
					for (let j = b0; j < b1; j++) {
						if (u[j] !== Math.fround(du[j - b0] as number)) return false;
						if (f[j] !== Math.fround(df[j - b0] as number)) return false;
					}
					return true;
				});
				expect(match).toBeDefined();
				drawn.add((match as RecordedDay).key);
			}
			// resampling, not one fixed day
			expect(drawn.size).toBeGreaterThan(1);
		}
	});

	test("noise on draws the same days as noise off (same random stream), scaled", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 30,
			recentTauMin: 0.001,
			timeShiftMin: 0,
		});
		const off = await buildScenarios(input, table, horizon, { noise: false });
		const on = await buildScenarios(input, table, horizon, { noise: true });
		const [b0, b1] = dateRange(
			off.start,
			"2026-11-13",
			addLocalDays(localDayStart(NOW, TZ), 1, TZ),
		);
		let notOne = 0;
		for (let s = 0; s < 30; s++) {
			const a = off.units[s] as Float32Array;
			const b = on.units[s] as Float32Array;
			const ratio = (b[b0] as number) / (a[b0] as number);
			if (Math.abs(ratio - 1) > 1e-3) notOne++;
			for (let j = b0; j < b1; j++)
				expect((b[j] as number) / (a[j] as number)).toBeCloseTo(ratio, 4);
		}
		expect(notOne).toBeGreaterThan(20);
	});

	test("deterministic for one local day; another local day draws differently", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 40,
			recentTauMin: 0.001,
		});
		const a = await buildScenarios(input, table, horizon, { noise: true });
		const b = await buildScenarios(input, table, horizon, { noise: true });
		expect(b.units).toEqual(a.units);
		expect(b.fable).toEqual(a.fable);
		// same day, an hour later: the same draws for later dates
		const later = setup(NOW + 3_600_000, {
			simulatedDays: 40,
			recentTauMin: 0.001,
		});
		const c = await buildScenarios(later.input, later.table, later.horizon, {
			noise: true,
		});
		const fri = addLocalDays(localDayStart(NOW, TZ), 1, TZ);
		const ia = (fri - a.start) / BUCKET_MS;
		const ic = (fri - c.start) / BUCKET_MS;
		expect(
			Array.from((c.units[7] as Float32Array).subarray(ic, ic + 288)),
		).toEqual(Array.from((a.units[7] as Float32Array).subarray(ia, ia + 288)));
		// another local day key seeds another draw
		const other: DayTable = {
			...table,
			today: { ...table.today, key: "2026-11-13" },
		};
		const d = await buildScenarios(input, other, horizon, { noise: true });
		expect(d.units).not.toEqual(a.units);
	});

	test("today is scaled by the day factor, later dates are not", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 10,
			recentTauMin: 0.001,
		});
		const heavy: DayTable = {
			...table,
			today: { ...table.today, unitsSoFar: table.today.unitsSoFar * 2 },
		};
		const base = await buildScenarios(input, table, horizon, { noise: false });
		const up = await buildScenarios(input, heavy, horizon, { noise: false });
		const ratio = up.diagnostics.dayFactor / base.diagnostics.dayFactor;
		expect(ratio).toBeGreaterThan(1.1);
		// 14:00 today, far beyond τ
		const j = (Date.UTC(2026, 10, 12, 13, 0) - base.start) / BUCKET_MS;
		expect((up.units[0] as Float32Array)[j]).toBeCloseTo(
			((base.units[0] as Float32Array)[j] as number) * ratio,
			6,
		);
		const k = (Date.UTC(2026, 10, 13, 13, 0) - base.start) / BUCKET_MS;
		expect((up.units[0] as Float32Array)[k]).toBe(
			(base.units[0] as Float32Array)[k] as number,
		);
	});

	test("the last-hour blend weights e^(−h/τ)", async () => {
		const tau = 60;
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 3,
			recentTauMin: tau,
		});
		const off = await buildScenarios(input, table, horizon, { noise: false });
		const noBlend = await buildScenarios(
			{
				...input,
				settings: settings({ simulatedDays: 3, recentTauMin: 0.001 }),
			},
			table,
			horizon,
			{ noise: false },
		);
		const r = table.today.recentRate;
		for (const j of [3, 12, 30]) {
			const h = (off.start + j * BUCKET_MS - NOW) / 60_000;
			const w = Math.exp(-h / tau);
			const v = (noBlend.units[1] as Float32Array)[j] as number;
			expect((off.units[1] as Float32Array)[j]).toBeCloseTo(
				w * r + (1 - w) * v,
				6,
			);
		}
	});

	test("a longer horizon leaves the draws of the shared dates unchanged", async () => {
		const input = makeInput(NOW, { simulatedDays: 30, recentTauMin: 0.001 });
		const table = buildDayTable(input);
		const short = computeHorizon(NOW, [account(NOW + 2 * DAY)], TZ);
		const long = computeHorizon(NOW, [account(NOW + 7 * DAY)], TZ);
		expect(long.simEnd).toBeGreaterThan(short.simEnd);
		const a = await buildScenarios(input, table, short, { noise: true });
		const b = await buildScenarios(input, table, long, { noise: true });
		for (let s = 0; s < 30; s++)
			expect(
				Array.from((b.units[s] as Float32Array).subarray(0, a.bucketCount)),
			).toEqual(Array.from(a.units[s] as Float32Array));
	});

	test("a date whose pool is empty draws from all recorded days", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 20,
			recentTauMin: 0.001,
		});
		const noWeekends: DayTable = {
			...table,
			days: table.days.filter((d) => d.type !== "weekend"),
		};
		expect(poolFor(noWeekends, "weekend")).toEqual([]);
		const sc = await buildScenarios(input, noWeekends, horizon, {
			noise: false,
		});
		const sat = addLocalDays(localDayStart(NOW, TZ), 2, TZ);
		const [b0] = dateRange(sc.start, "2026-11-14", sat);
		for (const u of sc.units) {
			const match = noWeekends.days.find((d) =>
				d.units.every((v, i) => u[b0 + i] === Math.fround(v)),
			);
			expect(match).toBeDefined();
		}
	});

	test("time noise shifts the recorded day by whole buckets within ±timeShiftMin", async () => {
		const { input, table, horizon } = setup(NOW, {
			simulatedDays: 60,
			recentTauMin: 0.001,
			timeShiftMin: 30,
		});
		// equal totals: zero scale bandwidth, so only the time shift acts
		const todayStart = localDayStart(NOW, TZ);
		const days: RecordedDay[] = [1, 2, 3, 4, 5, 6, 7].map((back) => {
			const start = addLocalDays(todayStart, -back, TZ);
			const units = new Float64Array(288);
			for (let i = 0; i < 12; i++) units[100 + back * 10 + i] = 1 + i / 100;
			return {
				key: localDayKey(start, TZ),
				start,
				type: "workday",
				weight: 1,
				units,
				fable: new Float64Array(288),
				total: 12.66,
				fableTotal: 0,
			};
		});
		const handmade: DayTable = { days, today: table.today };
		const sc = await buildScenarios(input, handmade, horizon, { noise: true });
		expect(sc.diagnostics.bandwidths["2026-11-13"]).toBe(0);
		const fri = addLocalDays(todayStart, 1, TZ);
		const [b0] = dateRange(sc.start, "2026-11-13", fri);
		const shifts = new Set<number>();
		for (const u of sc.units) {
			let found: number | null = null;
			for (const d of days)
				for (let k = -6; k <= 6 && found === null; k++) {
					let ok = true;
					for (let i = 0; i < 288 && ok; i++) {
						const src = i - k;
						const v = src >= 0 && src < 288 ? (d.units[src] as number) : 0;
						if (u[b0 + i] !== Math.fround(v)) ok = false;
					}
					if (ok) found = k;
				}
			expect(found).not.toBeNull();
			shifts.add(found as number);
		}
		expect(shifts.size).toBeGreaterThan(5);
	});

	test("DST: a 23-hour target date (2026-03-29, Europe/Prague) reads the recorded day by wall clock", async () => {
		const now = Date.UTC(2026, 2, 27, 9, 0);
		const { input, table, horizon } = setup(now, {
			simulatedDays: 20,
			recentTauMin: 0.001,
		});
		const sc = await buildScenarios(input, table, horizon, { noise: false });
		const sun = addLocalDays(localDayStart(now, TZ), 2, TZ);
		const [b0, b1] = dateRange(sc.start, "2026-03-29", sun);
		expect(b1 - b0).toBe(276);
		const pool = poolFor(table, "weekend");
		for (const u of sc.units) {
			const match = pool.find((d) => {
				for (let j = b0; j < b1; j++) {
					const slot = Math.floor(
						localParts(sc.start + j * BUCKET_MS, TZ).minuteOfDay / 5,
					);
					if (u[j] !== Math.fround(d.units[slot] as number)) return false;
				}
				return true;
			});
			expect(match).toBeDefined();
		}
	});

	test("defaults (400 days, a week horizon): wall time and longest slice between yields", async () => {
		const { input, table, horizon } = setup(NOW);
		let last = performance.now();
		let longest = 0;
		let running = true;
		const tick = () => {
			const t = performance.now();
			longest = Math.max(longest, t - last);
			last = t;
			if (running) setImmediate(tick);
		};
		setImmediate(tick);
		const t0 = performance.now();
		const sc = await buildScenarios(input, table, horizon, { noise: true });
		const wall = performance.now() - t0;
		running = false;
		console.log(
			`buildScenarios defaults: ${sc.units.length} days × ${sc.bucketCount} buckets, wall ${wall.toFixed(1)} ms, longest slice ${longest.toFixed(1)} ms`,
		);
		expect(sc.units.length).toBe(400);
		expect(horizon.simEnd - NOW).toBe(7 * DAY);
		expect(longest).toBeLessThan(100);
	});
});
