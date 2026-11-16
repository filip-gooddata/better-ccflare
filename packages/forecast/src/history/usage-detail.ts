/**
 * Usage detail kept for the calibration learners: token sums per category and
 * model family per bucket, and an ordered log of the requests of each session.
 *
 * Usage metadata only. No row holds message text, a session id, a file name,
 * a path or a tool name; sessions appear only as an opaque salted key.
 */
import type { EpochMs, ModelFamily } from "../types";

export type UsageDetailSource = "transcript" | "proxy";

/** forecast_meta key of the per-install salt for session keys. */
export const SESSION_SALT_META_KEY = "usage_session_salt";

/** forecast_meta key set once the transcript usage-detail pass has finished. */
export const USAGE_DETAIL_BACKFILL_META_KEY = "transcript_usage_detail_done";

/**
 * forecast_meta key holding a JSON object of counts and epoch-ms bounds of what
 * the transcript pass covered: { files, lines, requests, firstAt, lastAt }.
 */
export const USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY =
	"transcript_usage_detail_coverage";

/** forecast_meta key: epoch ms of the first proxy sync that recorded usage detail. */
export const USAGE_DETAIL_PROXY_SINCE_META_KEY = "proxy_usage_detail_since";

/**
 * Token sums of one (bucket, account, source, family). `accountId` is "" for
 * transcript rows. `cacheWriteTokens` holds every cache write; the two split
 * fields sum only the writes whose request reported the split, so
 * cacheWriteTokens - cacheWrite5mTokens - cacheWrite1hTokens is the unsplit rest.
 */
export interface UsageTokenRow {
	bucketStart: EpochMs;
	accountId: string;
	source: UsageDetailSource;
	family: ModelFamily;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
}

/**
 * One request of one session, in time order. Learners derive idle gaps,
 * turnover and cache-class transitions from the sequence. `seq` orders
 * requests of one session that share the same `at` (0 for the first).
 * The split fields are null when the source did not report the split.
 */
export interface SessionRequestRow {
	source: UsageDetailSource;
	sessionKey: string;
	accountId: string;
	at: EpochMs;
	seq: number;
	family: ModelFamily;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

/**
 * The database as the usage-detail code sees it. DatabaseOperations from
 * @better-ccflare/database satisfies it structurally.
 */
export interface UsageDetailDb {
	/** Insert or replace by (bucketStart, accountId, source, family). */
	upsertUsageTokens(rows: UsageTokenRow[]): Promise<void>;
	/** Replace every row of `source` with bucketStart in [from, to) by `rows`, in one transaction. */
	replaceUsageTokens(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
		rows: UsageTokenRow[],
	): Promise<void>;
	getUsageTokens(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
	): Promise<UsageTokenRow[]>;
	/** Insert or replace by (source, sessionKey, at, seq). */
	upsertSessionRequests(rows: SessionRequestRow[]): Promise<void>;
	/** Replace every row of `source` with `at` in [from, to) by `rows`, in one transaction. */
	replaceSessionRequests(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
		rows: SessionRequestRow[],
	): Promise<void>;
	/** Rows of `source` with `at` in [from, to), ascending by (sessionKey, at, seq). */
	getSessionRequests(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
	): Promise<SessionRequestRow[]>;
	/** Delete token rows with bucketStart < before and session rows with at < before. */
	pruneUsageDetail(before: EpochMs): Promise<void>;
}
