/**
 * A repeated `overage_in_use` cooldown write keeps the later deadline of an
 * active bench, in memory and in the database: two in-flight responses may
 * report different resets, and the shorter one must not end the bench early.
 * An overage write onto an active ordinary cooldown with a later deadline
 * keeps that deadline and labels it as the overage bench.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	cleanupTempDbs,
	tempDbPath,
} from "@better-ccflare/database/test-utils";
import type { Account } from "@better-ccflare/types";
import type { CircuitBreaker } from "../../circuit-breaker";
import { holdsOverageBench } from "../header-mark-out";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let dbOps: DatabaseOperations;

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		consecutive_rate_limits: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		...overrides,
	} as unknown as Account;
}

function seed(until: number | null, reason: string | null): void {
	dbOps.getDatabase().run(
		`INSERT INTO accounts (id, name, provider, created_at, rate_limited_until, rate_limited_at, rate_limited_reason, consecutive_rate_limits)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		["a", "a", "anthropic", Date.now(), until, Date.now() - MINUTE, reason, 0],
	);
}

function stored(): { until: number | null; reason: string | null } {
	return dbOps
		.getDatabase()
		.query<{ until: number | null; reason: string | null }, [string]>(
			"SELECT rate_limited_until AS until, rate_limited_reason AS reason FROM accounts WHERE id = ?",
		)
		.get("a") as { until: number | null; reason: string | null };
}

function harness() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		asyncWriter: {
			enqueue: (job: () => Promise<unknown>) => {
				pending.push(Promise.resolve().then(job));
			},
		},
		dbOps,
	} as unknown as ProxyContext;
	const breaker = {
		recordFailure: mock(() => {}),
	} as unknown as CircuitBreaker;
	return { ctx, breaker, settle: () => Promise.all(pending) };
}

function overage(
	acc: Account,
	resetTime: number,
	h: ReturnType<typeof harness>,
	preserveStreak = true,
): void {
	applyRateLimitCooldown(
		acc,
		{
			isRateLimited: true,
			resetTime,
			reason: "overage_in_use",
			preserveStreak,
		},
		h.ctx,
		h.breaker,
	);
}

beforeEach(() => {
	resetRateLimitProbeGatesForTests();
	dbOps = new DatabaseOperations(tempDbPath("overage-repeat-bench"));
});

afterEach(async () => {
	resetRateLimitProbeGatesForTests();
	await dbOps.close();
	cleanupTempDbs();
});

describe("two overage writes onto one account", () => {
	for (const preserveStreak of [true, false]) {
		const path = preserveStreak ? "all-limited rule path" : "streak path";

		it(`a shorter second deadline keeps the longer bench (${path})`, async () => {
			const now = Date.now();
			seed(null, null);
			const acc = account();
			const h = harness();
			overage(acc, now + 2 * HOUR, h, preserveStreak);
			await h.settle();
			overage(acc, now + HOUR, h, preserveStreak);
			await h.settle();
			expect(acc.rate_limited_until).toBe(now + 2 * HOUR);
			expect(acc.rate_limited_reason).toBe("overage_in_use");
			expect(stored()).toEqual({
				until: now + 2 * HOUR,
				reason: "overage_in_use",
			});
		});

		it(`a longer second deadline extends the bench (${path})`, async () => {
			const now = Date.now();
			seed(null, null);
			const acc = account();
			const h = harness();
			overage(acc, now + HOUR, h, preserveStreak);
			await h.settle();
			overage(acc, now + 3 * HOUR, h, preserveStreak);
			await h.settle();
			expect(acc.rate_limited_until).toBe(now + 3 * HOUR);
			expect(acc.rate_limited_reason).toBe("overage_in_use");
			expect(stored()).toEqual({
				until: now + 3 * HOUR,
				reason: "overage_in_use",
			});
		});
	}

	it("review probe: a 1 h overage write onto a 2 h bench keeps 2 h in memory and DB", async () => {
		const now = Date.now();
		const until = now + 2 * HOUR;
		seed(until, "overage_in_use");
		const acc = account({
			rate_limited_until: until,
			rate_limited_reason: "overage_in_use",
		});
		const h = harness();
		overage(acc, now + HOUR, h);
		await h.settle();
		expect(acc.rate_limited_until).toBe(until);
		expect(stored()).toEqual({ until, reason: "overage_in_use" });
	});
});

describe("stale objects and direct database writes", () => {
	it("a stale in-memory account without the bench cannot shorten it in the database", async () => {
		const now = Date.now();
		const benchUntil = now + 2 * HOUR;
		seed(benchUntil, "overage_in_use");
		const acc = account();
		const h = harness();
		overage(acc, now + HOUR, h);
		await h.settle();
		expect(stored()).toEqual({
			until: benchUntil,
			reason: "overage_in_use",
		});
	});

	for (const [label, increment, opts] of [
		["streak write", true, undefined],
		["authoritative write", false, { authoritativeObservedAt: Date.now() }],
		["guarded write", false, undefined],
	] as const) {
		it(`repository ${label}: a shorter overage deadline keeps the bench`, async () => {
			const now = Date.now();
			const benchUntil = now + 2 * HOUR;
			seed(benchUntil, "overage_in_use");
			await dbOps.markAccountRateLimited(
				"a",
				now + HOUR,
				"overage_in_use",
				increment,
				opts ? { authoritativeObservedAt: now } : undefined,
			);
			expect(stored()).toEqual({
				until: benchUntil,
				reason: "overage_in_use",
			});
		});

		it(`repository ${label}: a longer overage deadline extends the bench`, async () => {
			const now = Date.now();
			seed(now + HOUR, "overage_in_use");
			await dbOps.markAccountRateLimited(
				"a",
				now + 3 * HOUR,
				"overage_in_use",
				increment,
				opts ? { authoritativeObservedAt: now } : undefined,
			);
			expect(stored()).toEqual({
				until: now + 3 * HOUR,
				reason: "overage_in_use",
			});
		});

		it(`repository ${label}: an overage write onto a longer ordinary cooldown keeps it as the bench`, async () => {
			const now = Date.now();
			seed(now + 3 * HOUR, "upstream_429_with_reset");
			await dbOps.markAccountRateLimited(
				"a",
				now + HOUR,
				"overage_in_use",
				increment,
				opts ? { authoritativeObservedAt: now } : undefined,
			);
			expect(stored()).toEqual({
				until: now + 3 * HOUR,
				reason: "overage_in_use",
			});
		});
	}
});

describe("an overage write onto an active ordinary cooldown", () => {
	it("keeps the later ordinary deadline and labels it the overage bench", async () => {
		const now = Date.now();
		const ordinaryUntil = now + 3 * HOUR;
		seed(ordinaryUntil, "upstream_429_with_reset");
		const acc = account({
			rate_limited_until: ordinaryUntil,
			rate_limited_reason: "upstream_429_with_reset",
		});
		const h = harness();
		overage(acc, now + HOUR, h);
		await h.settle();
		expect(acc.rate_limited_until).toBe(ordinaryUntil);
		expect(acc.rate_limited_reason).toBe("overage_in_use");
		expect(stored()).toEqual({
			until: ordinaryUntil,
			reason: "overage_in_use",
		});
	});
});

describe("after the bench deadline", () => {
	it("the account is usable again and an ordinary write replaces the expired bench", async () => {
		const now = Date.now();
		seed(null, null);
		const acc = account();
		const h = harness();
		overage(acc, now + 2 * HOUR, h);
		await h.settle();
		overage(acc, now + HOUR, h);
		await h.settle();
		expect(holdsOverageBench(acc, now + 2 * HOUR - 1)).toBe(true);
		expect(holdsOverageBench(acc, now + 2 * HOUR)).toBe(false);

		// The bench has run out: a later ordinary cooldown is not held to it.
		const expired = now - MINUTE;
		acc.rate_limited_until = expired;
		dbOps
			.getDatabase()
			.run("UPDATE accounts SET rate_limited_until = ? WHERE id = ?", [
				expired,
				"a",
			]);
		expect(holdsOverageBench(acc)).toBe(false);
		const reset = now + 10 * MINUTE;
		applyRateLimitCooldown(
			acc,
			{ resetTime: reset, reason: "upstream_429_with_reset" },
			h.ctx,
			h.breaker,
		);
		await h.settle();
		expect(acc.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(stored()).toEqual({
			until: reset,
			reason: "upstream_429_with_reset",
		});
	});
});
