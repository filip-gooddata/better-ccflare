/**
 * End-to-end tests of the forecast wiring: a sandbox database, the real
 * service, scheduler, store and tracker, the real engine where the history
 * allows it, a fake usage cache, fake timers and a fake pre-warm runner. No
 * test starts the `claude` CLI or reaches anything but localhost.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, resolveForecastSettings } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	disabledForecastResponse,
	type EpochMs,
	FORECAST_MIN_SPACING_MS,
	FORECAST_POLL_SETTLE_MS,
	FORECAST_STALE_POLLS,
	type ForecastInput,
	type ForecastResponse,
	type ForecastResult,
	type ForecastSettings,
	type PaceContext,
	type PlacementAdvice,
	type Plan,
	PROXY_SYNC_LAST,
	PROXY_SYNC_MARKER,
	type PrewarmRunResult,
	type SessionTrackerLike,
	validateForecastResponse,
} from "@better-ccflare/forecast";
import { type APIContext, APIRouter } from "@better-ccflare/http-api";
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import { Logger } from "@better-ccflare/logger";
import type { UsageData } from "@better-ccflare/providers";
import type {
	Account,
	RequestMeta,
	StrategyStore,
	StrategyUsageWindow,
} from "@better-ccflare/types";
import {
	buildInput,
	replayFixture,
} from "../../../packages/forecast/src/engine/__tests__/fixtures-engine";
import { createUnservedApiGuard } from "./api-guard";
import {
	awaitForecastStop,
	createForecastWiring,
	type ForecastRunnerContext,
	type ForecastWiring,
	loadClaudeLimits,
} from "./forecast-wiring";
import {
	createUsageSnapshotRecorder,
	setUsageSnapshotListener,
} from "./server";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const POLL = 90_000;
const NOW = Date.parse("2026-11-11T15:30:00Z");
const PACE: PaceContext = {
	timeZone: "Europe/Prague",
	workDays: 5,
	fiveHourGuardPct: 90,
	idleMs: 10 * MIN,
};

// ── sandbox ──────────────────────────────────────────────────────────────

const dirs: string[] = [];
const dbs: DatabaseOperations[] = [];
const wirings: ForecastWiring[] = [];
afterAll(async () => {
	for (const wiring of wirings) await wiring.stop();
	for (const db of dbs) await db.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "forecast-wiring-"));
	dirs.push(dir);
	return dir;
}

function tempDb(): DatabaseOperations {
	const db = new DatabaseOperations(join(tempDir(), "test.db"));
	dbs.push(db);
	return db;
}

const HOME = tempDir();

/** Defaults from the resolver, single fields overridden. */
function forecastSettings(
	over: Partial<ForecastSettings> = {},
): ForecastSettings {
	return {
		...resolveForecastSettings({
			env: {},
			file: {},
			home: HOME,
			warn: () => {},
		}),
		enabled: true,
		...over,
	};
}

async function insertClaude(
	dbOps: DatabaseOperations,
	id: string,
	name: string,
	over: { paused?: number; requiresReauth?: number; cooldown?: number } = {},
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, paused, requires_reauth, rate_limited_until)
			 VALUES (?, ?, 'anthropic', ?, ?, ?, ?, ?, ?)`,
		[
			id,
			name,
			`rt-${id}`,
			`at-${id}`,
			NOW,
			over.paused ?? 0,
			over.requiresReauth ?? 0,
			over.cooldown ?? null,
		],
	);
}

async function insertApiKeyAccount(
	dbOps: DatabaseOperations,
	id: string,
	provider: string,
): Promise<void> {
	// API-key accounts carry the key in both token fields.
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, 'key', 'key', ?)`,
		[id, `${id}-name`, provider, NOW],
	);
}

/** A clock and timers that only move when a test advances them. */
class FakeTime {
	now: EpochMs;
	private next = 1;
	pending: { id: number; at: EpochMs; fn: () => void }[] = [];
	sets = 0;
	constructor(now: EpochMs) {
		this.now = now;
	}
	clock = { now: () => this.now };
	timer = {
		set: (fn: () => void, ms: number) => {
			this.sets++;
			const id = this.next++;
			this.pending.push({ id, at: this.now + ms, fn });
			return id;
		},
		clear: (handle: unknown) => {
			this.pending = this.pending.filter((p) => p.id !== handle);
		},
	};
	async advance(ms: number) {
		const end = this.now + ms;
		for (;;) {
			const due = this.pending
				.filter((p) => p.at <= end)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.pending = this.pending.filter((p) => p !== due);
			this.now = Math.max(this.now, due.at);
			due.fn();
			await flush();
		}
		this.now = end;
		await flush();
	}
}

