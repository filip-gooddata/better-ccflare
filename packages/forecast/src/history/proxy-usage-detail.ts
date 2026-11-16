import type { EpochMs } from "../types";
import { bucketStart, modelFamily } from "../units";
import type { ClaudeRequestUsageRow, ForecastDb } from "./ports";
import { type MetaAccess, sessionKey, sessionSalt } from "./session-key";
import {
	type SessionRequestRow,
	USAGE_DETAIL_PROXY_SINCE_META_KEY,
	type UsageTokenRow,
} from "./usage-detail";

export interface ProxyUsageDetailResult {
	tokenRows: number;
	sessionRows: number;
}

/** One MetaAccess per database, so sessionSalt shares one salt creation per store. */
const metaByDb = new WeakMap<ForecastDb, MetaAccess>();

function metaAccess(db: ForecastDb): MetaAccess {
	let meta = metaByDb.get(db);
	if (!meta) {
		meta = {
			getMeta: (key) => db.getForecastMeta(key),
			setMeta: (key, value) => db.setForecastMeta(key, value),
		};
		metaByDb.set(db, meta);
	}
	return meta;
}

/**
 * Rebuild the proxy's usage detail of [from, to) from the same request rows
 * the demand sync read (ascending by time, then request id): token sums per
 * bucket, account and family, and one session row per request that names a
 * client session. The raw client session id is only hashed here, never kept.
 */
export async function recordProxyUsageDetail(
	db: ForecastDb,
	from: EpochMs,
	to: EpochMs,
	requests: readonly ClaudeRequestUsageRow[],
	now: EpochMs,
): Promise<ProxyUsageDetailResult> {
	const tokens = new Map<string, UsageTokenRow>();
	const sessions: SessionRequestRow[] = [];
	const seqs = new Map<string, number>();
	const salt = requests.some((r) => r.clientSessionId)
		? await sessionSalt(metaAccess(db))
		: null;

	for (const request of requests) {
		const family = modelFamily(request.model);
		const start = bucketStart(request.timestamp);
		const tokenKey = `${start}\u0000${request.accountId}\u0000${family}`;
		let row = tokens.get(tokenKey);
		if (!row) {
			row = {
				bucketStart: start,
				accountId: request.accountId,
				source: "proxy",
				family,
				requestCount: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
			};
			tokens.set(tokenKey, row);
		}
		row.requestCount += 1;
		row.inputTokens += request.inputTokens;
		row.outputTokens += request.outputTokens;
		row.cacheReadTokens += request.cacheReadTokens;
		row.cacheWriteTokens += request.cacheWriteTokens;
		row.cacheWrite5mTokens += request.cacheWrite5mTokens ?? 0;
		row.cacheWrite1hTokens += request.cacheWrite1hTokens ?? 0;

		if (!request.clientSessionId || salt === null) continue;
		const key = sessionKey(salt, "proxy", request.clientSessionId);
		const seqKey = `${key}\u0000${request.timestamp}`;
		const seq = seqs.get(seqKey) ?? 0;
		seqs.set(seqKey, seq + 1);
		sessions.push({
			source: "proxy",
			sessionKey: key,
			accountId: request.accountId,
			at: request.timestamp,
			seq,
			family,
			inputTokens: request.inputTokens,
			outputTokens: request.outputTokens,
			cacheReadTokens: request.cacheReadTokens,
			cacheWriteTokens: request.cacheWriteTokens,
			cacheWrite5mTokens: request.cacheWrite5mTokens,
			cacheWrite1hTokens: request.cacheWrite1hTokens,
		});
	}

	const tokenRows = [...tokens.values()];
	await db.replaceUsageTokens("proxy", from, to, tokenRows);
	await db.replaceSessionRequests("proxy", from, to, sessions);
	if ((await db.getForecastMeta(USAGE_DETAIL_PROXY_SINCE_META_KEY)) === null) {
		await db.setForecastMeta(USAGE_DETAIL_PROXY_SINCE_META_KEY, String(now));
	}
	return { tokenRows: tokenRows.length, sessionRows: sessions.length };
}

/** Usage detail older than this is pruned: the start of the history window's first bucket. */
export function usageDetailCutoff(
	now: EpochMs,
	historyLookbackDays: number,
): EpochMs {
	return bucketStart(now - historyLookbackDays * 86_400_000);
}
