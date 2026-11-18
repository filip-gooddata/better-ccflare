import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveForecastSettings } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import specFull from "../../contract/__tests__/fixtures/spec-example-full.json";
import { validateForecastResponse } from "../../contract/validate";
import type {
	PaceFitState,
	PaceSeries,
	PaceSeriesInput,
} from "../../engine/pace/types";
import { unavailableResponse } from "../../engine/response";
import {
	runTranscriptBackfill,
	TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
	TRANSCRIPT_BACKFILL_META_KEY,
	TRANSCRIPT_BACKFILL_WRITTEN_META_KEY,
} from "../../history/backfill";
import { createDemandStore } from "../../history/demand-store";
import type { ForecastDb } from "../../history/ports";
import {
	earliestProxyBucket,
	PROXY_SYNC_MARKER,
} from "../../history/proxy-demand";
import { sessionKey } from "../../history/session-key";
import {
	SESSION_SALT_META_KEY,
	type SessionRequestRow,
	USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
	USAGE_DETAIL_BACKFILL_META_KEY,
	type UsageDetailDb,
	type UsageTokenRow,
} from "../../history/usage-detail";
import {
	FakeRunner,
	FakeStore,
	limits,
	plan,
} from "../../prewarm/__tests__/fakes";
import {
	createPrewarmScheduler,
	type PrewarmScheduler,
} from "../../prewarm/scheduler";
import type {
	DemandStore,
	EpochMs,
	ForecastInput,
	ForecastInputsDetail,
	ForecastResponse,
	ForecastResult,
	ForecastSettings,
	LiveSession,
	MoveAdvice,
	PaceContext,
	PlacementAdvice,
	Plan,
	PrewarmStatus,
	SessionTrackerLike,
} from "../../types";
import { bucketStart } from "../../units";
import {
	PACE_REFIT_TIMEOUT_MS,
	type PaceRefitOutcome,
	type PaceRefitRunner,
} from "../pace-refit-runner";
import {
	createForecastService,
	FORECAST_MIN_SPACING_MS,
	FORECAST_POLL_SETTLE_MS,
	FORECAST_STALE_POLLS,
	type ForecastService,
	type ForecastServiceDeps,
	PACE_REFIT_CADENCE_MS,
	paceRefitRange,
} from "../service";

const MIN = 60_000;

/** Resolved defaults with single-field overrides; never a complete settings literal. */
function settings(over: Partial<ForecastSettings> = {}): ForecastSettings {
	return {
		...resolveForecastSettings({
			env: {},
			file: {},
			home: "/home/tester",
			warn: () => {},
		}),
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		transcriptsDir: null,
		...over,
	};
}
const T0 = Date.UTC(2026, 10, 12, 6, 0);
const POLL = 90_000;
const [A, B] = specFull.accounts as [string, string];

const dirs: string[] = [];
const dbs: DatabaseOperations[] = [];
afterAll(async () => {
	for (const db of dbs) await db.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): DatabaseOperations {
	const dir = mkdtempSync(join(tmpdir(), "forecast-service-"));
	dirs.push(dir);
	const db = new DatabaseOperations(join(dir, "test.db"));
	dbs.push(db);
	return db;
}

/** A clock and timers that only move when a test advances them. */
class FakeTime {
	now: EpochMs = T0;
	private next = 1;
	pending: { id: number; at: EpochMs; fn: () => void }[] = [];
	clock = { now: () => this.now };
	timer = {
		set: (fn: () => void, ms: number) => {
			const id = this.next++;
			this.pending.push({ id, at: this.now + ms, fn });
			return id;
		},
		clear: (handle: unknown) => {
			this.pending = this.pending.filter((p) => p.id !== handle);
		},
	};
	/** Moves the clock, running each timer that comes due, in order. */
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

class Deferred {
	promise: Promise<void>;
	resolve!: () => void;
	constructor() {
		this.promise = new Promise((r) => {
			this.resolve = r;
		});
	}
}

const placement: PlacementAdvice = {
	tiers: [[A], [B]],
	rule: "forecast-open",
	reason: "test",
};
const move: MoveAdvice = {
	sessionId: "s1",
	from: A,
	to: B,
	rule: "forecast-move",
	reason: "test",
	gainPoints: 3,
	costPoints: 1,
};

function availablePlan(now: EpochMs, openAt: Plan["openAt"] = {}): Plan {
	return { ...plan(openAt, now), placement, moves: [move] };
}

function available(now: EpochMs, p = availablePlan(now)): ForecastResult {
	return {
		available: true,
		response: specFull as ForecastResponse,
		plan: p,
	};
}

class FakeEngine {
	inputs: ForecastInput[] = [];
	active = 0;
	maxActive = 0;
	hold: Deferred | null = null;
	result: (input: ForecastInput) => ForecastResult = (i) => available(i.now);
	failWith: Error | null = null;
	constructor(private log: string[]) {}
	async compute(input: ForecastInput): Promise<ForecastResult> {
		this.log.push("engine");
		this.inputs.push(input);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.hold) await this.hold.promise;
			if (this.failWith) throw this.failWith;
			return this.result(input);
		} finally {
			this.active--;
		}
	}
}

class FakeDemandStore extends FakeStore implements DemandStore {
	constructor(private log: string[]) {
		super();
	}
	async upsert() {}
	async loadPooled() {
		this.log.push("store.loadPooled");
		return [];
	}
	async loadByAccount() {
		this.log.push("store.loadByAccount");
		return [];
	}
	/** Start of the earliest stored bucket; by default older than any lookback. */
	earliestAt: EpochMs | null = T0 - 400 * 24 * 60 * MIN;
	async earliest() {
		return this.earliestAt;
	}
}

class FakeTracker implements SessionTrackerLike {
	liveCalls: [EpochMs, number][] = [];
	constructor(private log: string[]) {}
	observe() {}
	get(sessionId: string): LiveSession | null {
		return sessionId === "s1"
			? {
					sessionId,
					accountId: A,
					family: "sonnet" as LiveSession["family"],
					lastRequestAt: T0,
					cacheTtlMs: 3_600_000,
					coldAt: null,
					contextTokens: 10,
					recentUnits: 1,
					warmUnits: 1,
				}
			: null;
	}
	live(now: EpochMs, maxIdleMs: number) {
		this.log.push("tracker.live");
		this.liveCalls.push([now, maxIdleMs]);
		return [];
	}
	forget() {}
}

class FakeScheduler implements PrewarmScheduler {
	ticks: EpochMs[] = [];
	stopped = false;
	onTick: (() => void) | null = null;
	idleGate: Deferred | null = null;
	state: PrewarmStatus = {
		enabled: true,
		planned: [{ accountId: A, openAt: T0 + 60 * MIN }],
		last: [],
	};
	constructor(private log: string[]) {}
	async tick(now: EpochMs) {
		this.log.push("scheduler.tick");
		this.ticks.push(now);
		this.onTick?.();
	}
	status() {
		return this.state;
	}
	async idle() {
		await this.idleGate?.promise;
	}
	stop() {
		this.stopped = true;
	}
}

const PACE: PaceContext = {
	timeZone: "Europe/Prague",
	workDays: 5,
	fiveHourGuardPct: 90,
	idleMs: 30 * MIN,
};

interface Harness {
	service: ForecastService;
	time: FakeTime;
	log: string[];
	warns: string[];
	infos: string[];
	engine: FakeEngine;
	tracker: FakeTracker;
	scheduler: FakeScheduler;
	settings: { current: ForecastSettings };
	backfills: string[];
	usageDetailBackfills: string[];
	store: FakeDemandStore;
	db: ForecastDb;
	failSync: { on: boolean };
}

/** Logs the forecast db calls; the sync's first call fails while failSync is on. */
function loggingDb(log: string[], failSync: { on: boolean }): ForecastDb {
	const real = tempDb() as unknown as ForecastDb;
	return new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				log.push(`db.${String(prop)}`);
				if (failSync.on && prop === "getForecastMeta")
					throw new Error("db locked");
				return value.apply(target, args);
			};
		},
	});
}

function harness(
	over: Partial<ForecastServiceDeps> & {
		settings?: Partial<ForecastSettings>;
		time?: FakeTime;
	} = {},
): Harness {
	const log: string[] = [];
	const warns: string[] = [];
	const infos: string[] = [];
	const backfills: string[] = [];
	const usageDetailBackfills: string[] = [];
	const time = over.time ?? new FakeTime();
	const engine = new FakeEngine(log);
	const tracker = new FakeTracker(log);
	const scheduler = new FakeScheduler(log);
	const current = { current: settings(over.settings) };
	const failSync = { on: false };
	const db = loggingDb(log, failSync);
	const store = new FakeDemandStore(log);
	const { settings: _s, time: _t, ...rest } = over;
	const service = createForecastService({
		settings: () => current.current,
		pace: () => PACE,
		db,
		store,
		engine,
		tracker,
		loadLimits: async (now) => {
			log.push("loadLimits");
			return [limits(A, now), limits(B, now, { counted: false })];
		},
		scheduler,
		backfill: async (dir) => {
			backfills.push(dir);
		},
		usageDetailBackfill: async (dir) => {
			usageDetailBackfills.push(dir);
		},
		clock: time.clock,
		timer: time.timer,
		pollIntervalMs: POLL,
		logger: {
			info: (m) => infos.push(m),
			warn: (m) => warns.push(m),
		},
		paceRefit: null,
		...rest,
	});
	return {
		service,
		time,
		log,
		warns,
		infos,
		engine,
		tracker,
		scheduler,
		settings: current,
		backfills,
		usageDetailBackfills,
		store,
		db,
		failSync,
	};
}

