import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { forceResetRateLimit } from "../account";

// The CLI clears the database itself, then asks a running local server to
// redo the reset there (family blocks live in that server's memory). Both
// halves keep known exhaustion, and the CLI output says what was kept.

const HOUR = 60 * 60 * 1000;

function makeConfig(): Config {
	return {
		getRuntime: () => ({ port: 8080, tlsEnabled: false }),
		getLocalControlSecret: () => "secret",
	} as unknown as Config;
}

describe("CLI --force-reset-rate-limit keeps an overage bench and family blocks", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;
	let originalFetch: typeof fetch;
	let fetchedUrls: string[];

	function serverAnswers(body: unknown) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			fetchedUrls.push(url);
			if (!url.startsWith("http://localhost:")) {
				throw new Error(`unexpected fetch ${url}`);
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
	}

	beforeEach(() => {
		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		dbPath = join(tmpdir(), `test-cli-reset-holds-${suffix}.db`);
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
		originalFetch = globalThis.fetch;
		fetchedUrls = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			fetchedUrls.push(typeof input === "string" ? input : input.toString());
			throw new Error("connection refused");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		DatabaseFactory.reset();
		for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
			if (existsSync(path)) rmSync(path, { force: true });
		}
	});

	async function insertRow(until: number | null, reason: string | null) {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts
				(id, name, provider, refresh_token, created_at, rate_limited_until, rate_limited_reason, priority)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			["acct", "work", "anthropic", "rt", Date.now(), until, reason, 0],
		);
	}

	async function row() {
		return dbOps.getAdapter().get<{
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
		}>(
			"SELECT rate_limited_until, rate_limited_reason FROM accounts WHERE id = ?",
			["acct"],
		);
	}

	it("keeps an active bench and reports it with its deadline when no server answers", async () => {
		const benchUntil = Date.now() + 3 * HOUR;
		await insertRow(benchUntil, "overage_in_use");

		const result = await forceResetRateLimit(dbOps, "work", makeConfig());

		expect(result.success).toBe(true);
		const after = await row();
		expect(after?.rate_limited_reason).toBe("overage_in_use");
		expect(after?.rate_limited_until).toBe(benchUntil);
		expect(result.kept?.overageBench?.until).toBe(benchUntil);
		expect(result.message).toContain(
			`Kept the overage_in_use bench until ${new Date(benchUntil).toISOString()}`,
		);
		expect(result.message).toContain(
			"No running local server answered, so family blocks held in a server's memory were not checked or cleared.",
		);
	});

	it("reports the family blocks a running server kept", async () => {
		const benchUntil = Date.now() + 3 * HOUR;
		const familyUntil = Date.now() + 24 * HOUR;
		await insertRow(benchUntil, "overage_in_use");
		serverAnswers({
			success: true,
			usagePollTriggered: true,
			kept: {
				overageBench: {
					until: benchUntil,
					untilIso: new Date(benchUntil).toISOString(),
				},
				familyBlocks: [
					{
						family: "fable",
						until: familyUntil,
						untilIso: new Date(familyUntil).toISOString(),
						source: "header",
					},
				],
			},
		});

		const result = await forceResetRateLimit(dbOps, "work", makeConfig());

		expect(result.success).toBe(true);
		expect(fetchedUrls[0]).toContain(
			"/api/accounts/acct/force-reset-rate-limit",
		);
		expect(result.kept?.familyBlocks).toEqual([
			{
				family: "fable",
				until: familyUntil,
				untilIso: new Date(familyUntil).toISOString(),
				source: "header",
			},
		]);
		expect(result.message).toContain(
			`Kept family blocks on the running server: fable until ${new Date(familyUntil).toISOString()}`,
		);
		expect(result.message).toContain("immediate usage polling was triggered");
	});

	it("clears an ordinary cooldown and reports nothing kept", async () => {
		await insertRow(Date.now() + HOUR, "upstream_429_with_reset");
		serverAnswers({
			success: true,
			usagePollTriggered: false,
			kept: { overageBench: null, familyBlocks: [] },
		});

		const result = await forceResetRateLimit(dbOps, "work", makeConfig());

		const after = await row();
		expect(after?.rate_limited_until).toBeNull();
		expect(after?.rate_limited_reason).toBeNull();
		expect(result.kept).toEqual({ overageBench: null, familyBlocks: [] });
		expect(result.message).not.toContain("Kept");
	});

	it("clears a bench whose reset has passed", async () => {
		await insertRow(Date.now() - 1000, "overage_in_use");

		const result = await forceResetRateLimit(dbOps, "work", makeConfig());

		const after = await row();
		expect(after?.rate_limited_until).toBeNull();
		expect(after?.rate_limited_reason).toBeNull();
		expect(result.kept?.overageBench).toBeNull();
		expect(result.message).not.toContain("Kept the overage_in_use bench");
	});
});
