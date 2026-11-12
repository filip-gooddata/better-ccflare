import { describe, expect, test } from "bun:test";
import type { PrewarmRecord } from "../../types";
import {
	createPrewarmScheduler,
	PREWARM_MAX_TIMER_MS,
	PREWARM_RECORDS_KEY,
	PREWARM_TESTS_KEY,
} from "../scheduler";
import { H, limits, MIN, plan, settings, T0, world } from "./fakes";

const ISO_T0 = "2026-11-12T06:00:00.000Z";

function onWorld(state: Parameters<typeof world>[0] = {}) {
	const w = world({
		settings: settings({ prewarm: true }),
		forecast: { available: true, plan: plan({ a: T0 }) },
		limits: [limits("a", T0 - MIN)],
		...state,
	});
	return { w, s: createPrewarmScheduler(w.deps) };
}

function storedRecords(w: ReturnType<typeof world>): PrewarmRecord[] {
	return JSON.parse(w.store.meta.get(PREWARM_RECORDS_KEY) ?? "[]");
}

function rec(over: Partial<PrewarmRecord>): PrewarmRecord {
	return {
		accountId: "a",
		kind: "plan",
		scheduledAt: T0,
		firedAt: T0,
		exitCode: 0,
		windowOpened: true,
		resetsAt: T0 + 5 * H,
		...over,
	};
}

describe("off", () => {
	test("never fires with prewarm false and no test, whatever the plan says", async () => {
		const { w, s } = onWorld({ settings: settings({ prewarm: false }) });
		w.state.forecast = {
			available: true,
			plan: plan({ a: T0 - H, b: T0 + MIN }),
		};
		w.state.limits = [limits("a", T0), limits("b", T0)];
		for (let i = 0; i < 5; i++) {
			w.clock.at = T0 + i * 30 * MIN;
			await s.tick(w.clock.at);
			w.timer.fire();
		}
		await s.idle();
		expect(w.runner.calls).toEqual([]);
		expect(w.lines).toEqual([]);
		expect(w.timer.pending).toEqual([]);
		expect(s.status()).toEqual({ enabled: false, planned: [], last: [] });
	});
});

