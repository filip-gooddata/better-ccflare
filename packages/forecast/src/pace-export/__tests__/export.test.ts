import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportPaceSeries,
	maybeExportPaceSeries,
	PACE_EXPORT_ENV,
	paceExportIo,
} from "../export";
import { buildPaceExport, canonicalJson, paceExportHash } from "../format";
import { captureLogger, exportInput } from "./fixture";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pace-export-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Every string-valued field in the file, by path (array indices as []). */
function stringPaths(value: unknown, path = ""): string[] {
	if (typeof value === "string") return [path];
	if (Array.isArray(value))
		return value.flatMap((v) => stringPaths(v, `${path}[]`));
	if (value && typeof value === "object")
		return Object.entries(value).flatMap(([k, v]) =>
			stringPaths(v, path ? `${path}.${k}` : k),
		);
	return [];
}

/** Every leaf that is neither a finite number, a string nor null. */
function oddLeaves(value: unknown, path = ""): string[] {
	if (value === null || typeof value === "string") return [];
	if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
	if (Array.isArray(value))
		return value.flatMap((v, i) => oddLeaves(v, `${path}[${i}]`));
	if (typeof value === "object")
		return Object.entries(value as object).flatMap(([k, v]) =>
			oddLeaves(v, `${path}.${k}`),
		);
	return [path];
}

describe("pace export: off by default", () => {
	it("unset or empty: does no work, touches no file, builds no payload", () => {
		const writeFile = spyOn(paceExportIo, "writeFile");
		const rename = spyOn(paceExportIo, "rename");
		const unlink = spyOn(paceExportIo, "unlink");
		try {
			for (const env of [{}, { [PACE_EXPORT_ENV]: "" }]) {
				let built = 0;
				const log = captureLogger();
				const out = maybeExportPaceSeries(
					env,
					() => {
						built++;
						return exportInput(1);
					},
					log.logger,
				);
				expect(out).toBeNull();
				expect(built).toBe(0);
				expect(log.infos).toEqual([]);
				expect(log.warns).toEqual([]);
			}
			expect(writeFile).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
			expect(unlink).not.toHaveBeenCalled();
		} finally {
			writeFile.mockRestore();
			rename.mockRestore();
			unlink.mockRestore();
		}
	});
});

describe("pace export: content", () => {
	const input = exportInput(21);
	const file = buildPaceExport(input, "1.2.3");

	it("carries the series, settings and days as numbers", () => {
		expect(file.schema).toBe(1);
		expect(file.revision).toBe("1.2.3");
		expect(file.now).toBe(input.now);
		expect(file.historyFrom).toBe(input.historyFrom);
		expect(file.bucketMs).toBe(300_000);
		expect(file.timeZone).toBe("Europe/Prague");
		expect(file.accountCount).toBe(2);
		expect(file.settings).toEqual({
			workDays: 5,
			historyLookbackDays: 84,
			historyHalfLifeDays: 14,
			workStartSharePct: 5,
			timeShiftMin: 30,
		});
		expect(file.rowOne).toEqual({
			served: [0, 0, 0, 0, 0, 1, 1],
			pending: null,
		});
		expect(file.buckets.start).toBe(input.series.start);
		expect(file.buckets.units).toEqual(Array.from(input.series.units));
		expect(file.buckets.censored).toEqual(Array.from(input.series.censored));
		expect(file.days.length).toBeGreaterThan(15);
		const censoredDays = file.days.filter((d) => d.censored === 1);
		expect(censoredDays.length).toBeGreaterThan(0);
		expect(censoredDays.reduce((s, d) => s + d.censoredBuckets, 0)).toBe(40);
		for (const d of file.days) {
			expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect([0, 1]).toContain(d.censored);
			expect([0, 1]).toContain(d.active);
			expect(d.censored).toBe(d.censoredBuckets > 0 ? 1 : 0);
		}
		// local dates are consecutive and end the day before now's local day
		expect(file.days.at(-1)?.date).toBe("2026-11-15");
	});

	it("has no string field beyond revision, timeZone, days[].date and the hash", () => {
		const parsed = JSON.parse(canonicalJson(file));
		expect([...new Set(stringPaths(parsed))].sort()).toEqual([
			"days[].date",
			"hash",
			"revision",
			"timeZone",
		]);
		expect(oddLeaves(parsed)).toEqual([]);
	});

	it("leaves out extra fields a caller passes", () => {
		const leaky = {
			...input,
			settings: { ...input.settings, accountId: "acct-123" },
			sessionId: "s-1",
		} as unknown as typeof input;
		const text = canonicalJson(buildPaceExport(leaky, "1.2.3"));
		expect(text).not.toContain("acct-123");
		expect(text).not.toContain("s-1");
		expect(text).not.toContain("accountId");
	});

	it("the hash is stable: same input same hash, key order irrelevant, any change moves it", () => {
		const again = buildPaceExport(exportInput(21), "1.2.3");
		expect(again.hash).toBe(file.hash);
		expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
		const { hash, ...body } = file;
		const reordered = Object.fromEntries(Object.entries(body).reverse());
		expect(paceExportHash(reordered)).toBe(hash);
		const moved = exportInput(21);
		(moved.series.units as Float64Array)[5] += 0.5;
		expect(buildPaceExport(moved, "1.2.3").hash).not.toBe(hash);
		expect(buildPaceExport(input, "1.2.4").hash).not.toBe(hash);
	});

	it("canonical form: sorted keys, no whitespace", () => {
		expect(canonicalJson({ b: [1, { d: 2, c: "x" }], a: 0.1 })).toBe(
			'{"a":0.1,"b":[1,{"c":"x","d":2}]}',
		);
	});

	it("refuses a non-finite number instead of writing a lossy file", () => {
		const bad = exportInput(2);
		bad.settings.historyHalfLifeDays = Number.POSITIVE_INFINITY;
		expect(() => buildPaceExport(bad, "1.2.3")).toThrow("nonfinite");
	});
});

