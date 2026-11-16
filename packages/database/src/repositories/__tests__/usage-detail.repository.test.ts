import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ForecastDemandRepository } from "../forecast-demand.repository";
import { RequestRepository } from "../request.repository";
import {
	type SessionRequestRow,
	UsageDetailRepository,
	type UsageTokenRow,
} from "../usage-detail.repository";

const B = 300_000;

function tokens(
	bucketStart: number,
	accountId: string,
	source: "proxy" | "transcript",
	family: UsageTokenRow["family"],
	n = 1,
): UsageTokenRow {
	return {
		bucketStart,
		accountId,
		source,
		family,
		requestCount: n,
		inputTokens: 10 * n,
		outputTokens: 20 * n,
		cacheReadTokens: 30 * n,
		cacheWriteTokens: 40 * n,
		cacheWrite5mTokens: 15 * n,
		cacheWrite1hTokens: 5 * n,
	};
}

function session(
	source: "proxy" | "transcript",
	sessionKey: string,
	at: number,
	seq = 0,
	split: [number | null, number | null] = [20, 30],
): SessionRequestRow {
	return {
		source,
		sessionKey,
		accountId: "acct",
		at,
		seq,
		family: "opus",
		inputTokens: 1,
		outputTokens: 2,
		cacheReadTokens: 300,
		cacheWriteTokens: 70,
		cacheWrite5mTokens: split[0],
		cacheWrite1hTokens: split[1],
	};
}

function columns(db: Database, table: string): string[] {
	return (
		db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
	).map((c) => c.name);
}

function primaryKey(db: Database, table: string): string[] {
	return (
		db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
			pk: number;
		}>
	)
		.filter((c) => c.pk > 0)
		.sort((x, y) => x.pk - y.pk)
		.map((c) => c.name);
}

const TOKEN_COLUMNS = [
	"bucket_start",
	"account_id",
	"source",
	"family",
	"request_count",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cache_write_5m_tokens",
	"cache_write_1h_tokens",
];

const SESSION_COLUMNS = [
	"source",
	"session_key",
	"account_id",
	"at",
	"seq",
	"family",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cache_write_5m_tokens",
	"cache_write_1h_tokens",
];

