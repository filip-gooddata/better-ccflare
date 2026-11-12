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

function isApiPath(pathname: string): boolean {
	const lower = pathname.toLowerCase();
	return lower === "/api" || lower.startsWith("/api/");
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
		if (!isApiPath(url.pathname)) return null;
		if (PROXY_PASSTHROUGH_API_PATHS.has(url.pathname)) return null;

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
