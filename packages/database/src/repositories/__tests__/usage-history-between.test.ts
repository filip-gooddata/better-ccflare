import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";

describe("UsageHistoryRepository.getSnapshotsBetween", () => {
	let db: Database;
	let repo: UsageHistoryRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		const insert = db.prepare(
			"INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at) VALUES (?, ?, ?, ?, ?)",
		);
		insert.run("b", 200, "five_hour", 40, 9000);
		insert.run("a", 200, "seven_day", 10.5, null);
		insert.run("a", 100, "five_hour", 12, 5000);
		insert.run("a", 150, "seven_day_opus", 3, null);
		insert.run("a", 300, "five_hour", 50, 5000);
		insert.run("a", 99, "five_hour", 11, 5000);
	});

	afterEach(() => {
		db.close();
	});

	it("returns the named windows of all accounts in [from, to), ascending", async () => {
		expect(
			await repo.getSnapshotsBetween(100, 300, ["five_hour", "seven_day"]),
		).toEqual([
			{
				accountId: "a",
				timestamp: 100,
				windowKey: "five_hour",
				utilization: 12,
				resetsAt: 5000,
			},
			{
				accountId: "a",
				timestamp: 200,
				windowKey: "seven_day",
				utilization: 10.5,
				resetsAt: null,
			},
			{
				accountId: "b",
				timestamp: 200,
				windowKey: "five_hour",
				utilization: 40,
				resetsAt: 9000,
			},
		]);
	});

	it("returns nothing for no windows", async () => {
		expect(await repo.getSnapshotsBetween(0, 1000, [])).toEqual([]);
	});
});
