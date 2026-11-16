import { BUCKET_MS, type EpochMs, type TokenUsage } from "../types";
import { bucketStart, demandUnits, isFableUsage } from "../units";
import type {
	ClaudeRequestUsageRow,
	ForecastDemandDbRow,
	HistoryDeps,
} from "./ports";
import { recordProxyUsageDetail } from "./proxy-usage-detail";
import { USAGE_DETAIL_PROXY_THROUGH_META_KEY } from "./usage-detail";

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
	/** Start of the usage-detail rebuild; it ends at  too. */
	detailFrom: EpochMs;
	tokenRows: number;
	sessionRows: number;
	/** Name of the error that stopped the usage-detail rebuild; never its message. */
	detailError?: string;
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The error name only, when it is a plain identifier: a message could carry a path. */
function errorName(error: unknown): string {
	const name = error instanceof Error ? error.name : typeof error;
	return ERROR_NAME.test(name) ? name : "Error";
}

/**
 * Recompute the proxy's demand buckets from the `requests` table and replace
 * the stored `proxy` rows of those buckets. The first run covers everything
 * the table holds; later runs the whole buckets from bucketStart(now - 60 min)
 * through the bucket holding `now`, reaching back to 60 minutes before the
 * last finished run when that is earlier (a gap in the runs is caught up).
 * The proxy usage detail is rebuilt from the same rows, reaching back to the
 * end of the last rebuild that finished when that is earlier (all of
 * `requests` before any has), with a read of its own when that reaches
 * further back than the demand window. Its failure is reported in the result
 * and never stops the demand rows or their markers.
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
	const detail = await syncUsageDetail({ db }, from, to, usage, now);
	if (firstRun) await db.setForecastMeta(PROXY_SYNC_MARKER, String(now));
	await db.setForecastMeta(PROXY_SYNC_LAST, String(now));
	return {
		from,
		to,
		firstRun,
		requests: usage.length,
		rows: rows.length,
		...detail,
	};
}

type UsageDetailSync = Pick<
	ProxySyncResult,
	"detailFrom" | "tokenRows" | "sessionRows" | "detailError"
>;

/**
 * Rebuild the usage detail of [min(from, through), to), or [0, to) before any
 * rebuild finished, and advance `through` to `to` once it has. A throw is
 * returned as the error name and leaves `through` where it was.
 */
async function syncUsageDetail(
	{ db }: HistoryDeps,
	from: EpochMs,
	to: EpochMs,
	usage: readonly ClaudeRequestUsageRow[],
	now: EpochMs,
): Promise<UsageDetailSync> {
	let detailFrom: EpochMs = 0;
	try {
		const stored = await db.getForecastMeta(
			USAGE_DETAIL_PROXY_THROUGH_META_KEY,
		);
		const through = Number(stored);
		detailFrom =
			stored !== null && Number.isFinite(through) && through >= 0
				? Math.min(from, through)
				: 0;
		const requests =
			detailFrom < from
				? await db.getClaudeOAuthRequestUsage(detailFrom, to)
				: usage;
		const counts = await recordProxyUsageDetail(
			db,
			detailFrom,
			to,
			requests,
			now,
		);
		await db.setForecastMeta(USAGE_DETAIL_PROXY_THROUGH_META_KEY, String(to));
		return { detailFrom, ...counts };
	} catch (error) {
		return {
			detailFrom,
			tokenRows: 0,
			sessionRows: 0,
			detailError: errorName(error),
		};
	}
}

/** Start of the earliest stored proxy bucket: the transcript backfill's cut-over. */
export function earliestProxyBucket({
	db,
}: HistoryDeps): Promise<EpochMs | null> {
	return db.getEarliestForecastDemand("proxy");
}
