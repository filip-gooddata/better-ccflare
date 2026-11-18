import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnDemand } from "../../engine/learn";
import type { PartitionFitter } from "../../engine/learn/types";
import { formatF2LearnLine } from "../../service/f2-learn-log";
import { daytypesJob } from "../../service/forecast-jobs";
import { exportPaceSeries } from "../export";
import type { PaceExportInput } from "../format";
import { canonicalJson } from "../format";
import { loadPaceExport, parsePaceExport } from "../load";
import {
	captureLogger,
	exportInput,
	NO_UNITS_CHOICE,
	ON_CHOICE,
} from "./fixture";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pace-load-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** learnDemand calls no fitter (rows 2-8); this one fails loudly if that changes. */
const noFit: PartitionFitter = () => {
	throw new Error("learnDemand must not fit");
};

async function roundTrip(days: number, rowOne?: PaceExportInput["rowOne"]) {
	const input =
		rowOne === undefined ? exportInput(days) : exportInput(days, rowOne);
	const target = join(dir, "series.json");
	const { logger } = captureLogger();
	// keep an untouched copy: the in-memory learner runs on the same values the export saw
	const series = {
		...input.series,
		units: input.series.units.slice(),
		censored: input.series.censored.slice(),
	};
	await exportPaceSeries(target, input, logger, "1.2.3");
	return { input, series, loaded: await loadPaceExport(target), target };
}

describe("pace export loader", () => {
	it("reads back the exact PaceSeries, now and learner settings", async () => {
		const { input, series, loaded } = await roundTrip(21);
		expect(loaded.series.start).toBe(series.start);
		expect(loaded.series.timeZone).toBe(series.timeZone);
		expect(loaded.series.units).toBeInstanceOf(Float64Array);
		expect(loaded.series.censored).toBeInstanceOf(Uint8Array);
		expect(Array.from(loaded.series.units)).toEqual(Array.from(series.units));
		expect(Array.from(loaded.series.censored)).toEqual(
			Array.from(series.censored),
		);
		expect(loaded.now).toBe(input.now);
		expect(loaded.settings).toEqual(input.settings);
		expect(loaded.rowOne).toEqual({ choice: ON_CHOICE, pending: null });
		expect(loaded.file.revision).toBe("1.2.3");
	});

	for (const [name, rowOne] of [
		["no stored row-1 choice", null],
		[
			"a stored row-1 choice that switched on",
			{ choice: ON_CHOICE, pending: null },
		],
		[
			"a stored row-1 choice with NaN losses",
			{ choice: NO_UNITS_CHOICE, pending: null },
		],
	] as const)
		it(`round trip with ${name}: learnDemand gives the same forecast f2 learn line`, async () => {
			const { input, series, loaded } = await roundTrip(28, rowOne);
			const live = learnDemand(
				{ ...input.settings, series, now: input.now, fitWithPartition: noFit },
				input.rowOne?.choice ?? null,
			);
			expect(loaded.rowOne).toEqual(input.rowOne);
			const offline = learnDemand(
				loaded.learnInput(noFit),
				loaded.rowOne?.choice ?? null,
			);
			const liveLine = formatF2LearnLine(live, 0, { mainJob: true });
			expect(liveLine).toStartWith("forecast f2 learn ");
			if (rowOne) expect(liveLine).toContain(" rows=daytypes:");
			expect(formatF2LearnLine(offline, 0, { mainJob: true })).toBe(liveLine);
			// everything but the wall-clock job time
			expect({ ...offline, ms: 0 }).toEqual({ ...live, ms: 0 });
		});

	it("the payload runs the row-1 job the same as the in-memory series, with and without a pending partition", async () => {
		for (const pending of [null, [0, 0, 0, 0, 0, 1, 2]]) {
			const { input, series, loaded } = await roundTrip(21, {
				choice: ON_CHOICE,
				pending,
			});
			const fitter = () => (p: readonly number[]) =>
				({ tag: p.join("") }) as never;
			const nested = () => (_p: readonly number[]) => ({
				units: [1],
				loss: [1],
			});
			const live = daytypesJob(
				{
					...series,
					now: input.now,
					...input.settings,
					daytypes: input.rowOne?.choice ?? null,
					pending: input.rowOne?.pending ?? null,
				},
				fitter,
				nested,
			);
			const offline = daytypesJob(
				{
					...loaded.payload(),
					daytypes: loaded.rowOne?.choice ?? null,
					pending: loaded.rowOne?.pending ?? null,
				},
				fitter,
				nested,
			);
			expect(offline).toEqual(live);
			expect(offline.nested).toBe(pending !== null);
		}
	});

	it("rejects a file whose content no longer matches its hash", async () => {
		const { target } = await roundTrip(3);
		const parsed = JSON.parse(readFileSync(target, "utf8"));
		parsed.buckets.units[0] += 1;
		writeFileSync(target, canonicalJson(parsed));
		await expect(loadPaceExport(target)).rejects.toThrow("hash mismatch");
	});

	it("rejects another schema and a malformed field", () => {
		expect(() => parsePaceExport('{"schema":2}')).toThrow("schema");
		expect(() =>
			parsePaceExport(canonicalJson({ schema: 1, buckets: { units: ["1"] } })),
		).toThrow();
	});
});
