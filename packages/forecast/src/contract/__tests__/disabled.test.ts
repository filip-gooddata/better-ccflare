import { describe, expect, test } from "bun:test";
import { disabledForecastResponse } from "../disabled";
import specNone from "./fixtures/spec-example-none.json";

describe("disabledForecastResponse", () => {
	test("is the spec no-forecast shape with reason disabled and no prewarm", () => {
		expect(disabledForecastResponse(1794486000000)).toEqual({
			...specNone,
			reason: "disabled",
		} as typeof specNone);
		expect("prewarm" in disabledForecastResponse(1)).toBe(false);
	});

	test("gives an integer computedAt", () => {
		expect(disabledForecastResponse(1000.7).computedAt).toBe(1000);
	});
});
