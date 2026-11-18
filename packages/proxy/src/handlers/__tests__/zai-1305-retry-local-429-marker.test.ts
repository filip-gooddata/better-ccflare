/**
 * The ZAI 1305 retry re-issues the request itself and copies the retry's raw
 * response headers, outside forwardUpstream. The proxy-only local-429 marker
 * must still never reach the client from upstream on that path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_429_MARKER_HEADER } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { checkZai1305 } from "../proxy-operations";

const ENV_KEYS = [
	"CCFLARE_OVERLOAD_RETRY_ENABLED",
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_MS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let realFetch: typeof globalThis.fetch;

function sse(text: string, headers: Record<string, string> = {}): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		}),
		{
			status: 200,
			headers: { "content-type": "text/event-stream", ...headers },
		},
	);
}

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
	process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
	process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
	process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	realFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("ZAI 1305 retry and the local-429 marker", () => {
	it("strips the marker from the retry response it returns", async () => {
		globalThis.fetch = (async () =>
			sse('data: {"type":"message_start"}\n\n', {
				[LOCAL_429_MARKER_HEADER]: "1",
				"x-upstream-kept": "yes",
			})) as unknown as typeof globalThis.fetch;

		const first = sse(
			'data: {"error":{"code":1305,"message":"service overloaded"}}\n\n',
			{ "x-better-ccflare-request-id": "req-1" },
		);
		const result = await checkZai1305(
			first,
			{ name: "zai-test", provider: "zai" } as Account,
			new Request("https://upstream.test/v1/messages", {
				method: "POST",
				body: "{}",
			}),
			new Logger("zai-1305-marker-test"),
		);

		expect(result.status).toBe(200);
		expect(result.headers.get(LOCAL_429_MARKER_HEADER)).toBeNull();
		expect(result.headers.get("x-upstream-kept")).toBe("yes");
		expect(result.headers.get("x-better-ccflare-request-id")).toBe("req-1");
	});
});