/** Every response the provider gives passes the contract validator. */
function serve(h: Harness): ForecastResponse {
	const response = h.service.provider();
	expect(validateForecastResponse(response)).toEqual([]);
	return response;
}

describe("forecast service: one cycle", () => {
	it("syncs, loads, computes, keeps and then ticks the scheduler, in that order", async () => {
		const h = harness();
		await h.service.runOnce();
		const first = (name: string) => h.log.indexOf(name);
		expect(first("db.getForecastMeta")).toBe(0);
		expect(first("db.getForecastMeta")).toBeLessThan(first("store.loadPooled"));
		expect(first("store.loadPooled")).toBeLessThan(first("loadLimits"));
		expect(first("db.getUsageSnapshotsBetween")).toBeLessThan(
			first("loadLimits"),
		);
		expect(first("loadLimits")).toBeLessThan(first("tracker.live"));
		expect(first("tracker.live")).toBeLessThan(first("engine"));
		expect(first("engine")).toBeLessThan(first("scheduler.tick"));
		expect(h.log.at(-1)).toBe("scheduler.tick");

		// the new result is kept before the tick reads it
		const next = harness({ settings: { prewarm: true } });
		const seen: (boolean | null)[] = [];
		next.scheduler.onTick = () =>
			seen.push(next.service.forecastView()?.available ?? null);
		await next.service.runOnce();
		expect(seen).toEqual([true]);

		const input = h.engine.inputs[0];
		expect(input?.now).toBe(T0);
		expect(input?.historyFrom).toBe(
			T0 - settings().historyLookbackDays * 24 * 60 * MIN,
		);
		expect(input?.pace).toBe(PACE);
		expect(input?.accounts.map((a) => a.accountId)).toEqual([A, B]);
		expect(h.tracker.liveCalls).toEqual([[T0, PACE.idleMs]]);
		expect(h.scheduler.ticks).toEqual([T0]);
		expect(h.service.limits().map((a) => a.accountId)).toEqual([A, B]);
		expect(serve(h).available).toBe(true);
		expect(h.warns).toEqual([]);
	});

	it("never runs two computations at once: a notify during a cycle gives exactly one follow-up", async () => {
		const h = harness();
		h.engine.hold = new Deferred();
		const first = h.service.runOnce();
		await flush();
		expect(h.engine.active).toBe(1);
		// joins the running cycle instead of starting another
		const joined = h.service.runOnce();
		for (let i = 0; i < 3; i++) {
			h.service.notifyUsagePoll();
			await h.time.advance(FORECAST_POLL_SETTLE_MS);
		}
		expect(h.engine.inputs.length).toBe(1);
		const hold = h.engine.hold;
		h.engine.hold = null;
		hold.resolve();
		await first;
		await joined;
		await flush();
		// the follow-up waits for the minimum spacing from the first start
		expect(h.engine.inputs.length).toBe(1);
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.idle();
		expect(h.engine.inputs.length).toBe(2);
		expect(h.engine.inputs[1]?.now).toBe(T0 + FORECAST_MIN_SPACING_MS);
		await h.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(h.engine.inputs.length).toBe(2);
		expect(h.engine.maxActive).toBe(1);
	});

	it("debounces usage snapshots and keeps the minimum spacing", async () => {
		const h = harness();
		h.service.notifyUsagePoll();
		await h.time.advance(3_000);
		h.service.notifyUsagePoll();
		await h.time.advance(FORECAST_POLL_SETTLE_MS - 1);
		expect(h.engine.inputs.length).toBe(0);
		await h.time.advance(1);
		await h.service.idle();
		expect(h.engine.inputs.map((i) => i.now)).toEqual([
			T0 + 3_000 + FORECAST_POLL_SETTLE_MS,
		]);
		const startedAt = T0 + 3_000 + FORECAST_POLL_SETTLE_MS;
		h.service.notifyUsagePoll();
		await h.time.advance(FORECAST_POLL_SETTLE_MS);
		expect(h.engine.inputs.length).toBe(1);
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.idle();
		expect(h.engine.inputs.map((i) => i.now)).toEqual([
			startedAt,
			startedAt + FORECAST_MIN_SPACING_MS,
		]);
	});

	it("a sync failure is logged and the cycle carries on", async () => {
		const h = harness();
		h.failSync.on = true;
		await h.service.runOnce();
		expect(h.engine.inputs.length).toBe(1);
		expect(h.scheduler.ticks.length).toBe(1);
		expect(h.warns.length).toBe(1);
		expect(h.warns[0]).toContain("sync=db locked");
		expect(serve(h).available).toBe(true);
	});

	it("a usage-detail failure is logged by name only and the demand sync still counts as done", async () => {
		const real = tempDb() as unknown as ForecastDb;
		const db = new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "replaceUsageTokens") {
					return async () => {
						const error = new Error("/private/conversation/path secret");
						error.name = "DiskFullError";
						throw error;
					};
				}
				return value.bind(target);
			},
		});
		const h = harness({ db, settings: { transcriptsDir: "/tmp/transcripts" } });
		await h.service.runOnce();
		await flush();
		expect(h.warns).toEqual([
			"forecast usage detail sync failed error=DiskFullError",
		]);
		expect(h.warns.join("\n")).not.toContain("secret");
		expect(h.backfills).toEqual(["/tmp/transcripts"]);
		expect(h.engine.inputs.length).toBe(1);
		expect(await real.getForecastMeta(PROXY_SYNC_MARKER)).not.toBeNull();
	});
});

describe("forecast service: history range", () => {
	it("starts the history at the earliest stored bucket inside the lookback", async () => {
		const h = harness();
		h.store.earliestAt = T0 - 2 * 24 * 60 * MIN;
		await h.service.runOnce();
		expect(h.engine.inputs[0]?.historyFrom).toBe(T0 - 2 * 24 * 60 * MIN);
	});

	it("an empty store gives an empty history range", async () => {
		const h = harness();
		h.store.earliestAt = null;
		await h.service.runOnce();
		expect(h.engine.inputs[0]?.historyFrom).toBe(T0);
	});
});

describe("forecast service: fresh and stale", () => {
	it("a stale result gives no advice and the error shape, with prewarm", async () => {
		const h = harness({ settings: { routing: true } });
		await h.service.runOnce();
		const limit = FORECAST_STALE_POLLS * POLL;
		await h.time.advance(limit);
		expect(h.service.advisor.placeNewSession(h.time.now)).toEqual(placement);
		expect(serve(h).available).toBe(true);
		await h.time.advance(1);
		expect(h.service.advisor.placeNewSession(h.time.now)).toBeNull();
		expect(h.service.advisor.moveFor("s1", h.time.now)).toBeNull();
		expect(h.service.forecastView()).toBeNull();
		const res = serve(h);
		expect(res.available).toBe(false);
		expect(res.reason).toBe("error");
		expect(res.computedAt).toBe(h.time.now);
		// counted accounts of the last limits only
		expect(res.accounts).toEqual([A]);
		expect(res.prewarm).toEqual(h.scheduler.state);
	});

	it("before the first computation the provider answers the error shape", () => {
		const h = harness();
		const res = serve(h);
		expect(res.reason).toBe("error");
		expect(res.accounts).toEqual([]);
		expect(res.prewarm).toEqual(h.scheduler.state);
	});

	it("an engine throw keeps the error shape and gives no advice", async () => {
		const h = harness({ settings: { routing: true } });
		h.engine.failWith = new Error("boom");
		await h.service.runOnce();
		const res = serve(h);
		expect(res.reason).toBe("error");
		expect(res.accounts).toEqual([A]);
		expect(h.service.advisor.placeNewSession(h.time.now)).toBeNull();
		expect(h.service.advisor.moveFor("s1", h.time.now)).toBeNull();
		expect(h.service.forecastView()).toBeNull();
		expect(h.scheduler.ticks.length).toBe(1);
		expect(h.warns.join("\n")).toContain("engine=boom");
	});

	it("passes the engine's insufficient_history answer through", async () => {
		const h = harness({ settings: { routing: true } });
		h.engine.result = (i) => ({
			available: false,
			reason: "insufficient_history",
			response: unavailableResponse(i.now, "insufficient_history", [A]),
			plan: null,
		});
		await h.service.runOnce();
		const res = serve(h);
		expect(res.reason).toBe("insufficient_history");
		expect(res.computedAt).toBe(T0);
		expect(res.prewarm).toEqual(h.scheduler.state);
		expect(h.service.advisor.placeNewSession(h.time.now)).toBeNull();
	});

	it("always carries prewarm from the scheduler status, or empty lists without one", async () => {
		const h = harness();
		await h.service.runOnce();
		expect(serve(h).prewarm).toEqual(h.scheduler.state);
		const none = harness({ scheduler: null, settings: { prewarm: true } });
		await none.service.runOnce();
		expect(serve(none).prewarm).toEqual({
			enabled: true,
			planned: [],
			last: [],
		});
	});

	it("without a scheduler, planned still lists the kept plan's openings, prewarm on or off", async () => {
		for (const prewarm of [false, true]) {
			const h = harness({ scheduler: null, settings: { prewarm } });
			h.engine.result = (i) =>
				available(
					i.now,
					availablePlan(i.now, { [A]: T0 + 30 * MIN, [B]: null }),
				);
			await h.service.runOnce();
			expect(serve(h).prewarm).toEqual({
				enabled: prewarm,
				planned: [{ accountId: A, openAt: T0 + 30 * MIN }],
				last: [],
			});
		}
	});

	it("the provider never throws", async () => {
		const h = harness();
		await h.service.runOnce();
		h.scheduler.status = () => {
			throw new Error("status broke");
		};
		const res = serve(h);
		expect(res.reason).toBe("error");
		expect(res.prewarm).toEqual({ enabled: false, planned: [], last: [] });
	});
});