describe("plan pre-warm", () => {
	test("fires once when every guard holds, then records the result from the next reading", async () => {
		const { w, s } = onWorld();
		await s.tick(T0 + 5_000);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(w.lines).toEqual([
			`forecast prewarm fire account=name-a kind=plan scheduled=${ISO_T0} late=5`,
			"forecast prewarm done account=name-a exit=0 ms=1234",
		]);
		const firedAt = T0 + 5_000;
		expect(storedRecords(w)).toEqual([
			rec({ firedAt, windowOpened: null, resetsAt: null }),
		]);

		// A reading taken before the run finished decides nothing; the plan, not yet
		// recomputed, still lists the opening, which is now blocked as recent.
		await s.tick(T0 + 10_000);
		expect(w.lines.slice(2)).toEqual([
			"forecast prewarm skip account=name-a reason=recent",
		]);

		const resetsAt = firedAt + 5 * H;
		w.state.limits = [
			limits("a", T0 + 90_000, {
				fiveHour: { usedPct: 1, resetsAt },
			}),
		];
		await s.tick(T0 + 90_000);
		expect(w.lines.slice(3)).toEqual([
			`forecast prewarm result account=name-a windowOpened=true resetsAt=${new Date(resetsAt).toISOString()}`,
			"forecast prewarm skip account=name-a reason=window_open",
		]);
		expect(storedRecords(w)).toEqual([rec({ firedAt, resetsAt })]);
		expect(w.runner.calls).toEqual(["a"]);
	});

	test("a reading without an open window records windowOpened=false", async () => {
		const { w, s } = onWorld();
		w.runner.result = { exitCode: 1, durationMs: 300, error: null };
		await s.tick(T0);
		await s.idle();
		w.state.limits = [limits("a", T0 + 90_000)];
		await s.tick(T0 + 90_000);
		expect(w.lines.slice(1)).toEqual([
			"forecast prewarm done account=name-a exit=1 ms=300",
			"forecast prewarm result account=name-a windowOpened=false resetsAt=none",
			"forecast prewarm skip account=name-a reason=recent",
		]);
		expect(s.status().last[0]).toMatchObject({
			exitCode: 1,
			windowOpened: false,
			resetsAt: null,
		});
	});

	test("a runner that could not start is recorded as exit=none with a warning", async () => {
		const { w, s } = onWorld();
		w.runner.result = { exitCode: null, durationMs: 60_000, error: "timeout" };
		await s.tick(T0);
		await s.idle();
		expect(w.lines[1]).toBe(
			"forecast prewarm done account=name-a exit=none ms=60000",
		);
		expect(w.warnings).toEqual([
			"forecast prewarm failed account=name-a error=timeout",
		]);
	});

	const guards: [string, Parameters<typeof onWorld>[0], string | null][] = [
		[
			"forecast unavailable",
			{ forecast: { available: false, plan: null } },
			null,
		],
		["no forecast yet", { forecast: null }, null],
		[
			"openAt in the future",
			{ forecast: { available: true, plan: plan({ a: T0 + MIN }) } },
			null,
		],
		[
			"openAt null",
			{ forecast: { available: true, plan: plan({ a: null }) } },
			null,
		],
		[
			"reading older than 10 minutes",
			{ limits: [limits("a", T0 - 10 * MIN - 1)] },
			"stale_reading",
		],
		["no reading", { limits: [] }, "stale_reading"],
		[
			"window already open",
			{
				limits: [
					limits("a", T0, { fiveHour: { usedPct: 3, resetsAt: T0 + H } }),
				],
			},
			"window_open",
		],
		[
			"not counted",
			{ limits: [limits("a", T0, { counted: false })] },
			"not_counted",
		],
		[
			"weekly limit out",
			{
				limits: [
					limits("a", T0, { weekly: { usedPct: 100, resetsAt: T0 + 24 * H } }),
				],
			},
			"out",
		],
		["blocked", { limits: [limits("a", T0, { blockedUntil: T0 + H })] }, "out"],
	];
	for (const [name, state, reason] of guards) {
		test(`guard: ${name}`, async () => {
			const { w, s } = onWorld(state);
			await s.tick(T0);
			await s.tick(T0 + 30_000);
			await s.idle();
			expect(w.runner.calls).toEqual([]);
			expect(w.lines).toEqual(
				reason
					? [
							`forecast prewarm skip account=${state.limits?.[0] ? "name-a" : "a"} reason=${reason}`,
						]
					: [],
			);
		});
	}

	test("guard: one in the last 5 hours", async () => {
		const { w, s } = onWorld();
		w.store.meta.set(
			PREWARM_RECORDS_KEY,
			JSON.stringify([
				rec({ firedAt: T0 - 5 * H + MIN, windowOpened: false, resetsAt: null }),
			]),
		);
		await s.tick(T0);
		expect(w.runner.calls).toEqual([]);
		expect(w.lines).toEqual([
			"forecast prewarm skip account=name-a reason=recent",
		]);
		// Five hours after that one, it may fire.
		w.state.limits = [limits("a", T0 + 2 * MIN)];
		await s.tick(T0 + 2 * MIN);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
	});

	test("guard: daily cap counts today's pre-warms, test included", async () => {
		const sixHoursAgo = T0 - 6 * H; // 01:00 Prague, same local day
		const { w, s } = onWorld({
			settings: settings({ prewarm: true, prewarmMaxPerDay: 1 }),
		});
		w.store.meta.set(
			PREWARM_RECORDS_KEY,
			JSON.stringify([
				rec({ kind: "test", firedAt: sixHoursAgo, windowOpened: false }),
			]),
		);
		await s.tick(T0);
		expect(w.runner.calls).toEqual([]);
		expect(w.lines).toEqual([
			"forecast prewarm skip account=name-a reason=daily_cap",
		]);

		const { w: w2, s: s2 } = onWorld({
			settings: settings({ prewarm: true, prewarmMaxPerDay: 2 }),
		});
		w2.store.meta.set(
			PREWARM_RECORDS_KEY,
			JSON.stringify([
				rec({ kind: "test", firedAt: sixHoursAgo, windowOpened: false }),
			]),
		);
		await s2.tick(T0);
		await s2.idle();
		expect(w2.runner.calls).toEqual(["a"]);

		// Yesterday's pre-warms do not count.
		const { w: w3, s: s3 } = onWorld({
			settings: settings({ prewarm: true, prewarmMaxPerDay: 1 }),
		});
		w3.store.meta.set(
			PREWARM_RECORDS_KEY,
			JSON.stringify([rec({ firedAt: T0 - 8 * H, windowOpened: false })]),
		);
		await s3.tick(T0);
		await s3.idle();
		expect(w3.runner.calls).toEqual(["a"]);
	});

	test("guard: one running", async () => {
		const { w, s } = onWorld();
		w.runner.hold = true;
		await s.tick(T0);
		w.state.limits = [limits("a", T0 + MIN)];
		await s.tick(T0 + MIN);
		expect(w.runner.calls).toEqual(["a"]);
		expect(w.lines[1]).toBe(
			"forecast prewarm skip account=name-a reason=running",
		);
		w.runner.release();
		await s.idle();
	});

	test("a skip is logged once per opening and reason", async () => {
		const { w, s } = onWorld({ limits: [limits("a", T0, { counted: false })] });
		for (let i = 0; i < 4; i++) await s.tick(T0 + i * MIN);
		expect(w.lines).toEqual([
			"forecast prewarm skip account=name-a reason=not_counted",
		]);
	});

	test("two due accounts both fire, earliest opening first", async () => {
		const { w, s } = onWorld({
			forecast: { available: true, plan: plan({ b: T0 - MIN, a: T0 }) },
			limits: [limits("a", T0), limits("b", T0)],
		});
		await s.tick(T0);
		await s.idle();
		expect(w.runner.calls).toEqual(["b", "a"]);
	});
});

