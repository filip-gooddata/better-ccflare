import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
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

const ENV_KEYS = [
	"LB_STRATEGY",
	"SESSION_PACE_WORK_DAYS",
	"SESSION_PACE_FAMILY_GUARD_PCT",
	"SESSION_PACE_FIVE_HOUR_GUARD_PCT",
	"SESSION_PACE_TIE_BAND_PCT",
	"SESSION_PACE_IDLE_MS",
] as const;

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

	it("does not repeat the invalid work-days warning when the endpoint is polled", async () => {
		process.env.LB_STRATEGY = "least-used";
		process.env.SESSION_PACE_WORK_DAYS = "0";
		const warn = spyOn(Logger.prototype, "warn");
		try {
			const config = makeConfig();
			const running = new LeastUsedStrategy();
			for (let i = 0; i < 5; i++) {
				const body = await strategyBody(config, running);
				expect((body.sessionPace as Record<string, unknown>).workDays).toBe(5);
			}
			const workDayWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("SESSION_PACE_WORK_DAYS"),
			);
			expect(workDayWarnings).toHaveLength(1);
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

	it("adds no keys beyond strategy, strategySource and the six sessionPace fields", async () => {
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