describe("forecast service: advisor", () => {
	it("gives placement and moves while fresh and routing is on", async () => {
		const h = harness({ settings: { routing: true } });
		await h.service.runOnce();
		expect(h.service.advisor.placeNewSession(h.time.now)).toEqual(placement);
		expect(h.service.advisor.moveFor("s1", h.time.now)).toEqual(move);
		expect(h.service.advisor.moveFor("other", h.time.now)).toBeNull();
		expect(h.service.advisor.cacheTtlMs("s1")).toBe(3_600_000);
	});

	it("routing off (live) gives no advice but still answers cacheTtlMs", async () => {
		const h = harness({ settings: { routing: true } });
		await h.service.runOnce();
		h.settings.current = settings({ routing: false });
		expect(h.service.advisor.placeNewSession(h.time.now)).toBeNull();
		expect(h.service.advisor.moveFor("s1", h.time.now)).toBeNull();
		expect(h.service.advisor.cacheTtlMs("s1")).toBe(3_600_000);
		expect(h.service.advisor.cacheTtlMs("nobody")).toBeNull();
		h.settings.current = settings({ routing: true, enabled: false });
		expect(h.service.advisor.placeNewSession(h.time.now)).toBeNull();
		expect(h.service.forecastView()).toBeNull();
	});

	it("an applied move is consumed until the next plan", async () => {
		const h = harness({ settings: { routing: true } });
		await h.service.runOnce();
		h.service.advisor.applied("place", "s1", B, h.time.now);
		expect(h.service.advisor.moveFor("s1", h.time.now)).toEqual(move);
		h.service.advisor.applied("move", "s1", B, h.time.now);
		expect(h.service.advisor.moveFor("s1", h.time.now)).toBeNull();
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		expect(h.service.advisor.moveFor("s1", h.time.now)).toEqual(move);
	});
});

describe("forecast service: backfill", () => {
	it("starts once after the first successful sync when transcriptsDir is set", async () => {
		const h = harness({ settings: { transcriptsDir: "/tmp/transcripts" } });
		h.failSync.on = true;
		await h.service.runOnce();
		expect(h.backfills).toEqual([]);
		h.failSync.on = false;
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual(["/tmp/transcripts"]);
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual(["/tmp/transcripts"]);
	});

	it("does not start without transcriptsDir", async () => {
		const h = harness();
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual([]);
	});

	it("a failing backfill is logged without its message and the service carries on", async () => {
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			backfill: async () => {
				throw new Error("/private/conversation/path secret");
			},
		});
		await h.service.runOnce();
		await flush();
		const failed = h.warns.filter((w) => w.includes("backfill"));
		expect(failed).toEqual(["forecast backfill failed error=Error"]);
		expect(h.warns.join("\n")).not.toContain("secret");
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		expect(h.engine.inputs.length).toBe(2);
	});

	it("is not awaited by the cycle", async () => {
		const gate = new Deferred();
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			backfill: () => gate.promise,
		});
		await h.service.runOnce();
		expect(h.scheduler.ticks.length).toBe(1);
		gate.resolve();
	});
});

/** UsageDetailDb rows kept in memory; the rest of the db is the real one. */
class MemoryUsageDetail {
	tokens = new Map<string, UsageTokenRow>();
	requests = new Map<string, SessionRequestRow>();
	async upsertUsageTokens(rows: UsageTokenRow[]) {
		for (const r of rows)
			this.tokens.set(
				`${r.bucketStart}|${r.accountId}|${r.source}|${r.family}`,
				{ ...r },
			);
	}
	async upsertSessionRequests(rows: SessionRequestRow[]) {
		for (const r of rows)
			this.requests.set(`${r.source}|${r.sessionKey}|${r.at}|${r.seq}`, {
				...r,
			});
	}
	async replaceUsageTokens() {}
	async replaceSessionRequests() {}
	async getSessionRequests() {
		return [];
	}
	async getUsageTokens() {
		return [];
	}
	async pruneUsageDetail() {}
}

const USAGE_DETAIL_METHODS = new Set<string>([
	"upsertUsageTokens",
	"upsertSessionRequests",
	"replaceUsageTokens",
	"replaceSessionRequests",
	"getSessionRequests",
	"getUsageTokens",
	"pruneUsageDetail",
] satisfies (keyof UsageDetailDb)[]);

function startupDb(detail: MemoryUsageDetail): ForecastDb {
	const real = tempDb() as unknown as ForecastDb;
	return new Proxy(real, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && USAGE_DETAIL_METHODS.has(prop)) {
				const fn = Reflect.get(detail, prop) as (...a: unknown[]) => unknown;
				return fn.bind(detail);
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function transcriptLine(at: EpochMs, n: number, model = "claude-opus-5-5") {
	return JSON.stringify({
		type: "assistant",
		sessionId: `sess-secret-${n}`,
		requestId: `req_${n}`,
		timestamp: new Date(at).toISOString(),
		message: {
			id: `msg_${n}`,
			model,
			content: [{ type: "text", text: "private words" }],
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				cache_read_input_tokens: 300,
				cache_creation_input_tokens: 40,
				cache_creation: {
					ephemeral_5m_input_tokens: 30,
					ephemeral_1h_input_tokens: 10,
				},
			},
		},
	});
}

function transcriptsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "forecast-service-transcripts-"));
	dirs.push(root);
	mkdirSync(join(root, "proj"), { recursive: true });
	writeFileSync(
		join(root, "proj", "one.jsonl"),
		`${[
			transcriptLine(T0 - 2 * 3_600_000, 1),
			transcriptLine(T0 - 2 * 3_600_000 + 30_000, 2, "claude-fable-5-2"),
			transcriptLine(T0 - 3_600_000, 3),
		].join("\n")}\n`,
	);
	writeFileSync(
		join(root, "proj", "two.jsonl"),
		`${transcriptLine(T0 - 90 * MIN, 4, "claude-sonnet-5")}\n`,
	);
	return root;
}

const TRANSCRIPT_META_KEYS = [
	TRANSCRIPT_BACKFILL_META_KEY,
	TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
	TRANSCRIPT_BACKFILL_WRITTEN_META_KEY,
];

async function demandSnapshot(db: ForecastDb): Promise<string> {
	const far = T0 + 400 * 24 * 60 * MIN;
	return JSON.stringify({
		transcript: await db.getForecastDemandByAccount("transcript", 0, far),
		proxy: await db.getForecastDemandByAccount("proxy", 0, far),
		pooled: await db.getForecastDemandPooled(0, far),
		meta: await Promise.all(
			TRANSCRIPT_META_KEYS.map((k) => db.getForecastMeta(k)),
		),
	});
}

async function fullSnapshot(
	db: ForecastDb,
	detail: MemoryUsageDetail,
): Promise<string> {
	const sorted = <T>(m: Map<string, T>) =>
		[...m.entries()].sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify({
		demand: await demandSnapshot(db),
		tokens: sorted(detail.tokens),
		requests: sorted(detail.requests),
		coverage: await db.getForecastMeta(USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY),
		salt: await db.getForecastMeta(SESSION_SALT_META_KEY),
		marker: await db.getForecastMeta(USAGE_DETAIL_BACKFILL_META_KEY),
	});
}

async function untilLogged(h: Harness, prefix: string): Promise<string> {
	for (let i = 0; i < 400; i++) {
		const found = h.infos.find((m) => m.startsWith(prefix));
		if (found) return found;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`no line starting with ${prefix}`);
}

const DETAIL_LINE = "forecast usage detail backfill finished";