describe("usage-detail schema (SQLite)", () => {
	it("creates both tables, their keys and the session index on a fresh database", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		expect(columns(db, "forecast_usage_tokens")).toEqual(TOKEN_COLUMNS);
		expect(primaryKey(db, "forecast_usage_tokens")).toEqual([
			"bucket_start",
			"account_id",
			"source",
			"family",
		]);
		expect(columns(db, "forecast_session_requests")).toEqual(SESSION_COLUMNS);
		expect(primaryKey(db, "forecast_session_requests")).toEqual([
			"source",
			"session_key",
			"at",
			"seq",
		]);
		const index = db
			.prepare(
				"SELECT name FROM pragma_index_list('forecast_session_requests') WHERE origin = 'c'",
			)
			.all() as Array<{ name: string }>;
		expect(index).toHaveLength(1);
		const indexed = (
			db.prepare(`PRAGMA index_info(${index[0]?.name})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name);
		expect(indexed).toEqual(["source", "at"]);
		expect(columns(db, "requests")).toContain("cache_creation_5m_input_tokens");
		expect(columns(db, "requests")).toContain("cache_creation_1h_input_tokens");
		db.close();
	});

	it("upgrades a database without the tables and columns and keeps its demand rows", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run("DROP TABLE forecast_usage_tokens");
		db.run("DROP TABLE forecast_session_requests");
		db.run("ALTER TABLE requests DROP COLUMN cache_creation_5m_input_tokens");
		db.run("ALTER TABLE requests DROP COLUMN cache_creation_1h_input_tokens");
		const demand = new ForecastDemandRepository(new BunSqlAdapter(db));
		const rows = [
			{
				bucketStart: B,
				accountId: "a",
				source: "proxy",
				units: 0.125,
				fableUnits: 0.0625,
				requestCount: 3,
			},
			{
				bucketStart: 2 * B,
				accountId: "",
				source: "transcript",
				units: 1.5,
				fableUnits: 0,
				requestCount: 7,
			},
		];
		await demand.upsert(rows);
		const before = db
			.prepare("SELECT * FROM forecast_demand ORDER BY bucket_start")
			.all();

		runMigrations(db);
		runMigrations(db);

		expect(columns(db, "forecast_usage_tokens")).toEqual(TOKEN_COLUMNS);
		expect(columns(db, "forecast_session_requests")).toEqual(SESSION_COLUMNS);
		expect(columns(db, "requests")).toContain("cache_creation_5m_input_tokens");
		expect(columns(db, "requests")).toContain("cache_creation_1h_input_tokens");
		expect(
			db.prepare("SELECT * FROM forecast_demand ORDER BY bucket_start").all(),
		).toEqual(before);
		db.close();
	});
});

describe("UsageDetailRepository", () => {
	let db: Database;
	let repo: UsageDetailRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new UsageDetailRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("upserts token rows by (bucket, account, source, family) and reads [from, to) of one source", async () => {
		await repo.upsertTokens([
			tokens(B, "a", "proxy", "opus", 1),
			tokens(B, "a", "proxy", "fable", 2),
			tokens(B, "", "transcript", "opus", 3),
			tokens(3 * B, "a", "proxy", "opus", 4),
		]);
		await repo.upsertTokens([tokens(B, "a", "proxy", "opus", 5)]);

		expect(await repo.getTokens("proxy", 0, 3 * B)).toEqual([
			tokens(B, "a", "proxy", "fable", 2),
			tokens(B, "a", "proxy", "opus", 5),
		]);
		expect(await repo.getTokens("transcript", 0, 10 * B)).toEqual([
			tokens(B, "", "transcript", "opus", 3),
		]);
	});

	it("replaceTokens swaps only one source's rows inside [from, to)", async () => {
		await repo.upsertTokens([
			tokens(B, "a", "proxy", "opus"),
			tokens(2 * B, "a", "proxy", "opus"),
			tokens(2 * B, "", "transcript", "opus"),
			tokens(4 * B, "a", "proxy", "opus"),
		]);

		await repo.replaceTokens("proxy", 2 * B, 4 * B, [
			tokens(3 * B, "b", "proxy", "haiku", 2),
		]);

		expect(await repo.getTokens("proxy", 0, 10 * B)).toEqual([
			tokens(B, "a", "proxy", "opus"),
			tokens(3 * B, "b", "proxy", "haiku", 2),
			tokens(4 * B, "a", "proxy", "opus"),
		]);
		expect(await repo.getTokens("transcript", 0, 10 * B)).toEqual([
			tokens(2 * B, "", "transcript", "opus"),
		]);
	});

	it("upserts session rows by (source, key, at, seq), keeps a null split, and reads [from, to) by key then time", async () => {
		await repo.upsertSessionRequests([
			session("proxy", "k2", 500),
			session("proxy", "k1", 1000, 1, [null, null]),
			session("proxy", "k1", 1000, 0),
			session("proxy", "k1", 100),
			session("transcript", "k1", 600),
		]);
		await repo.upsertSessionRequests([session("proxy", "k2", 500, 0, [7, 0])]);

		expect(await repo.getSessionRequests("proxy", 200, 2000)).toEqual([
			session("proxy", "k1", 1000, 0),
			session("proxy", "k1", 1000, 1, [null, null]),
			session("proxy", "k2", 500, 0, [7, 0]),
		]);
		expect(await repo.getSessionRequests("proxy", 0, 1000)).toEqual([
			session("proxy", "k1", 100),
			session("proxy", "k2", 500, 0, [7, 0]),
		]);
	});

	it("replaceSessionRequests swaps one source's rows inside [from, to)", async () => {
		await repo.upsertSessionRequests([
			session("proxy", "k1", 100),
			session("proxy", "k1", 1000),
			session("proxy", "k1", 2000),
			session("transcript", "k1", 1000),
		]);

		await repo.replaceSessionRequests("proxy", 1000, 2000, [
			session("proxy", "k3", 1500),
		]);

		expect(await repo.getSessionRequests("proxy", 0, 10_000)).toEqual([
			session("proxy", "k1", 100),
			session("proxy", "k1", 2000),
			session("proxy", "k3", 1500),
		]);
		expect(await repo.getSessionRequests("transcript", 0, 10_000)).toEqual([
			session("transcript", "k1", 1000),
		]);
	});

	it("replaceSessionRequests rolls back its delete when an insert fails", async () => {
		await repo.upsertSessionRequests([session("proxy", "k1", 1000)]);
		const broken = {
			...session("proxy", "k2", 1200),
			inputTokens: null as unknown as number,
		};

		await expect(
			repo.replaceSessionRequests("proxy", 0, 10_000, [broken]),
		).rejects.toThrow();

		expect(await repo.getSessionRequests("proxy", 0, 10_000)).toEqual([
			session("proxy", "k1", 1000),
		]);
	});

	it("prune deletes token and session rows before the cutoff, nothing else", async () => {
		const demand = new ForecastDemandRepository(new BunSqlAdapter(db));
		await demand.upsert([
			{
				bucketStart: B,
				accountId: "a",
				source: "proxy",
				units: 1,
				fableUnits: 0,
				requestCount: 1,
			},
		]);
		await repo.upsertTokens([
			tokens(B, "a", "proxy", "opus"),
			tokens(2 * B, "", "transcript", "opus"),
			tokens(3 * B, "a", "proxy", "opus"),
		]);
		await repo.upsertSessionRequests([
			session("proxy", "k1", 2 * B - 1),
			session("transcript", "k1", 2 * B),
			session("proxy", "k2", 2 * B + 1),
		]);

		await repo.prune(2 * B);

		expect(await repo.getTokens("proxy", 0, 10 * B)).toEqual([
			tokens(3 * B, "a", "proxy", "opus"),
		]);
		expect(await repo.getTokens("transcript", 0, 10 * B)).toEqual([
			tokens(2 * B, "", "transcript", "opus"),
		]);
		expect(await repo.getSessionRequests("proxy", 0, 10 * B)).toEqual([
			session("proxy", "k2", 2 * B + 1),
		]);
		expect(await repo.getSessionRequests("transcript", 0, 10 * B)).toHaveLength(
			1,
		);
		expect(await demand.byAccount("proxy", 0, 10 * B)).toHaveLength(1);
	});

	it("PostgreSQL: every statement of a replace runs on the transaction", async () => {
		const onTx: Array<{ sql: string; values: unknown[] }> = [];
		const outside: string[] = [];
		const tx = {
			unsafe: async (sql: string, values: unknown[]) => {
				onTx.push({ sql, values });
				return [];
			},
		};
		const adapter = {
			isSQLite: false,
			getSQL: () => ({
				begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
			}),
			run: async (sql: string) => {
				outside.push(sql);
			},
			unsafe: async (sql: string) => {
				outside.push(sql);
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: fake adapter for testing
		const pg = new UsageDetailRepository(adapter as any);

		await pg.replaceTokens("proxy", 0, 10 * B, [
			tokens(B, "a", "proxy", "opus"),
		]);
		await pg.replaceSessionRequests("proxy", 5, 9, [session("proxy", "k", 5)]);

		expect(outside).toEqual([]);
		expect(onTx).toHaveLength(4);
		expect(onTx[0]?.sql).toContain(
			"DELETE FROM forecast_usage_tokens WHERE source = $1 AND bucket_start >= $2 AND bucket_start < $3",
		);
		expect(onTx[1]?.sql).toContain("INSERT INTO forecast_usage_tokens");
		expect(onTx[2]?.sql).toContain(
			"DELETE FROM forecast_session_requests WHERE source = $1 AND at >= $2 AND at < $3",
		);
		expect(onTx[3]?.sql).toContain("INSERT INTO forecast_session_requests");
	});
});

describe("claudeOAuthUsage session and split fields", () => {
	it("returns the client session id and the nullable cache write split", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES ('a', 'a', 'anthropic', 'r', 'x', 0)`,
		);
		const requests = new RequestRepository(new BunSqlAdapter(db));
		const base = {
			method: "POST",
			path: "/v1/messages",
			accountUsed: "a",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1,
			failoverAttempts: 0,
		};
		await requests.save({
			...base,
			id: "r1",
			timestamp: 1000,
			clientSessionId: "session-1",
			usage: {
				model: "claude-opus-4-1",
				inputTokens: 1,
				outputTokens: 2,
				cacheReadInputTokens: 3,
				cacheCreationInputTokens: 700,
				cacheCreation5mInputTokens: 300,
				cacheCreation1hInputTokens: 0,
			},
		});
		await requests.save({
			...base,
			id: "r2",
			timestamp: 2000,
			usage: { model: "claude-opus-4-1", inputTokens: 5 },
		});

		const repo = new ForecastDemandRepository(new BunSqlAdapter(db));
		expect(await repo.claudeOAuthUsage(0, 10_000)).toEqual([
			{
				timestamp: 1000,
				accountId: "a",
				model: "claude-opus-4-1",
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 700,
				clientSessionId: "session-1",
				cacheWrite5mTokens: 300,
				cacheWrite1hTokens: 0,
			},
			{
				timestamp: 2000,
				accountId: "a",
				model: "claude-opus-4-1",
				inputTokens: 5,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				clientSessionId: null,
				cacheWrite5mTokens: null,
				cacheWrite1hTokens: null,
			},
		]);
		db.close();
	});

	it("a re-save without the split keeps the split first recorded", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const requests = new RequestRepository(new BunSqlAdapter(db));
		const base = {
			id: "r1",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1,
			failoverAttempts: 0,
		};
		await requests.save({
			...base,
			usage: {
				model: "m",
				cacheCreationInputTokens: 9,
				cacheCreation5mInputTokens: 4,
				cacheCreation1hInputTokens: 5,
			},
		});
		await requests.save({ ...base, success: false, errorMessage: "late" });

		expect(
			db
				.prepare(
					"SELECT cache_creation_5m_input_tokens AS m5, cache_creation_1h_input_tokens AS h1 FROM requests WHERE id = 'r1'",
				)
				.get(),
		).toEqual({ m5: 4, h1: 5 });
		db.close();
	});
});
