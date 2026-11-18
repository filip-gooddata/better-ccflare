import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { type Config, resolveForecastSettings } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import {
	type ForecastResponse,
	type ForecastSettings,
	validateForecastResponse,
} from "@better-ccflare/forecast";
import type { ApiKey } from "@better-ccflare/types";
import { APIRouter } from "../router";
import { AuthService } from "../services/auth-service";
import type { APIContext } from "../types";

const SETTINGS: ForecastSettings = {
	...resolveForecastSettings({
		env: {},
		file: {},
		home: "/home/tester",
		warn: () => {},
	}),
	enabled: true,
	routing: true,
	prewarm: false,
};

const KEPT: ForecastResponse = {
	contractVersion: 1,
	computedAt: 1794486000000,
	available: false,
	reason: "insufficient_history",
	accounts: ["acct-a"],
	levels: { light: 10, typical: 50, heavy: 90 },
	day: null,
	week: null,
	fable: {},
	prewarm: { enabled: false, planned: [], last: [] },
};

const dbs: Database[] = [];
afterEach(() => {
	while (dbs.length) dbs.pop()?.close();
});

function makeRouter(opts: {
	enabled?: boolean;
	getForecast?: APIContext["getForecast"];
	apiKeys?: number;
}): { router: APIRouter; settingsReads: () => number } {
	const db = new Database(":memory:");
	dbs.push(db);
	ensureSchema(db);
	runMigrations(db);
	const adapter = new BunSqlAdapter(db);
	const dbOps = {
		getAdapter: () => adapter,
		onRequestsDeleted: () => () => {},
		countActiveApiKeys: async () => opts.apiKeys ?? 0,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
	let reads = 0;
	const config = {
		getStrategy: () => "session-pace",
		getStrategySource: () => "default",
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
		getForecastSettings: () => {
			reads++;
			return { ...SETTINGS, enabled: opts.enabled ?? true };
		},
	} as unknown as Config;
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
		getSessionPaceSettings: () => ({
			workDays: 5,
			familyGuardPct: 90,
			fiveHourGuardPct: 90,
			tieBandPct: 10,
			idleMs: 3_600_000,
			timeZone: "Europe/Prague",
		}),
		getForecast: opts.getForecast,
	} as unknown as APIContext;
	return { router: new APIRouter(context), settingsReads: () => reads };
}

async function get(router: APIRouter, path: string) {
	const url = new URL(`http://localhost${path}`);
	const res = await router.handleRequest(url, new Request(url));
	if (!res) throw new Error(`no route for ${path}`);
	return res;
}