describe("forecast service: usage-detail backfill", () => {
	it("with transcriptsDir set after creation, starts after the existing backfill finishes, whatever its status", async () => {
		const order: string[] = [];
		const gate = new Deferred();
		const h = harness({
			backfill: async () => {
				order.push("backfill:start");
				await gate.promise;
				order.push("backfill:end");
				return { status: "already_done" };
			},
			usageDetailBackfill: async (dir) => {
				order.push(`detail:${dir}`);
				return { status: "done" };
			},
		});
		await flush();
		h.settings.current = {
			...h.settings.current,
			transcriptsDir: "/tmp/transcripts",
		};
		await h.service.runOnce();
		await flush();
		expect(order).toEqual(["backfill:start"]);
		gate.resolve();
		await flush();
		expect(order).toEqual([
			"backfill:start",
			"backfill:end",
			"detail:/tmp/transcripts",
		]);
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		await flush();
		expect(order.filter((o) => o.startsWith("detail"))).toHaveLength(1);
	});

	it("with transcriptsDir set after creation, does not start when the existing backfill failed", async () => {
		const h = harness({
			backfill: async () => {
				throw new Error("boom");
			},
		});
		await flush();
		h.settings.current = {
			...h.settings.current,
			transcriptsDir: "/tmp/transcripts",
		};
		await h.service.runOnce();
		await flush();
		expect(h.usageDetailBackfills).toEqual([]);
	});

	it("logs a failure by error name only", async () => {
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			usageDetailBackfill: async () => {
				throw new TypeError("/private/conversation/path secret");
			},
		});
		await h.service.runOnce();
		await flush();
		expect(h.warns).toEqual([
			"forecast usage detail backfill failed error=TypeError",
		]);
	});

	it("ends with one line of counts and status only", async () => {
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			usageDetailBackfill: async () => {
				h.time.now += 321;
				return {
					status: "done",
					files: 12,
					unreadable: 1,
					lines: 900,
					malformed: 2,
					tokenRows: 40,
					sessionRequests: 17,
					path: "/Users/someone/.claude/projects/x.jsonl",
				};
			},
		});
		await h.service.runOnce();
		await flush();
		expect(h.infos.filter((m) => m.startsWith(DETAIL_LINE))).toEqual([
			`${DETAIL_LINE} status=done files=12 unreadable=1 lines=900 malformed=2 tokenRows=40 requests=17 ms=321`,
		]);
	});

	it("first start with the old marker already set runs the new pass and fills both tables", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		await db.setForecastMeta(TRANSCRIPT_BACKFILL_META_KEY, '{"rows":2}');
		await db.setForecastMeta(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(T0 - 30 * MIN),
		);
		await db.upsertForecastDemand([
			{
				bucketStart: T0 - 120 * MIN,
				accountId: "",
				source: "transcript",
				units: 12.5,
				fableUnits: 2,
				requestCount: 2,
			},
		]);
		const before = await demandSnapshot(db);
		const root = transcriptsRoot();
		const h = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		await h.service.runOnce();
		const line = await untilLogged(h, DETAIL_LINE);
		expect(
			h.infos.find((m) => m.startsWith("forecast backfill finished")),
		).toContain("status=already_done");
		expect(line).toContain("status=done files=2 unreadable=0 lines=4");
		expect(detail.tokens.size).toBeGreaterThan(0);
		expect(detail.requests.size).toBe(4);
		for (const r of detail.tokens.values()) {
			expect(r.source).toBe("transcript");
			expect(r.bucketStart).toBeLessThan(T0 - 30 * MIN);
		}
		expect(await db.getForecastMeta(USAGE_DETAIL_BACKFILL_META_KEY)).not.toBe(
			null,
		);
		expect(await demandSnapshot(db)).toBe(before);
		expect(JSON.stringify([...detail.requests.values()])).not.toContain(
			"sess-secret",
		);
		await h.service.stop();
	});

	it("a second start logs already_done, reads no transcript and changes no stored row", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		const root = transcriptsRoot();
		const first = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		await first.service.runOnce();
		expect(await untilLogged(first, DETAIL_LINE)).toContain("status=done");
		await first.service.stop();
		const before = await fullSnapshot(db, detail);
		expect(detail.requests.size).toBeGreaterThan(0);

		// A transcript that would add rows if anything were read.
		writeFileSync(
			join(root, "proj", "three.jsonl"),
			`${transcriptLine(T0 - 4 * 3_600_000, 9)}\n`,
		);
		const second = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		await second.service.runOnce();
		const line = await untilLogged(second, DETAIL_LINE);
		expect(line).toContain("status=already_done files=0 unreadable=0 lines=0");
		expect(
			second.infos.find((m) => m.startsWith("forecast backfill finished")),
		).toContain("status=already_done");
		expect(await fullSnapshot(db, detail)).toBe(before);
		await second.service.stop();
	});

	it("leaves forecast_demand rows and the existing markers byte-identical across the new pass", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		const root = transcriptsRoot();
		const beforeAll = await demandSnapshot(db);
		let afterExisting: string | null = null;
		const h = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: async (dir) => {
				const result = await runTranscriptBackfill({
					store,
					transcriptsDir: dir,
					earliestProxyBucket: () => earliestProxyBucket({ db }),
					now: () => T0,
				});
				afterExisting = await demandSnapshot(db);
				return result;
			},
			usageDetailBackfill: undefined,
		});
		// The new pass runs at creation, before the existing backfill.
		expect(await untilLogged(h, DETAIL_LINE)).toContain("status=done");
		expect(await demandSnapshot(db)).toBe(beforeAll);
		await h.service.runOnce();
		for (let i = 0; i < 400 && afterExisting === null; i++)
			await new Promise((r) => setTimeout(r, 5));
		expect(afterExisting).not.toBe(null);
		expect(await demandSnapshot(db)).toBe(afterExisting as unknown as string);

		// Same requests per bucket in both tables.
		const demand = await db.getForecastDemandByAccount(
			"transcript",
			0,
			T0 + MIN,
		);
		const perBucket = new Map<number, number>();
		for (const r of detail.tokens.values())
			perBucket.set(
				r.bucketStart,
				(perBucket.get(r.bucketStart) ?? 0) + r.requestCount,
			);
		expect(perBucket).toEqual(
			new Map(demand.map((r) => [r.bucketStart, r.requestCount])),
		);
		await h.service.stop();
	});
});

describe("forecast service: stop", () => {
	it("clears timers, stops the scheduler, awaits the running cycle; later notifies do nothing", async () => {
		const idle = harness();
		await idle.service.runOnce();
		idle.service.notifyUsagePoll();
		expect(idle.time.pending.length).toBe(1);
		await idle.service.stop();
		expect(idle.time.pending.length).toBe(0);
		expect(idle.scheduler.stopped).toBe(true);

		// stop waits for pre-warm runs in flight (scheduler.idle)
		const gated = harness();
		await gated.service.runOnce();
		gated.scheduler.idleGate = new Deferred();
		let gatedDone = false;
		const gatedStop = gated.service.stop().then(() => {
			gatedDone = true;
		});
		await flush();
		expect(gatedDone).toBe(false);
		gated.scheduler.idleGate.resolve();
		await gatedStop;
		expect(gatedDone).toBe(true);

		const h = harness();
		h.engine.hold = new Deferred();
		const running = h.service.runOnce();
		await flush();
		// queued behind the running computation; stop drops it
		h.service.notifyUsagePoll();
		let stopped = false;
		const stopping = h.service.stop().then(() => {
			stopped = true;
		});
		await flush();
		expect(h.time.pending.length).toBe(0);
		expect(h.scheduler.stopped).toBe(true);
		expect(stopped).toBe(false);
		h.engine.hold.resolve();
		await running;
		await stopping;
		expect(stopped).toBe(true);
		h.service.notifyUsagePoll();
		await h.service.runOnce();
		await h.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(h.time.pending.length).toBe(0);
		expect(h.engine.inputs.length).toBe(1);
	});
});

describe("forecast service with the real scheduler and a fake runner", () => {
	function withScheduler(
		over: Partial<ForecastSettings>,
		store: FakeStore,
		time: FakeTime,
		runner: FakeRunner,
		openAt: Plan["openAt"],
	) {
		let service: ForecastService | null = null;
		const scheduler = createPrewarmScheduler({
			runner,
			store,
			settings: () => settings(over),
			forecast: () => service?.forecastView() ?? null,
			limits: () => service?.limits() ?? [],
			timeZone: () => PACE.timeZone,
			clock: time.clock,
			timer: time.timer,
			logger: { info() {}, warn() {} },
		});
		const h = harness({ settings: over, time, scheduler });
		h.engine.result = (i) => available(i.now, availablePlan(i.now, openAt));
		service = h.service;
		return h;
	}

	it("prewarm off: the runner is never called even with a plan opening now", async () => {
		const time = new FakeTime();
		const runner = new FakeRunner();
		const h = withScheduler({ prewarm: false }, new FakeStore(), time, runner, {
			[A]: T0 - MIN,
		});
		for (let i = 0; i < 4; i++) {
			await h.service.runOnce();
			await h.service.idle();
			await time.advance(FORECAST_MIN_SPACING_MS);
		}
		expect(h.engine.inputs.length).toBe(4);
		expect(runner.calls).toEqual([]);
		expect(serve(h).prewarm?.enabled).toBe(false);
		await h.service.stop();
	});

	for (const prewarm of [false, true]) {
		it(`prewarm.planned lists the plan's window openings with prewarm ${prewarm ? "on" : "off"}`, async () => {
			const time = new FakeTime();
			const h = withScheduler(
				{ prewarm },
				new FakeStore(),
				time,
				new FakeRunner(),
				{ [A]: T0 + 3 * 60 * MIN, [B]: T0 + 60 * MIN },
			);
			await h.service.runOnce();
			await h.service.idle();
			const res = serve(h);
			expect(res.prewarm).toEqual({
				enabled: prewarm,
				planned: [
					{ accountId: B, openAt: T0 + 60 * MIN },
					{ accountId: A, openAt: T0 + 3 * 60 * MIN },
				],
				last: [],
			});
			expect(validateForecastResponse(res)).toEqual([]);
			await h.service.stop();
		});
	}

	it("prewarmTest fires once for the named account, and not again after a restart", async () => {
		const time = new FakeTime();
		const runner = new FakeRunner();
		const store = new FakeStore();
		const over = { prewarmTest: { account: A, at: T0 - MIN } };
		const first = withScheduler(over, store, time, runner, {});
		for (let i = 0; i < 3; i++) {
			await first.service.runOnce();
			await first.service.idle();
			await time.advance(FORECAST_MIN_SPACING_MS);
		}
		expect(runner.calls).toEqual([A]);
		expect(serve(first).prewarm?.last.map((r) => r.kind)).toEqual(["test"]);
		await first.service.stop();

		const again = withScheduler(over, store, time, runner, {});
		for (let i = 0; i < 2; i++) {
			await again.service.runOnce();
			await again.service.idle();
			await time.advance(FORECAST_MIN_SPACING_MS);
		}
		expect(runner.calls).toEqual([A]);
		await again.service.stop();
	});
});

