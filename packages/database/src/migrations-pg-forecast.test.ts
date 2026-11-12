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

function recordingAdapter() {
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
		get: async () => ({ exists: 1, count: 0 }),
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

	it("creates the tables on a fresh install", async () => {
		const { adapter, statements } = recordingAdapter();
		await ensureSchemaPg(adapter);
		expect(creates(statements, "forecast_demand")).toHaveLength(1);
		expect(creates(statements, "forecast_meta")).toHaveLength(1);
	});

	it("creates the tables when upgrading an older install", async () => {
		const { adapter, statements } = recordingAdapter();
		await runMigrationsPg(adapter);
		expect(creates(statements, "forecast_demand")).toHaveLength(1);
		expect(creates(statements, "forecast_meta")).toHaveLength(1);
	});
});
