/**
 * Round-3 holds of the usage cache:
 * - a held full reading survives a polling restart ("Refresh usage" stops and
 *   restarts polling), and a newer reading still replaces it; an explicit
 *   delete (account removal) still drops it;
 * - a reading whose only full window is the flat `seven_day_oauth_apps`
 *   window, which admission counts as an account limit, is held too.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { fullReadingHoldUntil, usageCache } from "../usage-fetcher";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const FIVE_RESET = NOW + 2 * HOUR;
const WEEK_RESET = NOW + 50 * HOUR;
const APPS_RESET = NOW + 70 * HOUR;

type Body = Record<string, unknown> | null;
let body: Body = null;
let originalFetch: typeof globalThis.fetch;

const flat = (five: number, seven = 20): Body => ({
	five_hour: {
		utilization: five,
		resets_at: new Date(FIVE_RESET).toISOString(),
	},
	seven_day: {
		utilization: seven,
		resets_at: new Date(WEEK_RESET).toISOString(),
	},
});

const oauthAppsFull = (): Body => ({
	...flat(30),
	seven_day_oauth_apps: {
		utilization: 100,
		resets_at: new Date(APPS_RESET).toISOString(),
	},
});

async function poll(): Promise<void> {
	await usageCache.refreshNow("a");
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function startPolling(): void {
	usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
}

async function startWith(first: Body): Promise<void> {
	body = first;
	startPolling();
	await poll();
	expect(usageCache.get("a")).not.toBeNull();
	body = null;
}

/** What "Refresh usage" does: stop polling, start it again, poll once. */
async function restartPolling(): Promise<void> {
	usageCache.stopPolling("a");
	startPolling();
	await poll();
}

beforeEach(() => {
	setSystemTime(new Date(NOW));
	originalFetch = globalThis.fetch;
	globalThis.fetch = mock(async () =>
		body === null
			? new Response("down", { status: 500 })
			: new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
	) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	usageCache.clear();
	setSystemTime();
});

describe("a held full reading across a polling restart", () => {
	it("survives stop and restart when the refresh poll fails", async () => {
		await startWith(flat(100));
		await restartPolling();
		expect(usageCache.get("a")).toEqual(flat(100));
		setSystemTime(new Date(NOW + 30 * MINUTE));
		expect(usageCache.get("a")).toEqual(flat(100));
	});

	it("is replaced by the restart's newer reading", async () => {
		await startWith(flat(100));
		body = flat(30);
		await restartPolling();
		expect(usageCache.get("a")).toEqual(flat(30));
	});

	it("an unheld reading is still dropped when polling stops", async () => {
		await startWith(flat(40));
		usageCache.stopPolling("a");
		expect(usageCache.get("a")).toBeNull();
	});

	it("an explicit delete (account removal) still drops a held reading", async () => {
		await startWith(flat(100));
		usageCache.stopPolling("a");
		usageCache.delete("a");
		expect(usageCache.get("a")).toBeNull();
	});
});

describe("a full flat seven_day_oauth_apps window", () => {
	it("gives the reading a hold until that window's reset", () => {
		expect(fullReadingHoldUntil(oauthAppsFull() as never, NOW)).toBe(
			APPS_RESET,
		);
	});

	it("keeps the polled reading past the ten-minute age until its reset", async () => {
		await startWith(oauthAppsFull());
		setSystemTime(new Date(NOW + 30 * MINUTE));
		await poll();
		expect(usageCache.get("a")).not.toBeNull();
		setSystemTime(new Date(APPS_RESET - MINUTE));
		expect(usageCache.get("a")).not.toBeNull();
		setSystemTime(new Date(APPS_RESET + 11 * MINUTE));
		expect(usageCache.get("a")).toBeNull();
	});
});