const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
};

class FakeRunner {
	calls: string[] = [];
	contexts: ForecastRunnerContext[] = [];
	/** While set, a run stays in flight until it resolves. */
	gate: Promise<void> | null = null;
	factory = (context: ForecastRunnerContext) => {
		this.contexts.push(context);
		return {
			run: async (accountId: string): Promise<PrewarmRunResult> => {
				this.calls.push(accountId);
				if (this.gate) await this.gate;
				return { exitCode: 0, durationMs: 5, error: null };
			},
		};
	};
}

class Lines {
	lines: string[] = [];
	info = (m: string) => {
		this.lines.push(m);
	};
	warn = (m: string) => {
		this.lines.push(`WARN ${m}`);
	};
}

interface Harness {
	wiring: ForecastWiring;
	time: FakeTime;
	runner: FakeRunner;
	logs: Lines;
	usage: Map<string, UsageData>;
	setSettings(over: Partial<ForecastSettings>): void;
}

function wire(opts: {
	dbOps: DatabaseOperations;
	settings?: Partial<ForecastSettings>;
	now?: EpochMs;
	pace?: PaceContext;
	engine?: { compute(input: ForecastInput): Promise<ForecastResult> };
	tracker?: SessionTrackerLike;
	usage?: Map<string, UsageData>;
	time?: FakeTime;
}): Harness {
	let settings = forecastSettings(opts.settings);
	const time = opts.time ?? new FakeTime(opts.now ?? NOW);
	const runner = new FakeRunner();
	const logs = new Lines();
	const usage = opts.usage ?? new Map<string, UsageData>();
	const wiring = createForecastWiring({
		config: {
			getForecastSettings: () => settings,
			getUsagePollIntervalMs: () => POLL,
		},
		dbOps: opts.dbOps,
		usage: { get: (id) => usage.get(id) ?? null },
		pace: () => opts.pace ?? PACE,
		proxyPort: () => 18080,
		createRunner: runner.factory,
		engine: opts.engine,
		tracker: opts.tracker,
		clock: time.clock,
		timer: time.timer,
		logger: logs,
	});
	wirings.push(wiring);
	return {
		wiring,
		time,
		runner,
		logs,
		usage,
		setSettings(over) {
			settings = { ...settings, ...over };
		},
	};
}

function routerFor(
	provider: (() => ForecastResponse) | undefined,
	settings: () => ForecastSettings,
): APIRouter {
	const config = {
		getStrategy: () => "session-pace",
		getStrategySource: () => "default",
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
		getForecastSettings: settings,
	} as unknown as Config;
	const routerDb = tempDb();
	return new APIRouter({
		db: routerDb.getAdapter(),
		config,
		dbOps: routerDb,
		alertService: {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		},
		getSessionPaceSettings: () => ({
			...PACE,
			familyGuardPct: 90,
			tieBandPct: 10,
		}),
		getForecast: provider,
	} as unknown as APIContext);
}

async function get(router: APIRouter, path: string) {
	const url = new URL(`http://localhost${path}`);
	const res = await router.handleRequest(url, new Request(url));
	if (!res) throw new Error(`no route for ${path}`);
	return res;
}

/** An available result whose plan carries the given advice. */
function availableResult(
	now: EpochMs,
	plan: Partial<Plan> = {},
): ForecastResult {
	return {
		available: true,
		response: {
			...disabledForecastResponse(now),
			available: true,
			reason: null,
		},
		plan: {
			computedAt: now,
			openAt: {},
			placement: null,
			moves: [],
			workStartMinute: null,
			...plan,
		},
	};
}

