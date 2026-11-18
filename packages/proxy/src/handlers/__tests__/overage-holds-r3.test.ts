/**
 * Round-3 hold of the overage bench: the legacy capacity-restored callback
 * (a usage poll below 100 % after the usage endpoint answered 429) clears an
 * ordinary cooldown as before, but never an active `overage_in_use` bench.
 * Only the bench's reset or the recovery rule (a newer poll showing both the
 * five-hour and the weekly window below 100 %) ends that.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	cleanupTempDbs,
	tempDbPath,
} from "@better-ccflare/database/test-utils";
import { usageCache } from "@better-ccflare/providers";
import { clearCooldownOnCapacityRestored } from "../header-mark-out";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let dbOps: DatabaseOperations;
let originalFetch: typeof globalThis.fetch;

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

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Polls once with a usage-endpoint 429, then once with a partial reading
 * (five-hour below the limit, no weekly window): the shape that fires the
 * capacity-restored callback.
 */
async function pollRateLimitedThenPartial(): Promise<void> {
	let answer: "429" | "partial" = "429";
	globalThis.fetch = mock(async () =>
		answer === "429"
			? new Response("slow down", {
					status: 429,
					headers: { "retry-after": "30" },
				})
			: new Response(
					JSON.stringify({
						five_hour: {
							utilization: 30,
							resets_at: new Date(Date.now() + 2 * HOUR).toISOString(),
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
	) as unknown as typeof fetch;
	const restored: Promise<unknown>[] = [];
	usageCache.startPolling(
		"a",
		"token",
		"anthropic",
		24 * HOUR,
		undefined,
		undefined,
		(accountId) => {
			restored.push(clearCooldownOnCapacityRestored(dbOps, accountId));
		},
	);
	await flush();
	await usageCache.refreshNow("a");
	answer = "partial";
	await usageCache.refreshNow("a");
	await flush();
	expect(restored.length).toBeGreaterThan(0);
	await Promise.all(restored);
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	dbOps = new DatabaseOperations(tempDbPath("overage-holds-r3"));
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	usageCache.clear();
	await dbOps.close();
	cleanupTempDbs();
});

describe("capacity-restored callback after a usage-endpoint 429", () => {
	it("keeps an active overage_in_use bench, in the database", async () => {
		const until = Date.now() + 2 * HOUR;
		seed(until, "overage_in_use");
		await pollRateLimitedThenPartial();
		expect(stored()).toEqual({ until, reason: "overage_in_use" });
	});

	it("still clears an ordinary cooldown as before", async () => {
		seed(Date.now() + 2 * HOUR, "upstream_429_with_reset");
		await pollRateLimitedThenPartial();
		expect(stored()).toEqual({ until: null, reason: null });
	});

	it("clears an overage bench whose reset has passed like any other", async () => {
		seed(Date.now() - MINUTE, "overage_in_use");
		const result = await clearCooldownOnCapacityRestored(dbOps, "a");
		// Nothing in the future to clear: the legacy rule only acts on a
		// cooldown still ahead, and leaves an expired row to the expiry sweep.
		expect(result).toBe("none");
	});

	it("does not clear a bench written between its read and its write", async () => {
		seed(Date.now() + HOUR, "upstream_429_with_reset");
		const until = Date.now() + 3 * HOUR;
		const racing = {
			getAccount: async (id: string) => {
				const account = await dbOps.getAccount(id);
				dbOps
					.getDatabase()
					.run(
						"UPDATE accounts SET rate_limited_until = ?, rate_limited_reason = 'overage_in_use' WHERE id = ?",
						[until, id],
					);
				return account;
			},
			getAdapter: () => dbOps.getAdapter(),
		};
		await clearCooldownOnCapacityRestored(racing, "a");
		expect(stored()).toEqual({ until, reason: "overage_in_use" });
	});
});
