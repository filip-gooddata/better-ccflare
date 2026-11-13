/**
 * The real engine, the real service and the real pre-warm scheduler together on the 2026-11-12
 * replay (engine/__tests__/replay-2026-11-12.test.ts) with pre-warm off, the default. Fakes: the
 * clock, the timers, the demand store, the usage readings, the limits, the session tracker and the
 * pre-warm runner. No network and no `claude` CLI.
 *
 * At 07:00 the plan opens acct-b at 10:00 by routing; until then new sessions follow the base order.
 * The service computes again at 10:00 with acct-a's window at 47 % (the record has it at 0 % at
 * 06:12 and 60 % at 10:58; 47 % is the straight line between them at 10:00): new sessions then go
 * to acct-b with rule `forecast-open`, and the runner is never called.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import { validateForecastResponse } from "../../contract/validate";
import { createForecastEngine } from "../../engine/engine";
import {
	buildInput,
	replayFixture,
} from "../../engine/__tests__/fixtures-engine";
import { prague } from "../../engine/__tests__/fixtures-sim";
import type { ForecastDb, UsageSnapshotDbRow } from "../../history/ports";
import { FakeRunner, FakeStore } from "../../prewarm/__tests__/fakes";
import { createPrewarmScheduler } from "../../prewarm/scheduler";
import type {
	DemandStore,
	EpochMs,
	ForecastInput,
	SessionTrackerLike,
} from "../../types";
import { createForecastService, type ForecastService } from "../service";

const POLL_MS = 90_000;
const OPEN_AT = prague(12, 10);

const dirs: string[] = [];
const dbs: DatabaseOperations[] = [];
afterAll(async () => {
	for (const db of dbs) await db.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A temporary database whose usage snapshots are the fixture's readings. */
function fixtureDb(current: { input: ForecastInput }): ForecastDb {
	const dir = mkdtempSync(join(tmpdir(), "forecast-replay-"));
	dirs.push(dir);
	const real = new DatabaseOperations(join(dir, "test.db"));
	dbs.push(real);
	const snapshots = async (
		from: EpochMs,
		to: EpochMs,
		windows: readonly string[],
	): Promise<UsageSnapshotDbRow[]> =>
		current.input.readings
			.filter((r) => r.at >= from && r.at < to && windows.includes(r.window))
			.map((r) => ({
				accountId: r.accountId,
				timestamp: r.at,
				windowKey: r.window,
				utilization: r.usedPct,
				resetsAt: r.resetsAt,
			}));
	return new Proxy(real as unknown as ForecastDb, {
		get(target, prop, receiver) {
			if (prop === "getUsageSnapshotsBetween") return snapshots;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The fixture's recorded demand, read through the DemandStore interface. */
function fixtureStore(current: { input: ForecastInput }): DemandStore {
	const meta = new FakeStore();
	return {
		async upsert() {},
		async loadPooled(from, to) {
			return current.input.history.filter((b) => b.start >= from && b.start < to);
		},
		async loadByAccount(from, to) {
			return current.input.accountHistory.filter(
				(b) => b.start >= from && b.start < to,
			);
		},
		async earliest() {
			return current.input.historyFrom;
		},
		getMeta: (key) => meta.getMeta(key),
		setMeta: (key, value) => meta.setMeta(key, value),
	};
}

const noSessions: SessionTrackerLike = {
	observe() {},
	get: () => null,
	live: () => [],
	forget() {},
};

function world() {
	const current = { input: buildInput(replayFixture()) };
	const clock = { at: current.input.now as EpochMs, now: () => clock.at };
	const timer = { set: () => 0, clear() {} };
	const logger = { info() {}, warn() {} };
	const runner = new FakeRunner();
	let service: ForecastService | null = null;
	const scheduler = createPrewarmScheduler({
		runner,
		store: new FakeStore(),
		settings: () => current.input.settings,
		forecast: () => service?.forecastView() ?? null,
		limits: () => service?.limits() ?? [],
		timeZone: () => current.input.pace.timeZone,
		clock,
		timer,
		logger,
	});
	service = createForecastService({
		settings: () => current.input.settings,
		pace: () => current.input.pace,
		db: fixtureDb(current),
		store: fixtureStore(current),
		engine: createForecastEngine(),
		tracker: noSessions,
		loadLimits: async () => current.input.accounts,
		scheduler,
		backfill: async () => {},
		clock,
		timer,
		pollIntervalMs: POLL_MS,
		logger,
	});
	/** Move the clock and the fixture's state to `at`, then compute once. */
	const computeAt = async (
		at: EpochMs,
		fiveHourA = replayFixture().fiveHour.a,
	) => {
		current.input = buildInput(
			replayFixture({
				now: at,
				fiveHour: { a: fiveHourA, b: { usedPct: 0, resetsAt: null } },
			}),
		);
		clock.at = at;
		await service.runOnce();
		await service.idle();
	};
	return { current, clock, runner, service, computeAt };
}

describe("forecast service with the real engine on the 2026-11-12 replay, pre-warm off", () => {
	it("routes new sessions to acct-b from the planned opening at 10:00 and never pre-warms", async () => {
		const w = world();
		expect(w.current.input.settings.prewarm).toBe(false);
		expect(w.current.input.settings.routing).toBe(true);

		// 07:00, before the planned opening.
		await w.computeAt(prague(12, 7));
		const early = w.service.forecastView();
		expect(early?.plan?.openAt).toEqual({ "acct-b": OPEN_AT });
		const before = w.service.advisor.placeNewSession(w.clock.at);
		expect(before?.rule).toBe("forecast-lookahead");
		expect(before?.reason).toBe("reset-soon");
		expect(before?.tiers).toEqual([["acct-a"], ["acct-b"]]);
		const morning = w.service.provider();
		expect(morning.available).toBe(true);
		expect(morning.prewarm).toEqual({
			enabled: false,
			planned: [{ accountId: "acct-b", openAt: OPEN_AT }],
			last: [],
		});
		expect(validateForecastResponse(morning)).toEqual([]);

		// 10:00, the planned opening time has come.
		await w.computeAt(OPEN_AT, { usedPct: 47, resetsAt: prague(12, 11) });
		const due = w.service.advisor.placeNewSession(w.clock.at);
		expect(due?.rule).toBe("forecast-open");
		expect(due?.tiers[0]).toEqual(["acct-b"]);
		expect(due?.reason).toMatch(/^\S+$/);
		const later = w.service.provider();
		expect(later.prewarm?.enabled).toBe(false);
		expect(validateForecastResponse(later)).toEqual([]);

		expect(w.runner.calls).toEqual([]);
		await w.service.stop();
	}, 120_000);
});
