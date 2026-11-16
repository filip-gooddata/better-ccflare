import { type Statement, writeAtomically } from "./atomic-write";
import { BaseRepository } from "./base.repository";

/** One row of `forecast_demand`: demand of one account and source in one bucket. */
export interface ForecastDemandRow {
	bucketStart: number;
	/** "" for sources that do not name the account (transcripts). */
	accountId: string;
	source: string;
	units: number;
	fableUnits: number;
	requestCount: number;
}

/** Demand of one bucket summed over accounts and sources. */
export interface ForecastDemandTotal {
	bucketStart: number;
	units: number;
	fableUnits: number;
	requestCount: number;
}

/** Token usage of one request served by a Claude OAuth account. */
export interface ClaudeOAuthRequestUsage {
	timestamp: number;
	accountId: string;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** requests.client_session_id; held only in memory while hashing to a session key. */
	clientSessionId: string | null;
	/** NULL when upstream did not report the 5-minute / 1-hour split. */
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

interface DemandDbRow {
	bucket_start: number;
	account_id: string;
	source: string;
	units: number;
	fable_units: number;
	request_count: number;
}

interface TotalDbRow {
	bucket_start: number;
	units: number;
	fable_units: number;
	request_count: number;
}

interface UsageDbRow {
	timestamp: number;
	account_id: string;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	client_session_id: string | null;
	cache_write_5m_tokens: number | null;
	cache_write_1h_tokens: number | null;
}

const UPSERT_SQL = `INSERT INTO forecast_demand
	(bucket_start, account_id, source, units, fable_units, request_count)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT (bucket_start, account_id, source) DO UPDATE SET
		units = EXCLUDED.units,
		fable_units = EXCLUDED.fable_units,
		request_count = EXCLUDED.request_count`;

/**
 * A Claude OAuth account, the same test as isEligibleForReauthDeadline in
 * @better-ccflare/types: provider "anthropic" (NULL counts as the column's
 * default), refresh and access token both present and different. Requests
 * of deleted accounts drop out because the join finds no account.
 */
const CLAUDE_OAUTH_USAGE_SQL = `SELECT r.timestamp AS timestamp,
		r.account_used AS account_id,
		r.model AS model,
		COALESCE(r.input_tokens, 0) AS input_tokens,
		COALESCE(r.output_tokens, 0) AS output_tokens,
		COALESCE(r.cache_read_input_tokens, 0) AS cache_read_tokens,
		COALESCE(r.cache_creation_input_tokens, 0) AS cache_write_tokens,
		r.client_session_id AS client_session_id,
		r.cache_creation_5m_input_tokens AS cache_write_5m_tokens,
		r.cache_creation_1h_input_tokens AS cache_write_1h_tokens
	FROM requests r
	JOIN accounts a ON a.id = r.account_used
	WHERE r.timestamp >= ? AND r.timestamp < ?
		AND COALESCE(a.provider, 'anthropic') = 'anthropic'
		AND a.refresh_token IS NOT NULL AND a.refresh_token <> ''
		AND a.access_token IS NOT NULL AND a.access_token <> ''
		AND a.refresh_token <> a.access_token
		AND COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0)
			+ COALESCE(r.cache_read_input_tokens, 0)
			+ COALESCE(r.cache_creation_input_tokens, 0) > 0
	ORDER BY r.timestamp, r.id`;

function nullableNumber(value: number | null): number | null {
	return value == null ? null : Number(value);
}

function toRow(row: DemandDbRow): ForecastDemandRow {
	return {
		bucketStart: Number(row.bucket_start),
		accountId: row.account_id,
		source: row.source,
		units: Number(row.units),
		fableUnits: Number(row.fable_units),
		requestCount: Number(row.request_count),
	};
}

function params(row: ForecastDemandRow): unknown[] {
	return [
		row.bucketStart,
		row.accountId,
		row.source,
		row.units,
		row.fableUnits,
		row.requestCount,
	];
}

/** Demand history of the interruption forecast (`forecast_demand`, `forecast_meta`). */
export class ForecastDemandRepository extends BaseRepository<ForecastDemandRow> {
	/** Insert or replace rows by (bucket_start, account_id, source). */
	async upsert(rows: ForecastDemandRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.writeAtomically(
			rows.map((row): Statement => [UPSERT_SQL, params(row)]),
		);
	}