class RecordingEngine {
	inputs: ForecastInput[] = [];
	running = 0;
	maxRunning = 0;
	gate: Promise<void> | null = null;
	fail = false;
	constructor(private make: (input: ForecastInput) => ForecastResult) {}
	compute = async (input: ForecastInput): Promise<ForecastResult> => {
		this.inputs.push(input);
		this.running++;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		try {
			if (this.gate) await this.gate;
			if (this.fail) throw new Error("engine boom");
			return this.make(input);
		} finally {
			this.running--;
		}
	};
}

// ── synthetic history in the sandbox database (real engine) ─────────────

async function seedReplay(
	dbOps: DatabaseOperations,
	historyDays: number,
): Promise<{ input: ForecastInput; usage: Map<string, UsageData> }> {
	const input = buildInput(replayFixture({ historyDays }));
	for (const account of input.accounts) {
		await insertClaude(dbOps, account.accountId, account.name);
	}
	await dbOps.upsertForecastDemand(
		input.accountHistory.map((b) => ({
			bucketStart: b.start,
			accountId: b.accountId,
			source: "proxy",
			units: b.units,
			fableUnits: b.fableUnits,
			requestCount: b.requests,
		})),
	);
	// The demand came from the fixture, not from `requests`: mark the first
	// sync done so a cycle only recomputes the last hour.
	await dbOps.setForecastMeta(PROXY_SYNC_MARKER, String(input.now));
	await dbOps.setForecastMeta(PROXY_SYNC_LAST, String(input.now));
	for (const r of input.readings) {
		await dbOps.recordUsageSnapshot(
			r.accountId,
			{
				[r.window]: {
					utilization: r.usedPct,
					resets_at: r.resetsAt ? new Date(r.resetsAt).toISOString() : null,
				},
			},
			r.at,
		);
	}
	const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
	const usage = new Map<string, UsageData>();
	for (const a of input.accounts) {
		usage.set(a.accountId, {
			...(a.fiveHour.resetsAt
				? {
						five_hour: {
							utilization: a.fiveHour.usedPct,
							resets_at: iso(a.fiveHour.resetsAt),
						},
					}
				: {}),
			seven_day: {
				utilization: a.weekly.usedPct,
				resets_at: iso(a.weekly.resetsAt),
			},
		} as UsageData);
	}
	return { input, usage };
}

// ── tests ────────────────────────────────────────────────────────────────