describe("forecast service: queued work", () => {
	it("runOnce covers a queued snapshot: the old timer does not fire a second computation", async () => {
		const h = harness();
		await h.service.runOnce();
		await h.time.advance(1_000);
		h.service.notifyUsagePoll();
		expect(h.time.pending.length).toBe(1);
		await h.time.advance(19_000);
		await h.service.runOnce();
		expect(h.time.pending.length).toBe(0);
		await h.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(h.engine.inputs.map((i) => i.now)).toEqual([T0, T0 + 20_000]);
	});

	it("a snapshot just before a computation ends gives one follow-up after its settle wait", async () => {
		const h = harness();
		h.engine.hold = new Deferred();
		const first = h.service.runOnce();
		await h.time.advance(29_000);
		h.service.notifyUsagePoll();
		expect(h.time.pending.length).toBe(0);
		h.engine.hold.resolve();
		h.engine.hold = null;
		await first;
		await flush();
		expect(h.time.pending.length).toBe(1);
		await h.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(h.engine.inputs.map((i) => i.now)).toEqual([
			T0,
			T0 + 29_000 + FORECAST_POLL_SETTLE_MS,
		]);
	});

	it("a later snapshot pushes the queued computation back to its own settle wait", async () => {
		const h = harness();
		await h.service.runOnce();
		h.service.notifyUsagePoll();
		await h.time.advance(28_000);
		h.service.notifyUsagePoll();
		expect(h.time.pending.length).toBe(1);
		await h.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(h.engine.inputs.map((i) => i.now)).toEqual([
			T0,
			T0 + 28_000 + FORECAST_POLL_SETTLE_MS,
		]);
	});

	it("idle waits for queued work, and stop releases it", async () => {
		const h = harness();
		h.service.notifyUsagePoll();
		let idle = false;
		const waiting = h.service.idle().then(() => {
			idle = true;
		});
		await flush();
		expect(idle).toBe(false);
		await h.time.advance(FORECAST_POLL_SETTLE_MS);
		await waiting;
		expect(idle).toBe(true);
		expect(h.engine.inputs.length).toBe(1);

		h.service.notifyUsagePoll();
		let idleAgain = false;
		const again = h.service.idle().then(() => {
			idleAgain = true;
		});
		await flush();
		expect(idleAgain).toBe(false);
		await h.service.stop();
		await again;
		expect(idleAgain).toBe(true);
		expect(h.engine.inputs.length).toBe(1);
	});

	it("the provider answers even when the clock throws", () => {
		const h = harness({
			clock: {
				now: () => {
					throw new Error("clock broke");
				},
			},
		});
		const res = serve(h);
		expect(res.reason).toBe("error");
		expect(res.prewarm).toEqual({ enabled: false, planned: [], last: [] });
	});

	it("starts the backfill once transcriptsDir is set after an earlier sync", async () => {
		const h = harness();
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual([]);
		h.settings.current = settings({ transcriptsDir: "/tmp/transcripts" });
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual(["/tmp/transcripts"]);
	});
});

describe("forecast service: log lines (amendment 3, C2)", () => {
	const HOUR = 3_600_000;
	const ID = "28f69dec-2e46-4b18-9557-dcdc132fc385";

	function noForecast(
		now: EpochMs,
		detail: Extract<ForecastResult, { available: false }>["detail"],
	): ForecastResult {
		return {
			available: false,
			reason: "insufficient_history",
			response: unavailableResponse(now, "insufficient_history", [ID]),
			plan: null,
			detail,
		};
	}

	function calibrationDetail(points: number, units: number) {
		return {
			rule: "calibration" as const,
			limits: [
				{
					accountId: ID,
					limit: "five_hour" as const,
					instances: points > 0 ? 1 : 0,
					points,
					minPoints: 5,
					units,
					k: "none" as const,
				},
				{
					accountId: ID,
					limit: "seven_day" as const,
					instances: 1,
					points: 12,
					minPoints: 5,
					units: 40.25,
					k: "own" as const,
				},
			],
		};
	}

	const unavailableLines = (h: Harness) =>
		h.infos.filter((m) => m.startsWith("forecast unavailable"));

	async function cycle(h: Harness, ms: number) {
		await h.time.advance(ms);
		await h.service.runOnce();
	}

	it("names the calibration rule and its numbers per account and limit", async () => {
		const h = harness();
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(0, 3.5));
		await h.service.runOnce();
		expect(unavailableLines(h)).toEqual([
			`forecast unavailable reason=insufficient_history rule=calibration ${ID}/five_hour: instances=0 points=0/5 units=3.5 k=none; ${ID}/seven_day: instances=1 points=12/5 units=40.3 k=own`,
		]);
	});

	it("names the history rule: recorded days and the pool of today against their minimums", async () => {
		const h = harness();
		h.engine.result = (i) =>
			noForecast(i.now, {
				rule: "history",
				recordedDays: 3,
				minRecordedDays: 5,
				pool: "workday",
				poolDays: 2,
				minPoolDays: 3,
			});
		await h.service.runOnce();
		expect(unavailableLines(h)).toEqual([
			"forecast unavailable reason=insufficient_history rule=history recordedDays=3/5 pool=workday:2/3",
		]);
	});

	it("names no_counted_account, and a reason without a rule", async () => {
		const h = harness();
		h.engine.result = (i) => noForecast(i.now, { rule: "no_counted_account" });
		await h.service.runOnce();
		h.engine.failWith = new Error("boom");
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h)).toEqual([
			"forecast unavailable reason=insufficient_history rule=no_counted_account",
			"forecast unavailable reason=error",
		]);
	});

	it("is not repeated on every poll: again when the rule or a number changes, else once an hour", async () => {
		const h = harness();
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(2, 3.5));
		await h.service.runOnce();
		for (let i = 1; i <= 10; i++) await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(1);
		// the unit sum is one of the numbers: a new sum is a new line
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(2, 13.5));
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(2);
		expect(unavailableLines(h)[1]).toContain("units=13.5");
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(3, 13.5));
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(3);
		await cycle(h, HOUR);
		expect(unavailableLines(h).length).toBe(4);
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(4);
	});

	it("says once when the forecast is available again, and nothing while it stays available", async () => {
		const h = harness();
		const availableLines = () =>
			h.infos.filter((m) => m.startsWith("forecast available"));
		await h.service.runOnce();
		expect(availableLines()).toEqual([]);
		h.engine.result = (i) => noForecast(i.now, { rule: "no_counted_account" });
		await cycle(h, FORECAST_MIN_SPACING_MS);
		h.engine.result = (i) => available(i.now);
		await cycle(h, FORECAST_MIN_SPACING_MS);
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(availableLines()).toEqual(["forecast available again"]);
		h.engine.result = (i) => noForecast(i.now, { rule: "no_counted_account" });
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(2);
	});

	it("the response of the provider carries no detail", async () => {
		const h = harness();
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(0, 3.5));
		await h.service.runOnce();
		const json = JSON.stringify(serve(h));
		expect(json).not.toContain("calibration");
		expect(json).not.toContain("detail");
	});

	it("writes the forecast inputs line after an available computation; the provider's response does not carry them (amendment 4, D2)", async () => {
		const h = harness();
		const inputs: ForecastInputsDetail = {
			pace: {
				status: "unfitted",
				fittedAt: null,
				bands: (
					[
						["0-1h", 30],
						["1-2h", 90],
						["2-4h", 180],
						["4-8h", 360],
						["8-16h", 720],
						["16h-1d", 1200],
						["1-2d", 2160],
						["2-4d", 4320],
						["4-7d", 7920],
					] as [string, number][]
				).map(([band, centreMin]) => ({
					band,
					centreMin,
					m: 1,
					feature: null,
					ratio: null,
					coef: null,
					clipped: false,
					lambda: null,
				})),
			},
			paceModel: null,
			pool: { name: "workday", days: 12, medianUnits: 80, p90Units: 120 },
			workStartMinute: 480,
			limits: [
				{
					accountId: ID,
					limit: "five_hour",
					k: 2,
					source: "own",
					instances: 4,
					points: 30,
					oldestHoursAgo: 200,
					newestHoursAgo: 0.5,
				},
			],
			caps: [{ accountId: ID, ratio: 6, binds: true }],
		};
		h.engine.result = (i) => ({ ...available(i.now), inputs });
		await h.service.runOnce();
		for (let i = 1; i <= 5; i++) await cycle(h, FORECAST_MIN_SPACING_MS);
		const lines = h.infos.filter((m) => m.startsWith("forecast inputs"));
		expect(lines).toEqual([
			`forecast inputs e4=unfitted fitAge=none days=none weeks=none cells=none e4m 0-1h=1.00 1-2h=1.00 2-4h=1.00 4-8h=1.00 8-16h=1.00 16h-1d=1.00 1-2d=1.00 2-4d=1.00 4-7d=1.00 e4f none e4floor count=0 pool=workday:12 median=80.0 p90=120.0 workStart=08:00 k: ${ID}/five_hour=2.0000 own instances=4 points=30 oldestH=200.0 newestH=0.5 cap: ${ID} r=6.00 binds=yes`,
		]);
		const json = JSON.stringify(serve(h));
		expect(json).not.toContain("paceModel");
		expect(json).not.toContain("belowFloor");
		expect(json).not.toContain("medianUnits");
	});

	it("ends the backfill with one line of counts, dates, cut-over, status and run time", async () => {
		const time = new FakeTime();
		const h = harness({
			time,
			settings: { transcriptsDir: "/tmp/transcripts" },
			backfill: async () => {
				time.now += 1234;
				return {
					status: "done",
					files: 1416,
					unreadable: 2,
					lines: 90000,
					malformed: 3,
					skipped: 400,
					deduped: 5000,
					unkeyed: 1,
					afterCutover: 70,
					responses: 61302,
					rows: 2743,
					cleared: 0,
					cutover: Date.UTC(2026, 10, 11, 7, 35),
					cutoverSource: "proxy",
					demandDays: 36,
					firstDemandDay: "2026-10-06",
					lastDemandDay: "2026-11-10",
				};
			},
		});
		await h.service.runOnce();
		await flush();
		const lines = h.infos.filter((m) =>
			m.startsWith("forecast backfill finished"),
		);
		expect(lines).toEqual([
			"forecast backfill finished status=done files=1416 unreadable=2 lines=90000 stored=61302 skipped: noUsage=400 duplicate=5000 afterCutover=70 malformed=3 unkeyed=1 rows=2743 cleared=0 days=36 first=2026-10-06 last=2026-11-10 cutover=2026-11-11T07:35:00.000Z ms=1234",
		]);
	});

	it("no path-like text reaches the backfill line, whatever the backfill returns", async () => {
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			backfill: async () => ({
				status: "/Users/someone/.claude/projects/p/session-1.jsonl",
				files: "/Users/someone/.claude/projects",
				lines: Number.NaN,
				responses: 4,
				firstDemandDay: "../../etc/session-2.jsonl",
				lastDemandDay: "2026-11-10 /x",
				cutover: "/tmp/x",
				extra: "/Users/someone/secret.jsonl",
			}),
		});
		await h.service.runOnce();
		await flush();
		const line = h.infos.find((m) =>
			m.startsWith("forecast backfill finished"),
		);
		expect(line).toBe(
			"forecast backfill finished status=unknown files=? unreadable=? lines=? stored=4 skipped: noUsage=? duplicate=? afterCutover=? malformed=? unkeyed=? rows=? cleared=? days=? first=none last=none cutover=none ms=0",
		);
		expect(h.infos.join("\n")).not.toMatch(/[\\/]|jsonl|session|Users/);
	});
});

