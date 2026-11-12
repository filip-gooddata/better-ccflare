/**
 * Served-usage sink: the collector reads the cache-write split
 * (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`)
 * and hands every served request that carries a client session id and token
 * usage to an optional sink. The sink never affects the request or its save.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	AsyncDbWriter,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	type ServedUsageEvent,
	type ServedUsageSink,
	UsageCollector,
} from "../usage-collector";
import type { StartMessage } from "../worker-messages";

interface SaveCall {
	requestId: string;
	accountId: string | null;
	clientSessionId: string | null;
	usage: { cacheCreationInputTokens?: number } | undefined;
}

function fakeDbOps(saves: SaveCall[]): DatabaseOperations {
	const saveRequest = async (...args: unknown[]) => {
		saves.push({
			requestId: args[0] as string,
			accountId: args[3] as string | null,
			usage: args[9] as SaveCall["usage"],
			clientSessionId: args[21] as string | null,
		});
	};
	return new Proxy(
		{ saveRequest },
		{
			get(target, prop) {
				if (prop in target) return target[prop as keyof typeof target];
				return async () => undefined;
			},
		},
	) as unknown as DatabaseOperations;
}

function startMessage(
	requestId: string,
	opts: {
		isStream: boolean;
		accountId?: string | null;
		clientSessionId?: string | null;
	},
): StartMessage {
	return {
		type: "start",
		messageId: `msg-${requestId}`,
		requestId,
		accountId: opts.accountId === undefined ? "acct-a" : opts.accountId,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now() - 1000,
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream: opts.isStream,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: "a",
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		clientSessionId:
			opts.clientSessionId === undefined ? "sess-1" : opts.clientSessionId,
	};
}

type CacheCreation = Record<string, unknown> | undefined;

function usageBlock(cacheCreation: CacheCreation): Record<string, unknown> {
	return {
		input_tokens: 12,
		cache_read_input_tokens: 3000,
		cache_creation_input_tokens: 700,
		output_tokens: 40,
		...(cacheCreation ? { cache_creation: cacheCreation } : {}),
	};
}

function jsonBody(cacheCreation: CacheCreation, withUsage = true): string {
	return JSON.stringify({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "text", text: "ok" }],
		...(withUsage ? { usage: usageBlock(cacheCreation) } : {}),
	});
}

function sseBody(cacheCreation: CacheCreation): string {
	return [
		"event: message_start",
		`data: ${JSON.stringify({
			type: "message_start",
			message: {
				model: "claude-opus-5-5",
				usage: { ...usageBlock(cacheCreation), output_tokens: 1 },
			},
		})}`,
		"",
		"event: content_block_start",
		`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		"",
		"event: message_delta",
		`data: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 40 },
		})}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
	].join("\n");
}

describe("UsageCollector - served usage sink", () => {
	let collector: UsageCollector | null = null;

	afterEach(() => {
		collector?.dispose();
		collector = null;
	});

	function setup(sink?: ServedUsageSink | null) {
		const saves: SaveCall[] = [];
		const events: ServedUsageEvent[] = [];
		collector = new UsageCollector(
			fakeDbOps(saves),
			new AsyncDbWriter(),
			() => false,
			() => {},
		);
		if (sink !== null) {
			collector.setServedUsageSink(sink ?? ((event) => events.push(event)));
		}
		return { c: collector, saves, events };
	}

	async function runJson(
		c: UsageCollector,
		requestId: string,
		body: string,
		start: Parameters<typeof startMessage>[1] = { isStream: false },
	) {
		c.handleStart(startMessage(requestId, { ...start, isStream: false }));
		await c.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(body).toString("base64"),
		});
		await c.drain();
	}

	async function runStream(
		c: UsageCollector,
		requestId: string,
		body: string,
		start: Parameters<typeof startMessage>[1] = { isStream: true },
	) {
		c.handleStart(startMessage(requestId, { ...start, isStream: true }));
		c.handleChunk(requestId, new Uint8Array(Buffer.from(body, "utf-8")));
		await c.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await c.drain();
	}

	const fullSplit = {
		ephemeral_5m_input_tokens: 200,
		ephemeral_1h_input_tokens: 500,
	};

	test("non-stream: emits the event with the split", async () => {
		const { c, events } = setup();
		const before = Date.now();
		await runJson(c, "json-split", jsonBody(fullSplit));
		const after = Date.now();
		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event.sessionId).toBe("sess-1");
		expect(event.accountId).toBe("acct-a");
		expect(event.at).toBeGreaterThanOrEqual(before);
		expect(event.at).toBeLessThanOrEqual(after);
		expect(event.usage).toEqual({
			model: "claude-opus-5-5",
			inputTokens: 12,
			outputTokens: 40,
			cacheReadTokens: 3000,
			cacheWriteTokens: 700,
			cacheWrite5mTokens: 200,
			cacheWrite1hTokens: 500,
		});
	});

	test("non-stream: split absent gives null for both fields", async () => {
		const { c, events } = setup();
		await runJson(c, "json-nosplit", jsonBody(undefined));
		expect(events).toHaveLength(1);
		expect(events[0].usage.cacheWriteTokens).toBe(700);
		expect(events[0].usage.cacheWrite5mTokens).toBeNull();
		expect(events[0].usage.cacheWrite1hTokens).toBeNull();
	});

	test("non-stream: partial split keeps the reported field, null for the other", async () => {
		const { c, events } = setup();
		await runJson(
			c,
			"json-partial",
			jsonBody({ ephemeral_1h_input_tokens: 700 }),
		);
		expect(events[0].usage.cacheWrite5mTokens).toBeNull();
		expect(events[0].usage.cacheWrite1hTokens).toBe(700);
	});

	test("non-stream: non-numeric split values count as absent", async () => {
		const { c, events } = setup();
		await runJson(
			c,
			"json-bad",
			jsonBody({
				ephemeral_5m_input_tokens: "200",
				ephemeral_1h_input_tokens: -1,
			}),
		);
		expect(events[0].usage.cacheWrite5mTokens).toBeNull();
		expect(events[0].usage.cacheWrite1hTokens).toBeNull();
	});

	test("stream: takes the split from message_start", async () => {
		const { c, events } = setup();
		await runStream(c, "sse-split", sseBody(fullSplit));
		expect(events).toHaveLength(1);
		expect(events[0].usage).toEqual({
			model: "claude-opus-5-5",
			inputTokens: 12,
			outputTokens: 40,
			cacheReadTokens: 3000,
			cacheWriteTokens: 700,
			cacheWrite5mTokens: 200,
			cacheWrite1hTokens: 500,
		});
	});

	test("stream: split absent gives null for both fields", async () => {
		const { c, events } = setup();
		await runStream(c, "sse-nosplit", sseBody(undefined));
		expect(events[0].usage.cacheWrite5mTokens).toBeNull();
		expect(events[0].usage.cacheWrite1hTokens).toBeNull();
	});

	test("stream: partial split keeps the reported field, null for the other", async () => {
		const { c, events } = setup();
		await runStream(
			c,
			"sse-partial",
			sseBody({ ephemeral_5m_input_tokens: 700 }),
		);
		expect(events[0].usage.cacheWrite5mTokens).toBe(700);
		expect(events[0].usage.cacheWrite1hTokens).toBeNull();
	});

	test("no event without a client session id", async () => {
		const { c, events } = setup();
		await runJson(c, "no-sess-null", jsonBody(fullSplit), {
			isStream: false,
			clientSessionId: null,
		});
		await runJson(c, "no-sess-empty", jsonBody(fullSplit), {
			isStream: false,
			clientSessionId: "",
		});
		expect(events).toHaveLength(0);
	});

	test("no event without token usage", async () => {
		const { c, events } = setup();
		await runJson(c, "no-usage", jsonBody(fullSplit, false));
		expect(events).toHaveLength(0);
	});

	test("stream: no event when frames carry a model but no usage", async () => {
		const { c, events, saves } = setup();
		const body = [
			"event: message_start",
			`data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5" } })}`,
			"",
			"event: message_stop",
			`data: {"type":"message_stop"}`,
			"",
		].join("\n");
		await runStream(c, "sse-model-only", body);
		expect(saves.map((s) => s.requestId)).toEqual(["sse-model-only"]);
		expect(events).toHaveLength(0);
	});

	test("stream: takes the split from a generic usage frame", async () => {
		const { c, events } = setup();
		const body = [
			"event: message_start",
			`data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5" } })}`,
			"",
			"event: usage",
			`data: ${JSON.stringify({
				type: "usage",
				usage: {
					input_tokens: 5,
					output_tokens: 9,
					cache_creation_input_tokens: 300,
					cache_creation: {
						ephemeral_5m_input_tokens: 100,
						ephemeral_1h_input_tokens: 200,
					},
				},
			})}`,
			"",
		].join("\n");
		await runStream(c, "sse-generic", body);
		expect(events).toHaveLength(1);
		expect(events[0].usage.cacheWriteTokens).toBe(300);
		expect(events[0].usage.cacheWrite5mTokens).toBe(100);
		expect(events[0].usage.cacheWrite1hTokens).toBe(200);
	});

	test("no event without a serving account", async () => {
		const { c, events } = setup();
		await runJson(c, "no-account", jsonBody(fullSplit), {
			isStream: false,
			accountId: null,
		});
		expect(events).toHaveLength(0);
	});

	test("a throwing sink breaks neither the request nor its save", async () => {
		let calls = 0;
		const { c, saves } = setup(() => {
			calls++;
			throw new Error("sink failed");
		});
		await runJson(c, "throw-json", jsonBody(fullSplit));
		await runStream(c, "throw-sse", sseBody(fullSplit));
		expect(calls).toBe(2);
		expect(saves.map((s) => s.requestId)).toEqual(["throw-json", "throw-sse"]);
		expect(saves[0].usage?.cacheCreationInputTokens).toBe(700);
		expect(saves[0].clientSessionId).toBe("sess-1");
	});

	test("no sink: request saved as before", async () => {
		const { c, saves } = setup(null);
		await runJson(c, "nosink", jsonBody(fullSplit));
		expect(saves).toHaveLength(1);
		expect(saves[0].usage?.cacheCreationInputTokens).toBe(700);
	});

	test("clearing the sink stops events", async () => {
		const { c, events } = setup();
		c.setServedUsageSink(null);
		await runJson(c, "cleared", jsonBody(fullSplit));
		expect(events).toHaveLength(0);
	});
});
