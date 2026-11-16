import { type Statement, writeAtomically } from "./atomic-write";
import { BaseRepository } from "./base.repository";

export type UsageDetailSource = "transcript" | "proxy";
export type UsageModelFamily = "opus" | "fable" | "sonnet" | "haiku" | "other";

/** One row of `forecast_usage_tokens`: token sums of one bucket, account, source and family. */
export interface UsageTokenRow {
	bucketStart: number;
	/** "" for transcript rows. */
	accountId: string;
	source: UsageDetailSource;
	family: UsageModelFamily;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
}

/**
 * One row of `forecast_session_requests`: one request of one session. `seq`
 * orders requests of one session that share the same `at`. The split fields
 * are null when the source did not report the split.
 */
export interface SessionRequestRow {
	source: UsageDetailSource;
	/** Opaque salted key; never the raw session identity. */
	sessionKey: string;
	accountId: string;
	at: number;
	seq: number;
	family: UsageModelFamily;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

interface TokenDbRow {
	bucket_start: number;
	account_id: string;
	source: UsageDetailSource;
	family: UsageModelFamily;
	request_count: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cache_write_5m_tokens: number;
	cache_write_1h_tokens: number;
}

interface SessionDbRow {
	source: UsageDetailSource;
	session_key: string;
	account_id: string;
	at: number;
	seq: number;
	family: UsageModelFamily;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cache_write_5m_tokens: number | null;
	cache_write_1h_tokens: number | null;
}

const TOKEN_COLUMNS = `bucket_start, account_id, source, family, request_count,
	input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
	cache_write_5m_tokens, cache_write_1h_tokens`;

const UPSERT_TOKENS_SQL = `INSERT INTO forecast_usage_tokens (${TOKEN_COLUMNS})
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (bucket_start, account_id, source, family) DO UPDATE SET
		request_count = EXCLUDED.request_count,
		input_tokens = EXCLUDED.input_tokens,
		output_tokens = EXCLUDED.output_tokens,
		cache_read_tokens = EXCLUDED.cache_read_tokens,
		cache_write_tokens = EXCLUDED.cache_write_tokens,
		cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
		cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens`;

const SESSION_COLUMNS = `source, session_key, account_id, at, seq, family,
	input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
	cache_write_5m_tokens, cache_write_1h_tokens`;

const UPSERT_SESSION_SQL = `INSERT INTO forecast_session_requests (${SESSION_COLUMNS})
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (source, session_key, at, seq) DO UPDATE SET
		account_id = EXCLUDED.account_id,
		family = EXCLUDED.family,
		input_tokens = EXCLUDED.input_tokens,
		output_tokens = EXCLUDED.output_tokens,
		cache_read_tokens = EXCLUDED.cache_read_tokens,
		cache_write_tokens = EXCLUDED.cache_write_tokens,
		cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
		cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens`;

function tokenParams(row: UsageTokenRow): unknown[] {
	return [
		row.bucketStart,
		row.accountId,
		row.source,
		row.family,
		row.requestCount,
		row.inputTokens,
		row.outputTokens,
		row.cacheReadTokens,
		row.cacheWriteTokens,
		row.cacheWrite5mTokens,
		row.cacheWrite1hTokens,
	];
}

function sessionParams(row: SessionRequestRow): unknown[] {
	return [
		row.source,
		row.sessionKey,
		row.accountId,
		row.at,
		row.seq,
		row.family,
		row.inputTokens,
		row.outputTokens,
		row.cacheReadTokens,
		row.cacheWriteTokens,
		row.cacheWrite5mTokens,
		row.cacheWrite1hTokens,
	];
}

function nullableNumber(value: number | null): number | null {
	return value == null ? null : Number(value);
}

function toTokenRow(row: TokenDbRow): UsageTokenRow {
	return {
		bucketStart: Number(row.bucket_start),
		accountId: row.account_id,
		source: row.source,
		family: row.family,
		requestCount: Number(row.request_count),
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens: Number(row.cache_write_tokens),
		cacheWrite5mTokens: Number(row.cache_write_5m_tokens),
		cacheWrite1hTokens: Number(row.cache_write_1h_tokens),
	};
}

function toSessionRow(row: SessionDbRow): SessionRequestRow {
	return {
		source: row.source,
		sessionKey: row.session_key,
		accountId: row.account_id,
		at: Number(row.at),
		seq: Number(row.seq),
		family: row.family,
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens: Number(row.cache_write_tokens),
		cacheWrite5mTokens: nullableNumber(row.cache_write_5m_tokens),
		cacheWrite1hTokens: nullableNumber(row.cache_write_1h_tokens),
	};
}

/**
 * Usage detail of the interruption forecast (`forecast_usage_tokens`,
 * `forecast_session_requests`): usage metadata only, for calibration learners.
 */
export class UsageDetailRepository extends BaseRepository<UsageTokenRow> {
	async upsertTokens(rows: UsageTokenRow[]): Promise<void> {
		if (rows.length === 0) return;
		await writeAtomically(
			this.adapter,
			rows.map((row): Statement => [UPSERT_TOKENS_SQL, tokenParams(row)]),
		);
	}

