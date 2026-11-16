/**
 * Opaque session keys for the usage-detail episode log.
 *
 * A key is an HMAC of the raw session identity under a per-install random
 * salt kept in forecast_meta. The raw identity (a client session id, a
 * transcript path) is never stored or logged; only the key is.
 */
import { createHmac, randomBytes } from "node:crypto";
import { SESSION_SALT_META_KEY } from "./usage-detail";

export interface MetaAccess {
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
}

/** The install's salt, created on first use. */
export async function sessionSalt(meta: MetaAccess): Promise<string> {
	const stored = await meta.getMeta(SESSION_SALT_META_KEY);
	if (stored) return stored;
	const salt = randomBytes(32).toString("hex");
	await meta.setMeta(SESSION_SALT_META_KEY, salt);
	return salt;
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
