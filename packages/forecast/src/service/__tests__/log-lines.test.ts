/** The forecast-inputs log line (design amendment 4, D2): content, change rule, 10-minute bound. */
import { describe, expect, it } from "bun:test";
import specFull from "../../contract/__tests__/fixtures/spec-example-full.json";
import { type PaceNow, plainPace } from "../../engine/pace";
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
const NOW = 1_800_000_000_000;
const MS = [2.004, 1.5, 1.25, 1, 1, 1, 1, 1, 0.7];

/** A fitted pace: features at 0-1h (clipped) and 2-4h, plain elsewhere. */
const PACE: PaceNow = {
	status: "fitted",
	fittedAt: NOW - 12.4 * MIN,
	bands: plainPace("fitted").bands.map((b, i) => ({
		...b,
		m: MS[i] as number,
		...(i === 0
			? {
					feature: "R:len30m:end0",
					ratio: 7.904,
					coef: 0.5213,
					clipped: true,
					lambda: 0.1,
				}
			: i === 2
				? {
						feature: "C:day-0",
						ratio: 1.2,
						coef: -0.31,
						clipped: false,
						lambda: 0,
					}
				: {}),
	})),
};

function detail(
	over: Partial<ForecastInputsDetail> = {},
): ForecastInputsDetail {
	return {
		pace: PACE,
		paceModel: {
			fittedAt: NOW - 12.4 * MIN,
			days: 84,
			weeks: 12,
			cellsEstablished: 5,
			cellsTotal: 216,
			belowFloor: [
				{ band: "1-2d", feature: "W:wk-1", units: 7 },
				{ band: "4-7d", feature: "C:day-7", units: 9 },
			],
		},
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

/** The detail with the first band's multiplier and the first k replaced. */
function withM(
	m: number,
	k = 1.98766,
	fittedAt = NOW - 12.4 * MIN,
): ForecastInputsDetail {
	const d = detail();
	return {
		...d,
		pace: {
			...PACE,
			fittedAt,
			bands: PACE.bands.map((b, i) => (i === 0 ? { ...b, m } : b)),
		},
		paceModel: d.paceModel ? { ...d.paceModel, fittedAt } : null,
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
	it("names the pace status, fit, band multipliers, selected features, cells below the floor, today's pool, the work start and every k", () => {
		expect(inputsLine(detail(), NOW)).toBe(
			"forecast inputs e4=fitted fitAge=12 days=84 weeks=12 cells=5/216" +
				" e4m 0-1h=2.00 1-2h=1.50 2-4h=1.25 4-8h=1.00 8-16h=1.00 16h-1d=1.00 1-2d=1.00 2-4d=1.00 4-7d=0.70" +
				" e4f 0-1h:R:len30m:end0=7.90x/b0.52/lambda0.10/clip 2-4h:C:day-0=1.20x/b-0.31/lambda0.00" +
				" e4floor count=2 1-2d:W:wk-1:7 4-7d:C:day-7:9" +
				" pool=workday:23 median=98.0 p90=152.0 workStart=08:05" +
				` k: ${A}/five_hour=1.9877 own instances=6 points=41 oldestH=312.5 newestH=0.3;` +
				` ${A}/seven_day=0.1504 own instances=3 points=12.5 oldestH=160.0 newestH=1.5;` +
				` ${A}/seven_day_fable=none none instances=0 points=0 oldestH=none newestH=none;` +
				` ${B}/five_hour=1.9877 borrowed instances=0 points=0 oldestH=none newestH=none` +
				` cap: ${A} r=13.22 binds=no; ${B} r=none binds=no`,
		);
	});

	it("unfitted or off without a state: the plain multipliers, no features, no fit numbers", () => {
		for (const status of ["unfitted", "off"] as const) {
			const line = inputsLine(
				detail({ pace: plainPace(status), paceModel: null }),
				NOW,
			);
			expect(line).toStartWith(
				`forecast inputs e4=${status} fitAge=none days=none weeks=none cells=none` +
					" e4m 0-1h=1.00 1-2h=1.00 2-4h=1.00 4-8h=1.00 8-16h=1.00 16h-1d=1.00 1-2d=1.00 2-4d=1.00 4-7d=1.00" +
					" e4f none e4floor count=0 pool=workday:23",
			);
			expect(line).not.toContain("dayFactor");
			expect(line).not.toContain("recentRate");
		}
	});

	it("lists at most 12 cells below the floor after their count", () => {
		const many = Array.from({ length: 15 }, (_, i) => ({
			band: "1-2d",
			feature: `C:day-${i}`,
			units: i,
		}));
		const d = detail();
		const line = inputsLine(
			{
				...d,
				paceModel: d.paceModel ? { ...d.paceModel, belowFloor: many } : null,
			},
			NOW,
		);
		expect(line).toContain("e4floor count=15 1-2d:C:day-0:0 ");
		expect(line).toContain(" 1-2d:C:day-11:11 more=3 pool=");
		expect(line).not.toContain("C:day-12");
	});

	it("ends with the planner's S for the chosen plan and for on demand (amendment 5, E5)", () => {
		const line = inputsLine(
			{
				...detail(),
				lowPoint: 59.94,
				lowPointOnDemand: -13.81,
			},
			NOW,
		);
		expect(line).toEndWith(
			` ${B}/five_hour=1.9877 borrowed instances=0 points=0 oldestH=none newestH=none` +
				` cap: ${A} r=13.22 binds=no; ${B} r=none binds=no lowPoint=59.9 lowPointOnDemand=-13.8`,
		);
		expect(
			inputsLine({ ...detail(), lowPoint: Number.NaN }, NOW),
		).not.toContain("lowPoint");
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
			pace: {
				...PACE,
				bands: PACE.bands.map((b, i) =>
					i === 0
						? {
								...b,
								band: "Filip's band",
								feature: "Filip's /Users/x",
								m: Number.NaN,
								ratio: Number.NaN,
								coef: Number.POSITIVE_INFINITY,
								lambda: Number.NaN,
							}
						: b,
				),
			},
			paceModel: {
				fittedAt: Number.NaN,
				days: Number.NaN,
				weeks: 12,
				cellsEstablished: 5,
				cellsTotal: 216,
				belowFloor: [
					{ band: "1-2d", feature: "/Users/x y", units: Number.NaN },
				],
			},
		});
		const line = inputsLine(d, NOW);
		expect(line).toContain(
			"e4=fitted fitAge=? days=? weeks=12 cells=5/216 e4m ?=? 1-2h=1.50",
		);
		expect(line).toContain("e4f ?:?=?x/b?/lambda?/clip 2-4h:");
		expect(line).toContain("e4floor count=1 1-2d:?:? pool=");
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
				/^([a-zA-Z_][a-zA-Z0-9_]*|[0-9a-f-]{36}|acct-b|-?[\d.]+|\?|\d\d|-?[\d.]+\/h|\d+h?-\d+[hd]|[a-zA-Z]+-\d+|(-?[\d.]+|\?)x|b(-?[\d.]+|\?)|lambda([\d.]+|\?))$/,
			);
		}
	});

	it("is written at the first available computation, then only when a band multiplier (to 0.05), the fit or a k (to 0.05) changes, at most once per 10 minutes", () => {
		const lines: string[] = [];
		const log = createInputsLog((m) => lines.push(m));
		let now = NOW;
		// unavailable, or available without inputs: nothing
		log.record(
			{ ...available(), available: false, reason: "error", plan: null },
			now,
		);
		log.record(available(), now);
		expect(lines).toEqual([]);

		const first = now;
		log.record(available(withM(2.004)), now);
		expect(lines.length).toBe(1);
		// m crosses a 0.05 step, but within 10 minutes of the last line: held
		expect(INPUTS_MIN_SPACING_MS).toBe(10 * MIN);
		now = first + MIN;
		log.record(available(withM(2.3)), now);
		expect(lines.length).toBe(1);
		now = first + 9 * MIN;
		log.record(available(withM(2.5)), now);
		expect(lines.length).toBe(1);
		// 10 minutes over: the latest state is written
		now = first + 10 * MIN;
		log.record(available(withM(2.6)), now);
		expect(lines.length).toBe(2);
		expect(lines[1]).toContain("e4m 0-1h=2.60 ");
		// polls with tiny moves of m and k, long after: nothing
		for (const [m, k] of [
			[2.61, 1.99],
			[2.59, 1.98],
			[2.62, 1.999],
		] as const) {
			now += 3 * INPUTS_MIN_SPACING_MS;
			log.record(available(withM(m, k)), now);
		}
		expect(lines.length).toBe(2);
		// a k moving by a 0.05 step: written
		now += MIN;
		log.record(available(withM(2.6, 2.05)), now);
		expect(lines.length).toBe(3);
		expect(lines[2]).toContain(`${A}/five_hour=2.0500 own`);
		// a new fit with the same rounded multipliers: written
		now += 3 * INPUTS_MIN_SPACING_MS;
		const fit = now - MIN;
		log.record(available(withM(2.6, 2.05, fit)), now);
		expect(lines.length).toBe(4);
		expect(lines[3]).toContain("e4=fitted fitAge=1 ");
		// a change that is back to the last written state by the time 10 minutes are over: nothing
		now += MIN;
		log.record(available(withM(3.5, 2.05, fit)), now);
		now += 10 * MIN;
		log.record(available(withM(2.6, 2.05, fit)), now);
		expect(lines.length).toBe(4);
		// the same fit polled again later: its age grows, nothing is written
		now += 3 * INPUTS_MIN_SPACING_MS;
		log.record(available(withM(2.6, 2.05, fit)), now);
		expect(lines.length).toBe(4);
	});

	it("is written when the pace status changes", () => {
		const lines: string[] = [];
		const log = createInputsLog((m) => lines.push(m));
		log.record(
			available(detail({ pace: plainPace("unfitted"), paceModel: null })),
			NOW,
		);
		log.record(
			available(detail({ pace: plainPace("off"), paceModel: null })),
			NOW + 11 * MIN,
		);
		expect(lines.length).toBe(2);
		expect(lines[1]).toStartWith("forecast inputs e4=off ");
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
			NOW,
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
