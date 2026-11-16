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
	/**
	 * Bands without a selection whose best candidate passed every screening test but the evidence
	 * floor (BH at q and positive out-of-fold R^2, with fewer independent units than the floor),
	 * one entry per hour cell of the band that passes the per-cell gate (positive out-of-fold
	 * R^2) with that candidate: the cells that would switch on by themselves once enough units
	 * accrue with the same result; that is not a promise.
	 */
	belowFloor: {
		band: string;
		feature: string;
		units: number;
		/** The hour cell: target day type and origin hour (local). */
		dayType: PaceDayTypeName;
		hour: number;
	}[];
	/** Slot means (288 local five-minute slots) per served day type, from the complete days before the fit. */
	baseline: Record<PaceDayTypeName, number[]>;
	/** Per band in PACE_BANDS order: the pooled selection and its established hour cells. */
	bands: PaceBandFit[];
	/** One selection per band, pooled over day types; null = plain line. */
	selected: { band: string; feature: string | null }[];
	dayTypeComparison: {
		partition: string;
		groups: number;
		loss: number;
		se: number;
	}[];
}

export type PaceDayTypeName = "workday" | "monday" | "weekend";

/**
 * One generated candidate as plain data (the apply path evaluates it).
 * R: rolling span of `len` buckets ending `end` buckets before now. S: the
 * target's span `k` days earlier. C: local calendar day `k` back (0 = so far).
 * D: the last complete weekday `wd` (0 = Monday). W: the last complete ISO
 * week, all days or its Tue-Fri days. T: the target span's share of weekday
 * `wd` or of local clock hour `hour`. `long`: evidence counted in ISO weeks.
 */
export interface PaceCandidate {
	id: string;
	family: "R" | "S" | "C" | "D" | "W" | "T";
	long: boolean;
	len?: number;
	end?: number;
	k?: number;
	wd?: number;
	hour?: number;
	workdays?: boolean;
}

/** An established hour cell: band x target day type x origin hour; m = exp(coef * (clip(x, lo, hi) - mean) / sd). */
export interface PaceCellFit {
	dayType: PaceDayTypeName;
	hour: number;
	lambda: number;
	/** Out-of-fold R^2 of the cell against its own mean (> 0, else the cell is not kept). */
	r2: number;
	mean: number;
	sd: number;
	lo: number;
	hi: number;
	coef: number;
	y0: number;
	rows: number;
}

export interface PaceBandFit {
	band: string;
	feature: PaceCandidate | null;
	/** Blocked-CV gain of the feature over no feature, in standard errors, and the independent units behind it. */
	gainSE: number | null;
	units: number | null;
	cells: PaceCellFit[];
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
