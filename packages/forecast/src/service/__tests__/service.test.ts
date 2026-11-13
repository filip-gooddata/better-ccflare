import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveForecastSettings } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import specFull from "../../contract/__tests__/fixtures/spec-example-full.json";
import { validateForecastResponse } from "../../contract/validate";
import { unavailableResponse } from "../../engine/response";
import type { ForecastDb } from "../../history/ports";
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
import {
	createForecastService,
	FORECAST_MIN_SPACING_MS,
	FORECAST_POLL_SETTLE_MS,
	FORECAST_STALE_POLLS,
	type ForecastService,
	type ForecastServiceDeps,
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
		clock: time.clock,
		timer: time.timer,
		pollIntervalMs: POLL,
		logger: {
			info: (m) => infos.push(m),
			warn: (m) => warns.push(m),
		},
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

	it("is not repeated on every poll: again when the rule or a deciding number changes, else once an hour", async () => {
		const h = harness();
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(2, 3.5));
		await h.service.runOnce();
		// demand keeps arriving: the unit sum grows on every poll, nothing decides differently
		for (let i = 1; i <= 10; i++) {
			const units = 3.5 + i;
			h.engine.result = (inp) =>
				noForecast(inp.now, calibrationDetail(2, units));
			await cycle(h, FORECAST_MIN_SPACING_MS);
		}
		expect(unavailableLines(h).length).toBe(1);
		h.engine.result = (i) => noForecast(i.now, calibrationDetail(3, 20));
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(2);
		await cycle(h, HOUR);
		expect(unavailableLines(h).length).toBe(3);
		await cycle(h, FORECAST_MIN_SPACING_MS);
		expect(unavailableLines(h).length).toBe(3);
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
