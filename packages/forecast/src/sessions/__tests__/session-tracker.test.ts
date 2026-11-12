import { describe, expect, it } from "bun:test";
import type { ServedEvent, TokenUsage } from "../../types";
import { demandUnits } from "../../units";
import {
	CACHE_TTL_1H_MS,
	CACHE_TTL_5M_MS,
	createSessionTracker,
} from "../session-tracker";

const MIN = 60_000;
const T0 = Date.parse("2026-11-12T08:00:00Z");

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
	return {
		model: "claude-opus-5-5",
		inputTokens: 10,
		outputTokens: 100,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite5mTokens: null,
		cacheWrite1hTokens: null,
		...overrides,
	};
}

function event(
	sessionId: string,
	at: number,
	u: Partial<TokenUsage> = {},
	accountId = "acct-a",
): ServedEvent {
	return { sessionId, accountId, at, usage: usage(u) };
}

function write(w5m: number | null, w1h: number | null): Partial<TokenUsage> {
	return {
		cacheWriteTokens: (w5m ?? 0) + (w1h ?? 0),
		cacheWrite5mTokens: w5m,
		cacheWrite1hTokens: w1h,
	};
}

describe("createSessionTracker", () => {
	it("reads a 1-hour lifetime from 1-hour cache writes", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("s1", T0, write(0, 5000)));
		const s = tracker.get("s1");
		expect(s?.cacheTtlMs).toBe(CACHE_TTL_1H_MS);
		expect(s?.coldAt).toBe(T0 + CACHE_TTL_1H_MS);
	});

	it("reads a 5-minute lifetime from 5-minute cache writes", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("s1", T0, write(5000, 0)));
		const s = tracker.get("s1");
		expect(s?.cacheTtlMs).toBe(CACHE_TTL_5M_MS);
		expect(s?.coldAt).toBe(T0 + CACHE_TTL_5M_MS);
	});

	it("mixed writes: 1 hour when at least half of the cache-write tokens so far were 1-hour writes", () => {
		const tracker = createSessionTracker({ now: () => T0 + 10 * MIN });
		tracker.observe(event("s1", T0, write(3000, 1000)));
		expect(tracker.get("s1")?.cacheTtlMs).toBe(CACHE_TTL_5M_MS);
		tracker.observe(event("s1", T0 + MIN, write(0, 2000)));
		// 3000 of 6000 are 1-hour writes: exactly half → 1 hour.
		expect(tracker.get("s1")?.cacheTtlMs).toBe(CACHE_TTL_1H_MS);
		expect(tracker.get("s1")?.coldAt).toBe(T0 + MIN + CACHE_TTL_1H_MS);
		tracker.observe(event("s1", T0 + 2 * MIN, write(1, 0)));
		expect(tracker.get("s1")?.cacheTtlMs).toBe(CACHE_TTL_5M_MS);
	});

	it("a split with one side null counts that side as 0", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("s1", T0, write(null, 800)));
		expect(tracker.get("s1")?.cacheTtlMs).toBe(CACHE_TTL_1H_MS);
	});

	it("unknown until a cache write with a known split was seen", () => {
		const tracker = createSessionTracker({ now: () => T0 + 5 * MIN });
		tracker.observe(event("s1", T0));
		expect(tracker.get("s1")?.cacheTtlMs).toBeNull();
		expect(tracker.get("s1")?.coldAt).toBeNull();
		// A cache write without a split does not settle it.
		tracker.observe(event("s1", T0 + MIN, { cacheWriteTokens: 4000 }));
		expect(tracker.get("s1")?.cacheTtlMs).toBeNull();
		// A split with zero tokens is no cache write either.
		tracker.observe(event("s1", T0 + 2 * MIN, write(0, 0)));
		expect(tracker.get("s1")?.cacheTtlMs).toBeNull();
		tracker.observe(event("s1", T0 + 3 * MIN, write(0, 10)));
		expect(tracker.get("s1")?.cacheTtlMs).toBe(CACHE_TTL_1H_MS);
		expect(tracker.get("s1")?.coldAt).toBe(T0 + 3 * MIN + CACHE_TTL_1H_MS);
	});

	it("keeps account, family and context of the last request", () => {
		const tracker = createSessionTracker({ now: () => T0 + MIN });
		tracker.observe(event("s1", T0, { model: "claude-opus-5-5" }, "acct-a"));
		tracker.observe(
			event(
				"s1",
				T0 + MIN,
				{
					model: "claude-fable-5-2",
					inputTokens: 7,
					cacheReadTokens: 90_000,
					cacheWriteTokens: 3,
				},
				"acct-b",
			),
		);
		const s = tracker.get("s1");
		expect(s).toMatchObject({
			sessionId: "s1",
			accountId: "acct-b",
			family: "fable",
			lastRequestAt: T0 + MIN,
			contextTokens: 90_010,
		});
	});

	it("an event older than the last request adds tokens but does not move the last request back", () => {
		const tracker = createSessionTracker({ now: () => T0 + 2 * MIN });
		tracker.observe(event("s1", T0 + MIN, {}, "acct-b"));
		tracker.observe(event("s1", T0, write(10, 0), "acct-a"));
		const s = tracker.get("s1");
		expect(s?.lastRequestAt).toBe(T0 + MIN);
		expect(s?.accountId).toBe("acct-b");
		expect(s?.cacheTtlMs).toBe(CACHE_TTL_5M_MS);
		expect(s?.coldAt).toBe(T0 + MIN + CACHE_TTL_5M_MS);
	});

	it("recentUnits sums demand units of the trailing 60 minutes", () => {
		let now = T0 + 30 * MIN;
		const tracker = createSessionTracker({ now: () => now });
		const a = usage({ inputTokens: 1000, outputTokens: 2000 });
		const b = usage({ inputTokens: 500, cacheReadTokens: 40_000 });
		tracker.observe({ sessionId: "s1", accountId: "x", at: T0, usage: a });
		tracker.observe({
			sessionId: "s1",
			accountId: "x",
			at: T0 + 30 * MIN,
			usage: b,
		});
		expect(tracker.get("s1")?.recentUnits).toBeCloseTo(
			demandUnits(a) + demandUnits(b),
			12,
		);
		now = T0 + 61 * MIN;
		expect(tracker.get("s1")?.recentUnits).toBeCloseTo(demandUnits(b), 12);
		const live = tracker.live(T0 + 91 * MIN, 2 * 60 * MIN);
		expect(live).toHaveLength(1);
		expect(live[0].recentUnits).toBe(0);
	});

	it("live() lists sessions with a request in the trailing maxIdleMs, newest last", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("old", T0 - 20 * MIN));
		tracker.observe(event("mid", T0 - 10 * MIN));
		tracker.observe(event("new", T0 - MIN));
		expect(tracker.live(T0, 15 * MIN).map((s) => s.sessionId)).toEqual([
			"mid",
			"new",
		]);
		expect(tracker.live(T0, 10 * MIN).map((s) => s.sessionId)).toEqual(["new"]);
	});

	it("forget() drops a session", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("s1", T0));
		tracker.forget("s1");
		expect(tracker.get("s1")).toBeNull();
		expect(tracker.live(T0, 60 * MIN)).toEqual([]);
	});

	it("ignores an event without a session id", () => {
		const tracker = createSessionTracker({ now: () => T0 });
		tracker.observe(event("", T0));
		expect(tracker.live(T0, 60 * MIN)).toEqual([]);
	});

	it("caps the number of sessions, evicting the least recently seen", () => {
		const tracker = createSessionTracker({ now: () => T0, maxSessions: 3 });
		tracker.observe(event("a", T0 - 4 * MIN));
		tracker.observe(event("b", T0 - 3 * MIN));
		tracker.observe(event("c", T0 - 2 * MIN));
		// Seeing "a" again makes "b" the least recently seen.
		tracker.observe(event("a", T0 - MIN));
		tracker.observe(event("d", T0));
		expect(tracker.get("b")).toBeNull();
		expect(
			["a", "c", "d"].map((id) => tracker.get(id)?.sessionId ?? null),
		).toEqual(["a", "c", "d"]);
	});

	it("expires a session after expireMs without a request", () => {
		let now = T0;
		const tracker = createSessionTracker({
			now: () => now,
			expireMs: 30 * MIN,
		});
		tracker.observe(event("s1", T0, write(0, 10)));
		now = T0 + 30 * MIN - 1;
		expect(tracker.get("s1")).not.toBeNull();
		now = T0 + 30 * MIN;
		expect(tracker.get("s1")).toBeNull();
		// Expired state does not carry into a new session with the same id.
		tracker.observe(event("s1", now));
		expect(tracker.get("s1")?.cacheTtlMs).toBeNull();
	});

	it("defaults: 10,000 sessions, 24-hour expiry", () => {
		let now = T0;
		const tracker = createSessionTracker({ now: () => now });
		for (let i = 0; i <= 10_000; i++) tracker.observe(event(`s${i}`, T0));
		expect(tracker.get("s0")).toBeNull();
		expect(tracker.get("s1")).not.toBeNull();
		now = T0 + 24 * 60 * MIN;
		expect(tracker.get("s1")).toBeNull();
	});
});