describe("usage snapshot hook", () => {
	afterEach(() => setUsageSnapshotListener(null));

	it("tells the listener after an Anthropic snapshot is recorded, not for other providers", async () => {
		const dbOps = tempDb();
		const seen: string[] = [];
		setUsageSnapshotListener((id) => seen.push(id));
		const logger = new Logger("test");
		const data = {
			five_hour: { utilization: 12, resets_at: null },
		} as unknown as UsageData;
		await createUsageSnapshotRecorder(
			{ id: "c1", name: "c1", provider: "anthropic" },
			dbOps,
			logger,
		)("c1", data);
		await createUsageSnapshotRecorder(
			{ id: "z1", name: "z1", provider: "zai" },
			dbOps,
			logger,
		)("z1", data);
		expect(seen).toEqual(["c1"]);
	});

	it("passes when the reading arrived, not when persistence finished", async () => {
		const dbOps = tempDb();
		let persistedAt = 0;
		const slowDb = new Proxy(dbOps, {
			get(target, prop, receiver) {
				if (prop === "recordUsageSnapshot") {
					return async (...args: unknown[]) => {
						await new Promise((resolve) => setTimeout(resolve, 25));
						persistedAt = Date.now();
						return (
							target.recordUsageSnapshot as (...a: unknown[]) => unknown
						).apply(target, args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const seen: Array<[string, number]> = [];
		setUsageSnapshotListener((id, readAt) => seen.push([id, readAt]));
		const before = Date.now();
		await createUsageSnapshotRecorder(
			{ id: "c1", name: "c1", provider: "anthropic" },
			slowDb,
			new Logger("test"),
		)("c1", {
			five_hour: { utilization: 5, resets_at: null },
		} as unknown as UsageData);
		expect(seen).toHaveLength(1);
		expect(seen[0][1]).toBeGreaterThanOrEqual(before);
		expect(seen[0][1]).toBeLessThan(persistedAt);
	});

	it("keeps recording when the listener throws", async () => {
		const dbOps = tempDb();
		setUsageSnapshotListener(() => {
			throw new Error("listener boom");
		});
		await expect(
			createUsageSnapshotRecorder(
				{ id: "c1", name: "c1", provider: "anthropic" },
				dbOps,
				new Logger("test"),
			)("c1", {
				five_hour: { utilization: 5, resets_at: null },
			} as unknown as UsageData),
		).resolves.toBeUndefined();
	});
});

describe("loadClaudeLimits", () => {
	it("stamps readAt with when the reading arrived, else the load time", async () => {
		const dbOps = tempDb();
		await insertClaude(dbOps, "a", "alpha");
		await insertClaude(dbOps, "b", "beta");
		const limits = await loadClaudeLimits(
			dbOps,
			{ get: () => ({}) as UsageData },
			NOW,
			(id) => (id === "a" ? NOW - 2 * MIN : null),
		);
		const readAt = new Map(limits.map((l) => [l.accountId, l.readAt]));
		expect(readAt.get("a")).toBe(NOW - 2 * MIN);
		expect(readAt.get("b")).toBe(NOW);
	});

	it("reads Claude OAuth accounts only, with counted, cooldown and closed windows", async () => {
		const dbOps = tempDb();
		await insertClaude(dbOps, "a", "alpha");
		await insertClaude(dbOps, "p", "paused", { paused: 1 });
		await insertClaude(dbOps, "r", "reauth", { requiresReauth: 1 });
		await insertClaude(dbOps, "c", "cool", { cooldown: NOW + HOUR });
		await insertApiKeyAccount(dbOps, "k", "anthropic");
		await insertApiKeyAccount(dbOps, "z", "zai");
		const usage = new Map<string, UsageData>([
			[
				"a",
				{
					five_hour: {
						utilization: 40,
						resets_at: new Date(NOW + HOUR).toISOString(),
					},
					seven_day: {
						utilization: 30,
						resets_at: new Date(NOW - MIN).toISOString(),
					},
					seven_day_fable: {
						utilization: 7,
						resets_at: new Date(NOW + DAY).toISOString(),
					},
				} as UsageData,
			],
		]);
		const limits = await loadClaudeLimits(
			dbOps,
			{ get: (id) => usage.get(id) ?? null },
			NOW,
		);
		const byId = new Map(limits.map((l) => [l.accountId, l]));
		expect([...byId.keys()].sort()).toEqual(["a", "c", "p", "r"]);
		const a = byId.get("a");
		expect(a?.counted).toBe(true);
		expect(a?.fiveHour).toEqual({ usedPct: 40, resetsAt: NOW + HOUR });
		// A weekly reset that has passed reads as a closed window.
		expect(a?.weekly).toEqual({ usedPct: 0, resetsAt: null });
		expect(a?.fable).toEqual({ usedPct: 7, resetsAt: NOW + DAY });
		expect(byId.get("p")?.counted).toBe(false);
		expect(byId.get("r")?.counted).toBe(false);
		expect(byId.get("c")?.blockedUntil).toBe(NOW + HOUR);
		expect(byId.get("c")?.fiveHour).toEqual({ usedPct: 0, resetsAt: null });
	});
});

describe("forecast on: a poll computes and /api/forecast serves it (real engine)", () => {
	afterEach(() => setUsageSnapshotListener(null));

	it("serves a valid available forecast with prewarm after one usage poll", async () => {
		const dbOps = tempDb();
		const { input, usage } = await seedReplay(dbOps, 28);
		const h = wire({ dbOps, now: input.now, pace: input.pace, usage });
		const router = routerFor(h.wiring.provider, () => forecastSettings());

		// Before any poll: the "error" shape (nothing kept yet), with prewarm.
		const before = await (await get(router, "/api/forecast")).json();
		expect(before.available).toBe(false);
		expect(before.reason).toBe("error");

		// One usage poll through the real recorder and the server's listener.
		setUsageSnapshotListener((id) => h.wiring.onUsageSnapshot(id));
		await createUsageSnapshotRecorder(
			{ id: "acct-a", name: "acct-a", provider: "anthropic" },
			dbOps,
			new Logger("test"),
		)("acct-a", usage.get("acct-a") as UsageData);
		await h.time.advance(FORECAST_POLL_SETTLE_MS);
		await h.wiring.service?.idle();

		const res = await get(router, "/api/forecast");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(validateForecastResponse(body)).toEqual([]);
		expect(body.available).toBe(true);
		expect(body.accounts.sort()).toEqual(["acct-a", "acct-b"]);
		expect(body.prewarm).toEqual({
			enabled: false,
			planned: expect.any(Array),
			last: [],
		});

		const strategy = await (await get(router, "/api/config/strategy")).json();
		expect(strategy.forecast).toEqual({
			path: "/api/forecast",
			contractVersion: 1,
		});
	}, 60_000);

	it("answers insufficient_history when the sandbox has too little history", async () => {
		// One recorded day under the default lookback: the days before the
		// store's earliest bucket are not counted as zero demand.
		const dbOps = tempDb();
		const { input, usage } = await seedReplay(dbOps, 1);
		const h = wire({ dbOps, now: input.now, pace: input.pace, usage });
		await h.wiring.service?.runOnce();
		const body = await (
			await get(
				routerFor(h.wiring.provider, () => forecastSettings()),
				"/api/forecast",
			)
		).json();
		expect(validateForecastResponse(body)).toEqual([]);
		expect(body.available).toBe(false);
		expect(body.reason).toBe("insufficient_history");
		expect(body.prewarm).toBeDefined();
	}, 60_000);
});

describe("forecast disabled at start-up", () => {
	it("constructs nothing, sets no timer, and the endpoint answers disabled", async () => {
		const dbOps = tempDb();
		const h = wire({ dbOps, settings: { enabled: false } });
		expect(h.wiring.service).toBeNull();
		expect(h.wiring.provider).toBeUndefined();
		expect(h.wiring.servedUsageSink).toBeUndefined();
		h.wiring.onUsageSnapshot("x");
		const strategy = new SessionPaceStrategy({}, { timeZone: PACE.timeZone });
		h.wiring.attachToStrategy(strategy);
		await h.time.advance(10 * MIN);
		expect(h.time.sets).toBe(0);
		expect(h.runner.contexts).toHaveLength(0);
		const body = await (
			await get(
				routerFor(h.wiring.provider, () =>
					forecastSettings({ enabled: false }),
				),
				"/api/forecast",
			)
		).json();
		expect(body.available).toBe(false);
		expect(body.reason).toBe("disabled");
		await h.wiring.stop();
	});
});

// ── routing ──────────────────────────────────────────────────────────────

function makeAccount(id: string): Account {
	return {
		id,
		name: `${id}-name`,
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: NOW + HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
	} as Account;
}

class UsageStore implements StrategyStore {
	weekly = new Map<string, StrategyUsageWindow>();
	resetAccountSession(): void {}
	resumeAccount(): void {}
	getAccountUtilization(): number | null {
		return null;
	}
	getAccountWeeklyWindow(id: string): StrategyUsageWindow | null {
		return this.weekly.get(id) ?? null;
	}
	getAccountFiveHourWindow(): StrategyUsageWindow | null {
		return { utilization: 20, resetsAt: NOW + HOUR };
	}
	getAccountModelFamilyWindows(): StrategyUsageWindow[] {
		return [];
	}
}

let reqCounter = 0;
function meta(session: string): RequestMeta {
	reqCounter++;
	return {
		id: `req-${reqCounter}`,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: session,
		routingModel: "claude-opus-5-5",
	};
}

function captureLines(strategy: SessionPaceStrategy): string[] {
	const lines: string[] = [];
	const log = (
		strategy as unknown as {
			log: { info: (m: string) => void; warn: (m: string) => void };
		}
	).log;
	log.info = (m: string) => lines.push(m);
	log.warn = (m: string) => lines.push(`WARN ${m}`);
	return lines;
}

function paceStrategy(): SessionPaceStrategy {
	const store = new UsageStore();
	// pace.3 alone prefers a (the larger weekly deficit) over b.
	store.weekly.set("a", { utilization: 20, resetsAt: NOW + 3.5 * DAY });
	store.weekly.set("b", { utilization: 50, resetsAt: NOW + 3.5 * DAY });
	const strategy = new SessionPaceStrategy({}, { timeZone: PACE.timeZone });
	strategy.initialize(store);
	return strategy;
}

const PLACE_B: PlacementAdvice = {
	tiers: [["b"], ["a"]],
	rule: "forecast-open",
	reason: "open-b",
};

describe("routing: the advisor drives session-pace", () => {
	const a = makeAccount("a");
	const b = makeAccount("b");
	beforeEach(() => setSystemTime(new Date(NOW)));
	afterEach(() => setSystemTime());

	function pace3First(session: string): string {
		return paceStrategy().select([a, b], meta(session))[0].id;
	}

	it("routing on: a forecast-driven placement and its one log line", async () => {
		expect(pace3First("s-base")).toBe("a");
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		const h = wire({ dbOps, settings: { routing: true }, engine });
		await h.wiring.service?.runOnce();
		const strategy = paceStrategy();
		h.wiring.attachToStrategy(strategy);
		const lines = captureLines(strategy);
		expect(strategy.select([a, b], meta("s-1"))[0].id).toBe("b");
		const placed = lines.filter((l) => l.includes("rule=forecast-open"));
		expect(placed).toHaveLength(1);
		expect(placed[0]).toStartWith("session-pace place session=");
		expect(placed[0]).toContain("account=b-name");
		expect(placed[0]).toContain("reason=open-b");
	});

	it("routing on and re-attached after a strategy hot reload", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		const h = wire({ dbOps, settings: { routing: true }, engine });
		await h.wiring.service?.runOnce();
		h.wiring.attachToStrategy(paceStrategy());
		const reloaded = paceStrategy();
		h.wiring.attachToStrategy(reloaded);
		expect(reloaded.select([a, b], meta("s-2"))[0].id).toBe("b");
	});

	it("routing off at start-up: session-pace gets no advisor", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		const h = wire({ dbOps, settings: { routing: false }, engine });
		await h.wiring.service?.runOnce();
		const strategy = paceStrategy();
		const set: unknown[] = [];
		const original = strategy.setForecastAdvisor.bind(strategy);
		strategy.setForecastAdvisor = (advisor) => {
			set.push(advisor);
			original(advisor);
		};
		h.wiring.attachToStrategy(strategy);
		expect(set).toEqual([null]);
		expect(strategy.select([a, b], meta("s-3"))[0].id).toBe("a");
	});

	it("an engine failure leaves the request to the pace.3 rules", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		engine.fail = true;
		const h = wire({ dbOps, settings: { routing: true }, engine });
		await h.wiring.service?.runOnce();
		const strategy = paceStrategy();
		h.wiring.attachToStrategy(strategy);
		expect(strategy.select([a, b], meta("s-4"))[0].id).toBe(pace3First("s-x"));
	});

	it("an advisor failure leaves the request to the pace.3 rules", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		const tracker: SessionTrackerLike = {
			observe: () => {},
			get: () => {
				throw new Error("tracker boom");
			},
			live: () => [],
			forget: () => {},
		};
		const h = wire({ dbOps, settings: { routing: true }, engine, tracker });
		await h.wiring.service?.runOnce();
		const strategy = paceStrategy();
		h.wiring.attachToStrategy(strategy);
		// A mapped session asks cacheTtlMs (tracker throws) on its next turn.
		strategy.select([a, b], meta("s-5"));
		expect(() => strategy.select([a, b], meta("s-5"))).not.toThrow();
		expect(() => h.wiring.service?.advisor.cacheTtlMs("s-5")).not.toThrow();
	});

	it("a non-session-pace strategy is left alone; the forecast is still served", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) => availableResult(i.now));
		const h = wire({ dbOps, settings: { routing: true }, engine });
		h.wiring.attachToStrategy({ select: () => [] });
		await h.wiring.service?.runOnce();
		expect(h.wiring.provider?.().available).toBe(true);
	});
});

