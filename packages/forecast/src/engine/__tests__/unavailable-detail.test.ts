import { describe, expect, test } from "bun:test";
import type { ForecastInput, ForecastResult } from "../../types";
import { createForecastEngine } from "../engine";
import { buildInput, FIXED_N_ENGINE, replayFixture } from "./fixtures-engine";

const engine = createForecastEngine(FIXED_N_ENGINE);

async function detailOf(input: ForecastInput) {
	const result: ForecastResult = await engine.compute(input);
	if (result.available) throw new Error("available");
	expect(result.reason).toBe("insufficient_history");
	expect(JSON.stringify(result.response)).not.toContain("rule");
	return result.detail;
}

describe("why there is no forecast (amendment 3, C2)", () => {
	test("no counted account", async () => {
		const input = buildInput(replayFixture());
		input.accounts = input.accounts.map((a) => ({ ...a, counted: false }));
		expect(await detailOf(input)).toEqual({ rule: "no_counted_account" });
	});

	test("history: recorded days and today's pool against their minimums", async () => {
		const detail = await detailOf(
			buildInput({ ...replayFixture(), historyDays: 2 }),
		);
		expect(detail?.rule).toBe("history");
		if (detail?.rule !== "history") return;
		expect(detail.minRecordedDays).toBe(5);
		expect(detail.minPoolDays).toBe(3);
		expect(detail.recordedDays).toBeLessThan(5);
		expect(["workday", "weekdays"]).toContain(detail.pool);
	});

	test("calibration: per counted account, five-hour and weekly, instances, points, units and k", async () => {
		const input = buildInput(replayFixture());
		input.readings = [];
		const detail = await detailOf(input);
		expect(detail?.rule).toBe("calibration");
		if (detail?.rule !== "calibration") return;
		const counted = input.accounts.filter((a) => a.counted).length;
		expect(detail.limits.length).toBe(2 * counted);
		for (const l of detail.limits) {
			expect(["five_hour", "seven_day"]).toContain(l.limit);
			expect(l).toMatchObject({
				instances: 0,
				points: 0,
				minPoints: 5,
				units: 0,
				k: "none",
			});
		}
	});

	test("calibration: an account without its own k borrows the other's", async () => {
		const input = buildInput(replayFixture());
		input.readings = input.readings.filter((r) => r.accountId !== "acct-b");
		const detail = await detailOf({
			...input,
			// acct-a's five-hour readings gone too: no account has a five-hour k
			readings: input.readings.filter((r) => r.window !== "five_hour"),
		});
		if (detail?.rule !== "calibration") throw new Error(String(detail?.rule));
		const weekly = (id: string) =>
			detail.limits.find((l) => l.accountId === id && l.limit === "seven_day")
				?.k;
		expect(weekly("acct-a")).toBe("own");
		expect(weekly("acct-b")).toBe("borrowed");
		expect(
			detail.limits.filter((l) => l.limit === "five_hour").map((l) => l.k),
		).toEqual(["none", "none"]);
	});
});
