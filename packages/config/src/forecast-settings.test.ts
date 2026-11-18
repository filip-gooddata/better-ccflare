import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FAN_LEVELS } from "@better-ccflare/forecast";
import { Logger } from "@better-ccflare/logger";
import {
	type ForecastConfigData,
	type ForecastResolveInput,
	resolveForecastSettings,
} from "./forecast-settings";
import { Config } from "./index";

const HOME = "/home/tester";

function resolve(
	env: Record<string, string | undefined> = {},
	file: ForecastConfigData = {},
) {
	const warnings: string[] = [];
	const input: ForecastResolveInput = {
		env,
		file,
		home: HOME,
		warn: (source, raw) => warnings.push(`${source}=${JSON.stringify(raw)}`),
	};
	return { settings: resolveForecastSettings(input), warnings };
}

const DEFAULTS = {
	enabled: true,
	routing: true,
	prewarm: false,
	prewarmTest: null,
	claudePath: null,
	prewarmModel: "haiku",
	prewarmMaxPerDay: 4,
	simulatedDays: 400,
	timeShiftMin: 30,
	transcriptsDir: `${HOME}/.claude/projects`,
	fanLevels: [...DEFAULT_FAN_LEVELS],
	minStopPoints: 1,
	moveMinGainPoints: 2,
	openMinGainPoints: 1,
	historyHalfLifeDays: 14,
	historyLookbackDays: 84,
	recentTauMin: 45,
	sessionTurnoverMin: 60,
	workStartSharePct: 5,
	paceConditioning: true,
};

