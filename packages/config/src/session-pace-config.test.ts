import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_NAMES = [
	"SESSION_PACE_FIVE_HOUR_GUARD_PCT",
	"SESSION_PACE_FAMILY_GUARD_PCT",
	"SESSION_PACE_TIE_BAND_PCT",
	"SESSION_PACE_IDLE_MS",
] as const;

function configWithFile(raw: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify(raw), "utf8");
	return {
		config: new Config(configPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("session-pace settings", () => {
	const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
	afterEach(() => {
		for (const n of ENV_NAMES) {
			if (saved[n] === undefined) delete process.env[n];
			else process.env[n] = saved[n];
		}
	});

	it("defaults to 90, 90, 10 and one hour", () => {
		for (const n of ENV_NAMES) delete process.env[n];
		const { config, cleanup } = configWithFile({});
		try {
			expect(config.getSessionPaceFiveHourGuardPct()).toBe(90);
			expect(config.getSessionPaceFamilyGuardPct()).toBe(90);
			expect(config.getSessionPaceTieBandPct()).toBe(10);
			expect(config.getSessionPaceIdleMs()).toBe(3_600_000);
		} finally {
			cleanup();
		}
	});

	it("reads the config file keys", () => {
		for (const n of ENV_NAMES) delete process.env[n];
		const { config, cleanup } = configWithFile({
			session_pace_five_hour_guard_pct: 80,
			session_pace_family_guard_pct: 85,
			session_pace_tie_band_pct: 5,
			session_pace_idle_ms: 1_800_000,
		});
		try {
			expect(config.getSessionPaceFiveHourGuardPct()).toBe(80);
			expect(config.getSessionPaceFamilyGuardPct()).toBe(85);
			expect(config.getSessionPaceTieBandPct()).toBe(5);
			expect(config.getSessionPaceIdleMs()).toBe(1_800_000);
		} finally {
			cleanup();
		}
	});

	it("lets environment variables override the file and clamps values", () => {
		process.env.SESSION_PACE_FIVE_HOUR_GUARD_PCT = "75.5";
		process.env.SESSION_PACE_FAMILY_GUARD_PCT = "150";
		process.env.SESSION_PACE_TIE_BAND_PCT = "not-a-number";
		process.env.SESSION_PACE_IDLE_MS = "1000";
		const { config, cleanup } = configWithFile({
			session_pace_five_hour_guard_pct: 80,
			session_pace_tie_band_pct: 5,
		});
		try {
			expect(config.getSessionPaceFiveHourGuardPct()).toBe(75.5);
			expect(config.getSessionPaceFamilyGuardPct()).toBe(100);
			expect(config.getSessionPaceTieBandPct()).toBe(5);
			expect(config.getSessionPaceIdleMs()).toBe(60_000);
		} finally {
			cleanup();
		}
	});
});
