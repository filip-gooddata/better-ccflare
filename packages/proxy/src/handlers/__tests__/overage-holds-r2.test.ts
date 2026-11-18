/**
 * Round-2 holds for the "no extra usage" router:
 * - a `seven_day_<family>` overage header records the family block even when
 *   the same response also shows an account window full;
 * - an overage bench is released by a recovering poll in the `limits[]` shape
 *   as well as the flat one;
 * - an ordinary cooldown may extend an active `overage_in_use` bench but
 *   never shorten or relabel it, in memory or in the database.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	cleanupTempDbs,
	tempDbPath,
} from "@better-ccflare/database/test-utils";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { CircuitBreaker } from "../../circuit-breaker";
import {
	applyOverageCooldown,
	observeLimitHeaders,
	resetHeaderMarkOutForTests,
} from "../header-mark-out";
import {
	clearFamilyBlocks,
	clearFamilyExhaustionCache,
	getFamilyBlock,
} from "../model-capacity";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const P = "anthropic-ratelimit-unified-";
const secs = (ms: number) => String(Math.floor(ms / 1000));
const atSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

let dbOps: DatabaseOperations;
let originalFetch: typeof globalThis.fetch;

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

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
	resetRateLimitProbeGatesForTests();
	resetHeaderMarkOutForTests();
	originalFetch = globalThis.fetch;
	dbOps = new DatabaseOperations(tempDbPath("overage-holds-r2"));
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	usageCache.clear();
	clearFamilyBlocks();
	clearFamilyExhaustionCache();
	resetRateLimitProbeGatesForTests();
	await dbOps.close();
	cleanupTempDbs();
});

describe("a family overage claim with a full account window", () => {
	it("records the standing family block as well as the account mark", () => {
		const now = Date.now();
		const weeklyReset = now + 50 * HOUR;
		const fiveReset = now + 2 * HOUR;
		globalThis.fetch = mock(
			async () => new Response("down", { status: 500 }),
		) as unknown as typeof fetch;
		observeLimitHeaders(
			new Response("{}", {
				headers: {
					[`${P}status`]: "allowed",
					[`${P}overage-in-use`]: "true",
					[`${P}representative-claim`]: "seven_day_fable",
					[`${P}reset`]: secs(weeklyReset),
					[`${P}5h-utilization`]: "1.0",
					[`${P}5h-reset`]: secs(fiveReset),
					[`${P}7d-utilization`]: "0.3",
					[`${P}7d-reset`]: secs(weeklyReset),
				},
			}),
			account(),
		);
		const block = getFamilyBlock("a", "fable");
		expect(block?.source).toBe("header");
		expect(block?.until).toBe(atSecond(weeklyReset));
		expect(getFamilyBlock("a", "sonnet")).toBeNull();
		const usage = usageCache.get("a") as {
			five_hour?: { utilization: number };
		} | null;
		expect(usage?.five_hour?.utilization).toBeGreaterThanOrEqual(100);
	});
});

describe("bench release on a limits[]-only recovering poll", () => {
	it("a newer poll with session and weekly_all below 100 % releases the bench", async () => {
		const now = Date.now();
		const reset = now + 2 * HOUR;
		seed(null, null);
		const acc = account();
		const { ctx, settle } = harness();
		let percent = 100;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						limits: [
							{
								kind: "session",
								percent,
								resets_at: new Date(reset).toISOString(),
							},
							{
								kind: "weekly_all",
								percent: 21,
								resets_at: new Date(now + 50 * HOUR).toISOString(),
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
		await flush();
		applyOverageCooldown(
			new Response("{}", {
				headers: {
					[`${P}overage-in-use`]: "true",
					[`${P}reset`]: secs(reset),
				},
			}),
			acc,
			ctx,
		);
		await settle();
		expect(stored()).toEqual({
			until: atSecond(reset),
			reason: "overage_in_use",
		});

		await new Promise((r) => setTimeout(r, 2));
		await usageCache.refreshNow("a");
		await flush();
		await settle();
		expect(stored().reason).toBe("overage_in_use");

		percent = 30;
		await usageCache.refreshNow("a");
		await flush();
		await settle();
		expect(stored()).toEqual({ until: null, reason: null });
	});
});

describe("an ordinary cooldown against an active overage bench", () => {
	const cases: Array<{
		name: string;
		info: (now: number) => Parameters<typeof applyRateLimitCooldown>[1];
	}> = [
		{
			name: "a 429 with an earlier reset",
			info: (now) => ({
				resetTime: now + 10 * MINUTE,
				reason: "upstream_429_with_reset",
			}),
		},
		{
			name: "a 429 without a reset",
			info: () => ({ reason: "upstream_429_no_reset_probe_cooldown" }),
		},
		{
			name: "an all-limited refusal with an earlier authoritative reset",
			info: (now) => ({
				resetTime: now + 10 * MINUTE,
				reason: "upstream_429_with_reset",
				preserveStreak: true,
			}),
		},
	];
	for (const c of cases) {
		it(`${c.name} neither shortens nor relabels it`, async () => {
			const now = Date.now();
			const benchUntil = now + 2 * HOUR;
			seed(benchUntil, "overage_in_use");
			const acc = account({
				rate_limited_until: benchUntil,
				rate_limited_reason: "overage_in_use",
			});
			const { ctx, breaker, settle } = harness();
			applyRateLimitCooldown(acc, c.info(now), ctx, breaker);
			await settle();
			expect(acc.rate_limited_until).toBe(benchUntil);
			expect(acc.rate_limited_reason).toBe("overage_in_use");
			expect(stored()).toEqual({
				until: benchUntil,
				reason: "overage_in_use",
			});
		});
	}

	it("a 429 with a later reset extends it and keeps the overage reason", async () => {
		const now = Date.now();
		const benchUntil = now + 2 * HOUR;
		const later = now + 5 * HOUR;
		seed(benchUntil, "overage_in_use");
		const acc = account({
			rate_limited_until: benchUntil,
			rate_limited_reason: "overage_in_use",
		});
		const { ctx, breaker, settle } = harness();
		applyRateLimitCooldown(
			acc,
			{ resetTime: later, reason: "upstream_429_with_reset" },
			ctx,
			breaker,
		);
		await settle();
		expect(acc.rate_limited_until).toBe(later);
		expect(acc.rate_limited_reason).toBe("overage_in_use");
		expect(stored()).toEqual({ until: later, reason: "overage_in_use" });
	});

	it("an expired overage bench is replaced like any cooldown", async () => {
		const now = Date.now();
		seed(now - MINUTE, "overage_in_use");
		const acc = account({
			rate_limited_until: now - MINUTE,
			rate_limited_reason: "overage_in_use",
		});
		const { ctx, breaker, settle } = harness();
		const reset = now + 10 * MINUTE;
		applyRateLimitCooldown(
			acc,
			{ resetTime: reset, reason: "upstream_429_with_reset" },
			ctx,
			breaker,
		);
		await settle();
		expect(acc.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(stored()).toEqual({
			until: reset,
			reason: "upstream_429_with_reset",
		});
	});

	it("a stale in-memory account cannot shorten the bench in the database", async () => {
		const now = Date.now();
		const benchUntil = now + 2 * HOUR;
		seed(benchUntil, "overage_in_use");
		const acc = account();
		const { ctx, breaker, settle } = harness();
		applyRateLimitCooldown(
			acc,
			{ resetTime: now + 10 * MINUTE, reason: "upstream_429_with_reset" },
			ctx,
			breaker,
		);
		await settle();
		expect(stored()).toEqual({
			until: benchUntil,
			reason: "overage_in_use",
		});
	});
});
