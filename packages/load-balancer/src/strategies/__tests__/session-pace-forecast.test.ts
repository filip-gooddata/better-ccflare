import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { clearAllProbeBackoff, setProbeBackoff } from "@better-ccflare/core";
import type {
	ForecastAdvisor,
	MoveAdvice,
	PlacementAdvice,
} from "@better-ccflare/forecast";
import {
	SessionPaceStrategy,
	sessionLogTag,
} from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
	StrategyUsageWindow,
} from "@better-ccflare/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-11T15:30:00Z");
const PRAGUE = { timeZone: "Europe/Prague" };
const S1 = "user_abc_account__session_11111111-aaaa";

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
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
		...overrides,
	};
}

class FakeUsageStore implements StrategyStore {
	weekly = new Map<string, StrategyUsageWindow>();
	fiveHour = new Map<string, StrategyUsageWindow>();
	family = new Map<string, StrategyUsageWindow[]>();

	resetAccountSession(): void {}
	resumeAccount(): void {}
	getAccountUtilization(): number | null {
		return null;
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
	/** Weekly deficit at NOW in Europe/Prague with Mon–Fri work days (see session-pace.test.ts). */
	setWeeklyDeficit(accountId: string, deficit: number): void {
		this.weekly.set(accountId, {
			utilization: 53.75 - deficit,
			resetsAt: NOW + 3.5 * DAY,
		});
	}
	setFiveHour(accountId: string, utilization: number, resetsAt = NOW + HOUR) {
		this.fiveHour.set(accountId, { utilization, resetsAt });
	}
	setFamily(accountId: string, family: string, utilization: number) {
		this.family.set(`${accountId}:${family}`, [
			{ utilization, resetsAt: NOW + 3 * DAY },
		]);
	}
}

class FakeAdvisor implements ForecastAdvisor {
	placement: PlacementAdvice | null = null;
	moves = new Map<string, MoveAdvice>();
	ttl = new Map<string, number | null>();
	appliedCalls: [string, string, string, number][] = [];
	placeCalls = 0;
	moveCalls = 0;