describe("resolveForecastSettings", () => {
	it("paceConditioning: on by default, off from the file or the environment, the environment first", () => {
		expect(resolve().settings.paceConditioning).toBe(true);
		expect(
			resolve({}, { forecast_pace_conditioning: false }).settings
				.paceConditioning,
		).toBe(false);
		expect(
			resolve({ FORECAST_PACE_CONDITIONING: "off" }).settings.paceConditioning,
		).toBe(false);
		expect(
			resolve(
				{ FORECAST_PACE_CONDITIONING: "true" },
				{ forecast_pace_conditioning: false },
			).settings.paceConditioning,
		).toBe(true);
		const bad = resolve({}, { forecast_pace_conditioning: "nope" });
		expect(bad.settings.paceConditioning).toBe(true);
		expect(bad.warnings).toEqual(['forecast_pace_conditioning="nope"']);
	});

	it("gives the design defaults with nothing set", () => {
		const { settings, warnings } = resolve();
		expect(settings).toEqual(DEFAULTS);
		expect(warnings).toEqual([]);
		expect(settings.fanLevels).toEqual([12, 24, 38, 62, 76, 88]);
	});

	it("reads every setting from the config file", () => {
		const { settings, warnings } = resolve(
			{},
			{
				forecast_enabled: false,
				forecast_routing: false,
				forecast_prewarm: true,
				forecast_prewarm_test: {
					account: "acct-a",
					at: "2026-11-13T07:30:00+01:00",
				},
				forecast_claude_path: "~/bin/claude",
				forecast_prewarm_model: "claude-haiku-5-5",
				forecast_prewarm_max_per_day: 2,
				forecast_simulated_days: 800,
				forecast_time_shift_min: 15,
				forecast_transcripts_dir: "/data/transcripts",
				forecast_fan_levels: [25, 75],
				forecast_min_stop_points: 0.5,
				forecast_move_min_gain_points: 3,
				forecast_open_min_gain_points: 1.5,
				forecast_history_half_life_days: 7,
				forecast_history_lookback_days: 28,
				forecast_recent_tau_min: 30,
				forecast_session_turnover_min: 90,
				forecast_work_start_share_pct: 12.5,
				forecast_pace_conditioning: false,
			},
		);
		expect(warnings).toEqual([]);
		expect(settings).toEqual({
			enabled: false,
			routing: false,
			prewarm: true,
			prewarmTest: {
				account: "acct-a",
				at: Date.parse("2026-11-13T06:30:00Z"),
			},
			claudePath: `${HOME}/bin/claude`,
			prewarmModel: "claude-haiku-5-5",
			prewarmMaxPerDay: 2,
			simulatedDays: 800,
			timeShiftMin: 15,
			transcriptsDir: "/data/transcripts",
			fanLevels: [25, 75],
			minStopPoints: 0.5,
			moveMinGainPoints: 3,
			openMinGainPoints: 1.5,
			historyHalfLifeDays: 7,
			historyLookbackDays: 28,
			recentTauMin: 30,
			sessionTurnoverMin: 90,
			workStartSharePct: 12.5,
			paceConditioning: false,
		});
	});

	it("prefers the environment over the config file", () => {
		const { settings, warnings } = resolve(
			{
				FORECAST_ENABLED: "false",
				FORECAST_PREWARM: "1",
				FORECAST_SIMULATED_DAYS: "600",
				FORECAST_FAN_LEVELS: "30, 70",
				FORECAST_TRANSCRIPTS_DIR: "none",
				FORECAST_PREWARM_TEST: '{"account":"work","at":1794560000000}',
				FORECAST_CLAUDE_PATH: "/opt/claude",
				FORECAST_PREWARM_MODEL: "sonnet",
				FORECAST_RECENT_TAU_MIN: "20",
				FORECAST_WORK_START_SHARE_PCT: "10",
			},
			{
				forecast_enabled: true,
				forecast_prewarm: false,
				forecast_simulated_days: 800,
				forecast_fan_levels: [25],
				forecast_transcripts_dir: "/data",
				forecast_prewarm_test: null,
				forecast_claude_path: "/usr/bin/claude",
				forecast_prewarm_model: "haiku",
				forecast_recent_tau_min: 60,
				forecast_work_start_share_pct: 20,
			},
		);
		expect(warnings).toEqual([]);
		expect(settings.enabled).toBe(false);
		expect(settings.prewarm).toBe(true);
		expect(settings.simulatedDays).toBe(600);
		expect(settings.fanLevels).toEqual([30, 70]);
		expect(settings.transcriptsDir).toBeNull();
		expect(settings.prewarmTest).toEqual({
			account: "work",
			at: 1794560000000,
		});
		expect(settings.claudePath).toBe("/opt/claude");
		expect(settings.prewarmModel).toBe("sonnet");
		expect(settings.recentTauMin).toBe(20);
		expect(settings.workStartSharePct).toBe(10);
	});

	it("treats an empty environment value as unset", () => {
		const { settings } = resolve(
			{ FORECAST_SIMULATED_DAYS: "", FORECAST_ENABLED: "" },
			{ forecast_simulated_days: 800, forecast_enabled: false },
		);
		expect(settings.simulatedDays).toBe(800);
		expect(settings.enabled).toBe(false);
	});

	it.each([
		["FORECAST_PREWARM_MAX_PER_DAY", "prewarmMaxPerDay", "-3", 0, "99", 24],
		["FORECAST_SIMULATED_DAYS", "simulatedDays", "1", 50, "100000", 2000],
		["FORECAST_TIME_SHIFT_MIN", "timeShiftMin", "-1", 0, "500", 120],
		["FORECAST_MIN_STOP_POINTS", "minStopPoints", "-1", 0, "101", 100],
		["FORECAST_MOVE_MIN_GAIN_POINTS", "moveMinGainPoints", "-1", 0, "300", 100],
		["FORECAST_OPEN_MIN_GAIN_POINTS", "openMinGainPoints", "-1", 0, "300", 100],
		[
			"FORECAST_HISTORY_HALF_LIFE_DAYS",
			"historyHalfLifeDays",
			"0",
			1,
			"999",
			365,
		],
		[
			"FORECAST_HISTORY_LOOKBACK_DAYS",
			"historyLookbackDays",
			"1",
			7,
			"999",
			365,
		],
		["FORECAST_RECENT_TAU_MIN", "recentTauMin", "0", 1, "9999", 720],
		[
			"FORECAST_SESSION_TURNOVER_MIN",
			"sessionTurnoverMin",
			"0",
			1,
			"9999",
			1440,
		],
		["FORECAST_WORK_START_SHARE_PCT", "workStartSharePct", "0", 1, "80", 50],
	] as const)("clamps %s into its range", (env, field, low, min, high, max) => {
		expect(resolve({ [env]: low }).settings[field]).toBe(min);
		const clampedHigh = resolve({ [env]: high });
		expect(clampedHigh.settings[field]).toBe(max);
		expect(clampedHigh.warnings).toEqual([]);
	});

	it("clamps config-file numbers and rounds whole-number settings", () => {
		const { settings } = resolve(
			{},
			{
				forecast_simulated_days: 10,
				forecast_prewarm_max_per_day: 2.6,
				forecast_history_lookback_days: 30.4,
			},
		);
		expect(settings.simulatedDays).toBe(50);
		expect(settings.prewarmMaxPerDay).toBe(3);
		expect(settings.historyLookbackDays).toBe(30);
	});

	it("replaces invalid values by the default and reports each", () => {
		const { settings, warnings } = resolve(
			{
				FORECAST_ENABLED: "maybe",
				FORECAST_SIMULATED_DAYS: "lots",
				FORECAST_FAN_LEVELS: "20,abc",
				FORECAST_PREWARM_TEST: "acct-a at 7",
				FORECAST_PREWARM_MODEL: "haiku; rm -rf /",
				FORECAST_CLAUDE_PATH: "bin/claude",
			},
			{
				forecast_routing: "yes",
				forecast_time_shift_min: "15",
				forecast_transcripts_dir: 42,
				forecast_work_start_share_pct: "five",
			},
		);
		expect(settings).toEqual(DEFAULTS);
		expect(warnings.sort()).toEqual(
			[
				'FORECAST_ENABLED="maybe"',
				'FORECAST_SIMULATED_DAYS="lots"',
				'FORECAST_FAN_LEVELS="20,abc"',
				'FORECAST_PREWARM_TEST="acct-a at 7"',
				'FORECAST_PREWARM_MODEL="haiku; rm -rf /"',
				'FORECAST_CLAUDE_PATH="bin/claude"',
				'forecast_routing="yes"',
				'forecast_time_shift_min="15"',
				"forecast_transcripts_dir=42",
				'forecast_work_start_share_pct="five"',
			].sort(),
		);
	});

	it("drops 10, 50, 90 and duplicates from fanLevels and sorts them", () => {
		expect(
			resolve({}, { forecast_fan_levels: [90, 30, 10, 30, 50, 70, 12] })
				.settings.fanLevels,
		).toEqual([12, 30, 70]);
		expect(
			resolve({ FORECAST_FAN_LEVELS: "88,50,12,12,10" }).settings.fanLevels,
		).toEqual([12, 88]);
	});

	it("accepts an empty fan", () => {
		expect(resolve({}, { forecast_fan_levels: [] }).settings.fanLevels).toEqual(
			[],
		);
		expect(resolve({ FORECAST_FAN_LEVELS: "none" }).settings.fanLevels).toEqual(
			[],
		);
	});

	describe("fanLevels as a count", () => {
		const EVERY_2_POINTS = [
			...Array.from({ length: 19 }, (_, i) => 12 + 2 * i),
			...Array.from({ length: 19 }, (_, i) => 52 + 2 * i),
		];

		it("generates the levels from a count in the config file", () => {
			const { settings, warnings } = resolve({}, { forecast_fan_levels: 38 });
			expect(settings.fanLevels).toEqual(EVERY_2_POINTS);
			expect(warnings).toEqual([]);
			expect(
				resolve({}, { forecast_fan_levels: 6 }).settings.fanLevels,
			).toEqual([20, 30, 40, 60, 70, 80]);
			expect(
				resolve({}, { forecast_fan_levels: 0 }).settings.fanLevels,
			).toEqual([]);
		});

		it("generates the levels from a bare whole number in the environment", () => {
			const { settings, warnings } = resolve({ FORECAST_FAN_LEVELS: " 38 " });
			expect(settings.fanLevels).toEqual(EVERY_2_POINTS);
			expect(warnings).toEqual([]);
			expect(resolve({ FORECAST_FAN_LEVELS: "0" }).settings.fanLevels).toEqual(
				[],
			);
			expect(
				resolve({ FORECAST_FAN_LEVELS: "78" }).settings.fanLevels,
			).toHaveLength(78);
		});

		it("reads a one-level list from the environment with a trailing comma", () => {
			expect(
				resolve({ FORECAST_FAN_LEVELS: "25," }).settings.fanLevels,
			).toEqual([25]);
			expect(
				resolve({ FORECAST_FAN_LEVELS: "20,80," }).settings.fanLevels,
			).toEqual([20, 80]);
		});

		it("keeps an old config file list of every 2 points as it was", () => {
			expect(
				resolve({}, { forecast_fan_levels: EVERY_2_POINTS }).settings.fanLevels,
			).toEqual(EVERY_2_POINTS);
		});

		it("lets the environment win over the config file whatever form each has", () => {
			expect(
				resolve({ FORECAST_FAN_LEVELS: "6" }, { forecast_fan_levels: [25, 75] })
					.settings.fanLevels,
			).toEqual([20, 30, 40, 60, 70, 80]);
			expect(
				resolve({ FORECAST_FAN_LEVELS: "25,75" }, { forecast_fan_levels: 6 })
					.settings.fanLevels,
			).toEqual([25, 75]);
		});

		it.each([
			[{}, { forecast_fan_levels: 7 }, "forecast_fan_levels=7"],
			[{}, { forecast_fan_levels: 80 }, "forecast_fan_levels=80"],
			[{}, { forecast_fan_levels: -2 }, "forecast_fan_levels=-2"],
			[{}, { forecast_fan_levels: 6.5 }, "forecast_fan_levels=6.5"],
			[{ FORECAST_FAN_LEVELS: "7" }, {}, 'FORECAST_FAN_LEVELS="7"'],
			[{ FORECAST_FAN_LEVELS: "80" }, {}, 'FORECAST_FAN_LEVELS="80"'],
			[{ FORECAST_FAN_LEVELS: "25,," }, {}, 'FORECAST_FAN_LEVELS="25,,"'],
		] as const)("rejects the count or list %j %j", (env, file, warning) => {
			const { settings, warnings } = resolve(env, file);
			expect(settings.fanLevels).toEqual([12, 24, 38, 62, 76, 88]);
			expect(warnings).toEqual([warning]);
		});
	});

	it.each([
		[[0, 20]],
		[[20, 100]],
		[[20.5]],
		["12,14"],
		[{ p: 12 }],
	])("rejects the fan list %j", (value) => {
		const { settings, warnings } = resolve({}, { forecast_fan_levels: value });
		expect(settings.fanLevels).toEqual([...DEFAULT_FAN_LEVELS]);
		expect(warnings).toHaveLength(1);
	});

	it("accepts prewarmTest with an account name or id and an ISO time or epoch ms", () => {
		expect(
			resolve(
				{},
				{ forecast_prewarm_test: { account: "Work", at: 1794560000000 } },
			).settings.prewarmTest,
		).toEqual({ account: "Work", at: 1794560000000 });
		expect(
			resolve(
				{},
				{ forecast_prewarm_test: { account: "1d05", at: "1794560000000" } },
			).settings.prewarmTest,
		).toEqual({ account: "1d05", at: 1794560000000 });
		expect(
			resolve(
				{},
				{
					forecast_prewarm_test: { account: "a", at: "2026-11-13T06:30:00Z" },
				},
			).settings.prewarmTest,
		).toEqual({ account: "a", at: Date.parse("2026-11-13T06:30:00Z") });
		expect(
			resolve(
				{ FORECAST_PREWARM_TEST: "none" },
				{
					forecast_prewarm_test: { account: "a", at: 1 },
				},
			).settings.prewarmTest,
		).toBeNull();
	});

	it.each([
		[{ account: "a", at: "2026-11-13T06:30:00" }],
		[{ account: "a", at: "tomorrow" }],
		[{ account: "", at: 1 }],
		[{ account: "a", at: -5 }],
		[{ account: "a", at: "9".repeat(400) }],
		[{ account: "a", at: 2 ** 60 }],
		[{ account: "a" }],
		["a@1"],
	])("rejects the prewarmTest %j (an ISO time needs a zone)", (value) => {
		const { settings, warnings } = resolve(
			{},
			{ forecast_prewarm_test: value },
		);
		expect(settings.prewarmTest).toBeNull();
		expect(warnings).toHaveLength(1);
	});

	it("expands a leading ~ in paths and turns them off with none or null", () => {
		expect(
			resolve({ FORECAST_TRANSCRIPTS_DIR: "~/t" }).settings.transcriptsDir,
		).toBe(`${HOME}/t`);
		expect(
			resolve({ FORECAST_TRANSCRIPTS_DIR: "~" }).settings.transcriptsDir,
		).toBe(HOME);
		expect(
			resolve({}, { forecast_transcripts_dir: null }).settings.transcriptsDir,
		).toBeNull();
		expect(
			resolve({}, { forecast_claude_path: null }).settings.claudePath,
		).toBeNull();
	});
});

