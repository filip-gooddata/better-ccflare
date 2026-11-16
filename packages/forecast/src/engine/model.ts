/**
 * Internal data shapes shared by the engine's parts (demand model, simulation
 * and planner, response builder). Not part of the public contract.
 */
import type {
	AccountId,
	AccountLimits,
	Calibration,
	EpochMs,
	ForecastInput,
	ForecastInputsDetail,
} from "../types";
import type { PaceNow } from "./pace";

export type DayType = "workday" | "monday" | "weekend";

/** One complete recorded local day. */
export interface RecordedDay {
	/** localDayKey of the day. */
	key: string;
	/** Local midnight. */
	start: EpochMs;
	type: DayType;
	/** Recency weight 0.5^(age in days / historyHalfLifeDays). */
	weight: number;
	/** Demand units per BUCKET_MS bucket from local midnight; length = day length / BUCKET_MS (DST days differ). */
	units: Float64Array;
	/** Fable part of `units`, same layout. */
	fable: Float64Array;
	total: number;
	fableTotal: number;
}

/** Today (incomplete, never in a pool): its key and day type. */
export interface TodaySoFar {
	key: string;
	/** Local midnight. */
	start: EpochMs;
	type: DayType;
}

export interface DayTable {
	/** Complete recorded days inside the lookback and [historyFrom, today 00:00), ascending. */
	days: RecordedDay[];
	today: TodaySoFar;
}

/** Time limits of the projection. */
export interface Horizon {
	now: EpochMs;
	/** Next local midnight: end of the `day` block. */
	dayEnd: EpochMs;
	/** now + 24 h: end of the 5-minute steps and of the 5-hour score window. */
	fineEnd: EpochMs;
	/** End of the `week` block. */
	weekEnd: EpochMs;
	/** End of the simulation and of the scenarios: the later of fineEnd and weekEnd. */
	simEnd: EpochMs;
}

/**
 * Kernel noise of the smoothed bootstrap. `shrunk` (the default): the variance-preserving
 * shrunk smoothed bootstrap of Silverman and Young (1987). `unshrunk`: plain kernel noise
 * exp(hε), which widens the variance of log totals to s² + h² (kept for measurement).
 * `off`: plain resampling, no scale or time noise.
 */
export type NoiseMode = "shrunk" | "unshrunk" | "off";

/** Engine options choosing the kernel noise; `noiseMode` wins over `noise` (true or absent = shrunk, false = off). */
export interface NoiseOptions {
	noise?: boolean;
	noiseMode?: NoiseMode;
}

/**
 * Demand of every simulated day (smoothed bootstrap of whole recorded days,
 * today's pace multiplier already applied), per BUCKET_MS bucket.
 */
export interface Scenarios {
	/** bucketStart(now): bucket 0 contains now and holds its full-bucket demand. */
	start: EpochMs;
	/** Buckets from `start` up to and including the one containing horizon.simEnd - 1. */
	bucketCount: number;
	/** One array per simulated day, length bucketCount. */
	units: Float32Array[];
	fable: Float32Array[];
	diagnostics: {
		/** Kernel noise on (shrunk or unshrunk); false is plain resampling. */
		noise: boolean;
		noiseMode: NoiseMode;
		/** Scale bandwidth h per pool used, keyed by the date it served ("YYYY-MM-DD"). */
		bandwidths: Record<string, number>;
		/** Today's pace (E4) whose multipliers scaled the buckets. */
		pace: PaceNow;
	};
}

/** Everything the planner and the response builder need. */
export interface EngineContext {
	input: ForecastInput;
	now: EpochMs;
	timeZone: string;
	/** Counted accounts, in input order. Account index = position here. */
	accounts: AccountLimits[];
	horizon: Horizon;
	table: DayTable;
	/** Every counted account has a 5-hour and a weekly k (availability guarantees it). */
	calibration: Calibration;
	scenarios: Scenarios;
	workStartMinute: number | null;
	/** What the forecast was computed from, for the service's log (amendment 4, D2). */
	inputs?: ForecastInputsDetail;
}

/**
 * The planner's score S of the chosen plan and of on demand, in points (design amendment 5, E5).
 * The engine adds them to the inputs detail for the service's log line only; the HTTP response
 * never carries them.
 */
export interface PlanLowPoints {
	lowPoint: number;
	lowPointOnDemand: number;
}

/**
 * Shared time axis of one simulation run. Starts at now; then every 5 minutes on
 * the clock to horizon.fineEnd, then every full hour to horizon.simEnd (both
 * ends included, simEnd even when not on the hour); plus every deterministic jump time (a reset of a window open now, a
 * weekly reset, the reset of a pre-warm opening), which appears twice: the value
 * before and the value after.
 */
export interface SampleAxis {
	times: EpochMs[];
}

export type OutLimit = "five_hour" | "seven_day";

/** One simulated day run under one plan, sampled on the SampleAxis. */
export interface SimTrace {
	/** Pooled 5-hour quota left (points, 0..100·accounts) per sample. */
	day: Float32Array;
	/** Pooled weekly quota left per sample. */
	week: Float32Array;
	/** Demand units that could not be served in (times[i-1], times[i]]; index 0 is 0. */
	unserved: Float32Array;
	/** Accounts running out, in time order (fill time interpolated to the minute). */
	outs: { account: number; at: EpochMs; limit: OutLimit }[];
	/** Per account index: when its Fable use reached 100, or null (also null without a Fable k). */
	fableOutAt: (EpochMs | null)[];
	/** 5-hour windows opening (by demand or by pre-warm), in time order. */
	opens: { account: number; at: EpochMs }[];
}

export interface SimulationResult {
	axis: SampleAxis;
	/** Same order as EngineContext.accounts. */
	accounts: AccountId[];
	traces: SimTrace[];
}
