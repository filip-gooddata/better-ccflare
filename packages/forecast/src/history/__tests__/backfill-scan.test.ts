import { describe, expect, test } from "bun:test";
import {
	MalformedLineError,
	type ScannedLine,
	scanUsageLine,
} from "../backfill-scan";

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Reference: the same metadata read through JSON.parse (test data only). */
function reference(text: string): ScannedLine {
	const entry = obj(JSON.parse(text));
	if (entry === null) throw new Error("not an object");
	const message = obj(entry.message);
	const usage = message ? obj(message.usage) : null;
	const split = usage ? obj(usage.cache_creation) : null;
	return {
		timestamp: str(entry.timestamp),
		requestId: str(entry.requestId),
		messageId: message ? str(message.id) : null,
		model: message ? str(message.model) : null,
		usage: usage
			? {
					inputTokens: num(usage.input_tokens),
					outputTokens: num(usage.output_tokens),
					cacheReadTokens: num(usage.cache_read_input_tokens),
					cacheWriteTokens: num(usage.cache_creation_input_tokens),
					hasSplit: split !== null,
					cacheWrite5mTokens: split
						? num(split.ephemeral_5m_input_tokens)
						: null,
					cacheWrite1hTokens: split
						? num(split.ephemeral_1h_input_tokens)
						: null,
				}
			: null,
	};
}

function scan(text: string): ScannedLine {
	return scanUsageLine(Buffer.from(text, "utf8"));
}

const decoyContent = [
	{ type: "text", text: 'quote \\" and "usage":{"input_tokens":999} \\\\' },
	{
		type: "tool_use",
		id: "toolu_1",
		input: {
			usage: { input_tokens: 777, output_tokens: 777 },
			message: { id: "msg_decoy", model: "decoy", usage: { input_tokens: 5 } },
			timestamp: "1999-01-01T00:00:00Z",
			list: [1, -2.5e3, true, false, null, "]}", { 'a"b': ["[{"] }],
		},
	},
];

const lines: Record<string, unknown> = {
	full: {
		parentUuid: null,
		type: "assistant",
		message: {
			content: decoyContent,
			id: "msg_01",
			model: "claude-opus-5-5",
			usage: {
				input_tokens: 12,
				cache_creation_input_tokens: 300,
				cache_read_input_tokens: 40_000,
				cache_creation: {
					ephemeral_5m_input_tokens: 100,
					ephemeral_1h_input_tokens: 200,
				},
				output_tokens: 99,
				server_tool_use: { web_search_requests: 0 },
				service_tier: "standard",
			},
		},
		requestId: "req_01",
		timestamp: "2026-10-05T08:00:00.000Z",
		toolUseResult: { usage: { input_tokens: 1 }, message: { usage: {} } },
	},
	noSplit: {
		timestamp: "2026-10-05T08:00:00.000Z",
		message: { id: "m", usage: { input_tokens: 1, output_tokens: 2 } },
	},
	nullSplit: {
		message: {
			usage: { cache_creation: null, cache_creation_input_tokens: 5 },
		},
	},
	nonNumbers: {
		message: {
			model: 7,
			id: null,
			usage: { input_tokens: "12", output_tokens: null },
		},
		requestId: ["x"],
	},
	noUsage: { type: "user", message: { role: "user", content: "hi" } },
	usageNotObject: { message: { usage: [1, 2] } },
	messageNotObject: { message: "text" },
	unicode: {
		timestamp: "2026-10-05T08:00:00Z",
		message: {
			model: "mé\u{1F600}",
			content: "  café \u{1F600}",
			usage: { input_tokens: 3 },
		},
	},
	duplicateKeys: { message: { usage: { input_tokens: 1 } } },
	empty: {},
};

describe("scanUsageLine", () => {
	for (const [name, value] of Object.entries(lines)) {
		test(`matches JSON.parse for ${name}`, () => {
			const compact = JSON.stringify(value);
			expect(scan(compact)).toEqual(reference(compact));
			const pretty = JSON.stringify(value, null, 2);
			expect(scan(pretty)).toEqual(reference(pretty));
		});
	}

	test("the last of duplicate keys wins, as in JSON.parse", () => {
		const text =
			'{"message":{"usage":{"input_tokens":1,"input_tokens":2},"id":"a","id":"b"},"timestamp":"x","timestamp":"y"}';
		expect(scan(text)).toEqual(reference(text));
		expect(scan(text).usage?.inputTokens).toBe(2);
	});

	test("ignores metadata-looking keys inside content", () => {
		const r = scan(JSON.stringify(lines.full));
		expect(r.messageId).toBe("msg_01");
		expect(r.usage?.inputTokens).toBe(12);
		expect(r.timestamp).toBe("2026-10-05T08:00:00.000Z");
	});

	test("escaped key names are decoded", () => {
		const text =
			'{"time\\u0073tamp":"t","message":{"usage":{"input_\\u0074okens":4}}}';
		expect(scan(text)).toEqual(reference(text));
	});

	test.each([
		["truncated", '{"message":{"usage":{"input_tokens":1}'],
		["unterminated string", '{"message":{"content":"abc'],
		["not an object", '"usage"'],
		["text", 'not json "usage"'],
		["trailing garbage", '{"message":{}} x'],
		["missing colon", '{"message" {}}'],
		["missing value", '{"message":}'],
		["two objects", "{}{}"],
		["empty", ""],
	])("throws a content-free error for %s", (_name, text) => {
		let error: unknown = null;
		try {
			scan(text);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(MalformedLineError);
		expect((error as Error).message).toBe("malformed transcript line");
	});
});
