import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { CircuitBreaker } from "../../circuit-breaker";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const HOUR = 3_600_000;

function account(streak: number): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		consecutive_rate_limits: streak,
		rate_limited_until: null,
	} as unknown as Account;
}

function harness() {
	const marks: Array<{ until: number; increment: boolean }> = [];
	const ctx = {
		asyncWriter: {
			enqueue: mock(async (job: () => Promise<void>) => {
				await job();
			}),
		},
		dbOps: {
			markAccountRateLimited: mock(
				async (_id: string, until: number, _r: string, increment = true) => {
					marks.push({ until, increment });
					return { consecutiveRateLimits: 3, applied: true };
				},
			),
		},
	} as unknown as ProxyContext;
	const recordFailure = mock(() => {});
	const breaker = { recordFailure } as unknown as CircuitBreaker;
	return { ctx, marks, recordFailure, breaker };
}

beforeEach(() => {
	resetRateLimitProbeGatesForTests();
});

afterEach(() => {
	resetRateLimitProbeGatesForTests();
});

describe("applyRateLimitCooldown with preserveStreak", () => {
	it("sets the cooldown from the reported reset without touching streak or breaker", async () => {
		const { ctx, marks, recordFailure, breaker } = harness();
		const acc = account(3);
		const resetTime = Date.now() + HOUR;

		applyRateLimitCooldown(
			acc,
			{ resetTime, reason: "upstream_429_with_reset", preserveStreak: true },
			ctx,
			breaker,
		);
		await Promise.resolve();

		expect(acc.rate_limited_until).toBe(resetTime);
		expect(acc.consecutive_rate_limits).toBe(3);
		expect(marks).toEqual([{ until: resetTime, increment: false }]);
		expect(recordFailure).not.toHaveBeenCalled();
	});

	it("keeps the current ramp tier instead of climbing it when no reset is reported", () => {
		const preserved = harness();
		const climbed = harness();
		const a = account(3);
		const b = account(3);

		applyRateLimitCooldown(
			a,
			{ reason: "upstream_429_no_reset_probe_cooldown", preserveStreak: true },
			preserved.ctx,
			preserved.breaker,
		);
		applyRateLimitCooldown(
			b,
			{ reason: "upstream_429_no_reset_probe_cooldown" },
			climbed.ctx,
			climbed.breaker,
		);

		expect(a.rate_limited_until as number).toBeLessThan(
			b.rate_limited_until as number,
		);
		expect(climbed.recordFailure).toHaveBeenCalledTimes(1);
		expect(climbed.marks[0]?.increment).toBe(true);
	});

	it("is a no-op flag for the transient upstream reasons", () => {
		const { ctx, marks, breaker } = harness();
		const acc = account(1);
		applyRateLimitCooldown(
			acc,
			{ reason: "upstream_529_overloaded_no_reset", preserveStreak: true },
			ctx,
			breaker,
		);
		expect(marks[0]?.increment).toBe(false);
		expect(acc.consecutive_rate_limits).toBe(1);
	});
});