describe("restart safety", () => {
	test("a restarted scheduler neither repeats nor forgets", async () => {
		const { w, s } = onWorld();
		w.runner.hold = true;
		await s.tick(T0);
		s.stop();
		// The process dies mid-run: the record is already stored.
		expect(storedRecords(w)).toHaveLength(1);

		const again = createPrewarmScheduler(w.deps);
		w.state.limits = [limits("a", T0 + 2 * MIN)];
		await again.tick(T0 + 2 * MIN);
		await again.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(again.status().last).toEqual([
			rec({ exitCode: null, windowOpened: false, resetsAt: null }),
		]);
		expect(w.lines.slice(1)).toEqual([
			"forecast prewarm result account=name-a windowOpened=false resetsAt=none",
			"forecast prewarm skip account=name-a reason=recent",
		]);
	});

	test("keeps the last 20 records, newest first", async () => {
		const { w, s } = onWorld();
		const old = Array.from({ length: 25 }, (_, i) =>
			rec({
				firedAt: T0 - 24 * H - i * H,
				windowOpened: false,
				resetsAt: null,
			}),
		);
		w.store.meta.set(PREWARM_RECORDS_KEY, JSON.stringify(old));
		await s.tick(T0);
		await s.idle();
		const stored = storedRecords(w);
		expect(stored).toHaveLength(20);
		expect(stored[0]?.firedAt).toBe(T0);
		expect(stored[1]?.firedAt).toBe(old[0]?.firedAt);
		expect(s.status().last).toEqual(stored);
	});

	test("unreadable meta is treated as empty with a warning", async () => {
		const { w, s } = onWorld();
		w.store.meta.set(PREWARM_RECORDS_KEY, "{oops");
		await s.tick(T0);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(w.warnings).toEqual([
			`forecast prewarm meta unreadable key=${PREWARM_RECORDS_KEY}`,
		]);
	});
});

describe("one-shot test", () => {
	const testWorld = (account = "a") =>
		onWorld({
			settings: settings({ prewarm: false, prewarmTest: { account, at: T0 } }),
			forecast: null,
		});

	test("fires once with prewarm off and no forecast, never twice for the pair", async () => {
		const { w, s } = testWorld();
		await s.tick(T0 - 10 * MIN);
		expect(w.runner.calls).toEqual([]);
		expect(w.timer.pending.map((p) => p.delayMs)).toEqual([
			PREWARM_MAX_TIMER_MS,
		]);

		await s.tick(T0 + 30_000);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(w.lines[0]).toBe(
			`forecast prewarm fire account=name-a kind=test scheduled=${ISO_T0} late=30`,
		);
		expect(JSON.parse(w.store.meta.get(PREWARM_TESTS_KEY) ?? "[]")).toEqual([
			`a|${T0}`,
		]);

		await s.tick(T0 + H);
		const restarted = createPrewarmScheduler(w.deps);
		await restarted.tick(T0 + 2 * H);
		await restarted.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(restarted.status().last[0]?.kind).toBe("test");
		expect(w.timer.pending).toEqual([]);
	});

	test("matches the account by name as well as id", async () => {
		const { w, s } = testWorld("name-a");
		await s.tick(T0);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
	});

	test("a new time for the same account fires again", async () => {
		const { w, s } = testWorld();
		await s.tick(T0);
		await s.idle();
		w.state.settings = settings({
			prewarmTest: { account: "a", at: T0 + 6 * H },
		});
		w.state.limits = [limits("a", T0 + 6 * H)];
		await s.tick(T0 + 6 * H);
		await s.idle();
		expect(w.runner.calls).toEqual(["a", "a"]);
	});

	test("skipped with a log line when the window is already open, and not retried", async () => {
		const { w, s } = testWorld();
		w.state.limits = [
			limits("a", T0, { fiveHour: { usedPct: 5, resetsAt: T0 + H } }),
		];
		await s.tick(T0);
		expect(w.lines).toEqual([
			"forecast prewarm skip account=name-a reason=window_open",
		]);
		w.state.limits = [limits("a", T0 + 2 * H)];
		await s.tick(T0 + 2 * H);
		await s.idle();
		expect(w.runner.calls).toEqual([]);
		expect(w.lines).toHaveLength(1);
	});

	test("an unknown account waits with one log line", async () => {
		const { w, s } = testWorld("nobody");
		await s.tick(T0);
		await s.tick(T0 + MIN);
		expect(w.runner.calls).toEqual([]);
		expect(w.lines).toEqual([
			"forecast prewarm skip account=nobody reason=unknown_account",
		]);
		expect(w.store.meta.get(PREWARM_TESTS_KEY)).toBeUndefined();
	});

	test("ignores the 10-minute reading age and the daily cap", async () => {
		const { w, s } = onWorld({
			settings: settings({
				prewarmMaxPerDay: 0,
				prewarmTest: { account: "a", at: T0 },
			}),
			forecast: null,
			limits: [limits("a", T0 - 3 * H)],
		});
		await s.tick(T0);
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
	});
});