// ── pre-warm ─────────────────────────────────────────────────────────────

describe("pre-warm through the wiring", () => {
	async function prewarmSetup(
		settings: Partial<ForecastSettings>,
		dbOps = tempDb(),
		time?: FakeTime,
		readings = true,
	) {
		if ((await dbOps.getAllAccounts()).length === 0) {
			await insertClaude(dbOps, "acct-a", "alpha");
			await insertClaude(dbOps, "acct-b", "beta");
		}
		// The plan wants acct-a's 5-hour window opened now.
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { openAt: { "acct-a": i.now - MIN } }),
		);
		const h = wire({ dbOps, settings, engine, time });
		if (readings) {
			// Current readings with no open window on either account.
			h.usage.set("acct-a", {} as UsageData);
			h.usage.set("acct-b", {} as UsageData);
		}
		return { dbOps, h };
	}

	async function polls(h: Harness, n: number) {
		for (let i = 0; i < n; i++) {
			h.wiring.onUsageSnapshot("acct-a");
			await h.time.advance(POLL);
			await h.wiring.service?.idle();
		}
	}

	it("control: with prewarm on, the plan's opening fires once, lazily reading the bound port", async () => {
		const { h } = await prewarmSetup({ prewarm: true });
		await polls(h, 3);
		expect(h.runner.calls).toEqual(["acct-a"]);
		expect(h.runner.contexts).toHaveLength(1);
		expect(h.runner.contexts[0].proxyPort).toBe(18080);
		expect(h.runner.contexts[0].proxyApiKey()).toBeNull();
	});

	it("shutdown: no pre-warm starts after stop, and the wait for one in flight is bounded", async () => {
		const { h } = await prewarmSetup({ prewarm: true });
		let release!: () => void;
		h.runner.gate = new Promise<void>((r) => {
			release = r;
		});
		h.wiring.onUsageSnapshot("acct-a");
		await h.time.advance(POLL);
		expect(h.runner.calls).toEqual(["acct-a"]);

		// Shutdown begins while the run is in flight; the drain budget runs out first.
		const stopping = h.wiring.stop();
		const bounded = awaitForecastStop(stopping, 15_000, h.time.timer);
		await h.time.advance(15_000);
		expect(await bounded).toBe(false);
		expect(h.time.pending).toHaveLength(0);

		// Stopped: later snapshots start no cycle and no second run.
		h.wiring.onUsageSnapshot("acct-b");
		await h.time.advance(10 * POLL);
		expect(h.runner.calls).toEqual(["acct-a"]);

		release();
		expect(await awaitForecastStop(stopping, 1_000, h.time.timer)).toBeTrue();
	});

	it("shutdown: a failing stop is reported and counts as finished", async () => {
		const time = new FakeTime(NOW);
		const errors: unknown[] = [];
		expect(
			await awaitForecastStop(
				Promise.reject(new Error("stop boom")),
				1_000,
				time.timer,
				(e) => errors.push(e),
			),
		).toBeTrue();
		expect(errors).toHaveLength(1);
		expect(time.pending).toHaveLength(0);
	});

	it("an account without a current usage reading is never pre-warmed", async () => {
		const { h } = await prewarmSetup(
			{ prewarm: true },
			tempDb(),
			undefined,
			false,
		);
		await polls(h, 3);
		expect(h.runner.calls).toEqual([]);
		h.usage.set("acct-a", {} as UsageData);
		await polls(h, 1);
		expect(h.runner.calls).toEqual(["acct-a"]);
	});

	it("judges windowOpened only from a reading taken after the run", async () => {
		const { h } = await prewarmSetup({ prewarm: true });
		await polls(h, 1);
		expect(h.runner.calls).toEqual(["acct-a"]);
		const last = () => h.wiring.provider?.().prewarm?.last[0];
		// Cycles driven by the other account leave acct-a's pre-run reading.
		for (let i = 0; i < 2; i++) {
			h.wiring.onUsageSnapshot("acct-b");
			await h.time.advance(POLL);
			await h.wiring.service?.idle();
		}
		expect(last()?.windowOpened).toBeNull();
		// A closed-window reading that arrived before the run but was persisted
		// after it still says nothing about the run.
		h.wiring.onUsageSnapshot("acct-a", h.time.now - 4 * POLL);
		await h.time.advance(POLL);
		await h.wiring.service?.idle();
		expect(last()?.windowOpened).toBeNull();
		h.usage.set("acct-a", {
			five_hour: {
				utilization: 1,
				resets_at: new Date(h.time.now + 5 * HOUR).toISOString(),
			},
		} as UsageData);
		h.wiring.onUsageSnapshot("acct-a");
		await h.time.advance(POLL);
		await h.wiring.service?.idle();
		expect(last()?.windowOpened).toBeTrue();
	});

	it("prewarm off: across several polls the runner is never called", async () => {
		const { h } = await prewarmSetup({ prewarm: false });
		await polls(h, 5);
		expect(h.runner.calls).toEqual([]);
		expect(h.runner.contexts).toHaveLength(0);
	});

	it("one-shot test mode fires once for the named account, never again after a restart", async () => {
		const at = NOW - MIN;
		const { dbOps, h } = await prewarmSetup({
			prewarm: false,
			prewarmTest: { account: "beta", at },
		});
		await polls(h, 3);
		expect(h.runner.calls).toEqual(["acct-b"]);
		await h.wiring.stop();

		// Restart: a new wiring over the same database.
		const restarted = await prewarmSetup(
			{ prewarm: false, prewarmTest: { account: "beta", at } },
			dbOps,
			new FakeTime(h.time.now),
		);
		await polls(restarted.h, 3);
		expect(restarted.h.runner.calls).toEqual([]);
	});
});

