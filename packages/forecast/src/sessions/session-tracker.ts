import type {
	AccountId,
	EpochMs,
	LiveSession,
	ModelFamily,
	ServedEvent,
	SessionTrackerLike,
} from "../types";
import { demandUnits, modelFamily } from "../units";

export const CACHE_TTL_5M_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
/** Same cap as the session-pace mapping. */
export const SESSION_TRACKER_MAX_SESSIONS = 10_000;
export const SESSION_TRACKER_EXPIRE_MS = 24 * 60 * 60_000;
const RECENT_WINDOW_MS = 60 * 60_000;

export interface SessionTrackerOptions {
	/** Most sessions kept; the least recently seen is evicted first. */
	maxSessions?: number;
	/** A session without a request for this long is forgotten. */
	expireMs?: number;
	/** Clock for `get()` (its trailing-hour units and expiry). */
	now?: () => EpochMs;
}

interface Entry {
	sessionId: string;
	accountId: AccountId;
	family: ModelFamily;
	lastRequestAt: EpochMs;
	contextTokens: number;
	write5m: number;
	write1h: number;
	recent: { at: EpochMs; units: number }[];
}

function tokens(n: number | null): number {
	return n !== null && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * In-memory record of client sessions seen on the proxy, fed one served
 * request at a time. The cache lifetime of a session is read from its cache
 * writes: 1 hour when at least half of its split cache-write tokens so far
 * were 1-hour writes, else 5 minutes; unknown until one cache write with a
 * known split was seen.
 */
export function createSessionTracker(
	options: SessionTrackerOptions = {},
): SessionTrackerLike {
	const maxSessions = options.maxSessions ?? SESSION_TRACKER_MAX_SESSIONS;
	const expireMs = options.expireMs ?? SESSION_TRACKER_EXPIRE_MS;
	const clock = options.now ?? Date.now;
	const sessions = new Map<string, Entry>();

	const expired = (e: Entry, now: EpochMs) => now - e.lastRequestAt >= expireMs;

	function view(e: Entry, now: EpochMs): LiveSession {
		const written = e.write5m + e.write1h;
		const cacheTtlMs =
			written > 0
				? e.write1h * 2 >= written
					? CACHE_TTL_1H_MS
					: CACHE_TTL_5M_MS
				: null;
		let recentUnits = 0;
		for (const r of e.recent) {
			if (r.at > now - RECENT_WINDOW_MS && r.at <= now) recentUnits += r.units;
		}
		return {
			sessionId: e.sessionId,
			accountId: e.accountId,
			family: e.family,
			lastRequestAt: e.lastRequestAt,
			cacheTtlMs,
			coldAt: cacheTtlMs === null ? null : e.lastRequestAt + cacheTtlMs,
			contextTokens: e.contextTokens,
			recentUnits,
		};
	}

	return {
		observe(event: ServedEvent): void {
			if (!event.sessionId) return;
			const { usage } = event;
			let entry = sessions.get(event.sessionId);
			if (entry && expired(entry, event.at)) {
				sessions.delete(event.sessionId);
				entry = undefined;
			}
			if (!entry) {
				while (sessions.size >= maxSessions) {
					const oldest = sessions.keys().next().value;
					if (oldest === undefined) break;
					sessions.delete(oldest);
				}
				entry = {
					sessionId: event.sessionId,
					accountId: event.accountId,
					family: modelFamily(usage.model),
					lastRequestAt: event.at,
					contextTokens: 0,
					write5m: 0,
					write1h: 0,
					recent: [],
				};
			} else {
				sessions.delete(event.sessionId);
			}
			sessions.set(event.sessionId, entry);

			if (event.at >= entry.lastRequestAt) {
				entry.lastRequestAt = event.at;
				entry.accountId = event.accountId;
				entry.family = modelFamily(usage.model);
				entry.contextTokens =
					tokens(usage.inputTokens) +
					tokens(usage.cacheReadTokens) +
					tokens(usage.cacheWriteTokens);
			}
			if (
				usage.cacheWrite5mTokens !== null ||
				usage.cacheWrite1hTokens !== null
			) {
				entry.write5m += tokens(usage.cacheWrite5mTokens);
				entry.write1h += tokens(usage.cacheWrite1hTokens);
			}
			entry.recent.push({ at: event.at, units: demandUnits(usage) });
			const horizon = entry.lastRequestAt - RECENT_WINDOW_MS;
			entry.recent = entry.recent.filter((r) => r.at > horizon);
		},

		get(sessionId: string): LiveSession | null {
			const entry = sessions.get(sessionId);
			if (!entry) return null;
			const now = clock();
			if (expired(entry, now)) {
				sessions.delete(sessionId);
				return null;
			}
			return view(entry, now);
		},

		live(now: EpochMs, maxIdleMs: number): LiveSession[] {
			const out: LiveSession[] = [];
			for (const entry of sessions.values()) {
				if (expired(entry, now)) continue;
				if (now - entry.lastRequestAt < maxIdleMs) out.push(view(entry, now));
			}
			return out;
		},

		forget(sessionId: string): void {
			sessions.delete(sessionId);
		},
	};
}