describe("forecast service: usage-detail retention", () => {
	const DAY = 24 * 60 * MIN;

	/** A real database that records each pruneUsageDetail cutoff in order with the sync. */
	function pruningDb(calls: string[], cutoffs: number[]): ForecastDb {
		const real = tempDb() as unknown as ForecastDb;
		return new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls.push(String(prop));
					if (prop === "pruneUsageDetail") cutoffs.push(args[0] as number);
					return value.apply(target, args);
				};
			},
		});
	}

	it("prunes usage detail after the sync to the configured history window", async () => {
		const calls: string[] = [];
		const cutoffs: number[] = [];
		const db = pruningDb(calls, cutoffs);
		const h = harness({ db, settings: { historyLookbackDays: 7 } });
		const now = T0 + 2 * MIN + 17;
		h.time.now = now;
		await h.service.runOnce();

		expect(cutoffs).toEqual([bucketStart(now - 7 * DAY)]);
		expect(calls.indexOf("pruneUsageDetail")).toBeGreaterThan(
			calls.lastIndexOf("replaceForecastDemand"),
		);

		h.settings.current = settings({ historyLookbackDays: 30 });
		h.time.now = now + 10 * MIN;
		await h.service.runOnce();
		expect(cutoffs[1]).toBe(bucketStart(now + 10 * MIN - 30 * DAY));
	});

	it("keeps old forecast_demand rows while pruning usage detail", async () => {
		const calls: string[] = [];
		const cutoffs: number[] = [];
		const db = pruningDb(calls, cutoffs);
		const old = bucketStart(T0 - 400 * DAY);
		await db.upsertForecastDemand([
			{
				bucketStart: old,
				accountId: "",
				source: "transcript",
				units: 1,
				fableUnits: 0,
				requestCount: 1,
			},
		]);
		const tokenRow = {
			bucketStart: old,
			accountId: "",
			source: "transcript" as const,
			family: "opus" as const,
			requestCount: 1,
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
		};
		await db.upsertUsageTokens([tokenRow]);
		const h = harness({ db });
		await h.service.runOnce();

		expect(
			await db.getForecastDemandByAccount("transcript", old, old + 1),
		).toHaveLength(1);
		expect(await db.getUsageTokens("transcript", old, old + 1)).toEqual([]);
	});

	it("a failing prune is reported and does not stop the cycle", async () => {
		const real = tempDb() as unknown as ForecastDb;
		const db = new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "pruneUsageDetail")
					return async () => {
						throw new Error("db locked");
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const h = harness({ db });
		await h.service.runOnce();
		expect(h.engine.inputs).toHaveLength(1);
		expect(h.warns.join("\n")).toContain("prune=");
	});

	it("a failing prune is logged by a plain error name only, never its message", async () => {
		const real = tempDb() as unknown as ForecastDb;
		const db = new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "pruneUsageDetail")
					return async () => {
						const error = new Error("/private/fake-prune-path/x.db secret");
						error.name = "Bad /fake-prune-path name";
						throw error;
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const h = harness({ db });
		await h.service.runOnce();
		expect(h.warns).toEqual(["forecast cycle failed prune=Error"]);
		expect(h.warns.join("\n")).not.toContain("fake-prune-path");
	});
});

describe("forecast service: F3 start-up and salt", () => {
	it("a usage-detail pass failure with a non-identifier name logs error=Error", async () => {
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			usageDetailBackfill: async () => {
				const error = new Error("/private/fake-detail-path secret");
				error.name = "Bad /fake-detail-path name";
				throw error;
			},
		});
		await h.service.runOnce();
		await flush();
		expect(h.warns).toEqual([
			"forecast usage detail backfill failed error=Error",
		]);
	});

	it("the proxy sync and the transcript pass share one salt creation through the service defaults", async () => {
		const ops = tempDb();
		await ops.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
				 VALUES ('acct-a', 'acct-a', 'anthropic', 'refresh-a', 'access-a', 0)`,
		);
		const gate = new Deferred();
		let saltReads = 0;
		let saltWrites = 0;
		const db = new Proxy(ops as unknown as ForecastDb, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "getForecastMeta")
					return async (key: string) => {
						if (key === SESSION_SALT_META_KEY) {
							saltReads++;
							await gate.promise;
						}
						return value.call(target, key);
					};
				if (prop === "setForecastMeta")
					return async (key: string, v: string) => {
						if (key === SESSION_SALT_META_KEY) saltWrites++;
						return value.call(target, key, v);
					};
				return value.bind(target);
			},
		});
		const root = transcriptsRoot();
		const h = harness({
			settings: { transcriptsDir: root },
			db,
			store: createDemandStore({ db }),
			usageDetailBackfill: undefined,
		});
		// no request yet: the first sync needs no salt; the transcript pass then waits on it
		await h.service.runOnce();
		for (let i = 0; i < 400 && saltReads === 0; i++)
			await new Promise((r) => setTimeout(r, 5));
		expect(saltReads).toBe(1);

		await ops.getAdapter().run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model,
			   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			   client_session_id)
			 VALUES ('req-1', ?, 'POST', '/v1/messages', 'acct-a', 'claude-opus-4-1', 10, 20, 100, 50, 's1')`,
			[T0 + MIN],
		);
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		const second = h.service.runOnce();
		await flush();
		gate.resolve();
		await second;
		expect(await untilLogged(h, DETAIL_LINE)).toContain("status=done");

		expect(saltWrites).toBe(1);
		const salt = (await ops.getForecastMeta(SESSION_SALT_META_KEY)) as string;
		expect(salt).toMatch(/^[0-9a-f]{64}$/);
		const far = T0 + 1000 * MIN;
		const proxyRows = await ops.getSessionRequests("proxy", 0, far);
		expect(proxyRows.map((r) => r.sessionKey)).toEqual([
			sessionKey(salt, "proxy", "s1"),
		]);
		const transcriptKeys = new Set(
			(await ops.getSessionRequests("transcript", 0, far)).map(
				(r) => r.sessionKey,
			),
		);
		expect(transcriptKeys).toEqual(
			new Set([
				sessionKey(salt, "transcript", join("proj", "one.jsonl")),
				sessionKey(salt, "transcript", join("proj", "two.jsonl")),
			]),
		);
		await h.service.stop();
	});

	it("production start-up through notifyUsagePoll alone runs the new pass once, and a second start changes nothing", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		await db.setForecastMeta(TRANSCRIPT_BACKFILL_META_KEY, '{"rows":2}');
		await db.setForecastMeta(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(T0 - 30 * MIN),
		);
		const root = transcriptsRoot();
		const first = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		first.service.notifyUsagePoll();
		expect(first.engine.inputs).toHaveLength(0);
		await first.time.advance(FORECAST_POLL_SETTLE_MS);
		expect(first.engine.inputs.map((i) => i.now)).toEqual([
			T0 + FORECAST_POLL_SETTLE_MS,
		]);
		const line = await untilLogged(first, DETAIL_LINE);
		expect(
			first.infos.find((m) => m.startsWith("forecast backfill finished")),
		).toContain("status=already_done");
		expect(line).toContain("status=done files=2 unreadable=0 lines=4");
		expect(first.infos.filter((m) => m.startsWith(DETAIL_LINE))).toHaveLength(
			1,
		);
		expect(detail.tokens.size).toBeGreaterThan(0);
		expect(detail.requests.size).toBe(4);
		expect(await db.getForecastMeta(USAGE_DETAIL_BACKFILL_META_KEY)).not.toBe(
			null,
		);
		await first.time.advance(10 * FORECAST_MIN_SPACING_MS);
		expect(first.engine.inputs).toHaveLength(1);
		await first.service.stop();
		const before = await fullSnapshot(db, detail);

		const second = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		second.time.now = first.time.now;
		second.service.notifyUsagePoll();
		await second.time.advance(FORECAST_POLL_SETTLE_MS);
		expect(second.engine.inputs).toHaveLength(1);
		expect(await untilLogged(second, DETAIL_LINE)).toContain(
			"status=already_done files=0 unreadable=0 lines=0",
		);
		expect(await fullSnapshot(db, detail)).toBe(before);
		await second.service.stop();
	});
});

const DAY = 24 * 60 * MIN;

