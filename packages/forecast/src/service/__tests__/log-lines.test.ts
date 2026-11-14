/** The forecast-inputs log line (design amendment 4, D2): content, change rule, 10-minute bound. */
import { describe, expect, it } from "bun:test";
import specFull from "../../contract/__tests__/fixtures/spec-example-full.json";
import type {
	ForecastInputsDetail,
	ForecastResponse,
	ForecastResult,
	Plan,
} from "../../types";
import {
	createInputsLog,
	INPUTS_MIN_SPACING_MS,
	inputsLine,
} from "../log-lines";

const A = "28f69dec-2e46-4b18-9557-dcdc132fc385";
const B = "acct-b";
const MIN = 60_000;

function detail(
	over: Partial<ForecastInputsDetail> = {},
): ForecastInputsDetail {
	return {
		dayFactor: {
			a: 1.0791,
			raw: 4.6512,
			clamped: 4,
			weight: 0.02637,
			y: 107.25,
			m: 0.6731,
			c: 25.524,
		},
		recentRatePerHour: 12.346,
		pool: { name: "workday", days: 23, medianUnits: 98.04, p90Units: 151.96 },
		workStartMinute: 8 * 60 + 5,
		limits: [
			{
				accountId: A,
				limit: "five_hour",
				k: 1.98766,
				source: "own",
				instances: 6,
				points: 41,
				oldestHoursAgo: 312.46,
				newestHoursAgo: 0.25,
			},
			{
				accountId: A,
				limit: "seven_day",
				k: 0.1504,
				source: "own",
				instances: 3,
				points: 12.5,
				oldestHoursAgo: 160.04,
				newestHoursAgo: 1.5,
			},
			{
				accountId: A,
				limit: "seven_day_fable",
				k: null,
				source: "none",
				instances: 0,
				points: 0,
				oldestHoursAgo: null,
				newestHoursAgo: null,
			},
			{
				accountId: B,
				limit: "five_hour",
				k: 1.98766,
				source: "borrowed",
				instances: 0,
				points: 0,
				oldestHoursAgo: null,
				newestHoursAgo: null,
			},
		],
		caps: [
			{ accountId: A, ratio: 13.21609, binds: false },
			{ accountId: B, ratio: null, binds: false },
		],
		...over,
	};
}

function withA(a: number, k = 1.98766): ForecastInputsDetail {
	const d = detail();
	return {
		...d,
		dayFactor: { ...d.dayFactor, a },
		limits: d.limits.map((l, i) => (i === 0 ? { ...l, k } : l)),
	};
}

function available(inputs?: ForecastInputsDetail): ForecastResult {
	return {
		available: true,
		response: specFull as ForecastResponse,
		plan: {} as Plan,
		...(inputs ? { inputs } : {}),
	};
}

