/**
 * Synthetic engine contexts for the simulation and planner tests: scenarios are built directly
 * (no demand model), demand is given per local clock time in units per minute.
 */
import { localParts } from "../../time";
import type {
	AccountLimits,
	EpochMs,
	ForecastSettings,
	LiveSession,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { bucketStart } from "../../units";
import { computeHorizon } from "../horizon";
import type { EngineContext } from "../model";
import { plainPace } from "../pace";

export const TZ = "Europe/Prague";
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** Local Prague wall time on 2026-11-12 (CET, UTC+1) and the following days. */
export function prague(
	day: number,
	hour: number,
	minute = 0,
	second = 0,
): EpochMs {
	return Date.UTC(2026, 10, day, hour - 1, minute, second);
}

export function settings(
	over: Partial<ForecastSettings> = {},
): ForecastSettings {
	return {
		enabled: true,
		routing: true,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 2,
		simulatedDays: 400,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: [],
		minStopPoints: 1,
		moveMinGainPoints: 2,
		openMinGainPoints: 1,
		historyHalfLifeDays: 14,
		historyLookbackDays: 56,
		recentTauMin: 45,
		sessionTurnoverMin: 60,
		workStartSharePct: 5,
		paceConditioning: true,
		...over,
	};
}

export interface AccountSpec {
	id: string;
	fiveUsed?: number;
	fiveReset?: EpochMs | null;
	weekUsed?: number;
	weekReset?: EpochMs | null;
	fableUsed?: number;
	fableReset?: EpochMs | null;
	blockedUntil?: EpochMs | null;
	blockedSince?: EpochMs | null;
}

export function account(spec: AccountSpec): AccountLimits {
	return {
		accountId: spec.id,
		name: spec.id,
		counted: true,
		fiveHour: { usedPct: spec.fiveUsed ?? 0, resetsAt: spec.fiveReset ?? null },
		weekly: { usedPct: spec.weekUsed ?? 0, resetsAt: spec.weekReset ?? null },
		fable:
			spec.fableUsed === undefined
				? null
				: { usedPct: spec.fableUsed, resetsAt: spec.fableReset ?? null },
		blockedUntil: spec.blockedUntil ?? null,
		blockedSince: spec.blockedSince ?? null,
		readAt: 0,
	};
}

export function session(
	over: Partial<LiveSession> & { sessionId: string; accountId: string },
): LiveSession {
	return {
		family: "opus",
		lastRequestAt: 0,
		cacheTtlMs: HOUR,
		coldAt: null,
		contextTokens: 100_000,
		recentUnits: 1,
		...over,
	};
}

export interface CtxSpec {
	now: EpochMs;
	accounts: AccountLimits[];
	k5?: Record<string, number>;
	kW?: Record<string, number>;
	kF?: Record<string, number | null>;
	/** Demand units per minute at an instant (local clock via `minuteOfDay`, weekday 1..7). */
	rate: (minuteOfDay: number, isoWeekday: number, at: EpochMs) => number;
	/** Fable share of demand (0..1). */
	fableShare?: number;
	days?: number;
	/** Day s is scaled by 1 - spread + 2·spread·s/(days-1): a deterministic spread of heavier and lighter days. */
	spread?: number;
	sessions?: LiveSession[];
	settings?: Partial<ForecastSettings>;
	workStartMinute?: number | null;
}

export function makeCtx(spec: CtxSpec): EngineContext {
	const s = settings(spec.settings);
	const days = spec.days ?? s.simulatedDays;
	const horizon = computeHorizon(spec.now, spec.accounts, TZ);
	const start = bucketStart(spec.now);
	const bucketCount = Math.floor((horizon.simEnd - 1 - start) / BUCKET_MS) + 1;
	const base = new Float32Array(bucketCount);
	for (let b = 0; b < bucketCount; b++) {
		const at = start + b * BUCKET_MS;
		const parts = localParts(at, TZ);
		base[b] = spec.rate(parts.minuteOfDay, parts.isoWeekday, at) * 5;
	}
	const spread = spec.spread ?? 0;
	const units: Float32Array[] = [];
	const fable: Float32Array[] = [];
	for (let d = 0; d < days; d++) {
		const scale = days > 1 ? 1 - spread + (2 * spread * d) / (days - 1) : 1;
		const u = new Float32Array(bucketCount);
		const f = new Float32Array(bucketCount);
		for (let b = 0; b < bucketCount; b++) {
			u[b] = base[b] * scale;
			f[b] = u[b] * (spec.fableShare ?? 0);
		}
		units.push(u);
		fable.push(f);
	}
	const ids = spec.accounts.map((a) => a.accountId);
	const fill = (values: Record<string, number> | undefined, dflt: number) =>
		Object.fromEntries(ids.map((id) => [id, values?.[id] ?? dflt]));
	return {
		input: {
			now: spec.now,
			settings: s,
			pace: {
				timeZone: TZ,
				workDays: 5,
				fiveHourGuardPct: 90,
				idleMs: 5 * MIN,
			},
			accounts: spec.accounts,
			history: [],
			historyFrom: spec.now - 30 * 24 * HOUR,
			accountHistory: [],
			readings: [],
			sessions: spec.sessions ?? [],
		},
		now: spec.now,
		timeZone: TZ,
		accounts: spec.accounts,
		horizon,
		table: {
			days: [],
			today: {
				key: "2026-11-12",
				start: prague(12, 0),
				type: "workday",
			},
		},
		calibration: {
			fiveHour: fill(spec.k5, 1),
			weekly: fill(spec.kW, 0.1),
			fable: Object.fromEntries(ids.map((id) => [id, spec.kF?.[id] ?? null])),
		},
		scenarios: {
			start,
			bucketCount,
			units,
			fable,
			diagnostics: {
				noise: false,
				noiseMode: "off",
				bandwidths: {},
				pace: plainPace("unfitted"),
			},
		},
		workStartMinute: spec.workStartMinute ?? null,
	};
}

/** Index of the first sample at `at` (the value before the jump for a jump pair). */
export function indexAt(times: EpochMs[], at: EpochMs): number {
	const i = times.indexOf(at);
	if (i < 0) throw new Error(`no sample at ${new Date(at).toISOString()}`);
	return i;
}

/** Longest gap between event-loop turns while `work` runs, and the number of turns. */
export async function measureYield<T>(
	work: () => Promise<T>,
): Promise<{ value: T; longestMs: number; turns: number; wallMs: number }> {
	let done = false;
	let last = performance.now();
	let longest = 0;
	let turns = 0;
	const tick = () => {
		const t = performance.now();
		longest = Math.max(longest, t - last);
		last = t;
		turns++;
		if (!done) setImmediate(tick);
	};
	setImmediate(tick);
	const started = performance.now();
	const value = await work();
	const wallMs = performance.now() - started;
	done = true;
	longest = Math.max(longest, performance.now() - last);
	return { value, longestMs: longest, turns, wallMs };
}
