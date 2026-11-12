import { describe, expect, test } from "bun:test";
import { addLocalDays, localDayStart, localParts } from "../../time";
import type {
	DemandBucket,
	EpochMs,
	ForecastInput,
	ForecastSettings,
	PaceContext,
} from "../../types";
import { BUCKET_MS } from "../../types";
import {
	buildDayTable,
	dayTypeOf,
	historyAvailable,
	MIN_POOL_DAYS,
	poolFor,
	WORK_START_RECENT_DAYS,
	workStartMinute,
} from "../days";
import type { DayTable, DayType, RecordedDay } from "../model";

const TZ = "Europe/Prague";
const PACE: PaceContext = {
	timeZone: TZ,
	workDays: 5,
	fiveHourGuardPct: 90,
	idleMs: 0,
};
// Thursday 2026-11-12 10:00 CET
const NOW = Date.UTC(2026, 10, 12, 9, 0);

function settings(over: Partial<ForecastSettings> = {}): ForecastSettings {
	return {
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 1,
		simulatedDays: 400,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: [],
		minStopPoints: 1,
		moveMinGainPoints: 1,
		openMinGainPoints: 1,
		historyHalfLifeDays: 14,
		historyLookbackDays: 28,
		recentTauMin: 60,
		sessionTurnoverMin: 60,
		...over,
	};
}

/** One bucket every BUCKET_MS in [from, to) where `f` gives demand. */
function history(
	from: EpochMs,
	to: EpochMs,
	f: (t: EpochMs) => number,
): DemandBucket[] {
	const out: DemandBucket[] = [];
	for (let t = from; t < to; t += BUCKET_MS) {
		const units = f(t);
		if (units > 0)
			out.push({ start: t, units, fableUnits: units / 4, requests: 1 });
	}
	return out;
}

function input(over: Partial<ForecastInput>): ForecastInput {
	return {
		now: NOW,
		settings: settings(),
		pace: PACE,
		accounts: [],
		history: [],
		historyFrom: 0,
		accountHistory: [],
		readings: [],
		sessions: [],
		...over,
	};
}

function day(key: string, type: DayType, start = 0): RecordedDay {
	return {
		key,
		start,
		type,
		weight: 1,
		units: new Float64Array(288),
		fable: new Float64Array(288),
		total: 0,
		fableTotal: 0,
	};
}

function table(types: DayType[], todayType: DayType): DayTable {
	return {
		days: types.map((t, i) => day(`d${i}`, t)),
		today: {
			key: "today",
			start: 0,
			type: todayType,
			unitsSoFar: 0,
			recentRate: 0,
			recentFableRate: 0,
		},
	};
}

describe("dayTypeOf", () => {
	test("monday, workday, weekend by ISO weekday and workDays", () => {
		const mon = localDayStart(Date.UTC(2026, 10, 9, 12), TZ);
		const thu = localDayStart(NOW, TZ);
		const fri = addLocalDays(thu, 1, TZ);
		const sat = addLocalDays(thu, 2, TZ);
		expect(dayTypeOf(mon, PACE)).toBe("monday");
		expect(dayTypeOf(thu, PACE)).toBe("workday");
		expect(dayTypeOf(fri, PACE)).toBe("workday");
		expect(dayTypeOf(sat, PACE)).toBe("weekend");
		expect(dayTypeOf(fri, { ...PACE, workDays: 4 })).toBe("weekend");
	});
});

describe("buildDayTable", () => {
	const todayStart = localDayStart(NOW, TZ);
	const from = addLocalDays(todayStart, -40, TZ);
	const flat = history(from, NOW, () => 0.01);

	test("only complete days inside the lookback, ascending, with recency weights", () => {
		const t = buildDayTable(
			input({
				history: flat,
				historyFrom: from,
				settings: settings({ historyLookbackDays: 7 }),
			}),
		);
		expect(t.days.map((d) => d.key)).toEqual([
			"2026-11-05",
			"2026-11-06",
			"2026-11-07",
			"2026-11-08",
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
		]);
		const yesterday = t.days[6] as RecordedDay;
		expect(yesterday.weight).toBeCloseTo(0.5 ** (1 / 14), 12);
		expect((t.days[0] as RecordedDay).weight).toBeCloseTo(0.5 ** (7 / 14), 12);
		expect(yesterday.units.length).toBe(288);
		expect(yesterday.total).toBeCloseTo(2.88, 9);
		expect(yesterday.fableTotal).toBeCloseTo(0.72, 9);
		expect(yesterday.type).toBe("workday");
		expect(t.days[4]?.type).toBe("monday");
		expect(t.days[2]?.type).toBe("weekend");
	});

	test("a day that starts before historyFrom is incomplete and left out", () => {
		const historyFrom = addLocalDays(todayStart, -5, TZ) + 12 * 3_600_000;
		const t = buildDayTable(
			input({
				history: flat.filter((b) => b.start >= historyFrom),
				historyFrom,
			}),
		);
		expect(t.days.map((d) => d.key)).toEqual([
			"2026-11-08",
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
		]);
	});

	test("missing buckets are zero; today is not in the table but feeds unitsSoFar and the recent rate", () => {
		const yStart = addLocalDays(todayStart, -1, TZ);
		const gap = yStart + 100 * BUCKET_MS;
		const h = history(from, NOW, (t) => {
			if (t === gap) return 0;
			if (t >= todayStart && t < NOW - 3_600_000) return 0.02;
			if (t >= NOW - 3_600_000) return 0.06;
			return 0.01;
		});
		const t = buildDayTable(input({ history: h, historyFrom: from }));
		const y = t.days[t.days.length - 1] as RecordedDay;
		expect(y.key).toBe("2026-11-11");
		expect(y.units[100]).toBe(0);
		expect(y.units[99]).toBeCloseTo(0.01, 12);
		expect(t.today.key).toBe("2026-11-12");
		expect(t.today.type).toBe("workday");
		expect(t.today.start).toBe(todayStart);
		// 09:00 local of 10:00 → 108 buckets at 0.02, then 12 at 0.06
		expect(t.today.unitsSoFar).toBeCloseTo(108 * 0.02 + 12 * 0.06, 9);
		expect(t.today.recentRate).toBeCloseTo(0.06, 12);
		expect(t.today.recentFableRate).toBeCloseTo(0.015, 12);
	});

	test("DST: the 25-hour day of 2026-10-25 in Europe/Prague has 300 buckets and keeps every unit", () => {
		const now = Date.UTC(2026, 9, 27, 9, 0);
		const start = localDayStart(Date.UTC(2026, 9, 20, 12), TZ);
		const h = history(start, now, () => 0.01);
		const t = buildDayTable(input({ now, history: h, historyFrom: start }));
		const byKey = new Map(t.days.map((d) => [d.key, d]));
		const dst = byKey.get("2026-10-25") as RecordedDay;
		expect(dst.units.length).toBe(300);
		expect(dst.total).toBeCloseTo(3.0, 9);
		expect(byKey.get("2026-10-24")?.units.length).toBe(288);
		expect(byKey.get("2026-10-26")?.units.length).toBe(288);
		expect(byKey.get("2026-10-26")?.total).toBeCloseTo(2.88, 9);
		expect(t.days.map((d) => d.key)).toEqual([
			"2026-10-20",
			"2026-10-21",
			"2026-10-22",
			"2026-10-23",
			"2026-10-24",
			"2026-10-25",
			"2026-10-26",
		]);
		expect(dst.weight).toBeCloseTo(0.5 ** (2 / 14), 12);
	});
});

