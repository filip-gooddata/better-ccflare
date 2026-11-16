import {
	type BunSqlAdapter,
	convertPlaceholders,
} from "../adapters/bun-sql-adapter";

export type Statement = [sql: string, values: unknown[]];

/**
 * Run the statements in one transaction. BunSqlAdapter.transaction does not
 * bind statements to the transaction, so each dialect's own API is used.
 */
export async function writeAtomically(
	adapter: BunSqlAdapter,
	statements: Statement[],
): Promise<void> {
	if (adapter.isSQLite) {
		const db = adapter.getSQLiteDb();
		db.transaction(() => {
			for (const [sql, values] of statements) {
				db.prepare(sql).run(...(values as [number]));
			}
		})();
		return;
	}
	await adapter.getSQL().begin(async (tx) => {
		for (const [sql, values] of statements) {
			// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
			await tx.unsafe(convertPlaceholders(sql), values as any[]);
		}
	});
}
