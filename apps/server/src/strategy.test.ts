import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Config, FORECAST_NUMBER_SETTINGS } from "@better-ccflare/config";
import { createConfigHandlers } from "@better-ccflare/http-api";
import {
	LeastUsedStrategy,
	SessionPaceStrategy,
} from "@better-ccflare/load-balancer";
import { Logger } from "@better-ccflare/logger";
import {
	type LoadBalancingStrategy,
	StrategyName,
} from "@better-ccflare/types";
import {
	buildStrategy,
	sessionPaceOptionsFrom,
	sessionPaceSettings,
} from "./strategy";

const FORECAST_ENV_KEYS = [
	"FORECAST_ENABLED",
	"FORECAST_ROUTING",
	"FORECAST_PREWARM",
	"FORECAST_PREWARM_TEST",
	"FORECAST_CLAUDE_PATH",
	"FORECAST_PREWARM_MODEL",
	"FORECAST_TRANSCRIPTS_DIR",
	"FORECAST_FAN_LEVELS",
	...FORECAST_NUMBER_SETTINGS.map((spec) => spec.env),
];

const ENV_KEYS = [
	...FORECAST_ENV_KEYS,
	"LB_STRATEGY",
	"SESSION_PACE_WORK_DAYS",
	"SESSION_PACE_FAMILY_GUARD_PCT",
	"SESSION_PACE_FIVE_HOUR_GUARD_PCT",
	"SESSION_PACE_TIE_BAND_PCT",
	"SESSION_PACE_IDLE_MS",
];

// Neither zone is UTC (the zone `bun test` runs in) nor the machine's
// Europe/Prague, so a value that leaks from the process zone shows up.
const INSTANCE_ZONE = "Pacific/Auckland";
const START_ZONE = "America/Denver";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const savedEnv = new Map<string, string | undefined>();
const tmpDirs: string[] = [];

function makeConfig(fileContents?: Record<string, unknown>): Config {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-strategy-"));
	tmpDirs.push(dir);
	const path = join(dir, "config.json");
	if (fileContents) writeFileSync(path, JSON.stringify(fileContents));
	return new Config(path);
}

function setPaceEnv(values: {
	workDays: string;
	familyGuardPct: string;
	fiveHourGuardPct: string;
	tieBandPct: string;
	idleMs: string;
}) {
	process.env.SESSION_PACE_WORK_DAYS = values.workDays;
	process.env.SESSION_PACE_FAMILY_GUARD_PCT = values.familyGuardPct;
	process.env.SESSION_PACE_FIVE_HOUR_GUARD_PCT = values.fiveHourGuardPct;
	process.env.SESSION_PACE_TIE_BAND_PCT = values.tieBandPct;
	process.env.SESSION_PACE_IDLE_MS = values.idleMs;
}

/** The fields the forecast adds to the strategy response with nothing configured. */
function defaultForecastFields() {
	return {
		forecastSettings: {
			enabled: true,
			routing: true,
			prewarm: false,
			prewarmTest: null,
			claudePath: null,
			prewarmModel: "haiku",
			prewarmMaxPerDay: 4,
			simulatedDays: 400,
			timeShiftMin: 30,
			transcriptsDir: join(homedir(), ".claude", "projects"),
			fanLevels: Array.from({ length: 39 }, (_, i) => 12 + 2 * i).filter(
				(p) => p !== 50,
			),
			minStopPoints: 1,
			moveMinGainPoints: 2,
			openMinGainPoints: 1,
			historyHalfLifeDays: 14,
			historyLookbackDays: 84,
			recentTauMin: 45,
			sessionTurnoverMin: 60,
			workStartSharePct: 5,
		},
		forecast: { path: "/api/forecast", contractVersion: 1 },
	};
}

async function strategyBody(
	config: Config,
	current: LoadBalancingStrategy | null,
): Promise<Record<string, unknown>> {
	const handlers = createConfigHandlers(config, () =>
		sessionPaceSettings(current, config, START_ZONE),
	);
	const response = handlers.getStrategy();
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	while (tmpDirs.length > 0) {
		rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
	}
});

