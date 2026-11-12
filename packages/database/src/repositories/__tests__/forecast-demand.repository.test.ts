import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ForecastDemandRepository } from "../forecast-demand.repository";

const B = 300_000;

function row(
	bucketStart: number,
	accountId: string,
	source: string,
	units: number,
	fableUnits = 0,
	requestCount = 1,
) {
	return { bucketStart, accountId, source, units, fableUnits, requestCount };
}

describe("ForecastDemandRepository", () => {
	let db: Database;
	let repo: ForecastDemandRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new ForecastDemandRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("upsert replaces a row by (bucket_start, account_id, source)", async () => {
		await repo.upsert([row(B, "a", "proxy", 1, 0.5, 2)]);
		await repo.upsert([row(B, "a", "proxy", 3, 1, 4)]);
		await repo.upsert([row(B, "a", "transcript", 7)]);

		expect(await repo.byAccount("proxy", 0, 10 * B)).toEqual([
			row(B, "a", "proxy", 3, 1, 4),
		]);
	});

	it("pooled sums accounts and sources in [from, to), ascending, without empty buckets", async () => {
		await repo.upsert([
			row(3 * B, "a", "proxy", 1, 0.25, 1),
			row(3 * B, "b", "proxy", 2, 0, 3),
			row(B, "", "transcript", 4, 1, 2),
			row(2 * B, "a", "proxy", 0, 0, 0),
			row(5 * B, "a", "proxy", 9),
		]);

		expect(await repo.pooled(B, 5 * B)).toEqual([
			{ bucketStart: B, units: 4, fableUnits: 1, requestCount: 2 },
			{ bucketStart: 3 * B, units: 3, fableUnits: 0.25, requestCount: 4 },
		]);
	});

	it("byAccount returns only the given source, ascending by bucket then account", async () => {
		await repo.upsert([
			row(2 * B, "b", "proxy", 2),
			row(2 * B, "a", "proxy", 1),
			row(B, "a", "proxy", 5),
			row(B, "", "transcript", 4),
		]);

		expect(await repo.byAccount("proxy", 0, 3 * B)).toEqual([
			row(B, "a", "proxy", 5),
			row(2 * B, "a", "proxy", 1),
			row(2 * B, "b", "proxy", 2),
		]);
	});

	it("replace drops the source's rows in [from, to) before writing", async () => {
		await repo.upsert([
			row(B, "a", "proxy", 1),
			row(2 * B, "a", "proxy", 1),
			row(2 * B, "gone", "proxy", 1),
			row(2 * B, "", "transcript", 1),
			row(3 * B, "a", "proxy", 1),
		]);

		await repo.replace("proxy", 2 * B, 3 * B, [row(2 * B, "a", "proxy", 6)]);

		expect(await repo.byAccount("proxy", 0, 10 * B)).toEqual([
			row(B, "a", "proxy", 1),
			row(2 * B, "a", "proxy", 6),
			row(3 * B, "a", "proxy", 1),
		]);
		expect(await repo.pooled(2 * B, 3 * B)).toEqual([
			{ bucketStart: 2 * B, units: 7, fableUnits: 0, requestCount: 2 },
		]);
	});

	it("earliest covers all rows or one source, null when empty", async () => {
		expect(await repo.earliest()).toBeNull();
		expect(await repo.earliest("proxy")).toBeNull();

		await repo.upsert([
			row(4 * B, "a", "proxy", 1),
			row(2 * B, "", "transcript", 1),
		]);

		expect(await repo.earliest()).toBe(2 * B);
		expect(await repo.earliest("proxy")).toBe(4 * B);
	});

	it("stores and replaces meta values", async () => {
		expect(await repo.getMeta("k")).toBeNull();
		await repo.setMeta("k", "1");
		await repo.setMeta("k", "2");
		expect(await repo.getMeta("k")).toBe("2");
	});

	it("lists usage of requests served by Claude OAuth accounts only", async () => {
		const insertAccount = db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, api_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`,
		);
		insertAccount.run("oauth", "oauth", "anthropic", "r1", "t1", null);
		insertAccount.run("oauth-null-provider", "np", null, "r2", "t2", null);
		insertAccount.run(
			"console",
			"console",
			"claude-console-api",
			null,
			null,
			"k",
		);
		insertAccount.run("same-token", "zai-like", "anthropic", "x", "x", null);
		insertAccount.run("no-refresh", "nr", "anthropic", null, "t3", null);
		insertAccount.run("zai", "zai", "zai", "k", "k", null);

		const insertRequest = db.prepare(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model,
			   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?)`,
		);
		insertRequest.run("r1", 1000, "oauth", "claude-opus", 1, 2, 3, 4);
		insertRequest.run(
			"r2",
			2000,
			"oauth-null-provider",
			null,
			null,
			5,
			null,
			null,
		);
		insertRequest.run("r3", 1500, "console", "claude-opus", 1, 1, 1, 1);
		insertRequest.run("r4", 1500, "same-token", "claude-opus", 1, 1, 1, 1);
		insertRequest.run("r5", 1500, "no-refresh", "claude-opus", 1, 1, 1, 1);
		insertRequest.run("r6", 1500, "zai", "glm", 1, 1, 1, 1);
		insertRequest.run(
			"r7",
			1500,
			"oauth",
			"claude-opus",
			null,
			null,
			null,
			null,
		);
		insertRequest.run("r8", 1500, "oauth", "claude-opus", 0, 0, 0, 0);
		insertRequest.run("r9", 1500, "deleted", "claude-opus", 1, 1, 1, 1);
		insertRequest.run("r10", 1500, null, "claude-opus", 1, 1, 1, 1);
		insertRequest.run("r11", 3000, "oauth", "claude-opus", 1, 1, 1, 1);

		expect(await repo.claudeOAuthUsage(0, 3000)).toEqual([
			{
				timestamp: 1000,
				accountId: "oauth",
				model: "claude-opus",
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
			},
			{
				timestamp: 2000,
				accountId: "oauth-null-provider",
				model: null,
				inputTokens: 0,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		]);
	});
});

describe("forecast tables in SQLite migrations", () => {
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

	it("creates both tables on a fresh database", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		expect(columns(db, "forecast_demand")).toEqual([
			"bucket_start",
			"account_id",
			"source",
			"units",
			"fable_units",
			"request_count",
		]);
		expect(primaryKey(db, "forecast_demand")).toEqual([
			"bucket_start",
			"account_id",
			"source",
		]);
		expect(columns(db, "forecast_meta")).toEqual(["key", "value"]);
		db.close();
	});

	it("adds both tables to an upgraded database and stays idempotent", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run("DROP TABLE forecast_demand");
		db.run("DROP TABLE forecast_meta");

		runMigrations(db);
		runMigrations(db);

		expect(columns(db, "forecast_demand")).toContain("request_count");
		expect(columns(db, "forecast_meta")).toEqual(["key", "value"]);
		db.close();
	});

	it("keeps rows across a rerun of migrations", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const repo = new ForecastDemandRepository(new BunSqlAdapter(db));
		await repo.upsert([row(B, "a", "proxy", 1)]);
		await repo.setMeta("m", "v");

		runMigrations(db);

		expect(await repo.byAccount("proxy", 0, 2 * B)).toEqual([
			row(B, "a", "proxy", 1),
		]);
		expect(await repo.getMeta("m")).toBe("v");
		db.close();
	});
});