/** One Claude OAuth account and a request at each time, in the database `db` wraps. */
async function seedClaudeRequests(db: ForecastDb, times: EpochMs[]) {
	const adapter = (db as unknown as DatabaseOperations).getAdapter();
	await adapter.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES ('acct-a', 'acct-a', 'anthropic', 'refresh-a', 'access-a', 0)`,
	);
	for (const [i, at] of times.entries()) {
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model,
			   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			   client_session_id)
			 VALUES (?, ?, 'POST', '/v1/messages', 'acct-a', 'claude-opus-4-1', 10, 20, 100, 50, 's1')`,
			[`req-seed-${i}`, at],
		);
	}
}

function markedStore(): FakeDemandStore {
	const store = new FakeDemandStore([]);
	store.meta.set(TRANSCRIPT_BACKFILL_META_KEY, '{"rows":2}');
	return store;
}

describe("forecast service: usage-detail pass at creation", () => {
	it("creation alone with the old marker set runs the pass once; a second service on the same store changes nothing", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		await db.setForecastMeta(TRANSCRIPT_BACKFILL_META_KEY, '{"rows":2}');
		await db.setForecastMeta(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(T0 - 30 * MIN),
		);
		await db.upsertForecastDemand([
			{
				bucketStart: T0 - 120 * MIN,
				accountId: "",
				source: "transcript",
				units: 12.5,
				fableUnits: 2,
				requestCount: 2,
			},
		]);
		const demandBefore = await demandSnapshot(db);
		const root = transcriptsRoot();
		const first = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		const line = await untilLogged(first, DETAIL_LINE);
		expect(line).toContain("status=done files=2 unreadable=0 lines=4");
		expect(first.engine.inputs).toHaveLength(0);
		expect(
			first.infos.some((m) => m.startsWith("forecast backfill started")),
		).toBe(false);
		expect(detail.tokens.size).toBeGreaterThan(0);
		expect(detail.requests.size).toBe(4);
		expect(await db.getForecastMeta(USAGE_DETAIL_BACKFILL_META_KEY)).not.toBe(
			null,
		);
		expect(await demandSnapshot(db)).toBe(demandBefore);
		await first.service.stop();
		expect(first.infos.filter((m) => m.startsWith(DETAIL_LINE))).toHaveLength(
			1,
		);
		const before = await fullSnapshot(db, detail);

		// A transcript that would add rows if anything were read.
		writeFileSync(
			join(root, "proj", "three.jsonl"),
			`${transcriptLine(T0 - 4 * 3_600_000, 9)}\n`,
		);
		const second = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		second.service.notifyUsagePoll();
		await second.time.advance(FORECAST_POLL_SETTLE_MS);
		expect(second.engine.inputs).toHaveLength(1);
		expect(await untilLogged(second, DETAIL_LINE)).toContain(
			"status=already_done files=0 unreadable=0 lines=0",
		);
		await second.service.stop();
		expect(second.infos.filter((m) => m.startsWith(DETAIL_LINE))).toHaveLength(
			1,
		);
		expect(await fullSnapshot(db, detail)).toBe(before);
	});

	it("creation followed quickly by a cycle runs the pass exactly once", async () => {
		const gate = new Deferred();
		const calls: string[] = [];
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			store: markedStore(),
			usageDetailBackfill: async (dir) => {
				calls.push(dir);
				await gate.promise;
				return { status: "done" };
			},
		});
		await h.service.runOnce();
		await flush();
		expect(h.backfills).toEqual(["/tmp/transcripts"]);
		expect(calls).toEqual(["/tmp/transcripts"]);
		gate.resolve();
		await flush();
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		await flush();
		expect(calls).toHaveLength(1);
		await h.service.stop();
	});

	it("when the cycle reaches the pass before the marker read settles, the creation path does not run it again", async () => {
		const metaGate = new Deferred();
		const store = markedStore();
		const read = store.getMeta.bind(store);
		store.getMeta = async (key: string) => {
			await metaGate.promise;
			return read(key);
		};
		const calls: string[] = [];
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			store,
			usageDetailBackfill: async (dir) => {
				calls.push(dir);
			},
		});
		await h.service.runOnce();
		await flush();
		expect(calls).toHaveLength(1);
		metaGate.resolve();
		await flush();
		expect(calls).toHaveLength(1);
		await h.service.stop();
	});

	it("a fresh install (no old marker) runs the pass at creation and leaves the demand backfill to the first cycle", async () => {
		const h = harness({ settings: { transcriptsDir: "/tmp/transcripts" } });
		await flush();
		await flush();
		expect(h.backfills).toEqual([]);
		expect(h.usageDetailBackfills).toEqual(["/tmp/transcripts"]);
		await h.service.stop();
		expect(h.usageDetailBackfills).toEqual(["/tmp/transcripts"]);
	});

	it("fresh install with Claude OAuth requests: creation alone cuts transcript tokens at the earliest request, and the first cycle stores that cut-over", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const R = T0 - 75 * MIN;
		await seedClaudeRequests(db, [R, R + 20 * MIN]);
		const store = createDemandStore({ db });
		const root = transcriptsRoot();
		const h = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		expect(await untilLogged(h, DETAIL_LINE)).toContain(
			"status=done files=2 unreadable=0 lines=4",
		);
		expect(h.engine.inputs).toHaveLength(0);
		const cut = bucketStart(R);
		const transcriptTokens = () =>
			[...detail.tokens.values()].filter((r) => r.source === "transcript");
		const atCreation = transcriptTokens();
		expect(atCreation.length).toBeGreaterThan(0);
		expect(atCreation.every((r) => r.bucketStart < cut)).toBe(true);
		// T0 - 1h is a transcript response at or after the cut-over
		expect(atCreation.reduce((n, r) => n + r.requestCount, 0)).toBe(3);
		expect(
			[...detail.requests.values()].filter((r) => r.source === "transcript"),
		).toHaveLength(4);
		expect(await db.getForecastMeta(USAGE_DETAIL_BACKFILL_META_KEY)).not.toBe(
			null,
		);
		expect(await db.getForecastMeta(TRANSCRIPT_BACKFILL_META_KEY)).toBe(null);
		expect(await db.getForecastMeta(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY)).toBe(
			null,
		);
		expect(await db.getForecastDemandByAccount("proxy", 0, T0 + DAY)).toEqual(
			[],
		);

		await h.service.runOnce();
		for (
			let i = 0;
			i < 400 &&
			(await db.getForecastMeta(TRANSCRIPT_BACKFILL_META_KEY)) === null;
			i++
		)
			await new Promise((r) => setTimeout(r, 5));
		expect(await db.getForecastMeta(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY)).toBe(
			String(cut),
		);
		const demand = await db.getForecastDemandByAccount("transcript", 0, cut);
		const demandCounts = new Map<number, number>();
		for (const row of demand)
			demandCounts.set(
				row.bucketStart,
				(demandCounts.get(row.bucketStart) ?? 0) + row.requestCount,
			);
		const tokenCounts = new Map<number, number>();
		for (const row of transcriptTokens())
			tokenCounts.set(
				row.bucketStart,
				(tokenCounts.get(row.bucketStart) ?? 0) + row.requestCount,
			);
		expect(demandCounts.size).toBeGreaterThan(0);
		expect([...tokenCounts.entries()].sort()).toEqual(
			[...demandCounts.entries()].sort(),
		);
		await h.service.stop();
		expect(h.infos.filter((m) => m.startsWith(DETAIL_LINE))).toHaveLength(1);

		const before = await fullSnapshot(db, detail);
		writeFileSync(
			join(root, "proj", "three.jsonl"),
			`${transcriptLine(T0 - 4 * 3_600_000, 9)}\n`,
		);
		const second = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		expect(await untilLogged(second, DETAIL_LINE)).toContain(
			"status=already_done files=0 unreadable=0 lines=0",
		);
		await second.service.stop();
		expect(await fullSnapshot(db, detail)).toBe(before);
	});

	it("fresh install with an empty requests table: creation cuts at the bucket of now; a second service changes nothing", async () => {
		const detail = new MemoryUsageDetail();
		const db = startupDb(detail);
		const store = createDemandStore({ db });
		const root = transcriptsRoot();
		// in the bucket of now, so at the cut-over: a session row, never a token row
		writeFileSync(
			join(root, "proj", "now.jsonl"),
			`${transcriptLine(T0 + MIN, 5)}\n`,
		);
		const first = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		expect(await untilLogged(first, DETAIL_LINE)).toContain(
			"status=done files=3 unreadable=0 lines=5",
		);
		const tokens = [...detail.tokens.values()];
		expect(tokens.every((r) => r.source === "transcript")).toBe(true);
		expect(tokens.every((r) => r.bucketStart < bucketStart(T0))).toBe(true);
		expect(tokens.reduce((n, r) => n + r.requestCount, 0)).toBe(4);
		expect(detail.requests.size).toBe(5);
		expect(await db.getForecastDemandByAccount("proxy", 0, T0 + DAY)).toEqual(
			[],
		);
		expect(await db.getForecastMeta(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY)).toBe(
			null,
		);
		await first.service.stop();
		expect(first.infos.filter((m) => m.startsWith(DETAIL_LINE))).toHaveLength(
			1,
		);
		expect(first.engine.inputs).toHaveLength(0);

		const before = await fullSnapshot(db, detail);
		const second = harness({
			settings: { transcriptsDir: root },
			db,
			store,
			backfill: undefined,
			usageDetailBackfill: undefined,
		});
		expect(await untilLogged(second, DETAIL_LINE)).toContain(
			"status=already_done files=0 unreadable=0 lines=0",
		);
		await second.service.stop();
		expect(await fullSnapshot(db, detail)).toBe(before);
	});

	it("does not run at creation without transcriptsDir", async () => {
		const h = harness({ store: markedStore() });
		await flush();
		expect(h.usageDetailBackfills).toEqual([]);
		await h.service.stop();
	});

	it("stop resolves only after an in-flight pass settles", async () => {
		const gate = new Deferred();
		let started = false;
		const h = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			store: markedStore(),
			usageDetailBackfill: async () => {
				started = true;
				await gate.promise;
				return { status: "done" };
			},
		});
		await flush();
		expect(started).toBe(true);
		let stopped = false;
		const stopping = h.service.stop().then(() => {
			stopped = true;
		});
		await flush();
		expect(stopped).toBe(false);
		gate.resolve();
		await stopping;
		expect(stopped).toBe(true);
		expect(h.infos.some((m) => m.startsWith(DETAIL_LINE))).toBe(true);
	});

	it("a failing pass is logged by name only, stop resolves, and the next service retries", async () => {
		const store = markedStore();
		let calls = 0;
		const failing = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			store,
			usageDetailBackfill: async () => {
				calls++;
				throw new TypeError("/private/conversation/path secret");
			},
		});
		await flush();
		await failing.service.stop();
		expect(calls).toBe(1);
		expect(failing.warns).toEqual([
			"forecast usage detail backfill failed error=TypeError",
		]);
		const next = harness({
			settings: { transcriptsDir: "/tmp/transcripts" },
			store,
		});
		await flush();
		await next.service.stop();
		expect(next.usageDetailBackfills).toEqual(["/tmp/transcripts"]);
	});
});

