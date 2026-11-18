import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The notice is once per process, so each case runs in a fresh Bun process:
 * two Config instances read the settings three times each, and the child
 * prints every Logger warning about the setting being ignored.
 */
const INDEX = join(import.meta.dir, "index.ts");
const LOGGER = join(import.meta.dir, "..", "..", "logger", "src", "index.ts");
const PROBE = `
import { Logger } from ${JSON.stringify(LOGGER)};
import { Config } from ${JSON.stringify(INDEX)};
const seen = [];
Logger.prototype.warn = function (message) {
	if (String(message).includes("ignored")) seen.push(String(message));
};
for (const c of [new Config(process.env.PROBE_CONFIG), new Config(process.env.PROBE_CONFIG)])
	for (let i = 0; i < 3; i++) c.getForecastSettings();
console.log(JSON.stringify(seen));
`;

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ignoredWarnings(
	file: Record<string, unknown>,
	simulatedDaysEnv?: string,
): string[] {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-simdays-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(file));
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith("FORECAST_")) env[k] = v;
	env.PROBE_CONFIG = path;
	if (simulatedDaysEnv !== undefined)
		env.FORECAST_SIMULATED_DAYS = simulatedDaysEnv;
	const run = Bun.spawnSync([process.execPath, "-e", PROBE], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0)
		throw new Error(`probe failed: ${run.stderr.toString()}`);
	const lines = run.stdout.toString().trim().split("\n");
	return JSON.parse(lines[lines.length - 1]) as string[];
}

describe("forecast.simulatedDays is ignored", () => {
	it("warns once per process when set in the environment", () => {
		const seen = ignoredWarnings({}, "800");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("FORECAST_SIMULATED_DAYS");
		expect(seen[0]).toContain("chosen per forecast");
	});

	it("warns once per process when set in the config file", () => {
		const seen = ignoredWarnings({ forecast_simulated_days: 800 });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("forecast_simulated_days");
	});

	it("stays silent when unset", () => {
		expect(ignoredWarnings({})).toEqual([]);
	});

	it("stays silent when left at its default", () => {
		expect(ignoredWarnings({ forecast_simulated_days: 400 })).toEqual([]);
		expect(ignoredWarnings({}, "400")).toEqual([]);
	});
});
