/**
 * Replay of 2026-11-13, 12:06 (flat-at-100 investigation): acct-a was refused by upstream with a
 * cooldown until Sunday while its 5-hour window still had 21 points left; only acct-b could take
 * work. Before revision 5 of the spec the day line stood at 100 from 14:00 to 17:00 with no stop
 * and no shortfall. Recorded days are the pooled hourly units of the days up to then
 * (fixtures-engine.ts); readings follow the fixture's own calibration (K_FIVE_HOUR, K_WEEKLY), so
 * the figures below are what the engine gives on this fixture, measured, not the live response.
 * The light line comes down to 47.8 but does not reach 0, so light has no stop. The recorded
 * days are not scaled by today's pace here (no fitted demand model: the plain lines), so the
 * stops start later than they did with the day factor, and the shortfall falls on acct-b.
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

	test("typical stop 16:39–17:00 with the shortfall on it; heavy stop 14:38–17:00; light low 47.8", async () => {
		const { response } = await compute();
		const day = response.day as ForecastBlock;
		expect(Math.min(...day.light)).toBeCloseTo(47.8, 5);
		expect(Math.min(...day.typical)).toBe(0);
		expect(Math.min(...day.heavy)).toBe(0);
		expect(day.stops.light).toEqual([]);
		expect(day.stops.typical).toEqual([
			{ start: prague(13, 16, 39), end: B_RESET },
		]);
		expect(day.stops.heavy).toEqual([
			{ start: prague(13, 14, 38), end: B_RESET },
		]);
		expect(day.shortfall).toEqual({
			stop: { start: prague(13, 16, 39), end: B_RESET },
			points: 4.2,
			lastAccount: "acct-b",
			perAccount: { "acct-a": 0, "acct-b": 4.2 },
		});
	});

	test("the contract validator finds no error", async () => {
		const { response } = await compute();
		expect(validateForecastResponse(response)).toEqual([]);
	});
});
