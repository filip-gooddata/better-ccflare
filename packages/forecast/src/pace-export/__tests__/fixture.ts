import { PRESENT_PARTITION } from "../../engine/learn";
import type { Partition, RowChoice } from "../../engine/learn/types";
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

export const MON_FRI: Partition = [0, 0, 0, 0, 0, 1, 1];

/** A stored row-1 choice that switched on, as forecast-jobs.test.ts stores one. */
export const ON_CHOICE: RowChoice<Partition> = {
	row: "daytypes",
	m: 3,
	floor: 4,
	units: 6,
	present: PRESENT_PARTITION,
	chosen: MON_FRI,
	runnerUp: PRESENT_PARTITION,
	served: MON_FRI,
	presentLoss: 2,
	chosenLoss: 1,
	gain: 1,
	se: 0.25,
	p: 0.01,
	runnerUpLoss: 2,
	on: true,
	reason: "on",
};

/** A stored row-1 choice with nothing scored: NaN losses, as selectRow returns it. */
export const NO_UNITS_CHOICE: RowChoice<Partition> = {
	row: "daytypes",
	m: 3,
	floor: 4,
	units: 0,
	present: PRESENT_PARTITION,
	chosen: PRESENT_PARTITION,
	runnerUp: null,
	served: PRESENT_PARTITION,
	presentLoss: Number.NaN,
	chosenLoss: Number.NaN,
	gain: 0,
	se: 0,
	p: 1,
	runnerUpLoss: Number.NaN,
	on: false,
	reason: "no-units",
};

export function exportInput(
	days = 21,
	rowOne: PaceExportInput["rowOne"] = { choice: ON_CHOICE, pending: null },
): PaceExportInput {
	const { series, historyFrom } = synthetic(days);
	return {
		series,
		now: T0,
		historyFrom,
		accountCount: 2,
		settings: { ...SETTINGS },
		rowOne,
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
