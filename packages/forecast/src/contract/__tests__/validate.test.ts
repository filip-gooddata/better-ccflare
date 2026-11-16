import { describe, expect, test } from "bun:test";
import type { ForecastResponse } from "../../types";
import { disabledForecastResponse } from "../disabled";
import { DEFAULT_FAN_LEVELS } from "../levels";
import { validateForecastResponse } from "../validate";
import specFull from "./fixtures/spec-example-full.json";
import specNone from "./fixtures/spec-example-none.json";
import { generateFullResponse } from "./generate";

// biome-ignore lint/suspicious/noExplicitAny: tests break the shape on purpose
type Loose = any;

function clone<T>(value: T): Loose {
	return structuredClone(value);
}

function expectError(value: unknown, field: string) {
	const errors = validateForecastResponse(value);
	expect(errors.length).toBeGreaterThan(0);
	expect(errors.some((e) => e.includes(field))).toBe(true);
}

describe("validateForecastResponse accepts", () => {
	test("the full example of the spec", () => {
		expect(validateForecastResponse(specFull)).toEqual([]);
	});

	test("the no-forecast example of the spec", () => {
		expect(validateForecastResponse(specNone)).toEqual([]);
	});

	test("typical outside the fan, between light and heavy", () => {
		const response = clone(specFull);
		expect(response.day.typical[1]).toBeLessThan(response.day.fan.p20[1]);
		response.day.typical[1] = response.day.light[1];
		response.week.typical[2] = response.week.heavy[2] + 1;
		expect(response.week.typical[2]).toBeLessThan(response.week.fan.p60[2]);
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("a full-size generated response with all 41 lines", () => {
		const response = generateFullResponse();
		expect(DEFAULT_FAN_LEVELS).toHaveLength(38);
		expect(Object.keys(response.day?.fan ?? {})).toHaveLength(38);
		expect(response.day?.times.length).toBeGreaterThanOrEqual(300);
		expect(response.week?.times.length).toBeGreaterThanOrEqual(170);
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("the disabled response", () => {
		expect(validateForecastResponse(disabledForecastResponse(1_000))).toEqual(
			[],
		);
	});

	test("unknown extra fields, which clients must ignore", () => {
		const response = clone(specFull);
		response.somethingNew = { a: 1 };
		response.day.extra = [1, 2];
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("a response without the optional prewarm field", () => {
		const response = clone(specFull);
		delete response.prewarm;
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("an empty fan (no fan levels configured)", () => {
		expect(validateForecastResponse(generateFullResponse([]))).toEqual([]);
	});
});

describe("validateForecastResponse rejects", () => {
	test("a non-object", () => {
		expectError(null, "response");
		expectError([], "response");
	});

	test("levels misordered at one index", () => {
		const response = clone(generateFullResponse());
		// p14 above p12 at index 10 only
		response.day.fan.p14[10] = response.day.fan.p12[10] + 1;
		const errors = validateForecastResponse(response);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("day.fan.p14[10]");
		expect(errors[0]).toContain("day.fan.p12[10]");
	});

	test("a fan level above the fan level before it", () => {
		const response = clone(specFull);
		response.week.fan.p40[3] = response.week.fan.p30[3] + 1;
		expectError(response, "week.fan.p40[3]");
	});

	test("typical above light", () => {
		const response = clone(specFull);
		response.day.typical[2] = response.day.light[2] + 1;
		expectError(response, "day.typical[2]");
	});

	test("typical below heavy", () => {
		const response = clone(specFull);
		response.day.typical[2] = 0;
		response.day.heavy[2] = 1;
		const errors = validateForecastResponse(response);
		expect(
			errors.some(
				(e) => e.includes("day.heavy[2]") && e.includes("day.typical[2]"),
			),
		).toBe(true);
	});

	test("heavy above typical", () => {
		const response = clone(specFull);
		response.day.heavy[1] = 60;
		expectError(response, "day.heavy[1]");
	});

	test("ragged arrays", () => {
		const response = clone(specFull);
		response.day.typical.pop();
		expectError(response, "day.typical");
		const fan = clone(specFull);
		fan.week.fan.p30.push(1);
		expectError(fan, "week.fan.p30");
		const past = clone(specFull);
		past.day.past.values.push(1);
		expectError(past, "day.past");
	});

	test.each([
		"contractVersion",
		"computedAt",
		"available",
		"reason",
		"accounts",
		"levels",
		"day",
		"week",
		"fable",
	])("a missing top-level field %s", (field) => {
		const response = clone(specFull);
		delete response[field];
		expectError(response, field);
	});

	test.each([
		"past",
		"times",
		"light",
		"typical",
		"heavy",
		"fan",
		"stops",
		"stopNow",
		"pastStops",
		"shortfall",
	])("a missing block field day.%s", (field) => {
		const response = clone(specFull);
		delete response.day[field];
		expectError(response, `day.${field}`);
	});

	test("a missing stop level", () => {
		const response = clone(specFull);
		delete response.week.stops.typical;
		expectError(response, "week.stops.typical");
	});

	test.each([
		"P20",
		"p",
		"p5x",
		"p050",
		"p100",
		"p0",
		"p10",
		"p50",
		"p90",
		"typical",
	])("a bad fan key %s", (key) => {
		const response = clone(specFull);
		response.day.fan[key] = response.day.fan.p20;
		expectError(response, `day.fan.${key}`);
	});

	test("a stop that starts before the projection", () => {
		const response = clone(specFull);
		response.day.stops.heavy[0].start = response.computedAt - 60_000;
		expectError(response, "day.stops.heavy[0]");
	});

	test("a stop that ends after the projection", () => {
		const response = clone(specFull);
		const last = response.week.times[response.week.times.length - 1];
		response.week.stops.heavy[0].end = last + 3_600_000;
		expectError(response, "week.stops.heavy[0]");
	});

	test("a stop whose line is not 0 inside it", () => {
		const response = clone(specFull);
		response.day.stops.typical[0].start = 1794490200000; // typical is 27 there
		expectError(response, "day.stops.typical[0]");
	});

	test("a light stop outside every typical stop", () => {
		const response = clone(specFull);
		response.day.light[4] = 0;
		response.day.light[5] = 0;
		response.day.fan.p20[4] = 0;
		response.day.stops.light = [{ start: 1794493800000, end: 1794495600000 }];
		expect(validateForecastResponse(response)).toEqual([]);
		response.day.stops.typical = [];
		response.day.shortfall = null;
		expectError(response, "day.stops.light[0]");
	});

	test("a projected stop that starts at computedAt (a begun stop is stopNow only)", () => {
		const response = clone(generateFullResponse());
		response.day.stops.heavy[0].start = response.computedAt;
		expectError(response, "day.stops.heavy[0]");
	});

	test("(not) a stop whose start time is shared with a jump of other levels", () => {
		const response = clone(generateFullResponse());
		const day = response.day;
		const k = day.times.indexOf(day.stops.heavy[0].start);
		// heavy reaches 0 there; every line carries its value twice (a jump time)
		const twice = (values: number[]) => values.splice(k, 0, values[k]);
		twice(day.times);
		for (const name of ["light", "typical", "heavy"]) twice(day[name]);
		for (const series of Object.values(day.fan)) twice(series as number[]);
		expect(day.heavy[k]).toBe(0);
		expect(day.heavy[k + 1]).toBe(0);
		expect(validateForecastResponse(response)).toEqual([]);
	});

	test("a projected stop that is only a slice of its zero run", () => {
		const late = clone(generateFullResponse());
		const heavy = late.day.stops.heavy[0];
		const at = late.day.times.indexOf(heavy.start);
		heavy.start = late.day.times[at + 1];
		expect(validateForecastResponse(late)).toContainEqual(
			expect.stringContaining("day.stops.heavy[0] is not maximal"),
		);
		const early = clone(generateFullResponse());
		const stop = early.day.stops.heavy[0];
		stop.end = early.day.times[early.day.times.indexOf(stop.start) + 1];
		expect(validateForecastResponse(early)).toContainEqual(
			expect.stringContaining("day.stops.heavy[0] is not maximal"),
		);
	});

	test("a projected stop that ends between axis points while its line is still 0", () => {
		const response = clone(specFull);
		const stop = response.day.stops.typical[0];
		stop.end = stop.start + 60_000;
		response.day.shortfall.stop = clone(stop);
		expect(validateForecastResponse(response)).toContainEqual(
			expect.stringContaining("day.stops.typical[0] is not maximal"),
		);
	});

	test("a past reset drawn as a slope instead of two entries", () => {
		const response = clone(specFull);
		const { times, values } = response.day.past;
		const jump = times.findIndex(
			(t: number, i: number) => i > 0 && t === times[i - 1],
		);
		expect(jump).toBeGreaterThan(0);
		times.splice(jump - 1, 1);
		values.splice(jump - 1, 1);
		expectError(response, "day.past.values");
	});

	test("values with more than one decimal", () => {
		const response = clone(specFull);
		response.day.light[2] = 52.25;
		expectError(response, "day.light[2]");
		const past = clone(specFull);
		past.day.past.values[0] = 10.01;
		expectError(past, "day.past.values[0]");
		const shortfall = clone(specFull);
		shortfall.day.shortfall.points += 0.05;
		expectError(shortfall, "day.shortfall.points");
	});

	test("a projected value above 100 points per counted account", () => {
		const response = clone(generateFullResponse());
		expect(response.accounts).toHaveLength(2);
		response.day.light[1] = 200.1;
		expectError(response, "day.light[1]");
	});

	test("stops out of time order", () => {
		const response = clone(specFull);
		response.day.stops.heavy.reverse();
		expectError(response, "day.stops.heavy[1]");
	});

	test("a jump given as three entries with the same time", () => {
		const response = clone(specFull);
		const t = response.day.times;
		// times[5] and [6] are a jump at 1794495600000; make [7] the same time
		t[7] = t[6];
		expectError(response, "day.times[7]");
	});

	test("a time axis that goes back", () => {
		const response = clone(specFull);
		response.day.times[2] = response.day.times[1] - 1;
		expectError(response, "day.times[2]");
	});

	test("a time axis that does not start at computedAt", () => {
		const response = clone(specFull);
		response.week.times[0] += 60_000;
		expectError(response, "week.times[0]");
	});

	test("a non-integer time", () => {
		const response = clone(specFull);
		response.computedAt = 1.5;
		expectError(response, "computedAt");
	});

	test("a negative or non-finite value", () => {
		const response = clone(specFull);
		response.day.light[2] = -1;
		expectError(response, "day.light[2]");
		const nan = clone(specFull);
		nan.day.light[2] = "52";
		expectError(nan, "day.light[2]");
	});

	test("levels other than 10, 50, 90", () => {
		const response = clone(specFull);
		response.levels.heavy = 95;
		expectError(response, "levels.heavy");
	});

	test("a wrong contract version", () => {
		const response = clone(specFull);
		response.contractVersion = 2;
		expectError(response, "contractVersion");
	});

	test("an unknown reason, or a reason while available", () => {
		const response = clone(specNone);
		response.reason = "busy";
		expectError(response, "reason");
		const available = clone(specFull);
		available.reason = "error";
		expectError(available, "reason");
	});

	test("an unavailable response with blocks or fable entries", () => {
		const response = clone(specNone);
		response.day = clone(specFull).day;
		expectError(response, "day");
		const fable = clone(specNone);
		fable.fable = { x: { outAt: null } };
		expectError(fable, "fable");
	});

	test("an available response without blocks", () => {
		const response = clone(specFull);
		response.week = null;
		expectError(response, "week");
	});

	test("a shortfall whose parts do not sum to points", () => {
		const response = clone(specFull);
		response.day.shortfall.points = 70;
		expectError(response, "day.shortfall.perAccount");
	});

	test("a shortfall that names neither stopNow nor the first typical stop", () => {
		const response = clone(specFull);
		response.day.shortfall.stop = clone(response.day.stops.heavy[0]);
		expectError(response, "day.shortfall.stop");
	});

	test("a shortfall without any stop", () => {
		const response = clone(specFull);
		response.week.shortfall = clone(response.day.shortfall);
		expectError(response, "week.shortfall");
	});

	test("a shortfall lastAccount that is not counted", () => {
		const response = clone(specFull);
		response.day.shortfall.lastAccount = "nobody";
		expectError(response, "day.shortfall.lastAccount");
	});

	test("a stopNow that is not running at computedAt", () => {
		const response = clone(specFull);
		response.day.stopNow = {
			start: response.computedAt + 60_000,
			end: response.computedAt + 120_000,
		};
		expectError(response, "day.stopNow");
	});

	test("a past stop that has not ended", () => {
		const response = clone(specFull);
		response.day.pastStops = [
			{
				start: response.computedAt - 60_000,
				end: response.computedAt + 60_000,
			},
		];
		expectError(response, "day.pastStops[0]");
	});

	test("past readings after computedAt", () => {
		const response = clone(specFull);
		response.day.past.times[response.day.past.times.length - 1] += 60_000;
		expectError(response, "day.past.times");
	});

	test("a fable entry for an account that is not counted, or a missing one", () => {
		const response = clone(specFull);
		response.fable.other = { outAt: null };
		expectError(response, "fable.other");
		const missing = clone(specFull);
		delete missing.fable["1d05b422-cf9f-43a1-964b-706e55017200"];
		expectError(missing, "fable");
	});

	test("a malformed prewarm block", () => {
		const response = clone(specFull);
		response.prewarm.last = [{ accountId: "a", kind: "other" }];
		expectError(response, "prewarm.last[0].kind");
		const order = clone(generateFullResponse());
		order.prewarm.last.push({
			...order.prewarm.last[0],
			firedAt: order.prewarm.last[0].firedAt + 1,
		});
		expectError(order, "prewarm.last[1]");
	});

	test("every error names its field with a path", () => {
		const response = clone(specFull) as ForecastResponse & Loose;
		response.day.fan.bad = [1];
		response.week.typical = "x";
		for (const message of validateForecastResponse(response)) {
			expect(message).toMatch(/^(day|week)\./);
		}
	});
});
