import { readFile } from "node:fs/promises";
import type {
	LearnInput,
	Partition,
	PartitionFitter,
	RowChoice,
} from "../engine/learn/types";
import type { PaceSeries } from "../engine/pace/types";
import type { SeriesJobPayload } from "../service/forecast-jobs";
import type { RefitDemandSettings } from "../service/pace-refit-runner";
import { BUCKET_MS, type EpochMs } from "../types";
import {
	canonicalJson,
	exportDays,
	PACE_EXPORT_SCHEMA,
	type PaceExportFile,
	paceExportHash,
	pickSettings,
	ROW_ONE,
	ROW_REASONS,
} from "./format";

/** An exported pace series read back into the inputs the same revision's learners take. */
export interface LoadedPaceExport {
	file: PaceExportFile;
	series: PaceSeries;
	now: EpochMs;
	settings: RefitDemandSettings;
	/** `rowOne.choice` is the second argument learnDemand got in the live main job. */
	rowOne: { choice: RowChoice<Partition>; pending: Partition | null } | null;
	/** `learnDemand`'s first argument; rows 2-8 call no fitter, row 1 needs a real one. */
	learnInput(fitWithPartition: PartitionFitter): LearnInput;
	/** The worker job payload (`refitJob`, `daytypesJob`) without `daytypes`/`pending`; fresh buffers per call. */
	payload(): SeriesJobPayload;
}

function fail(what: string): never {
	throw new Error(`pace export: ${what}`);
}

const isNum = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

function numbers(v: unknown, what: string): number[] {
	if (!Array.isArray(v) || !v.every(isNum))
		fail(`${what} must be a number array`);
	return v;
}

function num(v: unknown, what: string): number {
	if (!isNum(v)) fail(`${what} must be a finite number`);
	return v;
}

const numOrNaN = (v: unknown, what: string): number =>
	v === null ? Number.NaN : num(v, what);

function decodeRowChoice(v: unknown): RowChoice<Partition> {
	const c = (v ?? fail("rowOne.choice missing")) as Record<string, unknown>;
	const reason = ROW_REASONS[num(c.reason, "rowOne.choice.reason")];
	if (reason === undefined) fail("rowOne.choice.reason out of range");
	if (c.on !== 0 && c.on !== 1) fail("rowOne.choice.on must be 0 or 1");
	return {
		row: ROW_ONE,
		m: num(c.m, "rowOne.choice.m"),
		floor: num(c.floor, "rowOne.choice.floor"),
		units: num(c.units, "rowOne.choice.units"),
		present: numbers(c.present, "rowOne.choice.present"),
		chosen: numbers(c.chosen, "rowOne.choice.chosen"),
		runnerUp:
			c.runnerUp === null
				? null
				: numbers(c.runnerUp, "rowOne.choice.runnerUp"),
		served: numbers(c.served, "rowOne.choice.served"),
		presentLoss: numOrNaN(c.presentLoss, "rowOne.choice.presentLoss"),
		chosenLoss: numOrNaN(c.chosenLoss, "rowOne.choice.chosenLoss"),
		gain: numOrNaN(c.gain, "rowOne.choice.gain"),
		se: numOrNaN(c.se, "rowOne.choice.se"),
		p: numOrNaN(c.p, "rowOne.choice.p"),
		on: c.on === 1,
		reason,
	};
}

/** Parses and checks a file `exportPaceSeries` wrote: schema, field types, hash and the day table. */
export function parsePaceExport(text: string): LoadedPaceExport {
	const raw = JSON.parse(text) as Record<string, unknown>;
	if (raw?.schema !== PACE_EXPORT_SCHEMA)
		fail(`schema ${String(raw?.schema)} is not ${PACE_EXPORT_SCHEMA}`);
	const b = (raw.buckets ?? {}) as Record<string, unknown>;
	const units = numbers(b.units, "buckets.units");
	const censored = numbers(b.censored, "buckets.censored");
	if (units.length !== censored.length) fail("bucket arrays differ in length");
	if (!censored.every((c) => c === 0 || c === 1))
		fail("censored must be 0 or 1");
	if (typeof raw.timeZone !== "string") fail("timeZone must be a string");
	if (typeof raw.revision !== "string") fail("revision must be a string");
	if (num(raw.bucketMs, "bucketMs") !== BUCKET_MS)
		fail(`bucketMs ${raw.bucketMs} is not ${BUCKET_MS}`);
	const s = (raw.settings ?? {}) as Record<string, unknown>;
	const settings: RefitDemandSettings = {
		workDays: num(s.workDays, "settings.workDays"),
		historyLookbackDays: num(
			s.historyLookbackDays,
			"settings.historyLookbackDays",
		),
		historyHalfLifeDays: num(
			s.historyHalfLifeDays,
			"settings.historyHalfLifeDays",
		),
		workStartSharePct: num(s.workStartSharePct, "settings.workStartSharePct"),
		timeShiftMin: num(s.timeShiftMin, "settings.timeShiftMin"),
	};
	const r1 = raw.rowOne as Record<string, unknown> | null | undefined;
	const rowOne =
		r1 == null
			? null
			: {
					choice: decodeRowChoice(r1.choice),
					pending:
						r1.pending == null ? null : numbers(r1.pending, "rowOne.pending"),
				};
	if (typeof raw.hash !== "string" || paceExportHash(raw) !== raw.hash)
		fail("hash mismatch");
	const file = raw as unknown as PaceExportFile;
	const now = num(file.now, "now");
	const timeZone = file.timeZone;
	const start = num(b.start, "buckets.start");
	const series = (): PaceSeries => ({
		start,
		units: Float64Array.from(units),
		censored: Uint8Array.from(censored),
		timeZone,
	});
	const loaded = series();
	if (
		canonicalJson(exportDays(loaded, now, settings.workDays)) !==
		canonicalJson(file.days)
	)
		fail("days do not match the series");
	return {
		file,
		series: loaded,
		now,
		settings,
		rowOne,
		learnInput: (fitWithPartition) => ({
			...pickSettings(settings),
			series: loaded,
			now,
			fitWithPartition,
		}),
		payload: () => ({ ...series(), now, ...pickSettings(settings) }),
	};
}

/** Reads an export file from disk; see `parsePaceExport`. */
export async function loadPaceExport(path: string): Promise<LoadedPaceExport> {
	return parsePaceExport(await readFile(path, "utf8"));
}
