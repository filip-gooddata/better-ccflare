import type {
	AccountDemandBucket,
	DemandBucket,
	DemandStore,
	EpochMs,
	StoredDemandRow,
} from "../types";
import type { HistoryDeps } from "./ports";

/** DemandStore on the forecast_demand and forecast_meta tables. */
export function createDemandStore({ db }: HistoryDeps): DemandStore {
	return {
		async upsert(rows: StoredDemandRow[]): Promise<void> {
			await db.upsertForecastDemand(
				rows.map((row) => ({
					bucketStart: row.start,
					accountId: row.accountId,
					source: row.source,
					units: row.units,
					fableUnits: row.fableUnits,
					requestCount: row.requests,
				})),
			);
		},

		async loadPooled(from: EpochMs, to: EpochMs): Promise<DemandBucket[]> {
			const rows = await db.getForecastDemandPooled(from, to);
			return rows.map((row) => ({
				start: row.bucketStart,
				units: row.units,
				fableUnits: row.fableUnits,
				requests: row.requestCount,
			}));
		},

		async loadByAccount(
			from: EpochMs,
			to: EpochMs,
		): Promise<AccountDemandBucket[]> {
			const rows = await db.getForecastDemandByAccount("proxy", from, to);
			return rows.map((row) => ({
				start: row.bucketStart,
				accountId: row.accountId,
				units: row.units,
				fableUnits: row.fableUnits,
				requests: row.requestCount,
			}));
		},

		earliest: () => db.getEarliestForecastDemand(),
		getMeta: (key: string) => db.getForecastMeta(key),
		setMeta: (key: string, value: string) => db.setForecastMeta(key, value),
	};
}