	placeNewSession(): PlacementAdvice | null {
		this.placeCalls++;
		return this.placement;
	}
	moveFor(sessionId: string): MoveAdvice | null {
		this.moveCalls++;
		return this.moves.get(sessionId) ?? null;
	}
	cacheTtlMs(sessionId: string): number | null {
		return this.ttl.get(sessionId) ?? null;
	}
	applied(
		kind: "place" | "move",
		sessionId: string,
		accountId: string,
		now: number,
	): void {
		this.appliedCalls.push([kind, sessionId, accountId, now]);
	}
}

class ThrowingAdvisor implements ForecastAdvisor {
	placeNewSession(): PlacementAdvice | null {
		throw new Error("boom");
	}
	moveFor(): MoveAdvice | null {
		throw new Error("boom");
	}
	cacheTtlMs(): number | null {
		throw new Error("boom");
	}
	applied(): void {
		throw new Error("boom");
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

function captureLines(strategy: SessionPaceStrategy): string[] {
	const lines: string[] = [];
	const log = (
		strategy as unknown as {
			log: { info: (m: string) => void; warn: (m: string) => void };
		}
	).log;
	log.info = (m: string) => {
		lines.push(m);
	};
	log.warn = (m: string) => {
		lines.push(`WARN ${m}`);
	};
	return lines;
}

function lookahead(
	tiers: string[][],
	reason = "low-point+12.4",
): PlacementAdvice {
	return { tiers, rule: "forecast-lookahead", reason };
}

function move(
	sessionId: string,
	from: string,
	to: string,
	overrides: Partial<MoveAdvice> = {},
): MoveAdvice {
	return {
		sessionId,
		from,
		to,
		rule: "forecast-move",
		reason: "low-point+3.1",
		gainPoints: 3.14,
		costPoints: 1.25,
		...overrides,
	};
}

describe("SessionPaceStrategy with a forecast advisor", () => {
	let store: FakeUsageStore;
	let strategy: SessionPaceStrategy;
	let advisor: FakeAdvisor;
	let a: Account;
	let b: Account;
	let c: Account;

	beforeEach(() => {
		setSystemTime(new Date(NOW));
		clearAllProbeBackoff();
		store = new FakeUsageStore();
		strategy = new SessionPaceStrategy({}, PRAGUE);
		strategy.initialize(store);
		advisor = new FakeAdvisor();
		strategy.setForecastAdvisor(advisor);
		a = makeAccount("a");
		b = makeAccount("b");
		c = makeAccount("c");
		// Today's rules favour a over b over c.
		store.setWeeklyDeficit("a", 30);
		store.setWeeklyDeficit("b", 10);
		store.setWeeklyDeficit("c", 0);
		store.setFiveHour("a", 20);
		store.setFiveHour("b", 20);
		store.setFiveHour("c", 20);
	});

	afterEach(() => {
		setSystemTime();
		clearAllProbeBackoff();
	});

	describe("new session", () => {
		it("takes the first tier that holds a candidate and logs the advice's rule and reason", () => {
			const lines = captureLines(strategy);
			advisor.placement = lookahead([["x-unknown"], ["b"], ["a"]]);
			expect(ids(strategy.select([a, b, c], meta(S1)))).toEqual([
				"b",
				"a",
				"c",
			]);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toStartWith(
				`session-pace place session=${sessionLogTag(S1)} account=b-name rule=forecast-lookahead reason=low-point+12.4 work_days=5 tz=Europe/Prague family=opus candidates=[`,
			);
		});

		it("uses rule forecast-open from the advice", () => {
			const lines = captureLines(strategy);
			advisor.placement = {
				tiers: [["c"]],
				rule: "forecast-open",
				reason: "open-c-now",
			};
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("c");
			expect(lines[0]).toContain(
				"account=c-name rule=forecast-open reason=open-c-now ",
			);
		});

		it("ranks inside a tier by today's rules", () => {
			advisor.placement = lookahead([["c", "b"], ["a"]]);
			expect(ids(strategy.select([a, b, c], meta(S1)))).toEqual([
				"b",
				"c",
				"a",
			]);
			// Priority still beats deficit inside a tier.
			const c2 = makeAccount("c", { priority: -1 });
			expect(strategy.select([a, b, c2], meta("s2"))[0].id).toBe("c");
		});

		it("keeps the session on the placed account for later requests without asking again", () => {
			advisor.placement = lookahead([["b"]]);
			const m1 = meta(S1);
			strategy.select([a, b, c], m1);
			strategy.onRequestServed(m1, b, 200);
			advisor.placement = lookahead([["c"]]);
			setSystemTime(new Date(NOW + MIN));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("b");
		});

		it("the 5-hour guard is not a hard filter under advice", () => {
			store.setFiveHour("b", 95);
			advisor.placement = lookahead([["b"], ["a"]]);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("b");
		});

		it("never places on an account that is out (5-hour or weekly used up)", () => {
			store.setFiveHour("b", 100);
			store.weekly.set("c", { utilization: 100, resetsAt: NOW + DAY });
			advisor.placement = lookahead([["b"], ["c"], ["a"]]);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("skips a tier whose accounts fail the family guard or are backed off", () => {
			store.setFamily("b", "opus", 95);
			setProbeBackoff("c", NOW + HOUR);
			advisor.placement = lookahead([["b"], ["c"], ["a"]]);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("falls back to today's rules when no tier holds a candidate", () => {
			const lines = captureLines(strategy);
			advisor.placement = lookahead([["x-unknown"]]);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(lines[0]).toContain("account=a-name rule=pace-deficit ");
		});

		it("does not consult the advisor for requests without a client session", () => {
			advisor.placement = lookahead([["b"]]);
			expect(strategy.select([a, b, c], meta(null))[0].id).toBe("a");
			expect(advisor.placeCalls).toBe(0);
		});

		it("calls applied once, after the advised account served the request", () => {
			advisor.placement = lookahead([["b"]]);
			const m1 = meta(S1);
			strategy.select([a, b, c], m1);
			expect(advisor.appliedCalls).toEqual([]);
			setSystemTime(new Date(NOW + 2000));
			strategy.onRequestServed(m1, b, 200);
			strategy.onRequestServed(m1, b, 200);
			expect(advisor.appliedCalls).toEqual([["place", S1, "b", NOW + 2000]]);
		});

		it("does not call applied when another account or an error status served it", () => {
			advisor.placement = lookahead([["b"]]);
			const m1 = meta(S1);
			strategy.select([a, b, c], m1);
			strategy.onRequestServed(m1, a, 200);
			const m2 = meta("s2");
			strategy.select([a, b, c], m2);
			strategy.onRequestServed(m2, b, 529);
			expect(advisor.appliedCalls).toEqual([]);
		});
	});

	describe("live session", () => {
		function mapTo(session: string, account: Account) {
			advisor.placement = lookahead([[account.id]]);
			const m = meta(session);
			strategy.select([a, b, c], m);
			strategy.onRequestServed(m, account, 200);
			advisor.placement = null;
			advisor.appliedCalls = [];
		}

		it("applies a planned move, logs one line, rebinds when served, then stays", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, HOUR);
			const lines = captureLines(strategy);
			advisor.moves.set(S1, move(S1, "a", "c"));
			setSystemTime(new Date(NOW + MIN));
			const m = meta(S1);
			expect(ids(strategy.select([a, b, c], m))).toEqual(["c", "a", "b"]);
			expect(lines).toEqual([
				`session-pace move session=${sessionLogTag(S1)} from=a-name to=c-name rule=forecast-move reason=low-point+3.1 gain=3.1 cost=1.3`,
			]);
			strategy.onRequestServed(m, c, 200);
			expect(lines).toHaveLength(1);
			expect(advisor.appliedCalls).toEqual([["move", S1, "c", NOW + MIN]]);
			advisor.moves.clear();
			setSystemTime(new Date(NOW + 2 * MIN));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("c");
		});

		it("keeps the mapping and calls no applied when the move target did not serve", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, HOUR);
			advisor.moves.set(S1, move(S1, "a", "c"));
			const m = meta(S1);
			strategy.select([a, b, c], m);
			strategy.onRequestServed(m, a, 200);
			expect(advisor.appliedCalls).toEqual([]);
			advisor.moves.clear();
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("refuses a move to an account that is not a candidate", () => {
			mapTo(S1, a);
			const lines = captureLines(strategy);
			advisor.moves.set(S1, move(S1, "a", "c"));
			const cLimited = makeAccount("c", { rate_limited_until: NOW + HOUR });
			expect(ids(strategy.select([a, b, cLimited], meta(S1)))).toEqual([
				"a",
				"b",
			]);
			advisor.moves.set(S1, move(S1, "a", "x-unknown"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(lines).toEqual([]);
		});

		it("refuses a move to an account that is out", () => {
			mapTo(S1, a);
			store.setFiveHour("c", 100);
			advisor.moves.set(S1, move(S1, "a", "c"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			store.setFiveHour("c", 20);
			store.weekly.set("c", { utilization: 100, resetsAt: NOW + DAY });
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("refuses a move to an account that fails the family guard", () => {
			mapTo(S1, a);
			store.setFamily("c", "opus", 92);
			advisor.moves.set(S1, move(S1, "a", "c"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("refuses a stale move whose source is not the mapped account", () => {
			mapTo(S1, a);
			advisor.moves.set(S1, move(S1, "b", "c"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
		});

		it("allows a move onto an account above the 5-hour guard", () => {
			mapTo(S1, a);
			store.setFiveHour("c", 95);
			advisor.moves.set(S1, move(S1, "a", "c"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("c");
		});

		it("the family guard still moves a mapped session as today", () => {
			mapTo(S1, a);
			const lines = captureLines(strategy);
			store.setFamily("a", "opus", 95);
			advisor.moves.set(S1, move(S1, "a", "c"));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("b");
			expect(lines[0]).toStartWith(
				`session-pace family-guard demotes session=${sessionLogTag(S1)} from=a-name next=b-name`,
			);
		});
	});

	describe("cold session", () => {
		function mapTo(session: string, account: Account) {
			advisor.placement = lookahead([[account.id]]);
			const m = meta(session);
			strategy.select([a, b, c], m);
			strategy.onRequestServed(m, account, 200);
			advisor.appliedCalls = [];
		}

		it("re-places a session with a 5-minute cache after 5 minutes, with a cold: reason", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, 5 * MIN);
			advisor.placement = lookahead([["b"]], "rebalance");
			const lines = captureLines(strategy);

			setSystemTime(new Date(NOW + 5 * MIN - 1));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(lines).toEqual([]);

			// The previous request touched the mapping: 5 minutes after it.
			setSystemTime(new Date(NOW + 10 * MIN - 1));
			const m = meta(S1);
			expect(strategy.select([a, b, c], m)[0].id).toBe("b");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toStartWith(
				`session-pace place session=${sessionLogTag(S1)} account=b-name rule=forecast-lookahead reason=cold:rebalance `,
			);
			strategy.onRequestServed(m, b, 200);
			expect(advisor.appliedCalls).toEqual([
				["place", S1, "b", NOW + 10 * MIN - 1],
			]);
			advisor.placement = lookahead([["c"]]);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("b");
		});

		it("keeps a session with a 1-hour cache that has been idle 5 minutes", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, HOUR);
			advisor.placement = lookahead([["b"]]);
			setSystemTime(new Date(NOW + 6 * MIN));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			// Its moves are still asked for.
			expect(advisor.moveCalls).toBe(1);
		});

		it("an unknown lifetime falls back to the idle setting", () => {
			const short = new SessionPaceStrategy({ idleMs: 10 * MIN }, PRAGUE);
			short.initialize(store);
			short.setForecastAdvisor(advisor);
			advisor.placement = lookahead([["a"]]);
			const m = meta(S1);
			short.select([a, b, c], m);
			short.onRequestServed(m, a, 200);
			advisor.placement = lookahead([["b"]]);
			setSystemTime(new Date(NOW + 9 * MIN));
			expect(short.select([a, b, c], meta(S1))[0].id).toBe("a");
			setSystemTime(new Date(NOW + 30 * MIN));
			expect(short.select([a, b, c], meta(S1))[0].id).toBe("b");
		});

		it("a cold session landing on its own account logs the plain reason", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, 5 * MIN);
			advisor.placement = lookahead([["a"]], "stay");
			const lines = captureLines(strategy);
			setSystemTime(new Date(NOW + 6 * MIN));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(lines[0]).toContain(
				"account=a-name rule=forecast-lookahead reason=stay ",
			);
		});

		it("a cold session without placement advice stays mapped and asks no move", () => {
			mapTo(S1, a);
			advisor.ttl.set(S1, 5 * MIN);
			advisor.placement = null;
			advisor.moves.set(S1, move(S1, "a", "c"));
			setSystemTime(new Date(NOW + 6 * MIN));
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(advisor.moveCalls).toBe(0);
		});
	});

	describe("fallback identical to pace.3", () => {
		type Trace = (string | string[])[];

		/** A run through today's rules: placements, guards, failover, all-limited. */
		function scenario(make: () => SessionPaceStrategy): Trace {
			setSystemTime(new Date(NOW));
			clearAllProbeBackoff();
			const s = new FakeUsageStore();
			const strat = make();
			strat.initialize(s);
			const lines = captureLines(strat);
			const trace: Trace = [];
			const acc = [makeAccount("a"), makeAccount("b"), makeAccount("c")];
			s.setWeeklyDeficit("a", 30);
			s.setWeeklyDeficit("b", 29);
			s.setWeeklyDeficit("c", 0);
			s.setFiveHour("a", 20);
			s.setFiveHour("b", 92);
			s.fiveHour.set("c", { utilization: 0, resetsAt: null });
			const step = (session: string | null, model?: string) => {
				const m = meta(session, model);
				const order = strat.select(acc, m);
				trace.push(ids(order));
				trace.push(strat.peek(acc, meta(session, model)) ?? "none");
				if (order[0]) strat.onRequestServed(m, order[0], 200);
			};
			step("s1");
			step("s2");
			step(null);
			setSystemTime(new Date(NOW + 200));
			step("s3");
			step("s4");
			s.setFamily("a", "opus", 95);
			step("s1");
			step("s1", "claude-sonnet-4-5");
			setSystemTime(new Date(NOW + 3 * MIN));
			// Failover: the mapped account becomes unavailable.
			acc[1] = makeAccount("b", { rate_limited_until: NOW + HOUR });
			step("s2");
			setSystemTime(new Date(NOW + 2 * HOUR));
			step("s1");
			step("s5");
			const limited = strat.selectWhenAllLimited(
				[
					{
						account: acc[0],
						limits: [{ kind: "five_hour", resetAt: NOW + 3 * HOUR }],
					},
					{
						account: acc[2],
						limits: [{ kind: "five_hour", resetAt: NOW + 4 * HOUR }],
					},
				],
				meta("s6"),
			);
			trace.push(limited?.id ?? "none");
			trace.push(...lines);
			return trace;
		}

		it("an advisor with no advice and an advisor that throws route and log exactly as no advisor", () => {
			const plain = scenario(() => new SessionPaceStrategy({}, PRAGUE));
			const silent = new FakeAdvisor();
			const quiet = scenario(() => {
				const st = new SessionPaceStrategy({}, PRAGUE);
				st.setForecastAdvisor(silent);
				return st;
			});
			const throwing = scenario(() => {
				const st = new SessionPaceStrategy({}, PRAGUE);
				st.setForecastAdvisor(new ThrowingAdvisor());
				return st;
			});
			expect(plain.length).toBeGreaterThan(20);
			expect(quiet).toEqual(plain);
			expect(silent.placeCalls).toBeGreaterThan(0);
			expect(silent.moveCalls).toBeGreaterThan(0);
			expect(silent.appliedCalls).toEqual([]);
			const warnings = throwing.filter(
				(l) => typeof l === "string" && l.startsWith("WARN "),
			);
			// At most one warning a minute: NOW, NOW+3min, NOW+2h.
			expect(warnings).toHaveLength(3);
			for (const w of warnings) expect(w).toContain("forecast advisor failed");
			expect(throwing.filter((l) => !warnings.includes(l as string))).toEqual(
				plain,
			);
		});

		it("removing the advisor restores today's rules", () => {
			advisor.placement = lookahead([["c"]]);
			strategy.setForecastAdvisor(null);
			expect(strategy.select([a, b, c], meta(S1))[0].id).toBe("a");
			expect(advisor.placeCalls).toBe(0);
		});
	});
});
