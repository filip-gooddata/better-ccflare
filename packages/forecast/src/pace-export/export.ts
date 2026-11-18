import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	buildPaceExport,
	canonicalJson,
	PaceExportError,
	type PaceExportFile,
	type PaceExportInput,
} from "./format";

/** Absolute file path to write the pace series to at each refit; unset or empty is off. */
export const PACE_EXPORT_ENV = "FORECAST_PACE_SERIES_EXPORT";

// Build-time injected version, as packages/core/src/version.ts reads it.
declare const __BETTER_CCFLARE_VERSION__: string | undefined;

function buildRevision(): string {
	return typeof __BETTER_CCFLARE_VERSION__ !== "undefined" &&
		__BETTER_CCFLARE_VERSION__
		? __BETTER_CCFLARE_VERSION__
		: "dev";
}

/** The file calls the export makes; an object so tests can observe them. */
export const paceExportIo = { writeFile, rename, unlink };

export interface PaceExportLogger {
	info(message: string): void;
	warn(message: string): void;
}

/** errno code when the error has one, else a fixed short code; never a message or path. */
function codeOf(err: unknown, fallback: string): string {
	if (err instanceof PaceExportError) return err.code;
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
		? code
		: fallback;
}

async function writeAtomically(target: string, text: string): Promise<void> {
	const tmp = join(
		dirname(target),
		`.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		await paceExportIo.writeFile(tmp, text, { mode: 0o600, flag: "wx" });
		await paceExportIo.rename(tmp, target);
	} catch (err) {
		await paceExportIo.unlink(tmp).catch(() => {});
		throw err;
	}
}

async function writeExport(
	target: string,
	file: PaceExportFile,
	logger: PaceExportLogger,
): Promise<void> {
	try {
		await writeAtomically(target, `${canonicalJson(file)}\n`);
		logger.info(
			`forecast pace export ok buckets=${file.buckets.units.length} days=${file.days.length} hash=${file.hash.slice(0, 16)}`,
		);
	} catch (err) {
		logger.warn(`forecast pace export failed code=${codeOf(err, "write")}`);
	}
}

/**
 * Builds the file now (a copy, safe against a later buffer transfer) and writes
 * it; resolves when done. Never rejects: a failure logs one line.
 */
export function exportPaceSeries(
	target: string,
	input: PaceExportInput,
	logger: PaceExportLogger,
	revision: string = buildRevision(),
): Promise<void> {
	let file: PaceExportFile;
	try {
		if (!isAbsolute(target)) throw new PaceExportError("relative");
		file = buildPaceExport(input, revision);
	} catch (err) {
		logger.warn(`forecast pace export failed code=${codeOf(err, "build")}`);
		return Promise.resolve();
	}
	return writeExport(target, file, logger);
}

/**
 * The refit hook. Off (the variable unset or empty): returns null having read
 * one environment entry, without calling `input` or touching a file. On: as
 * `exportPaceSeries`; a throwing `input` logs `code=build`. Never throws.
 */
export function maybeExportPaceSeries(
	env: Record<string, string | undefined>,
	input: () => PaceExportInput,
	logger: PaceExportLogger,
	revision?: string,
): Promise<void> | null {
	const target = env[PACE_EXPORT_ENV];
	if (!target) return null;
	let resolved: PaceExportInput;
	try {
		if (!isAbsolute(target)) throw new PaceExportError("relative");
		resolved = input();
	} catch (err) {
		logger.warn(
			`forecast pace export failed code=${err instanceof PaceExportError ? err.code : "build"}`,
		);
		return Promise.resolve();
	}
	return exportPaceSeries(target, resolved, logger, revision);
}
