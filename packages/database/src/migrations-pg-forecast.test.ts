/**
 * PostgreSQL forecast tables, without a PostgreSQL server: a fake adapter
 * records the SQL that ensureSchemaPg and runMigrationsPg send. Column parity
 * with SQLite is covered by migrations-pg.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
	createForecastTablesPg,
	ensureSchemaPg,
	runMigrationsPg,
} from "./migrations-pg";

const TABLES = [
	"forecast_demand",
	"forecast_meta",
	"forecast_usage_tokens",
	"forecast_session_requests",
];

function recordingAdapter({ columnsExist = true } = {}) {
	const statements: string[] = [];
	const adapter = {
		isSQLite: false,
		unsafe: async (sql: string) => {
			statements.push(sql);
			return [];
		},
		run: async (sql: string) => {
			statements.push(sql);
		},
		runWithChanges: async (sql: string) => {
			statements.push(sql);
			return 0;
		},
		get: async () => ({ exists: columnsExist ? 1 : 0, count: 0 }),
		query: async () => [],
		transaction: async <T>(fn: () => Promise<T>) => fn(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: fake adapter for testing
	return { adapter: adapter as any, statements };
}

function creates(statements: string[], table: string): string[] {
	return statements.filter((s) =>
		s.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
	);
}

describe("forecast tables in PostgreSQL migrations", () => {
	it("declares both tables with the bucket/account/source primary key", async () => {
		const { adapter, statements } = recordingAdapter();
		await createForecastTablesPg(adapter);

		const [demand] = creates(statements, "forecast_demand");
		expect(demand).toContain("bucket_start BIGINT NOT NULL");
		expect(demand).toContain("account_id TEXT NOT NULL DEFAULT ''");
		expect(demand).toContain("units DOUBLE PRECISION");
		expect(demand).toContain("fable_units DOUBLE PRECISION");
		expect(demand).toContain("request_count INTEGER");
		expect(demand).toContain("PRIMARY KEY (bucket_start, account_id, source)");
		const [meta] = creates(statements, "forecast_meta");
		expect(meta).toContain("key TEXT PRIMARY KEY");
		expect(meta).toContain("value TEXT NOT NULL");
	});

	it("declares the usage-detail tables, their keys and the session index", async () => {
		const { adapter, statements } = recordingAdapter();
		await createForecastTablesPg(adapter);

		const [usage] = creates(statements, "forecast_usage_tokens");
		expect(usage).toContain("bucket_start BIGINT NOT NULL");
		expect(usage).toContain("account_id TEXT NOT NULL DEFAULT ''");
		expect(usage).toContain("family TEXT NOT NULL");
		for (const column of [
			"request_count",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"cache_write_5m_tokens",
			"cache_write_1h_tokens",
		]) {
			expect(usage).toContain(`${column} BIGINT NOT NULL DEFAULT 0`);
		}
		expect(usage).toContain(
			"PRIMARY KEY (bucket_start, account_id, source, family)",
		);

		const [sessions] = creates(statements, "forecast_session_requests");
		expect(sessions).toContain("session_key TEXT NOT NULL");
		expect(sessions).toContain("at BIGINT NOT NULL");
		expect(sessions).toContain("seq INTEGER NOT NULL");
		expect(sessions).toContain("family TEXT NOT NULL");
		expect(sessions).toContain("cache_write_tokens BIGINT NOT NULL DEFAULT 0");
		expect(sessions).toContain("cache_write_5m_tokens BIGINT,");
		expect(sessions).toContain("cache_write_1h_tokens BIGINT,");
		expect(sessions).toContain("PRIMARY KEY (source, session_key, at, seq)");
		expect(
			statements.some((s) =>
				s.includes("ON forecast_session_requests (source, at)"),
			),
		).toBe(true);
	});

	it("creates the tables on a fresh install", async () => {
		const { adapter, statements } = recordingAdapter();
		await ensureSchemaPg(adapter);
		for (const table of TABLES) {
			expect(creates(statements, table)).toHaveLength(1);
		}
	});

	it("creates the tables when upgrading an older install", async () => {
		const { adapter, statements } = recordingAdapter();
		await runMigrationsPg(adapter);
		for (const table of TABLES) {
			expect(creates(statements, table)).toHaveLength(1);
		}
	});

	it("adds the nullable cache write split columns to requests on both paths", async () => {
		const fresh = recordingAdapter();
		await ensureSchemaPg(fresh.adapter);
		const [requests] = creates(fresh.statements, "requests");
		expect(requests).toContain("cache_creation_5m_input_tokens INTEGER,");
		expect(requests).toContain("cache_creation_1h_input_tokens INTEGER,");

		// The fake reports every column as missing, so each upgrade ALTER runs.
		const upgrade = recordingAdapter({ columnsExist: false });
		await runMigrationsPg(upgrade.adapter);
		for (const column of [
			"cache_creation_5m_input_tokens",
			"cache_creation_1h_input_tokens",
		]) {
			expect(
				upgrade.statements.some((s) =>
					s.includes(`ALTER TABLE requests ADD COLUMN ${column} INTEGER`),
				),
			).toBe(true);
		}
	});
});
