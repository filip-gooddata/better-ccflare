/**
 * The database as history/ sees it. DatabaseOperations from
 * @better-ccflare/database satisfies this structurally, so this package does
 * not import the database at runtime.
 */
import type { EpochMs } from "../types";
import type { UsageDetailDb } from "./usage-detail";

export interface ForecastDemandDbRow {
	bucketStart: EpochMs;
	accountId: string;
	source: string;
	units: number;
	fableUnits: number;
	requestCount: number;
}

export interface ForecastDemandDbTotal {
	bucketStart: EpochMs;
	units: number;
	fableUnits: number;
	requestCount: number;
}

/** Token usage of one request served by a Claude OAuth account. */
export interface ClaudeRequestUsageRow {
	timestamp: EpochMs;
	accountId: string;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface UsageSnapshotDbRow {
	accountId: string;
	timestamp: EpochMs;
	windowKey: string;
	utilization: number;
	resetsAt: EpochMs | null;
}

export interface ForecastDb extends UsageDetailDb {
	upsertForecastDemand(rows: ForecastDemandDbRow[]): Promise<void>;
	/** Replace every row of `source` with bucketStart in [from, to) by `rows`. */
	replaceForecastDemand(
		source: string,
		from: EpochMs,
		to: EpochMs,
		rows: ForecastDemandDbRow[],
	): Promise<void>;
	getForecastDemandPooled(
		from: EpochMs,
		to: EpochMs,
	): Promise<ForecastDemandDbTotal[]>;
	getForecastDemandByAccount(
		source: string,
		from: EpochMs,
		to: EpochMs,
	): Promise<ForecastDemandDbRow[]>;
	getEarliestForecastDemand(source?: string): Promise<EpochMs | null>;
	getForecastMeta(key: string): Promise<string | null>;
	setForecastMeta(key: string, value: string): Promise<void>;
	/** Requests in [from, to) served by Claude OAuth accounts with token usage. */
	getClaudeOAuthRequestUsage(
		from: EpochMs,
		to: EpochMs,
	): Promise<ClaudeRequestUsageRow[]>;
	getUsageSnapshotsBetween(
		from: EpochMs,
		to: EpochMs,
		windowKeys: readonly string[],
	): Promise<UsageSnapshotDbRow[]>;
}

export interface HistoryDeps {
	db: ForecastDb;
}
