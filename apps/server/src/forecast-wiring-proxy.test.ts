/**
 * End to end: a request served through the real proxy code reaches the
 * forecast session tracker through `initProxy`'s served-usage sink and shows
 * up as a live session in the next forecast computation's input.
 *
 * The upstream is a stand-in on 127.0.0.1 behind an anthropic-compatible
 * account (API key, custom endpoint), so no request leaves this machine.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveForecastSettings } from "@better-ccflare/config";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type {
	ForecastInput,
	ForecastResult,
	PaceContext,
} from "@better-ccflare/forecast";
import {
	drainUsageCollector,
	handleProxy,
	initProxy,
	type ProxyContext,
	resetUsageCollectorForTests,
} from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
import { createForecastWiring, type ForecastWiring } from "./forecast-wiring";

const ACCOUNT_ID = "acc-standin";
const SESSION_ID = "user_test_account_standin_session_proxytest-1";
const MIN = 60_000;

const PACE: PaceContext = {
	timeZone: "Europe/Prague",
	workDays: 5,
	fiveHourGuardPct: 90,
	idleMs: 30 * MIN,
};

const USAGE = {
	input_tokens: 120,
	output_tokens: 7,
	cache_read_input_tokens: 3_000,
	cache_creation_input_tokens: 400,
	cache_creation: {
		ephemeral_5m_input_tokens: 0,
		ephemeral_1h_input_tokens: 400,
	},
};

interface StandIn {
	origin: string;
	paths: string[];
	stop(): void;
}

function startStandIn(): StandIn {
	const paths: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			paths.push(new URL(req.url).pathname);
			await req.arrayBuffer();
			return new Response(
				JSON.stringify({
					id: "msg_standin",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [{ type: "text", text: "ok" }],
					stop_reason: "end_turn",
					usage: USAGE,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		paths,
		stop: () => server.stop(true),
	};
}

/** Lets only loopback requests through; anything else fails the test. */
function loopbackOnlyFetch(original: typeof fetch, blocked: string[]) {
	const guarded = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		if (url.hostname !== "127.0.0.1") {
			blocked.push(url.toString());
			return Promise.reject(new Error(`blocked non-loopback fetch: ${url}`));
		}
		return original(input, init);
	};
	return Object.assign(guarded, original) as typeof fetch;
}

function proxyContext(dbOps: DatabaseOperations): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
			peek: () => null,
		} as never,
		dbOps,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "off",
		} as never,
		provider: { name: "anthropic", canHandle: () => true } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

describe("forecast wiring through the real proxy", () => {
	const originalFetch = globalThis.fetch;
	const originalPricingOffline = process.env.CF_PRICING_OFFLINE;
	const blocked: string[] = [];
	const inputs: ForecastInput[] = [];
	let dir: string;
	let dbOps: DatabaseOperations;
	let standIn: StandIn;
	let wiring: ForecastWiring;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "forecast-wiring-proxy-"));
		const dbPath = join(dir, "test.db");
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
		standIn = startStandIn();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, api_key, created_at, custom_endpoint)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				ACCOUNT_ID,
				"standin",
				"anthropic-compatible",
				"test-key",
				Date.now(),
				standIn.origin,
			],
		);
		globalThis.fetch = loopbackOnlyFetch(originalFetch, blocked);
		// The collector prices each request; keep the price list offline.
		process.env.CF_PRICING_OFFLINE = "1";

		const settings = {
			...resolveForecastSettings({
				env: {},
				file: {},
				home: dir,
				warn: () => {},
			}),
			enabled: true,
		};
		wiring = createForecastWiring({
			config: {
				getForecastSettings: () => settings,
				getUsagePollIntervalMs: () => 90_000,
			},
			dbOps,
			usage: { get: () => null },
			pace: () => PACE,
			proxyPort: () => 0,
			createRunner: () => {
				throw new Error("no pre-warm run in this test");
			},
			engine: {
				async compute(input: ForecastInput): Promise<ForecastResult> {
					inputs.push(input);
					throw new Error("recording engine");
				},
			},
			logger: { info: () => {}, warn: () => {} },
		});
		await initProxy(() => false, { servedUsageSink: wiring.servedUsageSink });
	});

	afterAll(async () => {
		globalThis.fetch = originalFetch;
		if (originalPricingOffline === undefined) {
			delete process.env.CF_PRICING_OFFLINE;
		} else {
			process.env.CF_PRICING_OFFLINE = originalPricingOffline;
		}
		await wiring?.stop();
		resetUsageCollectorForTests();
		standIn?.stop();
		// reset() closes the factory instance without awaiting it; capture
		// that close so the directory is removed only after it finished.
		let closing: Promise<void> = Promise.resolve();
		if (dbOps) {
			const close = dbOps.close.bind(dbOps);
			dbOps.close = () => {
				closing = close();
				return closing;
			};
		}
		DatabaseFactory.reset();
		await closing;
		rmSync(dir, { recursive: true, force: true });
	});

	it("feeds the served session into the next forecast input", async () => {
		expect(wiring.servedUsageSink).toBeDefined();
		expect(wiring.service).not.toBeNull();

		const response = await handleProxy(
			new Request("http://127.0.0.1:8080/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-account-id": ACCOUNT_ID,
				},
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 16,
					messages: [{ role: "user", content: "hello" }],
					metadata: { user_id: SESSION_ID },
				}),
			}),
			new URL("http://127.0.0.1:8080/v1/messages"),
			proxyContext(dbOps),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string };
		expect(body.id).toBe("msg_standin");
		await drainUsageCollector();

		await wiring.service?.runOnce();

		expect(standIn.paths).toEqual(["/v1/messages"]);
		expect(blocked).toEqual([]);
		expect(inputs).toHaveLength(1);
		const session = inputs[0]?.sessions.find((s) => s.sessionId === SESSION_ID);
		expect(session).toBeDefined();
		expect(session?.accountId).toBe(ACCOUNT_ID);
		expect(session?.contextTokens).toBe(
			USAGE.input_tokens +
				USAGE.cache_read_input_tokens +
				USAGE.cache_creation_input_tokens,
		);
		expect(session?.cacheTtlMs).toBe(60 * MIN);
	});
});