// ── endpoint and API guard ───────────────────────────────────────────────

describe("/api/forecast is local; unknown /api paths still get the guard's 404", () => {
	it("never forwards to the upstream", async () => {
		let upstreamHits = 0;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				upstreamHits++;
				return new Response("{}");
			},
		});
		try {
			const dbOps = tempDb();
			const engine = new RecordingEngine((i) => availableResult(i.now));
			const h = wire({ dbOps, engine });
			await h.wiring.service?.runOnce();
			const router = routerFor(h.wiring.provider, () => forecastSettings());
			const guard = createUnservedApiGuard({ logger: new Lines() });
			// The server's order: API router, then the guard, then the proxy.
			const serve = async (path: string) => {
				const url = new URL(`http://localhost${path}`);
				const routed = await router.handleRequest(url, new Request(url));
				if (routed) return routed;
				const refused = guard(url, "GET");
				if (refused) return refused;
				return fetch(`http://127.0.0.1:${upstream.port}${path}`);
			};
			const forecast = await serve("/api/forecast");
			expect(forecast.status).toBe(200);
			expect((await forecast.json()).available).toBe(true);
			const unknown = await serve("/api/forecast/nope");
			expect(unknown.status).toBe(404);
			expect(upstreamHits).toBe(0);
		} finally {
			upstream.stop(true);
		}
	});
});

