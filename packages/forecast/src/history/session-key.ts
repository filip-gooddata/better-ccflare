/**
 * Opaque session keys for the usage-detail session log.
 *
 * A key is an HMAC of the raw session identity under a per-install random
 * salt kept in forecast_meta. The raw identity (a client session id, a
 * transcript path) is never stored or logged; only the key is. The key is a
 * pseudonym: whoever holds the database holds the salt too.
 */
import { createHmac, randomBytes } from "node:crypto";
import { SESSION_SALT_META_KEY } from "./usage-detail";

export interface MetaAccess {
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
}

const pending = new WeakMap<MetaAccess, Promise<string>>();

/**
 * The install's salt, created on first use. Concurrent callers on the same
 * store share one creation, so the proxy sync and the transcript pass at
 * start-up never end up with two salts.
 */
export function sessionSalt(meta: MetaAccess): Promise<string> {
	const inFlight = pending.get(meta);
	if (inFlight) return inFlight;
	const created = loadOrCreate(meta);
	pending.set(meta, created);
	created.catch(() => pending.delete(meta));
	return created;
}

async function loadOrCreate(meta: MetaAccess): Promise<string> {
	const stored = await meta.getMeta(SESSION_SALT_META_KEY);
	if (stored) return stored;
	await meta.setMeta(SESSION_SALT_META_KEY, randomBytes(32).toString("hex"));
	const written = await meta.getMeta(SESSION_SALT_META_KEY);
	if (!written) throw new Error("session salt was not stored");
	return written;
}

/** Key of one session. `scope` keeps proxy and transcript identities apart. */
export function sessionKey(
	salt: string,
	scope: "proxy" | "transcript",
	identity: string,
): string {
	return createHmac("sha256", salt)
		.update(`${scope}\u0000${identity}`)
		.digest("hex")
		.slice(0, 32);
}
