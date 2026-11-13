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

	it.each([
		["GET", "/%61pi/nope"],
		["GET", "/api%2fnope"],
		["GET", "/%61%70%69/nope"],
		["GET", "/%2561pi/nope"],
		["GET", "/%25252561pi/nope"],
		["GET", "/API%2Fnope"],
		["GET", "//api/nope"],
		["GET", "///API//nope"],
		["GET", "/x/../api/nope"],
		["GET", "/x/%2e%2e/api/nope"],
		["GET", "/x/%252e%252e/api/nope"],
		["GET", "/./api/nope"],
		["GET", "/api%5Cnope"],
		["GET", "/%5Capi%5Cnope"],
		["GET", "\\api\\nope"],
		["GET", "/%61pi"],
		["GET", "/%61pi%3Fx=1"],
		["GET", "/%61pi%23frag"],
		["GET", "/%61pi;x=1/nope"],
		["GET", "/%61p%09i/nope"],
		// Dropping the decoded tab joins "%6" and "1" into a new escape.
		["GET", "/%6%091pi/nope"],
		["POST", "/%61pi/event_logging/batch"],
		["HEAD", "/%61pi/hello"],
		["HEAD", "/api%2Fhello"],
		["HEAD", "/API/hello"],
		["HEAD", "//api/hello"],
	])("refuses the encoded or varied API path %s %s", (method, path) => {
		const { check, warnings } = guardAt({ now: 0 });
		const response = check(method, path);
		expect(response?.status).toBe(404);
		expect(warnings).toHaveLength(1);
	});

	it.each([
		// A '%' without two hex digits after it. Read literally these are not
		// API paths, but a server that drops the bad escape reads /api/nope
		// and /api, so the guard fails closed.
		["GET", "/%zzapi/nope"],
		["GET", "/api%2"],
		["GET", "/api%"],
		["GET", "/%api/nope"],
		["GET", "/%25zzapi/nope"],
		// Two malformed escapes allow mixed readings ("%zz" dropped whole,
		// "%i" losing only its '%' reads /api/nope), so any such path is
		// refused, API or not.
		["GET", "/%zzap%i/nope"],
		["POST", "/v1/messages%zz%zz"],
	])("refuses the malformed escape %s %s that could read as an API path", (method, path) => {
		const { check } = guardAt({ now: 0 });
		expect(check(method, path)?.status).toBe(404);
	});

	it.each([
		["POST", "/v1/messages"],
		["POST", "/v1/messages%3Fbeta"],
		["POST", "/v1/messages%3Fbeta=true"],
		["POST", "/%76%31/messages"],
		["POST", "/v1/messages%zz"],
		["POST", "/v1/messages%"],
		["POST", "/v1/api/nope"],
		["POST", "/v1/%61pi/nope"],
		["GET", "/%61piary"],
		["GET", "/api%2Dx"],
		["GET", "/x/%2e%2e/apiary"],
		// Encoded exactly as deeply as the guard decodes (16 passes).
		["POST", `/v1/messages%${"25".repeat(15)}3Fbeta=true`],
	])("leaves the non-API path %s %s alone under every reading", (method, path) => {
		const { check, warnings } = guardAt({ now: 0 });
		expect(check(method, path)).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("refuses a path encoded more deeply than the guard decodes", () => {
		const { check } = guardAt({ now: 0 });
		let path = "/v1/messages";
		for (let i = 0; i < 20; i++)
			path = path.replaceAll("%", "%25").replace("/v", "/%76");
		expect(check("POST", path)?.status).toBe(404);
	});

	it("logs the raw encoded path on one line, never the decoded control characters", () => {
		const { check, warnings } = guardAt({ now: 0 });
		const response = check("GET", "/%61pi/x%0d%0aInjected:%20line%00");
		expect(response?.status).toBe(404);
		expect(warnings).toHaveLength(1);
		const message = warnings[0]?.message ?? "";
		expect(message).toBe(
			"Refused unserved API path: GET /%61pi/x%0d%0aInjected:%20line%00",
		);
		expect([...message].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
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

	it("hands the proxy the same URL the guard classified, never a decoded or rebuilt one", () => {
		const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
		const guardAt = src.indexOf("unservedApiGuard(url, req.method)");
		const proxyAt = src.indexOf("handleProxy(", guardAt);
		// The only binding of `url` is the const parsed from the request.
		expect(src.match(/(^|[^.\w])url\s*=(?![=>])/gm)).toEqual([" url ="]);
		expect(src).toContain("const url = new URL(req.url);");
		expect(src.slice(proxyAt, proxyAt + 80)).toMatch(
			/^handleProxy\(\s*req,\s*url,/,
		);
		const between = src.slice(guardAt, proxyAt);
		expect(between).not.toMatch(/decodeURI|unescape\(|new URL\(/);
	});
});