describe("timer and sleep", () => {
	test("arms its own timer for the next opening, at most a minute ahead", async () => {
		const { w, s } = onWorld({
			forecast: { available: true, plan: plan({ a: T0 + 30_000, b: T0 + H }) },
		});
		await s.tick(T0);
		expect(w.timer.pending.map((p) => p.delayMs)).toEqual([30_000]);
		w.clock.at = T0 + 30_000;
		w.state.limits = [limits("a", T0 + 20_000)];
		w.timer.fire();
		await s.idle();
		expect(w.runner.calls).toEqual(["a"]);
		expect(w.lines[0]).toContain("late=0");
		expect(w.timer.pending.map((p) => p.delayMs)).toEqual([
			PREWARM_MAX_TIMER_MS,
		]);
	});

	test("late firing after a simulated sleep records the delay", async () => {
		const { w, s } = onWorld({
			forecast: { available: true, plan: plan({ a: T0 }) },
			limits: [limits("a", T0 - 20 * MIN)],
		});
		await s.tick(T0 - 10 * MIN);
		expect(w.timer.pending).toHaveLength(1);
		// The Mac sleeps through the opening; it wakes 2 h later, a poll refreshes the readings.
		w.clock.at = T0 + 2 * H;
		w.state.limits = [limits("a", T0 + 2 * H - 5_000)];
		w.timer.fire();
		await s.idle();
		expect(w.lines[0]).toBe(
			`forecast prewarm fire account=name-a kind=plan scheduled=${ISO_T0} late=7200`,
		);
		expect(s.status().last[0]).toMatchObject({
			scheduledAt: T0,
			firedAt: T0 + 2 * H,
		});
	});

	test("the one-shot test after a sleep fires on stale readings and records the delay", async () => {
		const { w, s } = onWorld({
			settings: settings({ prewarmTest: { account: "a", at: T0 } }),
			forecast: null,
			limits: [limits("a", T0 - 8 * H)],
		});
		await s.tick(T0 - 8 * H);
		w.clock.at = T0 + 1_800_000;
		w.timer.fire();
		await s.idle();
		expect(w.lines[0]).toContain("kind=test");
		expect(w.lines[0]).toContain("late=1800");
	});

	test("stop clears the timer and later ticks do nothing", async () => {
		const { w, s } = onWorld({
			forecast: { available: true, plan: plan({ a: T0 + H }) },
		});
		await s.tick(T0);
		s.stop();
		expect(w.timer.pending).toEqual([]);
		await s.tick(T0 + 2 * H);
		expect(w.runner.calls).toEqual([]);
	});
});

describe("status", () => {
	test("matches PrewarmStatus: enabled, planned openings sorted, last newest first", async () => {
		const { w, s } = onWorld({
			forecast: {
				available: true,
				plan: plan({ b: T0 + 2 * H, a: T0 + H, c: null }),
			},
		});
		const prior = [
			rec({ firedAt: T0 - 7 * H, windowOpened: false, resetsAt: null }),
			rec({ firedAt: T0 - 30 * H }),
		];
		w.store.meta.set(PREWARM_RECORDS_KEY, JSON.stringify(prior));
		await s.tick(T0);
		expect(s.status()).toEqual({
			enabled: true,
			planned: [
				{ accountId: "a", openAt: T0 + H },
				{ accountId: "b", openAt: T0 + 2 * H },
			],
			last: prior,
		});
		w.state.settings = settings({ prewarm: false });
		expect(s.status().planned).toEqual([]);
		expect(s.status().enabled).toBe(false);
	});
});
