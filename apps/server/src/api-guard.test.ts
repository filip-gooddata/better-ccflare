import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createUnservedApiGuard,
	PROXY_PASSTHROUGH_API_PATHS,
	type UnservedApiGuardLogger,
} from "./api-guard";

function recordingLogger() {
	const warnings: Array<{ message: string; data?: unknown }> = [];
	const logger: UnservedApiGuardLogger = {
		warn: (message, data) => warnings.push({ message, data }),
	};
	return { logger, warnings };
}

function guardAt(clock: { now: number }) {
	const { logger, warnings } = recordingLogger();
	const guard = createUnservedApiGuard({
		logger,
		now: () => clock.now,
		logWindowMs: 60_000,
	});
	const check = (method: string, path: string) =>
		guard(new URL(`http://127.0.0.1:8791${path}`), method);
	return { check, warnings };
}

describe("createUnservedApiGuard", () => {
	it.each([
		["GET", "/api/usage"],
		["GET", "/api/sessions"],
		["GET", "/api/accounts/history"],
		["POST", "/api/nonexistent"],
		["GET", "/api"],
		["GET", "/api/"],
		["GET", "/API/usage"],
	])("answers %s %s locally with a JSON 404", async (method, path) => {
		const { check } = guardAt({ now: 0 });
		const response = check(method, path);
		expect(response).not.toBeNull();
		expect(response?.status).toBe(404);
		expect(response?.headers.get("Content-Type")).toBe("application/json");
		const body = await response?.json();
		expect(body).toEqual({
			type: "error",
			error: {
				type: "not_found_error",
				message: `${method} ${path} is not served by better-ccflare`,
			},
		});
	});

	it.each([
		["HEAD", "/api/hello"],
		["GET", "/api/hello"],
		["POST", "/api/event_logging/batch"],
		["GET", "/api/system/package-manager"],
	])("lets the Claude CLI path %s %s through to the proxy", (method, path) => {
		const { check, warnings } = guardAt({ now: 0 });
		expect(check(method, path)).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("keeps the pass-through list to the paths the evidence showed", () => {
		expect([...PROXY_PASSTHROUGH_API_PATHS].sort()).toEqual([
			"/api/event_logging/batch",
			"/api/hello",
			"/api/system/package-manager",
		]);
	});

	it.each([
		["POST", "/v1/messages"],
		["POST", "/v1/messages/count_tokens"],
		["POST", "/messages"],
		["GET", "/health"],
		["GET", "/"],
		["GET", "/dashboard/assets/app.js"],
		["GET", "/apiary"],
	])("leaves the non-/api path %s %s alone", (method, path) => {
		const { check, warnings } = guardAt({ now: 0 });
		expect(check(method, path)).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("matches pass-through paths exactly, so a near miss is refused", () => {
		const { check } = guardAt({ now: 0 });
		expect(check("HEAD", "/api/hello/")?.status).toBe(404);
		expect(check("HEAD", "/api/hello/x")?.status).toBe(404);
	});

	it("logs a refusal once per method and path per window, then reports the suppressed count", () => {
		const clock = { now: 0 };
		const { check, warnings } = guardAt(clock);

		check("GET", "/api/usage");
		check("GET", "/api/usage");
		check("GET", "/api/usage");
		check("POST", "/api/usage");
		check("GET", "/api/sessions");
		expect(warnings.map((w) => w.message)).toEqual([
			"Refused unserved API path: GET /api/usage",
			"Refused unserved API path: POST /api/usage",
			"Refused unserved API path: GET /api/sessions",
		]);

		clock.now = 59_999;
		check("GET", "/api/usage");
		expect(warnings).toHaveLength(3);

		clock.now = 60_000;
		check("GET", "/api/usage");
		expect(warnings).toHaveLength(4);
		expect(warnings[3]).toEqual({
			message: "Refused unserved API path: GET /api/usage",
			data: { suppressedSinceLastLog: 3 },
		});
	});

	it("never logs the query string", () => {
		const { check, warnings } = guardAt({ now: 0 });
		check("GET", "/api/usage?token=secret");
		expect(JSON.stringify(warnings)).not.toContain("secret");
	});

	it("truncates long paths in the log and the response", async () => {
		const { check, warnings } = guardAt({ now: 0 });
		const longPath = `/api/${"a".repeat(500)}`;
		const response = check("GET", longPath);
		expect(warnings[0]?.message.length).toBeLessThan(300);
		const body = (await response?.json()) as { error: { message: string } };
		expect(body.error.message.length).toBeLessThan(300);
	});

	it("bounds the memory of distinct refused paths", () => {
		const clock = { now: 0 };
		const { logger, warnings } = recordingLogger();
		const guard = createUnservedApiGuard({
			logger,
			now: () => clock.now,
			logWindowMs: 60_000,
			maxTrackedPaths: 3,
		});
		for (const n of [1, 2, 3, 4]) {
			guard(new URL(`http://h/api/p${n}`), "GET");
		}
		// The table was full at p4 and was reset, so p1 logs again.
		guard(new URL("http://h/api/p1"), "GET");
		expect(warnings).toHaveLength(5);
	});
});

// startServer() is not unit-testable without the whole runtime (see the
// wiring guards in server.test.ts), so this checks the fall-through order in
// the source: the guard runs after apiRouter and before proxy authentication.
describe("server.ts fall-through wiring", () => {
	it("checks unserved /api paths after apiRouter and before the proxy", () => {
		const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
		const apiRouterAt = src.indexOf("await apiRouter.handleRequest(url, req)");
		const guardAt = src.indexOf("unservedApiGuard(url, req.method)");
		const proxyAuthAt = src.indexOf(
			"authService.authenticateRequest(",
			guardAt,
		);
		const proxyAt = src.indexOf("handleProxy(", guardAt);
		expect(apiRouterAt).toBeGreaterThan(-1);
		expect(guardAt).toBeGreaterThan(apiRouterAt);
		expect(proxyAuthAt).toBeGreaterThan(guardAt);
		expect(proxyAt).toBeGreaterThan(guardAt);
		expect(src.indexOf("unservedApiGuard(url, req.method)", guardAt + 1)).toBe(
			-1,
		);
	});
});
