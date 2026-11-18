/**
 * The real engine, the real service and the real pre-warm scheduler together on the 2026-11-12
 * replay (engine/__tests__/replay-2026-11-12.test.ts) with pre-warm off, the default. Fakes: the
 * clock, the timers, the demand store, the usage readings, the limits, the session tracker and the
 * pre-warm runner. No network and no `claude` CLI.
 *
 * At 07:00 the plan holds acct-b closed until 08:30 (amendment 5, E3: S +76.9 against +13.7 when it
 * opens at once; the quarter-hour grid reaches 08:30 from 07:00); until then new sessions follow the
 * base order. The record has acct-a's window at 0 % at 06:12 and 60 % at 10:58; the fixture puts it
 * on the straight line between them. At 08:00 (23 %) the planner, searching again, keeps the hold to
 * 08:30 (S +76.9 against +59.8 opening at once). At 08:30 (29 %) holding no longer gains the gate,
 * so new sessions go to the idle acct-b with rule `forecast-open`. The runner is never called.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import { validateForecastResponse } from "../../contract/validate";
import {
	REPLAY_ENGINE,
	buildInput,
	replayFixture,
} from "../../engine/__tests__/fixtures-engine";
import { prague } from "../../engine/__tests__/fixtures-sim";
import { FULL_GRID_TIMEOUT_MS } from "../../engine/__tests__/plan-timeout";
import { createForecastEngine } from "../../engine/engine";
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
// the second computation, during the hold (until F1 the 07:00 plan held acct-b to here, 10:00 before amendment 5)
const OPEN_AT = prague(12, 8);
// amendment 5 (E1 to E3) and the F1 quarter-hour grid: the plans computed at 07:00 and 08:00 hold acct-b until 08:30
const REHOLD_AT = prague(12, 8, 30);

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
			return current.input.history.filter(
				(b) => b.start >= from && b.start < to,
			);
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
		engine: createForecastEngine(REPLAY_ENGINE),
		tracker: noSessions,
		loadLimits: async () => current.input.accounts,
		scheduler,
		backfill: async () => {},
		paceRefit: null,
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
	it(
		"holds acct-b until 08:30 at 07:00 and again at 08:00, then routes new sessions to it, and never pre-warms",
		async () => {
			const w = world();
			expect(w.current.input.settings.prewarm).toBe(false);
			expect(w.current.input.settings.routing).toBe(true);

			// 07:00, while the plan holds acct-b closed.
			await w.computeAt(prague(12, 7));
			const early = w.service.forecastView();
			expect(early?.plan?.openAt).toEqual({ "acct-b": REHOLD_AT });
			const before = w.service.advisor.placeNewSession(w.clock.at);
			expect(before?.rule).toBe("forecast-lookahead");
			// "reset-soon" before amendment 5: the hold gains S 62.6 over opening acct-b at once
			expect(before?.reason).toBe("low-point+62.6");
			expect(before?.tiers).toEqual([["acct-a"], ["acct-b"]]);
			const morning = w.service.provider();
			expect(morning.available).toBe(true);
			expect(morning.prewarm).toEqual({
				enabled: false,
				planned: [{ accountId: "acct-b", openAt: REHOLD_AT }],
				last: [],
			});
			expect(validateForecastResponse(morning)).toEqual([]);

			// 08:00, during the hold; the plan computed now still holds acct-b until 08:30.
			await w.computeAt(OPEN_AT, { usedPct: 23, resetsAt: prague(12, 11) });
			expect(w.service.forecastView()?.plan?.openAt).toEqual({
				"acct-b": REHOLD_AT,
			});
			const held = w.service.advisor.placeNewSession(w.clock.at);
			expect(held?.rule).toBe("forecast-lookahead");
			expect(held?.reason).toBe("low-point+16.1");
			expect(held?.tiers).toEqual([["acct-a"], ["acct-b"]]);

			// 08:30, no hold gains the gate: the idle acct-b heads the tiers (amendment 5, E1).
			await w.computeAt(REHOLD_AT, { usedPct: 29, resetsAt: prague(12, 11) });
			expect(w.service.forecastView()?.plan?.openAt).toEqual({
				"acct-b": REHOLD_AT,
			});
			const due = w.service.advisor.placeNewSession(w.clock.at);
			expect(due?.rule).toBe("forecast-open");
			expect(due?.tiers).toEqual([["acct-b"], ["acct-a"]]);
			expect(due?.reason).toBe("open-ahead+1.1");
			const later = w.service.provider();
			expect(later.prewarm?.enabled).toBe(false);
			expect(validateForecastResponse(later)).toEqual([]);

			expect(w.runner.calls).toEqual([]);
			await w.service.stop();
		},
		3 * FULL_GRID_TIMEOUT_MS,
	);
});
