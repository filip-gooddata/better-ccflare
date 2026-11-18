/**
 * A probe to an account at a full limit is answered with a 429 limit refusal:
 * the proxy's own local 429 (the forced-probe path never forwards to a full
 * account), or upstream's real one when the proxy did not know yet. Neither
 * says the endpoint is broken, so neither may count toward the
 * consecutive-failure pause, and the account is not probed again before the
 * refusal's reset: the usage poll's `resets_at` tells when it is usable.
 *
 * A failure that is not a limit refusal still counts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetAutoRefreshPromptPoolForTests } from "../auto-refresh-prompt-pool";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import {
	buildLocalCooldownResponse,
	buildLocalLimitResponse,
} from "../handlers/limit-response";

type AccountRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

type TestableScheduler = AutoRefreshScheduler & {
	sendDummyMessage(accountRow: AccountRow): Promise<boolean>;
	shouldRefreshAccount(accountRow: AccountRow, now: number): boolean;
	consecutiveFailures: Map<string, number>;
	FAILURE_THRESHOLD: number;
};

function makeDb() {
	const runCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runCalls,
	};
}

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
): Promise<TestableScheduler> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			internalProbeSecret: "secret",
		} as never,
	) as TestableScheduler;
}

function makeAccountRow(): AccountRow {
	return {
		id: "acc-full",
		name: "Full",
		provider: "anthropic",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * HOUR,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
	};
}

function respondWith(make: () => Response): void {
	globalThis.fetch = mock(async () => make()) as unknown as typeof fetch;
}

function pauseCallFor(db: ReturnType<typeof makeDb>, accountId: string) {
	return db.runCalls.find(
		([sql, params]) =>
			sql.includes("paused = 1") &&
			Array.isArray(params) &&
			params[0] === accountId,
	);
}

/** Upstream's real five-hour refusal (the design's fixture, no account ids). */
function upstreamLimit429(resetMs: number): Response {
	const reset = String(Math.floor(resetMs / 1000));
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "This request would exceed your account's rate limit.",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(Math.ceil((resetMs - Date.now()) / 1000)),
				"x-should-retry": "true",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": reset,
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"anthropic-ratelimit-unified-5h-status": "rejected",
				"anthropic-ratelimit-unified-5h-reset": reset,
				"anthropic-ratelimit-unified-5h-utilization": "1.0",
				"anthropic-ratelimit-unified-overage-status": "rejected",
				"anthropic-ratelimit-unified-overage-disabled-reason":
					"org_spend_cap_reached",
			},
		},
	);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
	resetAutoRefreshPromptPoolForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
});

describe("AutoRefreshScheduler — a probe refused for a full limit", () => {
	it("never pauses an account on the proxy's local limit 429", async () => {
		const resetMs = Date.now() + 2 * HOUR;
		respondWith(() =>
			buildLocalLimitResponse({ binding: { kind: "five_hour" }, resetMs }),
		);
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const row = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD + 1; i++) {
			resetAutoRefreshPromptPoolForTests();
			expect(await scheduler.sendDummyMessage(row)).toBe(false);
		}

		expect(scheduler.consecutiveFailures.get(row.id)).toBeUndefined();
		expect(pauseCallFor(db, row.id)).toBeUndefined();
	});

	it("does not count upstream's real limit 429 either", async () => {
		const resetMs = Date.now() + 2 * HOUR;
		respondWith(() => upstreamLimit429(resetMs));
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const row = makeAccountRow();

		expect(await scheduler.sendDummyMessage(row)).toBe(false);

		expect(scheduler.consecutiveFailures.get(row.id)).toBeUndefined();
	});

	it("does not probe the account again before the refusal's reset", async () => {
		const now = Date.now();
		const resetMs = now + 4 * DAY;
		respondWith(() =>
			buildLocalLimitResponse({ binding: { kind: "seven_day" }, resetMs }, now),
		);
		const scheduler = await makeScheduler(makeDb());
		const control = await makeScheduler(makeDb());
		const row = makeAccountRow();

		await scheduler.sendDummyMessage(row);

		// Past every rung of the uncounted-failure ladder, still before reset.
		expect(scheduler.shouldRefreshAccount(row, resetMs - HOUR)).toBe(false);
		// Once the reset has passed, the account is judged like any other.
		expect(scheduler.shouldRefreshAccount(row, resetMs + 1000)).toBe(
			control.shouldRefreshAccount(row, resetMs + 1000),
		);
	});
});

describe("AutoRefreshScheduler — a probe answered by the proxy's cooldown 429", () => {
	it("never pauses an account on the proxy's local cooldown 429", async () => {
		const cooldownEnd = Date.now() + 10 * 60 * 1000;
		respondWith(() => buildLocalCooldownResponse(null, cooldownEnd));
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const row = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD + 1; i++) {
			resetAutoRefreshPromptPoolForTests();
			expect(await scheduler.sendDummyMessage(row)).toBe(false);
		}

		expect(scheduler.consecutiveFailures.get(row.id)).toBeUndefined();
		expect(pauseCallFor(db, row.id)).toBeUndefined();
	});

	it("does not probe the account again before the cooldown's retry-after", async () => {
		const now = Date.now();
		const cooldownEnd = now + 3 * DAY;
		respondWith(() => buildLocalCooldownResponse(null, cooldownEnd, now));
		const scheduler = await makeScheduler(makeDb());
		const control = await makeScheduler(makeDb());
		const row = makeAccountRow();

		await scheduler.sendDummyMessage(row);

		expect(scheduler.shouldRefreshAccount(row, cooldownEnd - HOUR)).toBe(false);
		expect(scheduler.shouldRefreshAccount(row, cooldownEnd + 2000)).toBe(
			control.shouldRefreshAccount(row, cooldownEnd + 2000),
		);
	});

	it("still counts an upstream 429 with a retry-after but no limit refusal", async () => {
		respondWith(
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "Too many requests" },
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "30",
							"x-should-retry": "true",
						},
					},
				),
		);
		const scheduler = await makeScheduler(makeDb());
		const row = makeAccountRow();

		await scheduler.sendDummyMessage(row);

		expect(scheduler.consecutiveFailures.get(row.id)).toBe(1);
	});
});

describe("AutoRefreshScheduler — a genuinely failing probe still counts", () => {
	it("counts an upstream 500", async () => {
		respondWith(
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "api_error", message: "Internal server error" },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				),
		);
		const scheduler = await makeScheduler(makeDb());
		const row = makeAccountRow();

		await scheduler.sendDummyMessage(row);

		expect(scheduler.consecutiveFailures.get(row.id)).toBe(1);
	});

	it("counts a 429 that is not a limit refusal", async () => {
		respondWith(
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "Too many requests" },
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
		);
		const scheduler = await makeScheduler(makeDb());
		const row = makeAccountRow();

		await scheduler.sendDummyMessage(row);

		expect(scheduler.consecutiveFailures.get(row.id)).toBe(1);
	});

	it("pauses after the threshold of such failures, as before", async () => {
		respondWith(() => new Response("upstream broke", { status: 500 }));
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const row = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
			resetAutoRefreshPromptPoolForTests();
			await scheduler.sendDummyMessage(row);
		}

		expect(pauseCallFor(db, row.id)).toBeDefined();
	});
});
