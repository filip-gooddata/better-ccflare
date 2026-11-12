import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import { Config } from "./index";

const ENV_NAMES = [
	"SESSION_PACE_FIVE_HOUR_GUARD_PCT",
	"SESSION_PACE_FAMILY_GUARD_PCT",
	"SESSION_PACE_TIE_BAND_PCT",
	"SESSION_PACE_IDLE_MS",
	"SESSION_PACE_WORK_DAYS",
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

	describe("work days", () => {
		it("defaults to 5", () => {
			for (const n of ENV_NAMES) delete process.env[n];
			const { config, cleanup } = configWithFile({});
			try {
				expect(config.getSessionPaceWorkDays()).toBe(5);
			} finally {
				cleanup();
			}
		});

		it("reads the file key, and the environment beats the file", () => {
			for (const n of ENV_NAMES) delete process.env[n];
			const { config, cleanup } = configWithFile({ session_pace_work_days: 7 });
			try {
				expect(config.getSessionPaceWorkDays()).toBe(7);
				process.env.SESSION_PACE_WORK_DAYS = "6";
				expect(config.getSessionPaceWorkDays()).toBe(6);
			} finally {
				cleanup();
			}
		});

		it("uses 5 with one warning for anything but an integer from 1 to 7", () => {
			const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
			try {
				const invalidEnv = ["0", "8", "2.5", "abc", "-1"];
				for (const value of invalidEnv) {
					for (const n of ENV_NAMES) delete process.env[n];
					process.env.SESSION_PACE_WORK_DAYS = value;
					const { config, cleanup } = configWithFile({
						session_pace_work_days: 3,
					});
					try {
						warn.mockClear();
						expect(config.getSessionPaceWorkDays()).toBe(5);
						expect(config.getSessionPaceWorkDays()).toBe(5);
						expect(warn).toHaveBeenCalledTimes(1);
						expect(String(warn.mock.calls[0][0])).toContain(
							"SESSION_PACE_WORK_DAYS",
						);
					} finally {
						cleanup();
					}
				}
				for (const value of [0, 8, 3.5, "5"]) {
					for (const n of ENV_NAMES) delete process.env[n];
					const { config, cleanup } = configWithFile({
						session_pace_work_days: value,
					});
					try {
						warn.mockClear();
						expect(config.getSessionPaceWorkDays()).toBe(5);
						expect(config.getSessionPaceWorkDays()).toBe(5);
						expect(warn).toHaveBeenCalledTimes(1);
						expect(String(warn.mock.calls[0][0])).toContain(
							"session_pace_work_days",
						);
					} finally {
						cleanup();
					}
				}
			} finally {
				warn.mockRestore();
			}
		});
	});
});