describe("poolFor", () => {
	test("a type with at least 3 days pools alone", () => {
		const t = table(
			["monday", "monday", "monday", "workday", "workday"],
			"monday",
		);
		expect(MIN_POOL_DAYS).toBe(3);
		expect(poolFor(t, "monday").length).toBe(3);
		expect(poolFor(t, "workday").length).toBe(5);
	});

	test("fewer than 3: monday and workday pool together; weekend stays alone", () => {
		const t = table(
			["monday", "monday", "workday", "workday", "workday", "weekend"],
			"monday",
		);
		expect(poolFor(t, "monday").map((d) => d.type)).toEqual([
			"monday",
			"monday",
			"workday",
			"workday",
			"workday",
		]);
		expect(poolFor(t, "workday").length).toBe(3);
		expect(poolFor(t, "weekend").length).toBe(1);
	});
});

describe("historyAvailable", () => {
	test("fewer than 5 recorded days: no", () => {
		expect(
			historyAvailable(
				table(["workday", "workday", "workday", "workday"], "workday"),
			),
		).toBe(false);
	});
	test("today's pool below 3 after pooling: no", () => {
		expect(
			historyAvailable(
				table(
					[
						"monday",
						"workday",
						"workday",
						"workday",
						"workday",
						"weekend",
						"weekend",
					],
					"weekend",
				),
			),
		).toBe(false);
	});
	test("monday with 1 monday but enough workdays: yes", () => {
		expect(
			historyAvailable(
				table(["monday", "workday", "workday", "workday", "workday"], "monday"),
			),
		).toBe(true);
	});
});

describe("workStartMinute", () => {
	test("median first minute with demand over recent recorded work days", () => {
		const todayStart = localDayStart(NOW, TZ);
		const from = addLocalDays(todayStart, -7, TZ);
		// Thu 5 08:00, Fri 6 09:00, Sat/Sun 06:00 (weekend, ignored), Mon 9 none, Tue 10 10:00, Wed 11 09:30
		const startHour: Record<string, number | null> = {
			"2026-11-05": 8,
			"2026-11-06": 9,
			"2026-11-07": 6,
			"2026-11-08": 6,
			"2026-11-09": null,
			"2026-11-10": 10,
			"2026-11-11": 9.5,
		};
		const h = history(from, todayStart, (t) => {
			const p = localParts(t, TZ);
			const key = `2026-11-${String(p.day).padStart(2, "0")}`;
			const s = startHour[key];
			return s != null && p.minuteOfDay >= s * 60 && p.minuteOfDay < 18 * 60
				? 0.01
				: 0;
		});
		const t = buildDayTable(input({ history: h, historyFrom: from }));
		expect(WORK_START_RECENT_DAYS).toBeGreaterThanOrEqual(4);
		// work days with demand: 480, 540, 600, 570 → median 555
		expect(workStartMinute(t, TZ)).toBe(555);
	});

	test("a DST work day counts by its local clock (2026-10-25, 25 hours, workDays 7)", () => {
		const now = Date.UTC(2026, 9, 26, 9, 0);
		const from = localDayStart(Date.UTC(2026, 9, 25, 12), TZ);
		const h = history(from, localDayStart(now, TZ), (t) =>
			localParts(t, TZ).minuteOfDay >= 9 * 60 ? 0.01 : 0,
		);
		const t = buildDayTable(
			input({
				now,
				history: h,
				historyFrom: from,
				pace: { ...PACE, workDays: 7 },
			}),
		);
		expect(t.days.map((d) => [d.key, d.units.length, d.type])).toEqual([
			["2026-10-25", 300, "workday"],
		]);
		expect(workStartMinute(t, TZ)).toBe(540);
	});

	test("null without recorded work days with demand", () => {
		expect(
			workStartMinute(table(["weekend", "workday"], "workday"), TZ),
		).toBeNull();
	});
});
