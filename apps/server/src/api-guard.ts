/**
 * Local 404 for /api paths that neither the API router nor the proxy serves.
 *
 * Without it, any /api path the API router does not match falls through to
 * the proxy and goes upstream with a real account's token. Only the paths in
 * PROXY_PASSTHROUGH_API_PATHS keep reaching the proxy:
 * - /api/hello: the Claude CLI's connectivity check (HEAD), seen in the
 *   proxy's request records and log.
 * - /api/event_logging/batch, /api/system/package-manager: Claude CLI
 *   endpoints the proxy answers itself with a stub.
 */
export const PROXY_PASSTHROUGH_API_PATHS: ReadonlySet<string> = new Set([
	"/api/hello",
	"/api/event_logging/batch",
	"/api/system/package-manager",
]);

const MAX_PATH_CHARS = 200;

export interface UnservedApiGuardLogger {
	warn(message: string, data?: unknown): void;
}

export interface UnservedApiGuardOptions {
	logger: UnservedApiGuardLogger;
	now?: () => number;
	logWindowMs?: number;
	maxTrackedPaths?: number;
}

export type UnservedApiGuard = (url: URL, method: string) => Response | null;

const MAX_DECODE_PASSES = 16;

// A valid escape (two hex digits), or else a '%' with up to two following
// characters, which is a malformed escape.
const ESCAPE = /%(?:([0-9a-f]{2})|[^%]{0,2})/gi;

// How a server might treat a malformed escape: keep it as text, drop its
// '%', or drop the whole escape.
type MalformedEscapeReading = "keep" | "drop-percent" | "drop-escape";
const MALFORMED_ESCAPE_READINGS: readonly MalformedEscapeReading[] = [
	"keep",
	"drop-percent",
	"drop-escape",
];

function decodeOnce(path: string, reading: MalformedEscapeReading): string {
	return path.replace(ESCAPE, (escape: string, hex: string | undefined) => {
		if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
		if (reading === "keep") return escape;
		if (reading === "drop-percent") return escape.slice(1);
		return "";
	});
}

/** Percent-decodes until the path stops changing; null if it never does. */
function decodeFully(
	path: string,
	reading: MalformedEscapeReading,
): string | null {
	let current = path;
	for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
		const next = decodeOnce(current, reading);
		if (next === current) return current;
		current = next;
	}
	return null;
}

function resolveDotSegments(path: string): string {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (out.length > 1) out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/") || "/";
}

function normalise(decoded: string): string {
	const path = decoded
		.replace(/[?#][\s\S]*$/, "")
		.replace(/[\t\n\r]/g, "")
		.toLowerCase()
		.replaceAll("\\", "/")
		.replace(/;[^/]*/g, "")
		.replace(/\/{2,}/g, "/");
	return resolveDotSegments(path);
}

/**
 * True when any reading of the path a server could make lands on /api or
 * under /api/. Each reading percent-decodes until nothing changes, then cuts
 * at '?' or '#', drops tab, CR and LF, folds case, treats '\' as '/', drops
 * ';' segment parameters, collapses slash runs and resolves dot segments.
 * The readings differ only in how a malformed escape is treated. A path that
 * still changes after MAX_DECODE_PASSES counts as an API path (fail closed).
 */
function isApiPath(pathname: string): boolean {
	return MALFORMED_ESCAPE_READINGS.some((reading) => {
		const decoded = decodeFully(pathname, reading);
		if (decoded === null) return true;
		const path = normalise(decoded);
		return path === "/api" || path.startsWith("/api/");
	});
}

function truncate(path: string): string {
	return path.length > MAX_PATH_CHARS
		? `${path.slice(0, MAX_PATH_CHARS)}…`
		: path;
}

/**
 * Returns a 404 Response for an unserved /api path, or null when the request
 * should continue to the proxy. Logs each refused method and path at most
 * once per window, with the count of refusals suppressed since the last line.
 */
export function createUnservedApiGuard({
	logger,
	now = Date.now,
	logWindowMs = 60_000,
	maxTrackedPaths = 1_000,
}: UnservedApiGuardOptions): UnservedApiGuard {
	const lastLogged = new Map<string, { at: number; suppressed: number }>();

	return (url, method) => {
		// Exceptions match the raw pathname exactly, so any other spelling of
		// one is refused like every unserved API path.
		if (PROXY_PASSTHROUGH_API_PATHS.has(url.pathname)) return null;
		if (!isApiPath(url.pathname)) return null;

		const label = `${method} ${truncate(url.pathname)}`;
		const at = now();
		const entry = lastLogged.get(label);
		if (entry && at - entry.at < logWindowMs) {
			entry.suppressed++;
		} else {
			if (!entry && lastLogged.size >= maxTrackedPaths) lastLogged.clear();
			logger.warn(
				`Refused unserved API path: ${label}`,
				entry?.suppressed
					? { suppressedSinceLastLog: entry.suppressed }
					: undefined,
			);
			lastLogged.set(label, { at, suppressed: 0 });
		}

		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "not_found_error",
					message: `${label} is not served by better-ccflare`,
				},
			}),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	};
}
