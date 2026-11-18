/**
 * Account reload (POST /api/accounts/:id/reload) and a held usage reading:
 * a reading held until a full window's reset must survive the reload, so a
 * known-full account cannot pass admission if the next usage poll fails. A
 * newer reading still replaces it; an unheld reading is still dropped.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import { createAccountReloadHandler } from "../accounts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const ID = "reload-hold-account";

const reading = (five: number) => ({
	five_hour: {
		utilization: five,
		resets_at: new Date(NOW + 2 * HOUR).toISOString(),
	},
	seven_day: {
		utilization: 20,
		resets_at: new Date(NOW + 50 * HOUR).toISOString(),
	},
});

const dbOps = {
	getAdapter: () => ({
		get: async () => ({ name: "reload-hold", provider: "anthropic" }),
	}),
} as unknown as DatabaseOperations;

async function reload(): Promise<number> {
	const response = await createAccountReloadHandler(dbOps)(
		new Request(`http://localhost/api/accounts/${ID}/reload`, {
			method: "POST",
		}),
		ID,
	);
	return response.status;
}

beforeEach(() => setSystemTime(new Date(NOW)));

afterEach(() => {
	usageCache.delete(ID);
	setSystemTime();
});

describe("account reload and a held usage reading", () => {
	it("keeps a reading held until a full window resets", async () => {
		usageCache.set(ID, reading(100) as never);
		expect(await reload()).toBe(200);
		expect(usageCache.get(ID)).toEqual(reading(100));
		setSystemTime(new Date(NOW + 30 * 60_000));
		expect(usageCache.get(ID)).toEqual(reading(100));
	});

	it("lets a newer reading replace the held one after reload", async () => {
		usageCache.set(ID, reading(100) as never);
		await reload();
		usageCache.set(ID, reading(30) as never);
		expect(usageCache.get(ID)).toEqual(reading(30));
	});

	it("still drops an unheld reading", async () => {
		usageCache.set(ID, reading(40) as never);
		await reload();
		expect(usageCache.get(ID)).toBeNull();
	});
});
