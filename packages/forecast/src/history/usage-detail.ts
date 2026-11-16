/**
 * Usage detail kept for the calibration learners: token sums per category and
 * model family per bucket, and a log of activity episodes per session.
 *
 * Usage metadata only. No row holds message text, a session id, a file name,
 * a path or a tool name; sessions appear only as an opaque salted key.
 */
import type { EpochMs, ModelFamily } from "../types";

export type UsageDetailSource = "transcript" | "proxy";

/** Two requests of one session closer than this belong to one episode. */
export const EPISODE_GAP_MS = 60_000;

/** forecast_meta key of the per-install salt for session keys. */
export const SESSION_SALT_META_KEY = "usage_session_salt";

/** forecast_meta key set once the transcript usage-detail pass has finished. */
export const USAGE_DETAIL_BACKFILL_META_KEY = "transcript_usage_detail_done";

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
 * One activity episode of one session: a run of requests whose gaps are all
 * below EPISODE_GAP_MS. `gapBeforeMs` is the time from the previous episode's
 * last request, null for a session's first episode. The `first*` fields
 * describe the episode's first request; the sums cover the whole episode,
 * with the same split rule as UsageTokenRow.
 */
export interface SessionEpisodeRow {
	source: UsageDetailSource;
	sessionKey: string;
	accountId: string;
	startedAt: EpochMs;
	endedAt: EpochMs;
	gapBeforeMs: number | null;
	requestCount: number;
	firstFamily: ModelFamily;
	firstCacheReadTokens: number;
	firstCacheWriteTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
}

/**
 * The database as the usage-detail code sees it. DatabaseOperations from
 * @better-ccflare/database satisfies it structurally.
 */
export interface UsageDetailDb {
	/** Insert or replace by (bucketStart, accountId, source, family). */
	upsertUsageTokens(rows: UsageTokenRow[]): Promise<void>;
	/** Replace every row of `source` with bucketStart in [from, to) by `rows`. */
	replaceUsageTokens(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
		rows: UsageTokenRow[],
	): Promise<void>;
	/** Insert or replace by (source, sessionKey, startedAt). */
	upsertSessionEpisodes(rows: SessionEpisodeRow[]): Promise<void>;
	/** Replace every episode of `source` with startedAt >= from by `rows`. */
	replaceSessionEpisodesFrom(
		source: UsageDetailSource,
		from: EpochMs,
		rows: SessionEpisodeRow[],
	): Promise<void>;
	/** Episodes of `source` with endedAt >= since, ascending by startedAt. */
	getSessionEpisodesEndingSince(
		source: UsageDetailSource,
		since: EpochMs,
	): Promise<SessionEpisodeRow[]>;
	getUsageTokens(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
	): Promise<UsageTokenRow[]>;
	/** Delete token rows with bucketStart < before and episodes with endedAt < before. */
	pruneUsageDetail(before: EpochMs): Promise<void>;
}