function fitState(fittedAt: EpochMs, over: Partial<PaceFitState> = {}) {
	const state: PaceFitState = {
		fittedAt,
		days: 84,
		weeks: 12,
		candidates: 101,
		floor: 10,
		cellsEstablished: 5,
		cellsTotal: 189,
		belowFloor: [],
		baseline: { workday: [], monday: [], weekend: [] },
		bands: [],
		selected: [],
		dayTypeComparison: [],
		...over,
	};
	return state;
}

/** Each run waits until the test finishes it. */
class FakeRefitRunner implements PaceRefitRunner {
	calls: {
		series: PaceSeries;
		now: EpochMs;
		timeoutMs: number;
		signal?: AbortSignal;
	}[] = [];
	private waiting: ((o: PaceRefitOutcome) => void)[] = [];
	run(
		series: PaceSeries,
		now: EpochMs,
		opts: { timeoutMs: number; signal?: AbortSignal },
	): Promise<PaceRefitOutcome> {
		this.calls.push({ series, now, ...opts });
		return new Promise((resolve) => {
			this.waiting.push(resolve);
			opts.signal?.addEventListener("abort", () =>
				resolve({ status: "error", reason: "stopped", ms: 0 }),
			);
		});
	}
	async finish(outcome: PaceRefitOutcome) {
		const resolve = this.waiting.shift();
		if (!resolve) throw new Error("no refit running");
		resolve(outcome);
		await flush();
	}
}

function refitHarness(
	over: Parameters<typeof harness>[0] & { buildFails?: boolean } = {},
) {
	const runner = new FakeRefitRunner();
	const seriesInputs: PaceSeriesInput[] = [];
	const { buildFails, ...rest } = over;
	const h = harness({
		...rest,
		paceRefit: {
			runner,
			buildSeries: (input) => {
				seriesInputs.push(input);
				if (buildFails) throw new Error("bad history");
				return {
					start: input.historyFrom,
					units: new Float64Array(1),
					censored: new Uint8Array(1),
					timeZone: input.timeZone,
				};
			},
		},
	});
	const refitLines = () =>
		h.infos.filter((m) => m.startsWith("forecast e4 refit"));
	return { ...h, runner, seriesInputs, refitLines };
}

const paceOff = {
	paceConditioning: false,
} as unknown as Partial<ForecastSettings>;
const paceOn = {
	paceConditioning: true,
} as unknown as Partial<ForecastSettings>;

describe("forecast service: E4 refit in the worker", () => {
	it("refits at start-up; forecasts get null until the fit lands, then the new state", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		expect(h.engine.inputs[0]?.demandModel).toBeNull();
		expect(h.runner.calls).toHaveLength(1);
		expect(h.runner.calls[0]?.now).toBe(T0);
		expect(h.runner.calls[0]?.timeoutMs).toBe(PACE_REFIT_TIMEOUT_MS);

		const s1 = fitState(T0);
		await h.runner.finish({ status: "ok", state: s1, ms: 4000 });
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		expect(h.engine.inputs[1]?.demandModel).toBe(s1);
		expect(h.refitLines()).toHaveLength(1);
		expect(h.refitLines()[0]).toStartWith(
			"forecast e4 refit status=ok ms=4000 cadenceMin=60 days=84",
		);
	});

	it("the forecast does not wait for a running refit", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await h.time.advance(FORECAST_MIN_SPACING_MS);
		await h.service.runOnce();
		expect(h.engine.inputs).toHaveLength(2);
		expect(h.engine.inputs[1]?.demandModel).toBeNull();
		expect(h.runner.calls).toHaveLength(1);
	});

	it("refits every 60 minutes from the start of the last refit", async () => {
		expect(PACE_REFIT_CADENCE_MS).toBe(60 * MIN);
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		await h.runner.finish({ status: "ok", state: fitState(T0), ms: 1 });
		await h.time.advance(59 * MIN);
		expect(h.runner.calls).toHaveLength(1);
		await h.time.advance(MIN);
		expect(h.runner.calls).toHaveLength(2);
		expect(h.runner.calls[1]?.now).toBe(T0 + 60 * MIN);
		await h.runner.finish({ status: "ok", state: fitState(T0), ms: 1 });
		await h.time.advance(60 * MIN);
		expect(h.runner.calls).toHaveLength(3);
		expect(h.runner.calls[2]?.now).toBe(T0 + 120 * MIN);
		// repeated computations do not start extra refits
		await h.service.runOnce();
		await flush();
		expect(h.runner.calls).toHaveLength(3);
	});

	it("starts no second refit while one runs", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		await h.time.advance(60 * MIN);
		expect(h.runner.calls).toHaveLength(1);
		await h.runner.finish({ status: "ok", state: fitState(T0), ms: 1 });
		await h.time.advance(60 * MIN);
		expect(h.runner.calls).toHaveLength(2);
	});

	it("keeps the old state on a timeout and on a fit error, and logs the reason", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		const s1 = fitState(T0);
		await h.runner.finish({ status: "ok", state: s1, ms: 1 });
		await h.time.advance(60 * MIN);
		await h.runner.finish({ status: "timeout", ms: PACE_REFIT_TIMEOUT_MS });
		await h.service.runOnce();
		expect(h.engine.inputs.at(-1)?.demandModel).toBe(s1);
		await h.time.advance(60 * MIN);
		await h.runner.finish({ status: "error", reason: "fit-error", ms: 2 });
		await h.service.runOnce();
		expect(h.engine.inputs.at(-1)?.demandModel).toBe(s1);
		expect(h.refitLines().slice(1)).toEqual([
			`forecast e4 refit status=timeout ms=${PACE_REFIT_TIMEOUT_MS} cadenceMin=60 reason=timeout keptAgeMin=60`,
			"forecast e4 refit status=error ms=2 cadenceMin=60 reason=fit-error keptAgeMin=120",
		]);
	});

	it("logs a failure to build the refit input and starts no worker", async () => {
		const h = refitHarness({ buildFails: true });
		await h.service.runOnce();
		await flush();
		expect(h.runner.calls).toHaveLength(0);
		expect(h.refitLines()).toHaveLength(1);
		expect(h.refitLines()[0]).toMatch(
			/^forecast e4 refit status=error ms=\d+ cadenceMin=60 reason=input-error keptAgeMin=none$/,
		);
		await h.service.runOnce();
		expect(h.engine.inputs.at(-1)?.demandModel).toBeNull();
	});

	it("builds the refit input over the lookback with the counted accounts", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		const input = h.seriesInputs[0];
		expect(input?.now).toBe(T0);
		expect(input?.timeZone).toBe(PACE.timeZone);
		expect(input?.accounts).toEqual([A]);
		expect(input?.historyFrom).toBe(
			paceRefitRange(T0, h.settings.current.historyLookbackDays, 0).historyFrom,
		);
	});

	it("skips refits while paceConditioning is off and resumes at the next tick", async () => {
		const h = refitHarness({ settings: paceOff });
		await h.service.runOnce();
		await flush();
		await h.time.advance(60 * MIN);
		expect(h.runner.calls).toHaveLength(0);
		expect(h.refitLines()).toHaveLength(0);
		h.settings.current = { ...h.settings.current, ...paceOn };
		await h.time.advance(60 * MIN);
		expect(h.runner.calls).toHaveLength(1);
	});

	it("stop aborts the running refit and arms no further refit", async () => {
		const h = refitHarness();
		await h.service.runOnce();
		await flush();
		await h.service.stop();
		expect(h.runner.calls[0]?.signal?.aborted).toBe(true);
		expect(h.time.pending).toHaveLength(0);
		await h.time.advance(120 * MIN);
		expect(h.runner.calls).toHaveLength(1);
		expect(h.refitLines()).toHaveLength(0);
	});
});

describe("paceRefitRange", () => {
	const DAY = 24 * 60 * MIN;
	it("covers the lookback, clipped to the first stored bucket, and readings 7 days earlier", () => {
		expect(paceRefitRange(T0, 84, null)).toEqual({
			historyFrom: T0,
			readingsFrom: T0 - 7 * DAY,
		});
		expect(paceRefitRange(T0, 84, 0)).toEqual({
			historyFrom: T0 - 84 * DAY,
			readingsFrom: T0 - 91 * DAY,
		});
		expect(paceRefitRange(T0, 84, T0 - 10 * DAY)).toEqual({
			historyFrom: T0 - 10 * DAY,
			readingsFrom: T0 - 17 * DAY,
		});
	});
});
