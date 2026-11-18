import { buildPaceSeries } from "../../engine/pace";
import type { PaceSeries } from "../../engine/pace/types";
import type { RefitDemandSettings } from "../../service/pace-refit-runner";
import type { DemandBucket } from "../../types";
import type { PaceExportInput } from "../format";

export const T0 = Date.UTC(2026, 10, 16, 9, 0);
const BUCKET = 300_000;

export const SETTINGS: RefitDemandSettings = {
	workDays: 5,
	historyLookbackDays: 84,
	historyHalfLifeDays: 14,
	workStartSharePct: 5,
	timeShiftMin: 30,
};

/** Weekday office hours with deterministic noise, as forecast-jobs.test.ts builds it, plus some censored buckets. */
export function synthetic(days: number): {
	series: PaceSeries;
	historyFrom: number;
} {
	const n = (days * 24 * 60 * 60_000) / BUCKET;
	const historyFrom = T0 - n * BUCKET;
	const history: DemandBucket[] = Array.from({ length: n }, (_, i) => {
		const at = historyFrom + i * BUCKET;
		const hour = new Date(at).getUTCHours();
		const day = new Date(at).getUTCDay();
		const work = day >= 1 && day <= 5 && hour >= 7 && hour < 17;
		const units = work ? 1 + ((i * 7919) % 13) / 13 : ((i * 104729) % 5) / 50;
		return { start: at, units, fableUnits: 0, requests: units > 0 ? 1 : 0 };
	});
	const series = buildPaceSeries({
		history,
		historyFrom,
		now: T0,
		readings: [],
		accounts: ["a", "b"],
		timeZone: "Europe/Prague",
	});
	for (let i = 1000; i < 1040; i++) series.censored[i] = 1;
	return { series, historyFrom };
}

export function exportInput(days = 21): PaceExportInput {
	const { series, historyFrom } = synthetic(days);
	return {
		series,
		now: T0,
		historyFrom,
		accountCount: 2,
		settings: { ...SETTINGS },
		rowOne: { served: [0, 0, 0, 0, 0, 1, 1], pending: null },
	};
}

export function captureLogger() {
	const infos: string[] = [];
	const warns: string[] = [];
	return {
		infos,
		warns,
		logger: {
			info: (m: string) => {
				infos.push(m);
			},
			warn: (m: string) => {
				warns.push(m);
			},
		},
	};
}