describe("pace export: write", () => {
	it("writes the file atomically with mode 0600 and logs one ok line", async () => {
		const target = join(dir, "series.json");
		writeFileSync(target, "old");
		const log = captureLogger();
		const realRename = paceExportIo.rename;
		const seenAtRename: { tmpDir: string; mode: number; target: string }[] = [];
		const rename = spyOn(paceExportIo, "rename").mockImplementation(
			async (from: string, to: string) => {
				seenAtRename.push({
					tmpDir: join(from, ".."),
					mode: statSync(from).mode & 0o777,
					target: readFileSync(to, "utf8"),
				});
				return realRename(from, to);
			},
		);
		try {
			const input = exportInput(21);
			await maybeExportPaceSeries(
				{ [PACE_EXPORT_ENV]: target },
				() => input,
				log.logger,
				"9.9.9",
			);
			expect(seenAtRename).toEqual([
				{ tmpDir: dir, mode: 0o600, target: "old" },
			]);
			expect(readdirSync(dir)).toEqual(["series.json"]);
			expect(statSync(target).mode & 0o777).toBe(0o600);
			const written = JSON.parse(readFileSync(target, "utf8"));
			const expected = buildPaceExport(input, "9.9.9");
			expect(written.hash).toBe(expected.hash);
			expect(log.warns).toEqual([]);
			expect(log.infos).toEqual([
				`forecast pace export ok buckets=${input.series.units.length} days=${expected.days.length} hash=${expected.hash.slice(0, 16)}`,
			]);
		} finally {
			rename.mockRestore();
		}
	});

	it("a failing rename logs one failure line with the errno code, removes the temp file and keeps the old file", async () => {
		const target = join(dir, "series.json");
		writeFileSync(target, "old");
		const log = captureLogger();
		const rename = spyOn(paceExportIo, "rename").mockImplementation(
			async () => {
				throw Object.assign(new Error(`EXDEV: cross-device link ${target}`), {
					code: "EXDEV",
				});
			},
		);
		try {
			await exportPaceSeries(target, exportInput(3), log.logger, "1");
		} finally {
			rename.mockRestore();
		}
		expect(log.infos).toEqual([]);
		expect(log.warns).toEqual(["forecast pace export failed code=EXDEV"]);
		expect(readdirSync(dir)).toEqual(["series.json"]);
		expect(readFileSync(target, "utf8")).toBe("old");
	});

	it("a missing directory, a relative path and a throwing input each log one short code and never throw", async () => {
		const log = captureLogger();
		await maybeExportPaceSeries(
			{ [PACE_EXPORT_ENV]: join(dir, "missing", "series.json") },
			() => exportInput(2),
			log.logger,
		);
		await maybeExportPaceSeries(
			{ [PACE_EXPORT_ENV]: "series.json" },
			() => exportInput(2),
			log.logger,
		);
		await maybeExportPaceSeries(
			{ [PACE_EXPORT_ENV]: join(dir, "x.json") },
			() => {
				throw new Error(`secret ${dir}`);
			},
			log.logger,
		);
		expect(log.infos).toEqual([]);
		expect(log.warns).toEqual([
			"forecast pace export failed code=ENOENT",
			"forecast pace export failed code=relative",
			"forecast pace export failed code=build",
		]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("snapshots the series before returning, so a later buffer transfer cannot change the file", async () => {
		const target = join(dir, "series.json");
		const input = exportInput(3);
		const expected = buildPaceExport(input, "1").hash;
		const log = captureLogger();
		const pending = maybeExportPaceSeries(
			{ [PACE_EXPORT_ENV]: target },
			() => input,
			log.logger,
			"1",
		);
		input.series.units.fill(99);
		input.series.censored.fill(1);
		await pending;
		expect(JSON.parse(readFileSync(target, "utf8")).hash).toBe(expected);
	});
});
