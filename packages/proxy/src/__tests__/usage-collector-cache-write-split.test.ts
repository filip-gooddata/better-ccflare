/**
 * The 5-minute / 1-hour split of cache writes reaches the stored `requests`
 * row, so the forecast can learn from it later. When upstream does not report
 * the split, both columns stay NULL (unknown), never 0.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-cache-write-split.db`;

function startMessage(requestId: string, isStream: boolean): StartMessage {
	return {
		type: "start",
		messageId: `msg-${requestId}`,
		requestId,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

function sseBody(usage: Record<string, unknown>): string {
	return [
		"event: message_start",
		`data: ${JSON.stringify({
			type: "message_start",
			message: { model: "claude-opus-4-1", usage },
		})}`,
		"",
		"event: message_delta",
		`data: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 16 },
		})}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
	].join("\n");
}

function jsonBody(usage: Record<string, unknown>): string {
	return JSON.stringify({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-opus-4-1",
		content: [{ type: "text", text: "ok" }],
		usage,
	});
}

describe("UsageCollector - cache write split", () => {
	let dbOps: DatabaseOperations;
	let collector: UsageCollector;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		collector = new UsageCollector(
			dbOps,
			new AsyncDbWriter(),
			() => true,
			() => {},
		);
	});

	afterAll(() => {
		collector.dispose();
		// The factory is a process-wide singleton: later test files must not
		// inherit this connection after its file is deleted.
		DatabaseFactory.reset();
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
	});

	async function runStream(requestId: string, body: string) {
		collector.handleStart(startMessage(requestId, true));
		collector.handleChunk(
			requestId,
			new Uint8Array(Buffer.from(body, "utf-8")),
		);
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await collector.drain();
	}

	async function runJson(requestId: string, body: string) {
		collector.handleStart(startMessage(requestId, false));
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(body).toString("base64"),
		});
		await collector.drain();
	}

	async function stored(requestId: string) {
		const rows = await dbOps.getAdapter().query<{
			cache_creation_input_tokens: number | null;
			cache_creation_5m_input_tokens: number | null;
			cache_creation_1h_input_tokens: number | null;
		}>(
			`SELECT cache_creation_input_tokens, cache_creation_5m_input_tokens,
				cache_creation_1h_input_tokens FROM requests WHERE id = ?`,
			[requestId],
		);
		return rows[0];
	}

	test("stores the split reported in a streamed message_start", async () => {
		await runStream(
			"split-stream",
			sseBody({
				input_tokens: 10,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 700,
				cache_creation: {
					ephemeral_5m_input_tokens: 300,
					ephemeral_1h_input_tokens: 400,
				},
				output_tokens: 1,
			}),
		);
		expect(await stored("split-stream")).toEqual({
			cache_creation_input_tokens: 700,
			cache_creation_5m_input_tokens: 300,
			cache_creation_1h_input_tokens: 400,
		});
	});

	test("stores the split of a non-stream body, keeping a reported 0", async () => {
		await runJson(
			"split-json",
			jsonBody({
				input_tokens: 10,
				cache_creation_input_tokens: 500,
				cache_creation: {
					ephemeral_5m_input_tokens: 0,
					ephemeral_1h_input_tokens: 500,
				},
				output_tokens: 3,
			}),
		);
		expect(await stored("split-json")).toEqual({
			cache_creation_input_tokens: 500,
			cache_creation_5m_input_tokens: 0,
			cache_creation_1h_input_tokens: 500,
		});
	});

	test("leaves both split columns NULL when upstream reports no split", async () => {
		await runStream(
			"split-absent-stream",
			sseBody({
				input_tokens: 10,
				cache_creation_input_tokens: 200,
				output_tokens: 1,
			}),
		);
		expect(await stored("split-absent-stream")).toEqual({
			cache_creation_input_tokens: 200,
			cache_creation_5m_input_tokens: null,
			cache_creation_1h_input_tokens: null,
		});

		await runJson(
			"split-absent-json",
			jsonBody({ input_tokens: 10, output_tokens: 3 }),
		);
		const row = await stored("split-absent-json");
		expect(row?.cache_creation_5m_input_tokens).toBeNull();
		expect(row?.cache_creation_1h_input_tokens).toBeNull();
	});
});
