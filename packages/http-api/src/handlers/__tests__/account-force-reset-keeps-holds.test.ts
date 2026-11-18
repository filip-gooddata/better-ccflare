import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import {
	blockFamily,
	clearFamilyBlocksForAccount,
	getFamilyBlock,
	getFamilyBlocksForAccount,
} from "@better-ccflare/proxy";
import { createAccountForceResetRateLimitHandler } from "../accounts";

// A manual reset clears ordinary cooldowns but must not admit known exhausted
// capacity: an active overage_in_use bench and unexpired family blocks stay
// until their reset or a recovery reading, and the response says so.

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-force-reset-keeps-holds.db`;
const HOUR = 60 * 60 * 1000;

interface KeptBody {
	success: boolean;
	message: string;
	usagePollTriggered: boolean;
	kept: {
		overageBench: { until: number; untilIso: string } | null;
		familyBlocks: Array<{
			family: string;
			until: number;
			untilIso: string;
			source: string;
		}>;
	};
}

describe("force-reset-rate-limit keeps an overage bench and family blocks", () => {
	let dbOps: DatabaseOperations;
	let handler: ReturnType<typeof createAccountForceResetRateLimitHandler>;
	let originalFetch: typeof fetch;
	let fetchedUrls: string[];

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	// Every fetch in this file is answered by a fake; nothing leaves the process.
	function fakeFetch(answer: () => Response) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			fetchedUrls.push(url);
			return answer();
		}) as typeof fetch;
	}

	beforeEach(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountForceResetRateLimitHandler(dbOps);
		originalFetch = globalThis.fetch;
		fetchedUrls = [];
		fakeFetch(() => {
			throw new Error("network disabled in tests");
		});
		clearFamilyBlocksForAccount("acct");
		clearFamilyBlocksForAccount("other");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearFamilyBlocksForAccount("acct");
		clearFamilyBlocksForAccount("other");
		usageCache.delete("acct");
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function insertRow(
		rateLimitedUntil: number | null,
		reason: string | null,
		accessToken: string | null = null,
	) {
		return dbOps.getAdapter().run(
			`INSERT INTO accounts
				(id, name, provider, refresh_token, created_at, access_token,
				 rate_limited_until, rate_limited_reason, rate_limited_at,
				 rate_limit_status, rate_limit_reset)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"acct",
				"alpha",
				"anthropic",
				"rt",
				Date.now(),
				accessToken,
				rateLimitedUntil,
				reason,
				Date.now() - 1000,
				"rejected",
				Date.now() + HOUR,
			],
		);
	}

	async function row() {
		return dbOps.getAdapter().get<{
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
			rate_limit_status: string | null;
			rate_limit_reset: number | null;
		}>(
			"SELECT rate_limited_until, rate_limited_reason, rate_limit_status, rate_limit_reset FROM accounts WHERE id = ?",
			["acct"],
		);
	}

	async function reset(): Promise<KeptBody> {
		const response = await handler(
			new Request("http://localhost/api/accounts/acct/force-reset-rate-limit", {
				method: "POST",
			}),
			"acct",
		);
		expect(response.status).toBe(200);
		return (await response.json()) as KeptBody;
	}

	it("keeps an active overage_in_use bench, clears the rest, and reports the bench with its deadline", async () => {
		const benchUntil = Date.now() + 3 * HOUR;
		await insertRow(benchUntil, "overage_in_use");

		const body = await reset();

		const after = await row();
		expect(after?.rate_limited_reason).toBe("overage_in_use");
		expect(after?.rate_limited_until).toBe(benchUntil);
		expect(after?.rate_limit_status).toBeNull();
		expect(after?.rate_limit_reset).toBeNull();

		expect(body.success).toBe(true);
		expect(body.kept.overageBench).toEqual({
			until: benchUntil,
			untilIso: new Date(benchUntil).toISOString(),
		});
		expect(body.kept.familyBlocks).toEqual([]);
		expect(body.message).toContain("overage_in_use");
		expect(body.message).toContain(new Date(benchUntil).toISOString());
	});

	it("clears an ordinary cooldown and reports nothing kept", async () => {
		await insertRow(Date.now() + HOUR, "upstream_429_with_reset");

		const body = await reset();

		const after = await row();
		expect(after?.rate_limited_until).toBeNull();
		expect(after?.rate_limited_reason).toBeNull();
		expect(body.kept).toEqual({ overageBench: null, familyBlocks: [] });
		expect(body.message).not.toContain("Kept");
	});

	it("keeps an active header family block and reports it", async () => {
		await insertRow(null, null);
		const until = Date.now() + 24 * HOUR;
		blockFamily("acct", "fable", until, "header");
		blockFamily("other", "fable", until, "header");

		const body = await reset();

		expect(getFamilyBlock("acct", "fable")?.until).toBe(until);
		expect(getFamilyBlock("other", "fable")?.until).toBe(until);
		expect(body.kept.familyBlocks).toEqual([
			{
				family: "fable",
				until,
				untilIso: new Date(until).toISOString(),
				source: "header",
			},
		]);
		expect(body.message).toContain("fable");
		expect(body.message).toContain(new Date(until).toISOString());
	});

	it("keeps the family block when the usage refresh fails", async () => {
		await insertRow(null, null, "fake-token");
		const until = Date.now() + 24 * HOUR;
		blockFamily("acct", "fable", until, "header");
		fakeFetch(() => new Response("upstream down", { status: 500 }));

		const body = await reset();

		expect(fetchedUrls.length).toBe(1);
		expect(body.usagePollTriggered).toBe(false);
		expect(getFamilyBlock("acct", "fable")?.until).toBe(until);
		expect(body.kept.familyBlocks.map((b) => b.family)).toEqual(["fable"]);
	});

	it("keeps the family block when the refresh returns account windows without family telemetry", async () => {
		await insertRow(null, null, "fake-token");
		const until = Date.now() + 24 * HOUR;
		blockFamily("acct", "fable", until, "header");
		const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
		fakeFetch(
			() =>
				new Response(
					JSON.stringify({
						five_hour: { utilization: 40, resets_at: resetsAt },
						seven_day: { utilization: 20, resets_at: resetsAt },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const body = await reset();

		expect(fetchedUrls.length).toBe(1);
		expect(body.usagePollTriggered).toBe(true);
		expect(getFamilyBlock("acct", "fable")?.until).toBe(until);
		expect(body.kept.familyBlocks.map((b) => b.family)).toEqual(["fable"]);
	});

	it("after the bench and family reset have passed, the account is usable and nothing stale is kept", async () => {
		await insertRow(Date.now() - 1000, "overage_in_use");
		// Recorded while still ahead, expired by now.
		blockFamily(
			"acct",
			"fable",
			Date.now() - 1000,
			"header",
			Date.now() - 10_000,
		);

		const body = await reset();

		const after = await row();
		expect(after?.rate_limited_until).toBeNull();
		expect(after?.rate_limited_reason).toBeNull();
		expect(getFamilyBlocksForAccount("acct")).toEqual([]);
		expect(body.kept).toEqual({ overageBench: null, familyBlocks: [] });
	});
});
