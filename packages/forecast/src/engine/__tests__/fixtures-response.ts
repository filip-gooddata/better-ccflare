/**
 * Synthetic fixtures for the response builder tests: an EngineContext and a
 * SimulationResult built directly, without the demand or simulation parts.
 */
import type {
	AccountLimits,
	Calibration,
	EpochMs,
	ForecastInput,
	ForecastSettings,
	LimitReading,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { computeHorizon } from "../horizon";
import type {
	EngineContext,
	OutLimit,
	SampleAxis,
	SimTrace,
	SimulationResult,
} from "../model";

export const TZ = "Europe/Prague";
export const HOUR = 3_600_000;
export const MIN = 60_000;
/** Thursday 2026-11-12 13:20 CET, the spec's example state. */
export const NOW = Date.UTC(2026, 10, 12, 12, 20);
/** Thursday 2026-11-12 00:00 CET. */
export const MIDNIGHT = Date.UTC(2026, 10, 11, 23, 0);
/** Monday 2026-11-09 00:00 CET. */
export const MONDAY = Date.UTC(2026, 10, 8, 23, 0);

export const DEFAULT_FAN = [
	...Array.from({ length: 19 }, (_, i) => 12 + 2 * i),
	...Array.from({ length: 19 }, (_, i) => 52 + 2 * i),
];

export function settings(
	overrides: Partial<ForecastSettings> = {},
): ForecastSettings {
	return {
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 2,
		simulatedDays: 400,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: DEFAULT_FAN,
		minStopPoints: 1,
		moveMinGainPoints: 5,
		openMinGainPoints: 5,
		historyHalfLifeDays: 14,
		historyLookbackDays: 90,
		recentTauMin: 60,
		sessionTurnoverMin: 60,
		workStartSharePct: 5,
		...overrides,
	};
}

export function account(
	id: string,
	parts: Partial<AccountLimits> = {},
): AccountLimits {
	return {
		accountId: id,
		name: id,
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 0, resetsAt: Date.UTC(2026, 10, 16, 8) },
		fable: null,
		blockedUntil: null,
		readAt: NOW,
		...parts,
	};
}

/**
 * The sample axis as model.ts defines it: now, every 5 minutes on the clock to
 * fineEnd, every full hour to simEnd (simEnd included), every jump time twice.
 */
export function makeAxis(
	now: EpochMs,
	fineEnd: EpochMs,
	simEnd: EpochMs,
	jumps: EpochMs[] = [],
): SampleAxis {
	const set = new Set<EpochMs>([now]);
	for (
		let t = Math.ceil((now + 1) / BUCKET_MS) * BUCKET_MS;
		t <= fineEnd;
		t += BUCKET_MS
	)
		set.add(t);
	set.add(fineEnd);
	for (let t = Math.ceil((fineEnd + 1) / HOUR) * HOUR; t < simEnd; t += HOUR)
		set.add(t);
	set.add(simEnd);
	for (const j of jumps) set.add(j);
	const times: EpochMs[] = [];
	for (const t of [...set].sort((a, b) => a - b)) {
		times.push(t);
		if (jumps.includes(t)) times.push(t);
	}
	return { times };
}

export interface CtxOptions {
	now?: EpochMs;
	accounts?: AccountLimits[];
	readings?: LimitReading[];
	settings?: Partial<ForecastSettings>;
	calibration?: Partial<Calibration>;
}

export function makeCtx(options: CtxOptions = {}): EngineContext {
	const now = options.now ?? NOW;
	const accounts = options.accounts ?? [account("acct-a"), account("acct-b")];
	const input: ForecastInput = {
		now,
		settings: settings(options.settings),
		pace: { timeZone: TZ, workDays: 5, fiveHourGuardPct: 90, idleMs: 0 },
		accounts,
		history: [],
		historyFrom: 0,
		accountHistory: [],
		readings: options.readings ?? [],
		sessions: [],
	};
	const ids = accounts.map((a) => a.accountId);
	const perId = (k: number) => Object.fromEntries(ids.map((id) => [id, k]));
	return {
		input,
		now,
		timeZone: TZ,
		accounts,
		horizon: computeHorizon(now, accounts, TZ),
		table: {
			days: [],
			today: {
				key: "2026-11-12",
				start: MIDNIGHT,
				type: "workday",
				unitsSoFar: 0,
				recentRate: 0,
				recentFableRate: 0,
			},
		},
		calibration: {
			fiveHour: perId(2),
			weekly: perId(0.5),
			fable: Object.fromEntries(ids.map((id) => [id, null])),
			...options.calibration,
		},
		scenarios: {
			start: now,
			bucketCount: 0,
			units: [],
			fable: [],
			diagnostics: {
				noise: true,
				noiseMode: "shrunk",
				bandwidths: {},
				dayFactor: 1,
				recentRate: 0,
			},
		},
		workStartMinute: null,
	};
}

export interface TraceSpec {
	day: (t: EpochMs, i: number) => number;
	week?: (t: EpochMs, i: number) => number;
	/** Units unserved in (times[i-1], times[i]]. */
	unserved?: (t: EpochMs, i: number) => number;
	outs?: { account: number; at: EpochMs; limit: OutLimit }[];
	fableOutAt?: (EpochMs | null)[];
}

export function makeTrace(axis: SampleAxis, spec: TraceSpec): SimTrace {
	const n = axis.times.length;
	const day = new Float32Array(n);
	const week = new Float32Array(n);
	const unserved = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = axis.times[i];
		day[i] = spec.day(t, i);
		week[i] = spec.week ? spec.week(t, i) : 150;
		unserved[i] = i === 0 || !spec.unserved ? 0 : spec.unserved(t, i);
	}
	return {
		day,
		week,
		unserved,
		outs: spec.outs ?? [],
		fableOutAt: spec.fableOutAt ?? [null, null],
	};
}

export function makeSim(
	ctx: EngineContext,
	axis: SampleAxis,
	traces: SimTrace[],
): SimulationResult {
	return { axis, accounts: ctx.accounts.map((a) => a.accountId), traces };
}

export function defaultAxis(ctx: EngineContext, jumps: EpochMs[] = []) {
	return makeAxis(ctx.now, ctx.horizon.fineEnd, ctx.horizon.simEnd, jumps);
}

/** Deterministic pseudo-random numbers in [0, 1) for fixtures (mulberry32). */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The 41 default level lines of a block, in ascending level order. */
export function blockLines(block: {
	light: number[];
	typical: number[];
	heavy: number[];
	fan: Record<string, number[]>;
}): { level: number; values: number[] }[] {
	const lines = [
		{ level: 10, values: block.light },
		{ level: 50, values: block.typical },
		{ level: 90, values: block.heavy },
		...Object.entries(block.fan).map(([key, values]) => ({
			level: Number(key.slice(1)),
			values,
		})),
	];
	return lines.sort((a, b) => a.level - b.level);
}