	/**
	 * Replace every row of `source` with bucket_start in [from, to) by `rows`,
	 * so a bucket that lost an account loses its row too. All or nothing.
	 */
	async replace(
		source: string,
		from: number,
		to: number,
		rows: ForecastDemandRow[],
	): Promise<void> {
		await this.writeAtomically([
			[
				"DELETE FROM forecast_demand WHERE source = ? AND bucket_start >= ? AND bucket_start < ?",
				[source, from, to],
			],
			...rows.map((row): Statement => [UPSERT_SQL, params(row)]),
		]);
	}

	private writeAtomically(statements: Statement[]): Promise<void> {
		return writeAtomically(this.adapter, statements);
	}

	/** Buckets in [from, to) summed over accounts and sources, ascending, empty ones omitted. */
	async pooled(from: number, to: number): Promise<ForecastDemandTotal[]> {
		const rows = await this.query<TotalDbRow>(
			`SELECT bucket_start, SUM(units) AS units, SUM(fable_units) AS fable_units,
				SUM(request_count) AS request_count
			FROM forecast_demand
			WHERE bucket_start >= ? AND bucket_start < ?
			GROUP BY bucket_start
			HAVING SUM(units) > 0 OR SUM(request_count) > 0
			ORDER BY bucket_start`,
			[from, to],
		);
		return rows.map((row) => ({
			bucketStart: Number(row.bucket_start),
			units: Number(row.units),
			fableUnits: Number(row.fable_units),
			requestCount: Number(row.request_count),
		}));
	}

	/** Rows of one source in [from, to), ascending by bucket, then account. */
	async byAccount(
		source: string,
		from: number,
		to: number,
	): Promise<ForecastDemandRow[]> {
		const rows = await this.query<DemandDbRow>(
			`SELECT bucket_start, account_id, source, units, fable_units, request_count
			FROM forecast_demand
			WHERE source = ? AND bucket_start >= ? AND bucket_start < ?
			ORDER BY bucket_start, account_id`,
			[source, from, to],
		);
		return rows.map(toRow);
	}

	/** Start of the earliest bucket, of one source when given; null when there is none. */
	async earliest(source?: string): Promise<number | null> {
		const row =
			source === undefined
				? await this.get<{ earliest: number | null }>(
						"SELECT MIN(bucket_start) AS earliest FROM forecast_demand",
					)
				: await this.get<{ earliest: number | null }>(
						"SELECT MIN(bucket_start) AS earliest FROM forecast_demand WHERE source = ?",
						[source],
					);
		return row?.earliest == null ? null : Number(row.earliest);
	}

	async getMeta(key: string): Promise<string | null> {
		const row = await this.get<{ value: string }>(
			"SELECT value FROM forecast_meta WHERE key = ?",
			[key],
		);
		return row ? row.value : null;
	}

	async setMeta(key: string, value: string): Promise<void> {
		await this.run(
			`INSERT INTO forecast_meta (key, value) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, value],
		);
	}

	/**
	 * Token usage of requests in [from, to) served by Claude OAuth accounts
	 * and carrying usage, ascending by time. Token columns NULL count as 0.
	 */
	async claudeOAuthUsage(
		from: number,
		to: number,
	): Promise<ClaudeOAuthRequestUsage[]> {
		const rows = await this.query<UsageDbRow>(CLAUDE_OAUTH_USAGE_SQL, [
			from,
			to,
		]);
		return rows.map((row) => ({
			timestamp: Number(row.timestamp),
			accountId: row.account_id,
			model: row.model,
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read_tokens),
			cacheWriteTokens: Number(row.cache_write_tokens),
			clientSessionId: row.client_session_id ?? null,
			cacheWrite5mTokens: nullableNumber(row.cache_write_5m_tokens),
			cacheWrite1hTokens: nullableNumber(row.cache_write_1h_tokens),
		}));
	}
}