describe("forecast inputs line (amendment 4, D2)", () => {
	it("names the day factor, the recent rate, today's pool, the work start and every k", () => {
		expect(inputsLine(detail())).toBe(
			"forecast inputs dayFactor a=1.079 clamped=4.000 w=0.0264 raw=4.651 Y=107.25 M=0.67 c=25.52" +
				" recentRate=12.35/h pool=workday:23 median=98.0 p90=152.0 workStart=08:05" +
				` k: ${A}/five_hour=1.9877 own instances=6 points=41 oldestH=312.5 newestH=0.3;` +
				` ${A}/seven_day=0.1504 own instances=3 points=12.5 oldestH=160.0 newestH=1.5;` +
				` ${A}/seven_day_fable=none none instances=0 points=0 oldestH=none newestH=none;` +
				` ${B}/five_hour=1.9877 borrowed instances=0 points=0 oldestH=none newestH=none` +
				` cap: ${A} r=13.22 binds=no; ${B} r=none binds=no`,
		);
	});

	it("prints nothing but numbers, fixed words and account ids", () => {
		const d = detail({
			workStartMinute: null,
			pool: { name: "weekend", days: 4, medianUnits: null, p90Units: null },
			limits: [
				{
					accountId: "Filip's account /Users/x",
					limit: "five_hour",
					k: Number.NaN,
					source: "own",
					instances: 1,
					points: Number.POSITIVE_INFINITY,
					oldestHoursAgo: Number.NaN,
					newestHoursAgo: 2,
				},
			],
		});
		const line = inputsLine(d);
		expect(line).toContain(
			"pool=weekend:4 median=none p90=none workStart=none",
		);
		expect(line).toContain(
			"k: ?/five_hour=? own instances=1 points=? oldestH=? newestH=2.0",
		);
		expect(line).not.toContain("Filip");
		expect(line).not.toContain("/Users");
		// every token is a fixed word, a number, an id or "?"
		for (const token of line.split(/[\s;:=/]+/)) {
			expect(token).toMatch(
				/^([a-zA-Z_][a-zA-Z0-9_]*|[0-9a-f-]{36}|acct-b|-?[\d.]+|\?|\d\d|-?[\d.]+\/h)$/,
			);
		}
	});

	it("is written at the first available computation, then only when a (to 0.1) or a k (to 0.05) changes, at most once per 10 minutes", () => {
		const lines: string[] = [];
		const log = createInputsLog((m) => lines.push(m));
		let now = 1_000_000;
		// unavailable, or available without inputs: nothing
		log.record(
			{ ...available(), available: false, reason: "error", plan: null },
			now,
		);
		log.record(available(), now);
		expect(lines).toEqual([]);

		const first = now;
		log.record(available(withA(1.08)), now);
		expect(lines.length).toBe(1);
		// a crosses a 0.1 step, but within 10 minutes of the last line: held
		expect(INPUTS_MIN_SPACING_MS).toBe(10 * MIN);
		now = first + MIN;
		log.record(available(withA(1.3)), now);
		expect(lines.length).toBe(1);
		now = first + 9 * MIN;
		log.record(available(withA(1.5)), now);
		expect(lines.length).toBe(1);
		// 10 minutes over: the latest state is written
		now = first + 10 * MIN;
		log.record(available(withA(1.6)), now);
		expect(lines.length).toBe(2);
		expect(lines[1]).toContain("dayFactor a=1.600");
		// the same rounded state (a to 0.1, k to 0.05), long after: nothing
		now += 3 * INPUTS_MIN_SPACING_MS;
		log.record(available(withA(1.62, 1.999)), now);
		expect(lines.length).toBe(2);
		// a k moving by a 0.05 step: written
		now += MIN;
		log.record(available(withA(1.6, 2.05)), now);
		expect(lines.length).toBe(3);
		expect(lines[2]).toContain(`${A}/five_hour=2.0500 own`);
		// a change that is back to the last written state by the time 10 minutes are over: nothing
		now += MIN;
		log.record(available(withA(2.5, 2.05)), now);
		now += 10 * MIN;
		log.record(available(withA(1.6, 2.05)), now);
		expect(lines.length).toBe(3);
	});

	it("writes no new line when the same limits arrive in another order", () => {
		const lines: string[] = [];
		const log = createInputsLog((m) => lines.push(m));
		const first = 1_000_000;
		const d = detail();
		log.record(available(d), first);
		expect(lines.length).toBe(1);
		const reordered = { ...d, limits: [...d.limits].reverse() };
		log.record(available(reordered), first + MIN);
		log.record(available(reordered), first + 10 * MIN);
		log.record(available(reordered), first + 3 * INPUTS_MIN_SPACING_MS);
		expect(lines.length).toBe(1);
	});

	it("prints the weekly cap per account: r and whether it binds now", () => {
		const line = inputsLine(
			detail({
				caps: [
					{ accountId: A, ratio: 5.96508, binds: true },
					{ accountId: "Filip /Users/x", ratio: Number.NaN, binds: false },
				],
			}),
		);
		expect(line).toEndWith(` cap: ${A} r=5.97 binds=yes; ? r=? binds=no`);
	});

	it("writes no new line when only r, whether the cap binds, or the reading ages move", () => {
		const lines: string[] = [];
		const log = createInputsLog((m) => lines.push(m));
		const first = 1_000_000;
		const d = detail();
		log.record(available(d), first);
		expect(lines.length).toBe(1);
		const moved: ForecastInputsDetail = {
			...d,
			caps: [
				{ accountId: A, ratio: 12.4, binds: true },
				{ accountId: B, ratio: 6.1, binds: true },
			],
			limits: d.limits.map((l) =>
				l.oldestHoursAgo === null || l.newestHoursAgo === null
					? l
					: {
							...l,
							oldestHoursAgo: l.oldestHoursAgo + 5,
							newestHoursAgo: l.newestHoursAgo + 5,
						},
			),
		};
		log.record(available(moved), first + 3 * INPUTS_MIN_SPACING_MS);
		log.record(available(moved), first + 9 * INPUTS_MIN_SPACING_MS);
		expect(lines.length).toBe(1);
	});
});
