import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	cleanupTempDbs,
	tempDbPath,
} from "@better-ccflare/database/test-utils";
import type { Account } from "@better-ccflare/types";
import type { CircuitBreaker } from "../../circuit-breaker";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const HOUR = 3_600_000;
const MINUTE = 60_000;

let dbOps: DatabaseOperations;

interface Stored {
	rate_limited_until: number | null;
	consecutive_rate_limits: number;
}

function seed(until: number, streak: number): Account {
	dbOps.getDatabase().run(
		`INSERT INTO accounts (id, name, provider, created_at, rate_limited_until, rate_limited_at, rate_limited_reason, consecutive_rate_limits)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"a",
			"a",
			"anthropic",
			Date.now(),
			until,
			Date.now() - MINUTE,
			"upstream_429_no_reset_probe_cooldown",
			streak,
		],
	);
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		consecutive_rate_limits: streak,
		rate_limited_until: until,
	} as unknown as Account;
}

function stored(): Stored {
	return dbOps
		.getDatabase()
		.query<Stored, [string]>(
			"SELECT rate_limited_until, consecutive_rate_limits FROM accounts WHERE id = ?",
		)
		.get("a") as Stored;
}

function harness() {
	const pending: Promise<void>[] = [];
	const ctx = {
		asyncWriter: {
			enqueue: (job: () => Promise<void>) => {
				pending.push(job());
			},
		},
		dbOps,
	} as unknown as ProxyContext;
	const breaker = {
		recordFailure: mock(() => {}),
	} as unknown as CircuitBreaker;
	return { ctx, breaker, settle: () => Promise.all(pending) };
}

beforeEach(() => {
	resetRateLimitProbeGatesForTests();
	dbOps = new DatabaseOperations(tempDbPath("preserve-streak-db"));
});

afterEach(async () => {
	resetRateLimitProbeGatesForTests();
	await dbOps.close();
	cleanupTempDbs();
});

describe("applyRateLimitCooldown with preserveStreak against the stored cooldown", () => {
	it("shortens an older stored cooldown to an earlier header-reported reset, streak unchanged", async () => {
		const acc = seed(Date.now() + 5 * HOUR, 2);
		const resetTime = Date.now() + 10 * MINUTE;
		const { ctx, breaker, settle } = harness();

		applyRateLimitCooldown(
			acc,
			{ resetTime, reason: "upstream_429_with_reset", preserveStreak: true },
			ctx,
			breaker,
		);
		await settle();

		expect(stored()).toEqual({
			rate_limited_until: resetTime,
			consecutive_rate_limits: 2,
		});
		expect(acc.rate_limited_until).toBe(resetTime);
		expect(acc.consecutive_rate_limits).toBe(2);
	});

	it("keeps an older, later stored cooldown when the earlier reset is inferred", async () => {
		const longUntil = Date.now() + 5 * HOUR;
		const acc = seed(longUntil, 2);
		const { ctx, breaker, settle } = harness();

		applyRateLimitCooldown(
			acc,
			{
				resetTime: Date.now() + 10 * MINUTE,
				resetIsInferred: true,
				preserveStreak: true,
			},
			ctx,
			breaker,
		);
		await settle();

		expect(stored()).toEqual({
			rate_limited_until: longUntil,
			consecutive_rate_limits: 2,
		});
		expect(acc.rate_limited_until).toBe(longUntil);
		expect(acc.consecutive_rate_limits).toBe(2);
	});
});
