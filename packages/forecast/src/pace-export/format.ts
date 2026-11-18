import { createHash } from "node:crypto";
import { learnDays } from "../engine/learn/daily";
import type { Partition, RowChoice } from "../engine/learn/types";
import type { PaceSeries } from "../engine/pace/types";
import type { RefitDemandSettings } from "../service/pace-refit-runner";
import { BUCKET_MS, type EpochMs } from "../types";

/**
 * The opt-in pace series export (FORECAST_PACE_SERIES_EXPORT): the pooled series
 * a refit fitted on, so it can be compared offline with a frozen series and the
 * same revision's learners rerun on it. Numbers only; the strings are
 * `revision`, `timeZone`, each day's `date` and the `hash`.
 */
export const PACE_EXPORT_SCHEMA = 1;

export interface PaceExportInput {
	series: PaceSeries;
	now: EpochMs;
	historyFrom: EpochMs;
	accountCount: number;
	settings: RefitDemandSettings;
	/** The stored row-1 choice the main job passes to learnDemand, and the partition pending confirmation; null before any row-1 choice. */
	rowOne: { choice: RowChoice<Partition>; pending: Partition | null } | null;
}

export interface PaceExportDay {
	date: string;
	units: number;
	censoredBuckets: number;
	censored: 0 | 1;
	active: 0 | 1;
}

export interface PaceExportFile {
	schema: typeof PACE_EXPORT_SCHEMA;
	revision: string;
	now: EpochMs;
	historyFrom: EpochMs;
	bucketMs: number;
	timeZone: string;
	accountCount: number;
	settings: RefitDemandSettings;
	rowOne: { choice: ExportedRowChoice; pending: number[] | null } | null;
	buckets: { start: EpochMs; units: number[]; censored: number[] };
	days: PaceExportDay[];
	hash: string;
}

/** The only row a stored row-1 choice comes from. */
export const ROW_ONE = "daytypes";
/** `RowChoice.reason`, stored as its index here. */
export const ROW_REASONS: readonly RowChoice<unknown>["reason"][] = [
	"on",
	"present-best",
	"below-floor",
	"gain-le-se",
	"bh",
	"no-units",
];

/** A row-1 `RowChoice` as numbers: NaN as null, `on` as 0|1, `reason` as its ROW_REASONS index; `row` is always ROW_ONE. */
export interface ExportedRowChoice {
	m: number;
	floor: number;
	units: number;
	present: number[];
	chosen: number[];
	runnerUp: number[] | null;
	served: number[];
	presentLoss: number | null;
	chosenLoss: number | null;
	gain: number | null;
	se: number | null;
	p: number | null;
	on: 0 | 1;
	reason: number;
}

const nanToNull = (x: number): number | null => (Number.isNaN(x) ? null : x);

export function encodeRowChoice(c: RowChoice<Partition>): ExportedRowChoice {
	const reason = ROW_REASONS.indexOf(c.reason);
	if (c.row !== ROW_ONE || reason < 0) throw new PaceExportError("rowone");
	return {
		m: c.m,
		floor: c.floor,
		units: c.units,
		present: Array.from(c.present),
		chosen: Array.from(c.chosen),
		runnerUp: c.runnerUp ? Array.from(c.runnerUp) : null,
		served: Array.from(c.served),
		presentLoss: nanToNull(c.presentLoss),
		chosenLoss: nanToNull(c.chosenLoss),
		gain: nanToNull(c.gain),
		se: nanToNull(c.se),
		p: nanToNull(c.p),
		on: c.on ? 1 : 0,
		reason,
	};
}

/**
 * Canonical form the hash covers: JSON with every object's keys sorted by code
 * unit, no whitespace, numbers as JSON.stringify writes them (shortest
 * round-trip form). The file itself is written in this form.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.keys(value)
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** SHA-256 hex of the canonical form of the file without its `hash` field. */
export function paceExportHash(body: object): string {
	const { hash: _omit, ...rest } = body as Record<string, unknown>;
	return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

function assertFinite(value: unknown): void {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new PaceExportError("nonfinite");
	} else if (Array.isArray(value)) for (const v of value) assertFinite(v);
	else if (value !== null && typeof value === "object")
		for (const v of Object.values(value)) assertFinite(v);
}

/** A failure with a short code safe to log (no path, no message text). */
export class PaceExportError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** The settings the learners read, picked field by field so nothing else leaks into the file. */
export function pickSettings(s: RefitDemandSettings): RefitDemandSettings {
	return {
		workDays: s.workDays,
		historyLookbackDays: s.historyLookbackDays,
		historyHalfLifeDays: s.historyHalfLifeDays,
		workStartSharePct: s.workStartSharePct,
		timeShiftMin: s.timeShiftMin,
	};
}

function localDate(timeZone: string): (ms: EpochMs) => string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return (ms) => {
		const parts = fmt.formatToParts(ms);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
		return `${get("year")}-${get("month")}-${get("day")}`;
	};
}

/** Per local learn day of the series, as `learnDays` cuts them. */
export function exportDays(
	series: PaceSeries,
	now: EpochMs,
	workDays: number,
): PaceExportDay[] {
	const dateOf = localDate(series.timeZone);
	return learnDays(series, now, workDays).map((d) => {
		const first = (d.startMs - series.start) / BUCKET_MS;
		let censoredBuckets = 0;
		for (let i = 0; i < d.curve.length; i++)
			if (series.censored[first + i]) censoredBuckets++;
		return {
			date: dateOf(d.startMs),
			units: d.total,
			censoredBuckets,
			censored: d.censored ? 1 : 0,
			active: d.active ? 1 : 0,
		};
	});
}

/** Builds the file synchronously; the arrays are copies, so the caller may transfer the series buffers afterwards. */
export function buildPaceExport(
	input: PaceExportInput,
	revision: string,
): PaceExportFile {
	const settings = pickSettings(input.settings);
	const { series } = input;
	const body: Omit<PaceExportFile, "hash"> = {
		schema: PACE_EXPORT_SCHEMA,
		revision,
		now: input.now,
		historyFrom: input.historyFrom,
		bucketMs: BUCKET_MS,
		timeZone: series.timeZone,
		accountCount: input.accountCount,
		settings,
		rowOne: input.rowOne
			? {
					choice: encodeRowChoice(input.rowOne.choice),
					pending: input.rowOne.pending
						? Array.from(input.rowOne.pending)
						: null,
				}
			: null,
		buckets: {
			start: series.start,
			units: Array.from(series.units),
			censored: Array.from(series.censored),
		},
		days: exportDays(series, input.now, settings.workDays),
	};
	assertFinite(body);
	return { ...body, hash: paceExportHash(body) };
}
