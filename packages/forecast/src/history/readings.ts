import type { EpochMs, LimitReading, LimitWindow } from "../types";
import type { HistoryDeps } from "./ports";

const LIMIT_WINDOWS: readonly LimitWindow[] = [
	"five_hour",
	"seven_day",
	"seven_day_fable",
];

/** Recorded usage readings of the three limit windows in [from, to), ascending. */
export async function loadReadings(
	{ db }: HistoryDeps,
	from: EpochMs,
	to: EpochMs,
): Promise<LimitReading[]> {
	const rows = await db.getUsageSnapshotsBetween(from, to, LIMIT_WINDOWS);
	return rows.map((row) => ({
		accountId: row.accountId,
		at: row.timestamp,
		window: row.windowKey as LimitWindow,
		usedPct: row.utilization,
		resetsAt: row.resetsAt,
	}));
}