// ── concurrency and staleness ────────────────────────────────────────────

describe("computations do not overlap; a stale result gives no advice", () => {
	it("joins a running computation instead of starting a second one", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) => availableResult(i.now));
		let release!: () => void;
		engine.gate = new Promise<void>((r) => {
			release = r;
		});
		const h = wire({ dbOps, engine });
		const first = h.wiring.service?.runOnce();
		await flush();
		h.wiring.onUsageSnapshot("acct-a");
		await h.time.advance(FORECAST_POLL_SETTLE_MS);
		const second = h.wiring.service?.runOnce();
		await flush();
		expect(engine.running).toBe(1);
		release();
		await Promise.all([first, second]);
		// The snapshot seen mid-run is computed afterwards, after the spacing.
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.wiring.service?.idle();
		expect(engine.maxRunning).toBe(1);
		expect(engine.inputs).toHaveLength(2);
	});

	it("drops advice and serves the error shape once the result is stale", async () => {
		const dbOps = tempDb();
		const engine = new RecordingEngine((i) =>
			availableResult(i.now, { placement: PLACE_B }),
		);
		const h = wire({ dbOps, settings: { routing: true }, engine });
		await h.wiring.service?.runOnce();
		const advisor = h.wiring.service?.advisor;
		expect(advisor?.placeNewSession(h.time.now)).toEqual(PLACE_B);
		await h.time.advance(FORECAST_STALE_POLLS * POLL + MIN);
		expect(advisor?.placeNewSession(h.time.now)).toBeNull();
		const served = h.wiring.provider?.();
		expect(served?.available).toBe(false);
		expect(served?.reason).toBe("error");
	});
});