describe("APIRouter — GET /api/forecast", () => {
	it("serves what the provider returns, unchanged, with no-store", async () => {
		let calls = 0;
		const { router } = makeRouter({
			getForecast: () => {
				calls++;
				return KEPT;
			},
		});
		const res = await get(router, "/api/forecast");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Content-Type")).toContain("application/json");
		expect(await res.json()).toEqual(KEPT);
		expect(calls).toBe(1);
	});

	it("serves the disabled shape when no provider is registered", async () => {
		const { router } = makeRouter({});
		const res = await get(router, "/api/forecast");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = await res.json();
		expect(body.available).toBe(false);
		expect(body.reason).toBe("disabled");
		expect(body.day).toBeNull();
		expect(body.week).toBeNull();
		expect(body.fable).toEqual({});
		// the spec promises prewarm whenever the forecast is switched on
		expect(body.prewarm).toEqual({ enabled: false, planned: [], last: [] });
		expect(validateForecastResponse(body)).toEqual([]);
	});

	it("serves the disabled shape and never asks the provider when switched off", async () => {
		let calls = 0;
		const { router } = makeRouter({
			enabled: false,
			getForecast: () => {
				calls++;
				return KEPT;
			},
		});
		const res = await get(router, "/api/forecast");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = await res.json();
		expect(body.reason).toBe("disabled");
		expect(body.prewarm).toBeUndefined();
		expect(validateForecastResponse(body)).toEqual([]);
		expect(calls).toBe(0);
	});

	it("reads the enabled setting on each call", async () => {
		const { router, settingsReads } = makeRouter({ getForecast: () => KEPT });
		const before = settingsReads();
		await get(router, "/api/forecast");
		await get(router, "/api/forecast");
		expect(settingsReads() - before).toBe(2);
	});

	it("answers with reason error when the provider throws", async () => {
		const { router } = makeRouter({
			getForecast: () => {
				throw new Error("boom");
			},
		});
		const res = await get(router, "/api/forecast");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = await res.json();
		expect(body.reason).toBe("error");
		expect(body.prewarm).toEqual({ enabled: false, planned: [], last: [] });
		expect(validateForecastResponse(body)).toEqual([]);
	});

	it("holds no state: a fallback after a good response carries empty pre-warm lists", async () => {
		const prewarm = {
			enabled: true,
			planned: [{ accountId: "acct-a", openAt: 1794490000000 }],
			last: [],
		};
		let fail = false;
		const { router } = makeRouter({
			getForecast: () => {
				if (fail) throw new Error("boom");
				return { ...KEPT, prewarm };
			},
		});
		const good = await (await get(router, "/api/forecast")).json();
		expect(good.prewarm).toEqual(prewarm);
		fail = true;
		const body = await (await get(router, "/api/forecast")).json();
		expect(body.reason).toBe("error");
		expect(body.prewarm).toEqual({ enabled: false, planned: [], last: [] });
		expect(validateForecastResponse(body)).toEqual([]);
	});

	it("is GET only", async () => {
		const { router } = makeRouter({ getForecast: () => KEPT });
		const url = new URL("http://localhost/api/forecast");
		const res = await router.handleRequest(
			url,
			new Request(url, { method: "POST" }),
		);
		expect(res?.status ?? 404).not.toBe(200);
	});
});

describe("GET /api/forecast access rules match GET /api/config/strategy", () => {
	it("both answer without a key while no API key exists", async () => {
		const { router } = makeRouter({ getForecast: () => KEPT });
		expect((await get(router, "/api/config/strategy")).status).toBe(200);
		expect((await get(router, "/api/forecast")).status).toBe(200);
	});

	it("both refuse a request without a key once API keys exist", async () => {
		const { router } = makeRouter({ getForecast: () => KEPT, apiKeys: 1 });
		const strategy = await get(router, "/api/config/strategy");
		const forecast = await get(router, "/api/forecast");
		expect(strategy.status).toBe(401);
		expect(forecast.status).toBe(strategy.status);
	});

	it("both are exempt or not exempt alike, and authorised alike per key role", async () => {
		const auth = new AuthService({
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => [],
		} as unknown as DatabaseOperations);
		for (const method of ["GET"]) {
			expect(await auth.isPathExempt("/api/forecast", method)).toBe(
				await auth.isPathExempt("/api/config/strategy", method),
			);
		}
		for (const role of ["admin", "api-only"] as const) {
			const key = { role } as ApiKey;
			const forecast = await auth.authorizeEndpoint(
				key,
				"/api/forecast",
				"GET",
			);
			const strategy = await auth.authorizeEndpoint(
				key,
				"/api/config/strategy",
				"GET",
			);
			expect(forecast.authorized).toBe(strategy.authorized);
		}
	});
});

describe("APIRouter — GET /api/config/strategy forecast fields", () => {
	it("adds forecastSettings and the discovery field while enabled", async () => {
		const { router } = makeRouter({});
		const body = await (await get(router, "/api/config/strategy")).json();
		expect(Object.keys(body).sort()).toEqual([
			"forecast",
			"forecastSettings",
			"sessionPace",
			"strategy",
			"strategySource",
		]);
		expect(body.forecast).toEqual({
			path: "/api/forecast",
			contractVersion: 1,
		});
		expect(body.forecastSettings).toEqual({
			...SETTINGS,
			fanLevelCount: SETTINGS.fanLevels.length,
		});
	});

	it("keeps forecastSettings and drops the discovery field while disabled", async () => {
		const { router } = makeRouter({ enabled: false });
		const body = await (await get(router, "/api/config/strategy")).json();
		expect(Object.keys(body).sort()).toEqual([
			"forecastSettings",
			"sessionPace",
			"strategy",
			"strategySource",
		]);
		expect(body.forecastSettings.enabled).toBe(false);
	});
});
