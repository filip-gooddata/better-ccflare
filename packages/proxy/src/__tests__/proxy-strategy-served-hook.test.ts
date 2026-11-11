import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const originalFetch = globalThis.fetch;

function makeAccount(id: string, token: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: `refresh-${token}`,
		access_token: token,
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
	};
}

interface ServedCall {
	meta: RequestMeta;
	accountId: string;
	status: number;
}

function makeContext(accounts: Account[]) {
	const selectMetas: RequestMeta[] = [];
	const served: ServedCall[] = [];
	const ctx = {
		strategy: {
			select: (list: Account[], meta: RequestMeta) => {
				selectMetas.push(meta);
				return list;
			},
			peek: () => null,
			onRequestServed: (
				meta: RequestMeta,
				account: Account,
				status: number,
			) => {
				served.push({ meta, accountId: account.id, status });
			},
		} as never,
		dbOps: new Proxy(
			{
				getAllAccounts: mock(async () => accounts),
				getActiveComboForFamily: mock(async () => null),
			} as Record<string, unknown>,
			{
				get: (target, prop: string) =>
					prop in target ? target[prop] : mock(async () => undefined),
			},
		) as never,
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
	} as ProxyContext;
	return { ctx, selectMetas, served };
}

function request(headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-fable-5-2",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			metadata: { user_id: "user_x_account_y_session_abc12345" },
		}),
	});
}

function okResponse() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-fable-5-2",
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

let collectorSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
	const collector = {
		handleStart: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
		handleChunk: mock(() => {}),
	} as unknown as usageCollectorModule.UsageCollector;
	collectorSpies = [
		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(collector),
		spyOn(usageCollectorModule, "tryGetUsageCollector").mockReturnValue(
			collector,
		),
	];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const spy of collectorSpies) spy.mockRestore();
});

describe("proxy → strategy onRequestServed", () => {
	it("reports the account that served after the selected one returned 429", async () => {
		const first = makeAccount("acc-first", "token-first");
		const second = makeAccount("acc-second", "token-second");
		const { ctx, selectMetas, served } = makeContext([first, second]);
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(
					init?.headers ??
						(input instanceof Request ? input.headers : undefined),
				);
				const auth = headers.get("authorization") ?? "";
				if (auth.includes("token-first")) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "rate_limit_error", message: "limit" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					);
				}
				return okResponse();
			},
		) as never;

		const req = request();
		const response = await handleProxy(req, new URL(req.url), ctx);

		expect(response.status).toBe(200);
		expect(selectMetas).toHaveLength(1);
		expect(selectMetas[0].clientSessionId).toBe(
			"user_x_account_y_session_abc12345",
		);
		expect(selectMetas[0].routingModel).toBe("claude-fable-5-2");
		expect(served).toHaveLength(1);
		expect(served[0].accountId).toBe("acc-second");
		expect(served[0].status).toBe(200);
		expect(served[0].meta).toBe(selectMetas[0]);
	});

	it("does not call select() for a force-routed request", async () => {
		const first = makeAccount("acc-first", "token-first");
		const second = makeAccount("acc-second", "token-second");
		const { ctx, selectMetas, served } = makeContext([first, second]);
		globalThis.fetch = mock(async () => okResponse()) as never;

		const req = request({ "x-better-ccflare-account-id": "acc-second" });
		const response = await handleProxy(req, new URL(req.url), ctx);

		expect(response.status).toBe(200);
		expect(selectMetas).toHaveLength(0);
		expect(served.map((c) => c.accountId)).toEqual(["acc-second"]);
	});
});
