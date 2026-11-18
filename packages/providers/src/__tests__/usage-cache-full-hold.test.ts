/**
 * A polled reading that shows a window full stays in the cache until that
 * window's reset, even when later polls fail, the same way a header mark
 * does. A newer recovering poll still replaces it, and a reading with no full
 * window expires by age as before.
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
import { usageCache } from "../usage-fetcher";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const FIVE_RESET = NOW + 2 * HOUR;
const WEEK_RESET = NOW + 50 * HOUR;

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

const limitsOnly = (session: number, weekly = 20, scoped?: number): Body => ({
	limits: [
		{
			kind: "session",
			percent: session,
			resets_at: new Date(FIVE_RESET).toISOString(),
		},
		{
			kind: "weekly_all",
			percent: weekly,
			resets_at: new Date(WEEK_RESET).toISOString(),
		},
		...(scoped === undefined
			? []
			: [
					{
						kind: "weekly_scoped",
						percent: scoped,
						resets_at: new Date(WEEK_RESET).toISOString(),
						scope: { model: { display_name: "Fable" } },
					},
				]),
	],
});

async function poll(): Promise<void> {
	await usageCache.refreshNow("a");
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
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

async function startWith(first: Body): Promise<void> {
	body = first;
	usageCache.startPolling("a", "token", "anthropic", 24 * HOUR);
	await poll();
	expect(usageCache.get("a")).not.toBeNull();
	body = null;
}

describe("a polled full reading is held until its reset", () => {
	const shapes: Array<[string, Body]> = [
		["flat five_hour", flat(100)],
		["limits[] session", limitsOnly(100)],
		["limits[] weekly_scoped", limitsOnly(30, 20, 100)],
	];
	for (const [name, reading] of shapes) {
		it(`${name}: failed polls and the ten-minute age do not drop it`, async () => {
			await startWith(reading);
			setSystemTime(new Date(NOW + 30 * MINUTE));
			await poll();
			expect(usageCache.get("a")).not.toBeNull();
			expect(usageCache.getAge("a")).not.toBeNull();
		});
	}

	it("ends at the reset of the full window", async () => {
		await startWith(flat(100));
		setSystemTime(new Date(FIVE_RESET + 11 * MINUTE));
		expect(usageCache.get("a")).toBeNull();
	});

	it("a newer recovering poll replaces it, and that reading ages out as before", async () => {
		await startWith(flat(100));
		setSystemTime(new Date(NOW + 30 * MINUTE));
		body = flat(30);
		await poll();
		body = null;
		setSystemTime(new Date(NOW + 41 * MINUTE));
		expect(usageCache.get("a")).toBeNull();
	});

	it("a reading with no full window expires by age as before", async () => {
		await startWith(flat(60));
		setSystemTime(new Date(NOW + 11 * MINUTE));
		expect(usageCache.get("a")).toBeNull();
	});
});
