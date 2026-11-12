import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type {
	SessionPaceSettings,
	StrategyConfigResponse,
} from "@better-ccflare/types";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

const pace: SessionPaceSettings = {
	workDays: 5,
	familyGuardPct: 90,
	fiveHourGuardPct: 85,
	tieBandPct: 3,
	idleMs: 600_000,
	timeZone: "Europe/Prague",
};

describe("APIRouter — GET /api/config/strategy", () => {
	let db: Database;
	let router: APIRouter;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			onRequestsDeleted: () => () => {},
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		} as unknown as DatabaseOperations;
		const config = {
			getStrategy: () => "session_pace",
			getStrategySource: () => "env",
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const getSessionPaceSettings: APIContext["getSessionPaceSettings"] = () =>
			pace;
		const context = {
			db: adapter,
			config,
			dbOps,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
			getSessionPaceSettings,
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	afterEach(() => {
		db.close();
	});

	it("returns strategy, strategySource and sessionPace", async () => {
		const url = new URL("http://localhost/api/config/strategy");
		const res = await router.handleRequest(url, new Request(url));
		expect(res?.status).toBe(200);
		const expected: StrategyConfigResponse = {
			strategy: "session_pace",
			strategySource: "env",
			sessionPace: pace,
		};
		expect(await res?.json()).toEqual(expected);
	});
});
