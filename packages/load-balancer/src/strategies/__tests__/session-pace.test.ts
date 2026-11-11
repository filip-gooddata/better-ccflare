import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { clearAllProbeBackoff, setProbeBackoff } from "@better-ccflare/core";
import {
	SessionPaceStrategy,
	sessionLogTag,
	weeklyPaceDeficit,
} from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
	StrategyUsageWindow,
} from "@better-ccflare/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-11T15:30:00Z");

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
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
		...overrides,
	};
}

class FakeUsageStore implements StrategyStore {
	weekly = new Map<string, StrategyUsageWindow>();
	fiveHour = new Map<string, StrategyUsageWindow>();
	family = new Map<string, StrategyUsageWindow[]>();
	combined = new Map<string, number>();

	resetAccountSession(): void {}
	resumeAccount(): void {}
	getAccountUtilization(accountId: string): number | null {
		return this.combined.get(accountId) ?? null;
	}
	getAccountWeeklyWindow(accountId: string): StrategyUsageWindow | null {
		return this.weekly.get(accountId) ?? null;
	}
	getAccountFiveHourWindow(accountId: string): StrategyUsageWindow | null {
		return this.fiveHour.get(accountId) ?? null;
	}
	getAccountModelFamilyWindows(
		accountId: string,
		_provider: string,
		family: string,
	): StrategyUsageWindow[] {
		return this.family.get(`${accountId}:${family}`) ?? [];
	}

	/** Weekly window whose deficit at NOW is `deficit` (reset 3.5 days out). */
	setWeeklyDeficit(accountId: string, deficit: number): void {
		// reset at NOW + 3.5d → window started NOW - 3.5d → elapsed 50%.
		this.weekly.set(accountId, {
			utilization: 50 - deficit,
			resetsAt: NOW + 3.5 * DAY,
		});
	}
	setFiveHour(accountId: string, utilization: number, resetsAt = NOW + HOUR) {
		this.fiveHour.set(accountId, { utilization, resetsAt });
	}
	setFamily(
		accountId: string,
		family: string,
		utilization: number,
		resetsAt: number | null = NOW + 3 * DAY,
	) {
		this.family.set(`${accountId}:${family}`, [{ utilization, resetsAt }]);
	}
}

let reqCounter = 0;
function meta(
	session: string | null,
	model: string | null = "claude-opus-5-5",
): RequestMeta {
	reqCounter++;
	return {
		id: `req-${reqCounter}`,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: session,
		routingModel: model,
	};
}

const ids = (accounts: Account[]) => accounts.map((a) => a.id);

