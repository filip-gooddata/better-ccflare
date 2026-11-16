import type {
	AccountId,
	DemandBucket,
	EpochMs,
	LimitReading,
} from "../../types";

/**
 * E4, today's pace in the projection (DESIGN-E4). The refit runs in a worker;
 * the state it returns is plain data, safe for structured clone and swapped in
 * whole. Applying a state to today's usage runs on the caller's thread and is cheap.
 */

/** Five-minute pooled demand and its censoring, from `start` (bucket-aligned) for `units.length` buckets. */
export interface PaceSeries {
	start: EpochMs;
	/** Weighted demand units per bucket; a bucket absent from history is 0. */
	units: Float64Array;
	/** 1 where every account was at or above the censoring threshold on a limit window. */
	censored: Uint8Array;
	timeZone: string;
}

export interface PaceSeriesInput {
	history: DemandBucket[];
	historyFrom: EpochMs;
	now: EpochMs;
	readings: LimitReading[];
	accounts: AccountId[];
	timeZone: string;
}

/** Distance band ahead of now, in minutes: [fromMin, toMin), centre is the midpoint. */
export interface PaceBand {
	id: string;
	fromMin: number;
	toMin: number;
	centreMin: number;
}

/**
 * The fitted model. Plain data only (numbers, strings, arrays, records):
 * it crosses a worker boundary. The fields below are the ones the service and
 * the log need; the model may add more.
 */
export interface PaceFitState {
	fittedAt: EpochMs;
	/** Whole training days and ISO weeks the fit saw. */
	days: number;
	weeks: number;
	/** Candidate count m and evidence floor ceil(log2(m / q)). */
	candidates: number;
	floor: number;
	/** Selection cells (band x hour per day type) with an established feature, and all cells. */
	cellsEstablished: number;
	cellsTotal: number;
	/** Cells whose best candidate passed every test except the evidence floor: they switch on by themselves as units accrue. */
	belowFloor: { band: string; feature: string; units: number }[];
	/** One selection per band, pooled over day types; null = plain line. */
	selected: { band: string; feature: string | null }[];
}

/** E4 applied at an instant. */
export interface PaceNow {
	status: "fitted" | "unfitted" | "off";
	fittedAt: EpochMs | null;
	bands: {
		band: string;
		centreMin: number;
		/** Multiplier at the band centre now; 1 = plain line. */
		m: number;
		feature: string | null;
		/** Today's feature as a ratio to its baseline, and the coefficient on its standardised value. */
		ratio: number | null;
		coef: number | null;
		clipped: boolean;
		lambda: number | null;
	}[];
}