	/** Replace every row of `source` with bucket_start in [from, to) by `rows`. All or nothing. */
	async replaceTokens(
		source: UsageDetailSource,
		from: number,
		to: number,
		rows: UsageTokenRow[],
	): Promise<void> {
		await writeAtomically(this.adapter, [
			[
				"DELETE FROM forecast_usage_tokens WHERE source = ? AND bucket_start >= ? AND bucket_start < ?",
				[source, from, to],
			],
			...rows.map((row): Statement => [UPSERT_TOKENS_SQL, tokenParams(row)]),
		]);
	}

	/** Rows of `source` with bucket_start in [from, to), ascending by bucket, account, family. */
	async getTokens(
		source: UsageDetailSource,
		from: number,
		to: number,
	): Promise<UsageTokenRow[]> {
		const rows = await this.query<TokenDbRow>(
			`SELECT ${TOKEN_COLUMNS} FROM forecast_usage_tokens
			WHERE source = ? AND bucket_start >= ? AND bucket_start < ?
			ORDER BY bucket_start, account_id, family`,
			[source, from, to],
		);
		return rows.map(toTokenRow);
	}

	async upsertSessionRequests(rows: SessionRequestRow[]): Promise<void> {
		if (rows.length === 0) return;
		await writeAtomically(
			this.adapter,
			rows.map((row): Statement => [UPSERT_SESSION_SQL, sessionParams(row)]),
		);
	}

	/** Replace every session row of `source` with `at` in [from, to) by `rows`. All or nothing. */
	async replaceSessionRequests(
		source: UsageDetailSource,
		from: number,
		to: number,
		rows: SessionRequestRow[],
	): Promise<void> {
		await writeAtomically(this.adapter, [
			[
				"DELETE FROM forecast_session_requests WHERE source = ? AND at >= ? AND at < ?",
				[source, from, to],
			],
			...rows.map((row): Statement => [UPSERT_SESSION_SQL, sessionParams(row)]),
		]);
	}

	/** Session rows of `source` with `at` in [from, to), ascending by (session_key, at, seq). */
	async getSessionRequests(
		source: UsageDetailSource,
		from: number,
		to: number,
	): Promise<SessionRequestRow[]> {
		const rows = await this.query<SessionDbRow>(
			`SELECT ${SESSION_COLUMNS} FROM forecast_session_requests
			WHERE source = ? AND at >= ? AND at < ?
			ORDER BY session_key, at, seq`,
			[source, from, to],
		);
		return rows.map(toSessionRow);
	}

	/** Delete token rows with bucket_start < before and session rows with at < before. */
	async prune(before: number): Promise<void> {
		await writeAtomically(this.adapter, [
			["DELETE FROM forecast_usage_tokens WHERE bucket_start < ?", [before]],
			["DELETE FROM forecast_session_requests WHERE at < ?", [before]],
		]);
	}
}
