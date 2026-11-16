/**
 * Replay of 2026-11-13, 12:06 (flat-at-100 investigation): acct-a was refused by upstream with a
 * cooldown until Sunday while its 5-hour window still had 21 points left; only acct-b could take
 * work. Before revision 5 of the spec the day line stood at 100 from 14:00 to 17:00 with no stop
 * and no shortfall. Recorded days are the pooled hourly units of the days up to then
 * (fixtures-engine.ts); readings follow the fixture's own calibration (K_FIVE_HOUR, K_WEEKLY), so
 * the figures below are what the engine gives on this fixture, measured, not the live response.
 * The light line comes down to 0.5 at 17:00 but does not reach 0, so light has no stop. The
 * shortfall's spill gives acct-a its 79-point fill although acct-a cannot serve: the spill rule
 * (spec section 6) reads the 5-hour use, not the cooldown.
 */
import { describe, expect, test } from "bun:test";
import { validateForecastResponse } from "../../contract";
import type { ForecastBlock } from "../../types";
import { createForecastEngine } from "../engine";
import { buildInput, prague, replay1113Fixture } from "./fixtures-engine";

const NOW = prague(13, 12, 6, 2) + 785;
const B_RESET = prague(13, 17) + 11;

async function compute() {
	const result = await createForecastEngine().compute(
		buildInput(replay1113Fixture()),
	);
	if (!result.available) throw new Error(result.reason);
	return result;
}

describe("2026-11-13 12:06 replay: acct-a in a refusal cooldown", () => {
	test("the day line counts acct-a 0: it starts at acct-b's 79 and the levels meet the past at computedAt", async () => {
		const { response } = await compute();
		const day = response.day as ForecastBlock;
		expect(day.times[0]).toBe(NOW);
		expect([day.light[0], day.typical[0], day.heavy[0]]).toEqual([79, 79, 79]);
		expect(day.past.times.at(-1)).toBe(NOW);
		expect(day.past.values.at(-1)).toBe(79);
		expect(day.stopNow).toBeNull();
		expect(day.pastStops).toEqual([]);
	});

	test("typical stop 13:12–17:00 (the served day's own) with the shortfall on it; heavy stops 12:56–17:00 and 17:52–22:05; light low 0.5", async () => {
		const { response } = await compute();
		const day = response.day as ForecastBlock;
		expect(Math.min(...day.light)).toBeCloseTo(0.5, 5);
		expect(Math.min(...day.typical)).toBe(0);
		expect(Math.min(...day.heavy)).toBe(0);
		expect(day.stops.light).toEqual([]);
		// The served day (205 of 400) runs out at 13:12; its unserved demand to 17:00 is 211.3
		// points (13:21 and 259.5 for the pointwise median before the served day).
		expect(day.stops.typical).toEqual([
			{ start: prague(13, 13, 12), end: B_RESET },
		]);
		expect(day.stops.heavy).toEqual([
			{ start: prague(13, 12, 56), end: B_RESET },
			{ start: prague(13, 17, 52), end: prague(13, 22, 5) },
		]);
		expect(day.shortfall).toEqual({
			stop: { start: prague(13, 13, 12), end: B_RESET },
			points: 211.3,
			lastAccount: "acct-b",
			perAccount: { "acct-a": 79, "acct-b": 132.3 },
		});
	});

	test("the contract validator finds no error", async () => {
		const { response } = await compute();
		expect(validateForecastResponse(response)).toEqual([]);
	});
});
