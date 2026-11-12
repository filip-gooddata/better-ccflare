import { BUCKET_MS, type EpochMs, type TokenUsage } from "../types";
import { bucketStart, demandUnits, isFableUsage } from "../units";
import type { ForecastDemandDbRow, HistoryDeps } from "./ports";

/** forecast_meta key set when the first full aggregation of `requests` finished. */
export const PROXY_SYNC_MARKER = "proxy_demand_first_sync_at";
/** forecast_meta key holding `now` of the last finished run. */
export const PROXY_SYNC_LAST = "proxy_demand_last_sync_at";
/** How far back each later run recomputes. */
export const PROXY_SYNC_WINDOW_MS = 60 * 60_000;

export interface ProxySyncResult {
	from: EpochMs;
	to: EpochMs;
	firstRun: boolean;
	requests: number;
	rows: number;
}

/**
 * Recompute the proxy's demand buckets from the `requests` table and replace
 * the stored `proxy` rows of those buckets. The first run covers everything
 * the table holds; later runs the whole buckets from bucketStart(now - 60 min)
 * through the bucket holding `now`, reaching back to 60 minutes before the
 * last finished run when that is earlier (a gap in the runs is caught up).
 */
export async function syncProxyDemand(
	{ db }: HistoryDeps,
	now: EpochMs,
): Promise<ProxySyncResult> {
	const firstRun = (await db.getForecastMeta(PROXY_SYNC_MARKER)) === null;
	const last = Number(await db.getForecastMeta(PROXY_SYNC_LAST));
	const since = Number.isFinite(last) && last > 0 ? Math.min(now, last) : now;
	const from = firstRun ? 0 : bucketStart(since - PROXY_SYNC_WINDOW_MS);
	const to = bucketStart(now) + BUCKET_MS;

	const usage = await db.getClaudeOAuthRequestUsage(from, to);
	const byBucket = new Map<string, ForecastDemandDbRow>();
	for (const request of usage) {
		// The table keeps no 5-minute/1-hour split: the split stays unknown.
		const tokens: TokenUsage = {
			model: request.model,
			inputTokens: request.inputTokens,
			outputTokens: request.outputTokens,
			cacheReadTokens: request.cacheReadTokens,
			cacheWriteTokens: request.cacheWriteTokens,
			cacheWrite5mTokens: null,
			cacheWrite1hTokens: null,
		};
		const units = demandUnits(tokens);
		const start = bucketStart(request.timestamp);
		const key = `${start}\u0000${request.accountId}`;
		let row = byBucket.get(key);
		if (!row) {
			row = {
				bucketStart: start,
				accountId: request.accountId,
				source: "proxy",
				units: 0,
				fableUnits: 0,
				requestCount: 0,
			};
			byBucket.set(key, row);
		}
		row.units += units;
		if (isFableUsage(tokens)) row.fableUnits += units;
		row.requestCount += 1;
	}

	const rows = [...byBucket.values()];
	await db.replaceForecastDemand("proxy", from, to, rows);
	if (firstRun) await db.setForecastMeta(PROXY_SYNC_MARKER, String(now));
	await db.setForecastMeta(PROXY_SYNC_LAST, String(now));
	return { from, to, firstRun, requests: usage.length, rows: rows.length };
}

/** Start of the earliest stored proxy bucket: the transcript backfill's cut-over. */
export function earliestProxyBucket({
	db,
}: HistoryDeps): Promise<EpochMs | null> {
	return db.getEarliestForecastDemand("proxy");
}