describe("Config.getForecastSettings", () => {
	const NAMES = [
		"FORECAST_ENABLED",
		"FORECAST_SIMULATED_DAYS",
		"FORECAST_TRANSCRIPTS_DIR",
	];
	const saved = new Map<string, string | undefined>();
	const dirs: string[] = [];

	beforeEach(() => {
		for (const n of NAMES) {
			saved.set(n, process.env[n]);
			delete process.env[n];
		}
	});
	afterEach(() => {
		for (const n of NAMES) {
			const v = saved.get(n);
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
		while (dirs.length)
			rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	function config(raw: Record<string, unknown>): Config {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-forecast-"));
		dirs.push(dir);
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify(raw));
		return new Config(path);
	}

	it("resolves env over file over default and expands ~ against the home directory", () => {
		process.env.FORECAST_SIMULATED_DAYS = "500";
		const settings = config({
			forecast_simulated_days: 800,
			forecast_enabled: false,
		}).getForecastSettings();
		expect(settings.simulatedDays).toBe(500);
		expect(settings.enabled).toBe(false);
		expect(settings.transcriptsDir).toBe(join(homedir(), ".claude/projects"));
	});

	it("warns once per distinct invalid value however often it is read", () => {
		const warn = spyOn(Logger.prototype, "warn");
		try {
			const c = config({});
			for (const value of ["x", "y", "x"]) {
				process.env.FORECAST_SIMULATED_DAYS = value;
				for (let i = 0; i < 5; i++)
					expect(c.getForecastSettings().simulatedDays).toBe(400);
			}
			const forecastWarnings = warn.mock.calls.filter(([m]) =>
				String(m).includes("FORECAST_SIMULATED_DAYS"),
			);
			expect(forecastWarnings).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});
});
