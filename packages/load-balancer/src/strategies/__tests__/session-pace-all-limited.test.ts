import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	AccountLimit,
	LimitBlockedAccount,
	RequestMeta,
} from "@better-ccflare/types";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");

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

let reqCounter = 0;
function meta(session: string | null): RequestMeta {
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

const fiveHour = (inHours: number | null): AccountLimit => ({
	kind: "five_hour",
	resetAt: inHours === null ? null : NOW + inHours * HOUR,
});
const weekly = (inHours: number | null): AccountLimit => ({
	kind: "weekly",
	resetAt: inHours === null ? null : NOW + inHours * HOUR,
});
const cooldown = (inHours: number): AccountLimit => ({
	kind: "cooldown",
	resetAt: NOW + inHours * HOUR,
});
const family = (inHours: number | null): AccountLimit => ({
	kind: "family",
	family: "opus",
	resetAt: inHours === null ? null : NOW + inHours * HOUR,
});

function blocked(
	account: Account,
	...limits: AccountLimit[]
): LimitBlockedAccount {
	return { account, limits };
}

function captureLog(strategy: SessionPaceStrategy): string[] {
	const lines: string[] = [];
	const log = (strategy as unknown as { log: { info: (m: string) => void } })
		.log;
	log.info = (m: string) => {
		lines.push(m);
	};
	return lines;
}

describe("SessionPaceStrategy.selectWhenAllLimited", () => {
	let strategy: SessionPaceStrategy;
	const a = makeAccount("a");
	const b = makeAccount("b");

	beforeEach(() => {
		setSystemTime(new Date(NOW));
		strategy = new SessionPaceStrategy({}, { timeZone: "Europe/Prague" });
	});
	afterEach(() => {
		setSystemTime();
	});

	it("picks the account whose 5-hour window resets first", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, fiveHour(3)), blocked(b, fiveHour(1))],
			meta("s1"),
		);
		expect(pick?.id).toBe("b");
	});

	it("picks the account whose weekly window resets first", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, weekly(20)), blocked(b, weekly(40))],
			meta("s1"),
		);
		expect(pick?.id).toBe("a");
	});

	it("prefers a 5-hour-exhausted account over a weekly-exhausted one", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, weekly(30)), blocked(b, fiveHour(2))],
			meta("s1"),
		);
		expect(pick?.id).toBe("b");
	});

	it("picks the account whose provider cooldown ends first", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, cooldown(0.5)), blocked(b, cooldown(0.25))],
			meta("s1"),
		);
		expect(pick?.id).toBe("b");
	});

	it("uses the later reset of an account out on two limits", () => {
		// a: 5-hour resets in 1h but weekly only in 10h -> usable in 10h.
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, fiveHour(1), weekly(10)), blocked(b, fiveHour(4))],
			meta("s1"),
		);
		expect(pick?.id).toBe("b");
	});

	it("counts the requested family's limit like any other", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, family(6)), blocked(b, fiveHour(1), family(9))],
			meta("s1"),
		);
		expect(pick?.id).toBe("a");
	});

	it("sorts an unknown reset after every known one", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(a, fiveHour(1), weekly(null)), blocked(b, weekly(100))],
			meta("s1"),
		);
		expect(pick?.id).toBe("b");
	});

	it("still picks an account when every reset is unknown", () => {
		const pick = strategy.selectWhenAllLimited(
			[blocked(b, weekly(null)), blocked(a, fiveHour(null))],
			meta("s1"),
		);
		expect(pick?.id).toBe("a");
	});

	it("breaks a tie by priority, then by name", () => {
		const low = makeAccount("z-low", { priority: 1 });
		const high = makeAccount("y-high", { priority: 0 });
		expect(
			strategy.selectWhenAllLimited(
				[blocked(low, fiveHour(2)), blocked(high, fiveHour(2))],
				meta("s1"),
			)?.id,
		).toBe("y-high");

		const c = makeAccount("c", { priority: 3 });
		const d = makeAccount("d", { priority: 3 });
		expect(
			strategy.selectWhenAllLimited(
				[blocked(d, weekly(5)), blocked(c, weekly(5))],
				meta("s1"),
			)?.id,
		).toBe("c");
	});

	it("returns null for an empty list", () => {
		expect(strategy.selectWhenAllLimited([], meta("s1"))).toBeNull();
	});

	it("routes mapped, new and no-session requests alike", () => {
		// Map session s1 to a while a is available.
		expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
		const list = [blocked(a, fiveHour(3)), blocked(b, fiveHour(1))];
		expect(strategy.selectWhenAllLimited(list, meta("s1"))?.id).toBe("b");
		expect(strategy.selectWhenAllLimited(list, meta("s2"))?.id).toBe("b");
		expect(strategy.selectWhenAllLimited(list, meta(null))?.id).toBe("b");
	});

	it("leaves the session mapping alone", () => {
		expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
		strategy.selectWhenAllLimited(
			[blocked(a, fiveHour(3)), blocked(b, fiveHour(1))],
			meta("s1"),
		);
		// a is available again: the mapped session goes back to a.
		expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
	});

	it("does not rebind the session when the rule-routed account serves the request", () => {
		expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
		// The normal pass ran for this request (family filter emptied it later),
		// then the rule sent it to b, which answered 200.
		const m = meta("s1");
		expect(strategy.select([a, b], m)[0].id).toBe("a");
		expect(
			strategy.selectWhenAllLimited(
				[blocked(a, family(3)), blocked(b, family(1))],
				m,
			)?.id,
		).toBe("b");
		strategy.onRequestServed(m, b, 200);
		expect(strategy.select([a, b], meta("s1"))[0].id).toBe("a");
	});

	it("logs one placement line naming the rule, reason and every candidate", () => {
		const lines = captureLog(strategy);
		strategy.selectWhenAllLimited(
			[
				blocked(a, fiveHour(1), weekly(10)),
				blocked(b, cooldown(2), family(null)),
			],
			meta('{"session_id":"abcdef0123456789"}'),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			"session-pace place session=abcdef01 account=a rule=all-exhausted reason=earliest-reset " +
				"candidates=[a(usable=2026-11-12T22:00:00.000Z limits=5h@2026-11-12T13:00:00.000Z,weekly@2026-11-12T22:00:00.000Z); " +
				"b(usable=unknown limits=cooldown@2026-11-12T14:00:00.000Z,opus@unknown)]",
		);
	});

	it("logs session=none for a request without a session", () => {
		const lines = captureLog(strategy);
		strategy.selectWhenAllLimited([blocked(a, fiveHour(1))], meta(null));
		expect(lines[0]).toStartWith(
			"session-pace place session=none account=a rule=all-exhausted reason=earliest-reset ",
		);
	});
});