describe("GET /api/config/strategy sessionPace", () => {
	it("reports the running session-pace instance's settings set through env", async () => {
		process.env.LB_STRATEGY = "session-pace";
		setPaceEnv({
			workDays: "6",
			familyGuardPct: "80",
			fiveHourGuardPct: "75",
			tieBandPct: "5",
			idleMs: "1800000",
		});
		const config = makeConfig();
		const running = new SessionPaceStrategy(sessionPaceOptionsFrom(config), {
			timeZone: INSTANCE_ZONE,
		});

		expect(await strategyBody(config, running)).toEqual({
			strategy: "session-pace",
			strategySource: "env",
			sessionPace: {
				workDays: 6,
				familyGuardPct: 80,
				fiveHourGuardPct: 75,
				tieBandPct: 5,
				idleMs: 1800000,
				timeZone: "Pacific/Auckland",
			},
			...defaultForecastFields(),
		});
	});

	it("reports the zone the running instance splits days in", async () => {
		process.env.LB_STRATEGY = "session-pace";
		const config = makeConfig();
		const running = new SessionPaceStrategy(sessionPaceOptionsFrom(config), {
			timeZone: INSTANCE_ZONE,
		});

		const body = await strategyBody(config, running);
		const sessionPace = body.sessionPace as Record<string, unknown>;
		expect(sessionPace.timeZone).toBe(running.paceBasis.timeZone);
		expect(sessionPace.timeZone).toBe(INSTANCE_ZONE);
	});

	it("reports what buildStrategy gave the session-pace instance", async () => {
		process.env.LB_STRATEGY = "session-pace";
		setPaceEnv({
			workDays: "7",
			familyGuardPct: "85",
			fiveHourGuardPct: "70",
			tieBandPct: "15",
			idleMs: "600000",
		});
		const config = makeConfig();
		const running = buildStrategy(
			config.getStrategy(),
			FIVE_HOURS_MS,
			sessionPaceOptionsFrom(config),
		);
		expect(running).toBeInstanceOf(SessionPaceStrategy);

		const body = await strategyBody(config, running);
		expect(body.sessionPace).toEqual({
			workDays: 7,
			familyGuardPct: 85,
			fiveHourGuardPct: 70,
			tieBandPct: 15,
			idleMs: 600000,
			timeZone: (running as SessionPaceStrategy).paceBasis.timeZone,
		});
	});

	it("reads an invalid work-days env value as 5", async () => {
		process.env.LB_STRATEGY = "session-pace";
		process.env.SESSION_PACE_WORK_DAYS = "8";
		const config = makeConfig();
		const running = new SessionPaceStrategy(sessionPaceOptionsFrom(config), {
			timeZone: INSTANCE_ZONE,
		});

		const body = await strategyBody(config, running);
		expect((body.sessionPace as Record<string, unknown>).workDays).toBe(5);
	});

	it("warns once per distinct invalid work-days value however often the endpoint is polled", async () => {
		process.env.LB_STRATEGY = "least-used";
		const warn = spyOn(Logger.prototype, "warn");
		try {
			const config = makeConfig();
			const running = new LeastUsedStrategy();
			for (const value of ["0", "8", "0"]) {
				process.env.SESSION_PACE_WORK_DAYS = value;
				for (let i = 0; i < 5; i++) {
					const body = await strategyBody(config, running);
					expect((body.sessionPace as Record<string, unknown>).workDays).toBe(
						5,
					);
				}
			}
			const workDayWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("SESSION_PACE_WORK_DAYS"),
			);
			expect(workDayWarnings).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("reports values set through the config file", async () => {
		const config = makeConfig({
			lb_strategy: "session-pace",
			session_pace_work_days: 4,
			session_pace_family_guard_pct: 95,
			session_pace_five_hour_guard_pct: 60,
			session_pace_tie_band_pct: 20,
			session_pace_idle_ms: 7200000,
		});
		const running = new SessionPaceStrategy(sessionPaceOptionsFrom(config), {
			timeZone: INSTANCE_ZONE,
		});

		expect(await strategyBody(config, running)).toEqual({
			strategy: "session-pace",
			strategySource: "file",
			sessionPace: {
				workDays: 4,
				familyGuardPct: 95,
				fiveHourGuardPct: 60,
				tieBandPct: 20,
				idleMs: 7200000,
				timeZone: INSTANCE_ZONE,
			},
			...defaultForecastFields(),
		});
	});

	it("reports what session-pace would run with while another strategy runs", async () => {
		process.env.LB_STRATEGY = "least-used";
		setPaceEnv({
			workDays: "6",
			familyGuardPct: "80",
			fiveHourGuardPct: "75",
			tieBandPct: "5",
			idleMs: "1800000",
		});
		const config = makeConfig();
		const running = buildStrategy(
			config.getStrategy(),
			FIVE_HOURS_MS,
			sessionPaceOptionsFrom(config),
		);
		expect(running).toBeInstanceOf(LeastUsedStrategy);

		expect(await strategyBody(config, running)).toEqual({
			strategy: "least-used",
			strategySource: "env",
			sessionPace: {
				workDays: 6,
				familyGuardPct: 80,
				fiveHourGuardPct: 75,
				tieBandPct: 5,
				idleMs: 1800000,
				timeZone: "America/Denver",
			},
			...defaultForecastFields(),
		});
	});

	it("reports defaults and the start zone before any strategy is built", async () => {
		const config = makeConfig();
		expect(await strategyBody(config, null)).toEqual({
			strategy: "session",
			strategySource: "file",
			sessionPace: {
				workDays: 5,
				familyGuardPct: 90,
				fiveHourGuardPct: 90,
				tieBandPct: 10,
				idleMs: 3600000,
				timeZone: START_ZONE,
			},
			...defaultForecastFields(),
		});
	});

	it("keeps reporting the running instance until the strategy is rebuilt", async () => {
		process.env.LB_STRATEGY = "session-pace";
		process.env.SESSION_PACE_TIE_BAND_PCT = "5";
		const config = makeConfig();
		const running = new SessionPaceStrategy(sessionPaceOptionsFrom(config), {
			timeZone: INSTANCE_ZONE,
		});
		process.env.SESSION_PACE_TIE_BAND_PCT = "25";

		const before = await strategyBody(config, running);
		expect((before.sessionPace as Record<string, unknown>).tieBandPct).toBe(5);

		const rebuilt = buildStrategy(
			StrategyName.SessionPace,
			FIVE_HOURS_MS,
			sessionPaceOptionsFrom(config),
		);
		const after = await strategyBody(config, rebuilt);
		expect((after.sessionPace as Record<string, unknown>).tieBandPct).toBe(25);
	});

	it("reports the same start zone before and after a switch to session-pace", async () => {
		process.env.LB_STRATEGY = "least-used";
		const config = makeConfig();
		const before = buildStrategy(
			config.getStrategy(),
			FIVE_HOURS_MS,
			sessionPaceOptionsFrom(config),
			START_ZONE,
		);
		const beforeBody = await strategyBody(config, before);
		expect((beforeBody.sessionPace as Record<string, unknown>).timeZone).toBe(
			START_ZONE,
		);

		process.env.LB_STRATEGY = "session-pace";
		const after = buildStrategy(
			config.getStrategy(),
			FIVE_HOURS_MS,
			sessionPaceOptionsFrom(config),
			START_ZONE,
		);
		expect(after).toBeInstanceOf(SessionPaceStrategy);
		expect((after as SessionPaceStrategy).paceBasis.timeZone).toBe(START_ZONE);
		const afterBody = await strategyBody(config, after);
		expect(afterBody.strategy).toBe("session-pace");
		expect((afterBody.sessionPace as Record<string, unknown>).timeZone).toBe(
			START_ZONE,
		);
	});

	it("adds no keys beyond strategy, strategySource, the six sessionPace fields and the forecast fields", async () => {
		for (const strategy of ["session-pace", "session"]) {
			process.env.LB_STRATEGY = strategy;
			const config = makeConfig();
			const running = buildStrategy(
				config.getStrategy(),
				FIVE_HOURS_MS,
				sessionPaceOptionsFrom(config),
			);
			const body = await strategyBody(config, running);

			expect(Object.keys(body).sort()).toEqual([
				"forecast",
				"forecastSettings",
				"sessionPace",
				"strategy",
				"strategySource",
			]);
			const sessionPace = body.sessionPace as Record<string, unknown>;
			expect(Object.keys(sessionPace).sort()).toEqual([
				"familyGuardPct",
				"fiveHourGuardPct",
				"idleMs",
				"tieBandPct",
				"timeZone",
				"workDays",
			]);
			for (const key of [
				"workDays",
				"familyGuardPct",
				"fiveHourGuardPct",
				"tieBandPct",
				"idleMs",
			]) {
				expect(typeof sessionPace[key]).toBe("number");
			}
			expect(typeof sessionPace.timeZone).toBe("string");
		}
	});
});

describe("GET /api/config/strategy forecast fields", () => {
	const FORECAST_SETTINGS_KEYS = [
		"claudePath",
		"enabled",
		"fanLevels",
		"historyHalfLifeDays",
		"historyLookbackDays",
		"minStopPoints",
		"moveMinGainPoints",
		"openMinGainPoints",
		"prewarm",
		"prewarmMaxPerDay",
		"prewarmModel",
		"prewarmTest",
		"recentTauMin",
		"routing",
		"sessionTurnoverMin",
		"simulatedDays",
		"timeShiftMin",
		"transcriptsDir",
		"workStartSharePct",
	];

	it("has exactly these keys with the forecast on, and every existing field unchanged", async () => {
		process.env.LB_STRATEGY = "session-pace";
		const config = makeConfig();
		const body = await strategyBody(config, null);
		expect(Object.keys(body)).toEqual([
			"strategy",
			"strategySource",
			"sessionPace",
			"forecastSettings",
			"forecast",
		]);
		expect(body.strategy).toBe("session-pace");
		expect(body.strategySource).toBe("env");
		expect(body.forecast).toEqual({
			path: "/api/forecast",
			contractVersion: 1,
		});
		expect(
			Object.keys(body.forecastSettings as Record<string, unknown>).sort(),
		).toEqual(FORECAST_SETTINGS_KEYS);
		expect(body.forecastSettings).toEqual(
			defaultForecastFields().forecastSettings,
		);
	});

	it("has forecastSettings but no discovery field with the forecast off (environment)", async () => {
		process.env.FORECAST_ENABLED = "false";
		const config = makeConfig();
		const body = await strategyBody(config, null);
		expect(Object.keys(body)).toEqual([
			"strategy",
			"strategySource",
			"sessionPace",
			"forecastSettings",
		]);
		expect((body.forecastSettings as Record<string, unknown>).enabled).toBe(
			false,
		);
		expect(
			Object.keys(body.forecastSettings as Record<string, unknown>).sort(),
		).toEqual(FORECAST_SETTINGS_KEYS);
	});

	it("reports the forecast off from the config file, and the environment wins over it", async () => {
		const config = makeConfig({
			forecast_enabled: false,
			forecast_simulated_days: 800,
			forecast_fan_levels: [90, 20, 20, 50, 80],
		});
		const off = await strategyBody(config, null);
		expect("forecast" in off).toBe(false);
		const settings = off.forecastSettings as Record<string, unknown>;
		expect(settings.simulatedDays).toBe(800);
		expect(settings.fanLevels).toEqual([20, 80]);

		process.env.FORECAST_ENABLED = "true";
		process.env.FORECAST_SIMULATED_DAYS = "9";
		const on = await strategyBody(config, null);
		expect(on.forecast).toEqual({ path: "/api/forecast", contractVersion: 1 });
		expect((on.forecastSettings as Record<string, unknown>).simulatedDays).toBe(
			50,
		);
	});

	it("warns once per distinct invalid forecast value however often the endpoint is polled", async () => {
		const warn = spyOn(Logger.prototype, "warn");
		try {
			const config = makeConfig();
			process.env.FORECAST_PREWARM = "sometimes";
			for (let i = 0; i < 5; i++) {
				const body = await strategyBody(config, null);
				expect((body.forecastSettings as Record<string, unknown>).prewarm).toBe(
					false,
				);
			}
			const warnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("FORECAST_PREWARM"),
			);
			expect(warnings).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