describe("SessionPaceStrategy", () => {
	let store: FakeUsageStore;
	let strategy: SessionPaceStrategy;
	let a: Account;
	let b: Account;

	beforeEach(() => {
		setSystemTime(new Date(NOW));
		clearAllProbeBackoff();
		store = new FakeUsageStore();
		strategy = new SessionPaceStrategy();
		strategy.initialize(store);
		a = makeAccount("a");
		b = makeAccount("b");
	});

	afterEach(() => {
		setSystemTime();
		clearAllProbeBackoff();
	});

	/** Place a session at least 1s after the previous one (outside the recent-pick window). */
	function placeSpaced(session: string, accounts = [a, b], model?: string) {
		setSystemTime(new Date(Date.now() + 1_000));
		return strategy.select(accounts, meta(session, model));
	}

	describe("rule 1: stickiness per client session", () => {
		it("keeps a session on its account while that account is available, even when another account falls further behind pace", () => {
			store.setWeeklyDeficit("a", 30);
			store.setWeeklyDeficit("b", 0);
			expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");

			store.setWeeklyDeficit("a", -40);
			store.setWeeklyDeficit("b", 40);
			setSystemTime(new Date(NOW + 60_000));
			expect(ids(strategy.select([a, b], meta("s1")))).toEqual(["a", "b"]);
		});

		it("keys sessions by the whole clientSessionId (metadata.user_id)", () => {
			store.setWeeklyDeficit("a", 30);
			store.setWeeklyDeficit("b", 0);
			strategy.select([a, b], meta("user_x_session_1"));
			store.setWeeklyDeficit("a", -40);
			store.setWeeklyDeficit("b", 40);
			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta("user_x_session_1"))[0].id).toBe("a");
			expect(strategy.select([a, b], meta("user_x_session_2"))[0].id).toBe("b");
		});

		it("does not pin requests without a client session", () => {
			store.setWeeklyDeficit("a", 30);
			store.setWeeklyDeficit("b", 0);
			expect(strategy.select([a, b], meta(null))[0].id).toBe("a");
			store.setWeeklyDeficit("a", -40);
			store.setWeeklyDeficit("b", 40);
			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta(null))[0].id).toBe("b");
		});
	});

	describe("rule 2: largest weekly pace deficit wins a new session", () => {
		it("matches the live fixture of 2026-11-11T15:30Z", () => {
			const gooddata = makeAccount("gd", { name: "gooddata" });
			const gooddataAi = makeAccount("gdai", { name: "gooddata-ai" });
			const gdWindow = {
				utilization: 2,
				resetsAt: Date.parse("2026-11-15T14:00:00Z"),
			};
			const aiWindow = {
				utilization: 50,
				resetsAt: Date.parse("2026-11-17T02:00:00Z"),
			};
			expect(weeklyPaceDeficit(gdWindow, NOW)).toBeCloseTo(41.75, 2);
			expect(weeklyPaceDeficit(aiWindow, NOW)).toBeCloseTo(-27.68, 2);

			store.weekly.set("gd", gdWindow);
			store.weekly.set("gdai", aiWindow);
			expect(strategy.select([gooddataAi, gooddata], meta("s"))[0].id).toBe(
				"gd",
			);
		});

		it("clamps elapsed time to 0..100 and follows the formula for a passed reset", () => {
			expect(
				weeklyPaceDeficit({ utilization: 10, resetsAt: NOW + 8 * DAY }, NOW),
			).toBe(-10);
			expect(
				weeklyPaceDeficit({ utilization: 10, resetsAt: NOW - HOUR }, NOW),
			).toBe(90);
		});

		it("counts an account without weekly data as deficit 0", () => {
			store.setWeeklyDeficit("a", -5);
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("b");
			setSystemTime(new Date(NOW + 1_000));
			store.setWeeklyDeficit("a", 5);
			expect(strategy.select([a, b], meta("s2"))[0].id).toBe("a");
		});

		it("keeps configured priority ahead of the deficit", () => {
			const hi = makeAccount("hi", { priority: 0 });
			const lo = makeAccount("lo", { priority: 1 });
			store.setWeeklyDeficit("hi", -40);
			store.setWeeklyDeficit("lo", 40);
			expect(strategy.select([lo, hi], meta("s"))[0].id).toBe("hi");
		});

		it("keeps probe-backoff rank ahead of the deficit", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			setProbeBackoff("a", NOW + HOUR);
			expect(ids(strategy.select([a, b], meta("s")))).toEqual(["b", "a"]);
		});
	});

	describe("rule 3: 5-hour guard", () => {
		it("skips an account at or above 90% five-hour utilization for a new session", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFiveHour("a", 90);
			store.setFiveHour("b", 10);
			expect(ids(strategy.select([a, b], meta("s")))).toEqual(["b", "a"]);
		});

		it("ignores a stale five-hour figure whose reset has passed", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFiveHour("a", 99, NOW - 1);
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
		});

		it("ignores the guard when every candidate is guarded", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFiveHour("a", 95);
			store.setFiveHour("b", 92);
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
		});

		it("does not move an already mapped session", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s"));
			store.setFiveHour("a", 97);
			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
		});
	});

	describe("rule 4: near-tie alternation", () => {
		it("alternates sessions that start within the recent-pick window when the best deficits are within 10 points", () => {
			store.setWeeklyDeficit("a", 15);
			store.setWeeklyDeficit("b", 6);
			const first = strategy.select([a, b], meta("s1"))[0].id;
			setSystemTime(new Date(NOW + 100));
			const second = strategy.select([a, b], meta("s2"))[0].id;
			setSystemTime(new Date(NOW + 200));
			const third = strategy.select([a, b], meta("s3"))[0].id;
			expect([first, second, third]).toEqual(["a", "b", "a"]);
		});

		it("keeps alternating when several sessions start in the same millisecond", () => {
			store.setWeeklyDeficit("a", 15);
			store.setWeeklyDeficit("b", 6);
			const picks = ["s1", "s2", "s3", "s4"].map(
				(s) => strategy.select([a, b], meta(s))[0].id,
			);
			expect(picks).toEqual(["a", "b", "a", "b"]);
		});

		it("sends every new session to the leader outside the band", () => {
			store.setWeeklyDeficit("a", 20);
			store.setWeeklyDeficit("b", 9);
			const picks = [0, 100, 200].map((dt, i) => {
				setSystemTime(new Date(NOW + dt));
				return strategy.select([a, b], meta(`s${i}`))[0].id;
			});
			expect(picks).toEqual(["a", "a", "a"]);
		});

		it("sends sessions spaced beyond the recent-pick window to the leader", () => {
			store.setWeeklyDeficit("a", 15);
			store.setWeeklyDeficit("b", 6);
			expect(placeSpaced("s1")[0].id).toBe("a");
			expect(placeSpaced("s2")[0].id).toBe("a");
		});
	});

	describe("rule 5: paid extra-usage pool is ignored", () => {
		it("does not let combined utilization (which includes a spent paid pool) change the ranking", () => {
			store.setWeeklyDeficit("a", 30);
			store.setWeeklyDeficit("b", 0);
			store.combined.set("a", 100);
			store.combined.set("b", 0);
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
		});
	});

	describe("rule 6: after a failover the session stays", () => {
		it("rebinds to the account that served after a 429 that arrived after selection", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			const m = meta("s");
			expect(ids(strategy.select([a, b], m))).toEqual(["a", "b"]);
			// a returned 429 after selection; the proxy failed over and b served.
			strategy.onRequestServed(m, b, 200);

			setSystemTime(new Date(NOW + 60_000));
			expect(ids(strategy.select([a, b], meta("s")))).toEqual(["b", "a"]);
		});

		it("rebinds when the mapped account is unavailable and another serves, and does not return", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s"));

			const capped = makeAccount("a", { rate_limited_until: NOW + HOUR });
			const m = meta("s");
			expect(ids(strategy.select([capped, b], m))).toEqual(["b"]);
			strategy.onRequestServed(m, b, 200);

			setSystemTime(new Date(NOW + 30 * 60_000));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("b");
		});

		it("does not rebind on an error response or for a request it did not route", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			const m = meta("s");
			strategy.select([a, b], m);
			strategy.onRequestServed(m, b, 500);
			// A force-routed request (x-better-ccflare-account-id) never reaches select().
			strategy.onRequestServed(meta("s"), b, 200);
			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
		});
	});

	describe("rule 7: idle re-placement", () => {
		it("expires a mapping after one hour without a request and places the session fresh", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s"));
			store.setWeeklyDeficit("a", -40);
			store.setWeeklyDeficit("b", 40);

			setSystemTime(new Date(NOW + HOUR - 1));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
			// The request above refreshed the idle timer.
			setSystemTime(new Date(NOW + 2 * HOUR - 2));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("a");
			setSystemTime(new Date(NOW + 3 * HOUR - 2));
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("b");
		});
	});

	describe("rule 8: per-model-family guard", () => {
		const FABLE = "claude-fable-5-2";

		it("keeps a new session for a guarded family off the guarded account", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFamily("a", "fable", 90);
			store.setFamily("b", "fable", 10);
			expect(ids(strategy.select([a, b], meta("s", FABLE)))).toEqual([
				"b",
				"a",
			]);
		});

		it("moves a mapped session off a guarded account and keeps it there afterwards", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s", FABLE));
			store.setFamily("a", "fable", 95);
			store.setFamily("b", "fable", 10);

			setSystemTime(new Date(NOW + 60_000));
			const m = meta("s", FABLE);
			expect(ids(strategy.select([a, b], m))).toEqual(["b", "a"]);
			strategy.onRequestServed(m, b, 200);

			// The family row clears; the session stays on b (rule 6), for any model.
			store.setFamily("a", "fable", 5);
			setSystemTime(new Date(NOW + 120_000));
			expect(strategy.select([a, b], meta("s", FABLE))[0].id).toBe("b");
			expect(strategy.select([a, b], meta("s", "claude-opus-5-5"))[0].id).toBe(
				"b",
			);
		});

		it("when every candidate is guarded, keeps a mapped session and sends a new one to the lowest family utilization", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("mapped", FABLE));
			store.setFamily("a", "fable", 98);
			store.setFamily("b", "fable", 92);

			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta("mapped", FABLE))[0].id).toBe("a");
			expect(strategy.select([a, b], meta("new", FABLE))[0].id).toBe("b");
		});

		it("does not guard on a stale row whose reset has passed, or a row without a reset", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFamily("a", "fable", 99, NOW - 1);
			store.setFamily("b", "fable", 10);
			expect(strategy.select([a, b], meta("s1", FABLE))[0].id).toBe("a");
			store.setFamily("a", "fable", 99, null);
			expect(placeSpaced("s2", [a, b], FABLE)[0].id).toBe("a");
		});

		it("does not affect a non-Fable request in the same session", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s", "claude-opus-5-5"));
			store.setFamily("a", "fable", 99);
			store.setFamily("b", "fable", 10);
			setSystemTime(new Date(NOW + 60_000));
			expect(
				ids(strategy.select([a, b], meta("s", "claude-opus-5-5"))),
			).toEqual(["a", "b"]);
		});

		it("does not guard requests with an unknown family", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			store.setFamily("a", "fable", 99);
			expect(strategy.select([a, b], meta("s", "gpt-5"))[0].id).toBe("a");
			expect(placeSpaced("s2", [a, b], null as unknown as string)[0].id).toBe(
				"a",
			);
		});

		it("does not move a mapped session to an account with a worse probe-backoff rank", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			strategy.select([a, b], meta("s", FABLE));
			store.setFamily("a", "fable", 95);
			store.setFamily("b", "fable", 10);
			setProbeBackoff("b", NOW + HOUR);
			setSystemTime(new Date(NOW + 60_000));
			expect(strategy.select([a, b], meta("s", FABLE))[0].id).toBe("a");
		});
	});

	describe("placement order ruling", () => {
		it("prefers a 5-hour-guarded account over one under a probe-backoff penalty", () => {
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", -40);
			setProbeBackoff("a", NOW + HOUR);
			store.setFiveHour("b", 95);
			store.setFiveHour("a", 10);
			expect(strategy.select([a, b], meta("s"))[0].id).toBe("b");
		});

		it("orders a guarded-family request: no guard, then 5-hour-guarded only, then family-guarded by family utilization", () => {
			const free = makeAccount("free");
			const fiveH = makeAccount("fiveH");
			const famLow = makeAccount("famLow");
			const famHighBoth = makeAccount("famHighBoth");
			store.setWeeklyDeficit("free", -40);
			store.setWeeklyDeficit("fiveH", 40);
			store.setWeeklyDeficit("famLow", 40);
			store.setWeeklyDeficit("famHighBoth", 40);
			store.setFiveHour("fiveH", 95);
			store.setFiveHour("famLow", 95);
			store.setFamily("famLow", "fable", 91);
			store.setFamily("famHighBoth", "fable", 97);
			store.setFamily("free", "fable", 10);
			store.setFamily("fiveH", "fable", 10);
			expect(
				ids(
					strategy.select(
						[famHighBoth, famLow, fiveH, free],
						meta("s", "claude-fable-5-2"),
					),
				),
			).toEqual(["free", "fiveH", "famLow", "famHighBoth"]);
		});

		it("applies the family guard before the 5-hour guard", () => {
			store.setFiveHour("a", 95);
			store.setFamily("b", "fable", 95);
			store.setFamily("a", "fable", 10);
			expect(strategy.select([a, b], meta("s", "claude-fable-5-2"))[0].id).toBe(
				"a",
			);
		});

		it("lets a guarded account win over a higher-priority one only through the guards", () => {
			const hi = makeAccount("hi", { priority: 0 });
			const lo = makeAccount("lo", { priority: 1 });
			store.setFiveHour("hi", 95);
			expect(strategy.select([hi, lo], meta("s"))[0].id).toBe("lo");
		});
	});

	describe("rule 9: cold start", () => {
		it("alternates new sessions when no candidate has usage data, regardless of spacing", () => {
			const picks = ["s1", "s2", "s3", "s4"].map((s) => placeSpaced(s)[0].id);
			expect(picks).toEqual(["a", "b", "a", "b"]);
		});

		it("keeps alternating cold-start sessions placed in the same millisecond", () => {
			const picks = ["s1", "s2", "s3", "s4"].map(
				(s) => strategy.select([a, b], meta(s))[0].id,
			);
			expect(picks).toEqual(["a", "b", "a", "b"]);
		});
	});

	describe("rule 10: configurable thresholds", () => {
		it("honours custom guard, family guard, tie band and idle time", () => {
			const custom = new SessionPaceStrategy({
				fiveHourGuardPct: 50,
				familyGuardPct: 50,
				tieBandPct: 0,
				idleMs: 10 * 60_000,
			});
			custom.initialize(store);
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", 39);
			store.setFiveHour("a", 60);
			expect(custom.select([a, b], meta("s1"))[0].id).toBe("b");

			store.setFiveHour("a", 10);
			store.setFamily("a", "fable", 60);
			setSystemTime(new Date(NOW + 100));
			expect(custom.select([a, b], meta("s2", "claude-fable-5"))[0].id).toBe(
				"b",
			);

			// Tie band 0: a 1-point lead is not a near-tie, so no alternation.
			store.family.clear();
			setSystemTime(new Date(NOW + 200));
			expect(custom.select([a, b], meta("s3"))[0].id).toBe("a");
			setSystemTime(new Date(NOW + 300));
			expect(custom.select([a, b], meta("s4"))[0].id).toBe("a");

			// Idle 10 minutes.
			store.setWeeklyDeficit("a", -40);
			setSystemTime(new Date(NOW + 300 + 10 * 60_000));
			expect(custom.select([a, b], meta("s4"))[0].id).toBe("b");
		});

		it("uses defaults 90, 90, 10 and one hour", () => {
			expect(new SessionPaceStrategy().options).toEqual({
				fiveHourGuardPct: 90,
				familyGuardPct: 90,
				tieBandPct: 10,
				idleMs: HOUR,
			});
		});
	});

	describe("peek agrees with select", () => {
		const scenarios: Array<[string, () => void, string, string | null]> = [
			["pace", () => store.setWeeklyDeficit("b", 30), "s", null],
			[
				"five-hour guard",
				() => {
					store.setWeeklyDeficit("a", 30);
					store.setFiveHour("a", 99);
				},
				"s",
				null,
			],
			[
				"family guard",
				() => {
					store.setWeeklyDeficit("a", 30);
					store.setFamily("a", "fable", 99);
				},
				"s",
				"claude-fable-5-2",
			],
			["cold start", () => {}, "s", null],
		];
		for (const [name, setup, session, model] of scenarios) {
			it(`for a new session (${name})`, () => {
				setup();
				const m = meta(session, model);
				const peeked = strategy.peek([a, b], m);
				expect(peeked).toBe(strategy.select([a, b], m)[0].id);
			});
		}

		it("for a mapped session, a near-tie alternation and a paused account", () => {
			store.setWeeklyDeficit("a", 15);
			store.setWeeklyDeficit("b", 10);
			strategy.select([a, b], meta("mapped"));
			setSystemTime(new Date(NOW + 100));
			let m = meta("new");
			expect(strategy.peek([a, b], m)).toBe("b");
			expect(strategy.select([a, b], m)[0].id).toBe("b");
			m = meta("mapped");
			expect(strategy.peek([a, b], m)).toBe("a");
			expect(strategy.select([a, b], m)[0].id).toBe("a");
			const paused = makeAccount("a", { paused: true });
			expect(strategy.peek([paused, b], meta("mapped"))).toBe("b");
			expect(strategy.peek([paused])).toBeNull();
		});

		it("does not peek an auto-resumable paused account that select would reject for reauth", () => {
			const stuck = makeAccount("a", {
				paused: true,
				auto_fallback_enabled: true,
				rate_limit_reset: NOW - 60 * 60_000,
				requires_reauth: true,
			});
			store.setWeeklyDeficit("a", 40);
			store.setWeeklyDeficit("b", 0);
			const m = meta("reauth");
			const peeked = strategy.peek([stuck, b], m);
			expect(peeked).toBe("b");
			expect(strategy.select([stuck, b], m)[0].id).toBe(peeked as string);
		});

		it("does not mutate state", () => {
			store.setWeeklyDeficit("a", 15);
			store.setWeeklyDeficit("b", 10);
			strategy.peek([a, b], meta("s1"));
			strategy.peek([a, b], meta("s1"));
			expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
		});
	});

	describe("INFO logging", () => {
		it("logs a placement and a rebind with account names, deficits, 5-hour figures and the deciding rule", () => {
			const lines: string[] = [];
			const logger = (
				strategy as unknown as { log: { info: (m: string) => void } }
			).log;
			logger.info = (m: string) => {
				lines.push(m);
			};
			const gd = makeAccount("uuid-gd-0000", { name: "gooddata" });
			const ai = makeAccount("uuid-ai-0000", { name: "gooddata-ai" });
			store.weekly.set("uuid-gd-0000", {
				utilization: 2,
				resetsAt: Date.parse("2026-11-15T14:00:00Z"),
			});
			store.weekly.set("uuid-ai-0000", {
				utilization: 50,
				resetsAt: Date.parse("2026-11-17T02:00:00Z"),
			});
			store.setFiveHour("uuid-gd-0000", 12);
			store.setFiveHour("uuid-ai-0000", 49);
			store.setFamily("uuid-gd-0000", "fable", 4);
			store.setFamily("uuid-ai-0000", "fable", 9);
			const session = JSON.stringify({
				device_id: "dev",
				account_uuid: "acct-secret",
				session_id: "5e551011-aaaa-bbbb-cccc-000000000000",
			});
			const m = meta(session, "claude-fable-5-2");
			strategy.select([gd, ai], m);
			strategy.onRequestServed(m, ai, 200);

			expect(lines).toHaveLength(2);
			const [place, rebind] = lines;
			expect(place).toContain("session-pace place session=5e551011");
			expect(place).toContain("account=gooddata ");
			expect(place).toContain("rule=pace-deficit");
			expect(place).toContain("gooddata(deficit=+41.8 5h=12% fable=4%)");
			expect(place).toContain("gooddata-ai(deficit=-27.7 5h=49% fable=9%)");
			expect(rebind).toContain(
				"session-pace rebind session=5e551011 from=gooddata to=gooddata-ai rule=failover",
			);
			for (const line of lines) {
				expect(line).not.toContain("uuid-");
				expect(line).not.toContain("acct-secret");
				expect(line).not.toContain("5e551011-");
			}
			console.log(`SAMPLE ${place}\nSAMPLE ${rebind}`);
		});
	});

	describe("log tag", () => {
		it("uses the first 8 characters of the session-id part of metadata.user_id", () => {
			expect(
				sessionLogTag(
					JSON.stringify({
						device_id: "dev",
						account_uuid: "acct-uuid",
						session_id: "0123456789abcdef",
					}),
				),
			).toBe("01234567");
			expect(
				sessionLogTag(
					"user_abc_account_11111111-2222_session_fedcba98-7654-3210",
				),
			).toBe("fedcba98");
			expect(sessionLogTag("plain-session-id-xyz")).toBe("plain-se");
		});
	});
});
