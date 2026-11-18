/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body.
 *
 * Removes: content-encoding, content-length, transfer-encoding
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	sanitized.delete("transfer-encoding");

	return sanitized;
}

/**
 * Set only on a 429 the proxy builds itself. The proxy's own code
 * (`LOCAL_429_HEADER` in @better-ccflare/proxy) re-exports this name; it is
 * defined here so upstream responses can be cleaned of it without an import
 * cycle.
 */
export const LOCAL_429_MARKER_HEADER = "x-better-ccflare-local-429";

/**
 * Removes the headers only the proxy may set from an upstream response's
 * headers, in place, so an upstream (or anything in between) cannot pass one
 * off as the proxy's own. Returns whether anything was removed.
 */
export function stripProxyOnlyHeaders(headers: Headers): boolean {
	if (!headers.has(LOCAL_429_MARKER_HEADER)) return false;
	headers.delete(LOCAL_429_MARKER_HEADER);
	return true;
}

/**
 * An upstream response without the headers only the proxy may set. The same
 * response when it carries none; otherwise its headers are cleaned in place,
 * or, where the runtime keeps them immutable, a copy with the same status and
 * body is returned.
 */
export function withoutProxyOnlyHeaders(res: Response): Response {
	if (!res.headers.has(LOCAL_429_MARKER_HEADER)) return res;
	try {
		stripProxyOnlyHeaders(res.headers);
		return res;
	} catch {
		const headers = new Headers(res.headers);
		stripProxyOnlyHeaders(headers);
		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers,
		});
	}
}

/**
 * Removes hop-by-hop + compression negotiation headers and sensitive auth
 * headers from the ORIGINAL client request before it is persisted for
 * analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length,
 * authorization, x-api-key, cookie
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	// Strip sensitive auth headers from persisted payloads
	h.delete("authorization");
	h.delete("x-api-key");
	h.delete("cookie");
	// keep in sync with INTERNAL_PROBE_SECRET_HEADER
	// (@better-ccflare/proxy already depends on http-common, so importing the
	// proxy package's constant here would create an import cycle)
	h.delete("x-better-ccflare-internal-probe-secret");
	return h;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});
}
