/**
 * The aggregated usage profile (research 14-usage-profile: daily totals and the mean hourly
 * shape per weekday) through compute(), and the kernel-noise REPORT on both fixtures.
 */
import { describe, expect, test } from "bun:test";
import type { ForecastBlock, ForecastInput } from "../../types";
import { createForecastEngine, prepareEngineContext } from "../engine";
import type { NoiseMode } from "../model";
import {
	buildInput,
	defaultSettings,
	profileFixture,
	replayFixture,
} from "./fixtures-engine";

async function heavyLow(
	input: ForecastInput,
	noiseMode: NoiseMode,
): Promise<number> {
	const result = await createForecastEngine({ noiseMode }).compute(input);
	if (!result.available) throw new Error(result.reason);
	return Math.min(...(result.response.day as ForecastBlock).heavy);
}

describe("aggregated usage profile", () => {
	test("gives a forecast: 37 recorded days, calibrated, both blocks", async () => {
		const result = await createForecastEngine().compute(
			buildInput(profileFixture()),
		);
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.response.day?.times.length).toBeGreaterThan(100);
		expect(result.response.week).not.toBeNull();
	});

	test("learned work start (amendment A3): the minute by which 5 % of a work day's demand is used, not the overnight first request", async () => {
		const replay = await prepareEngineContext(buildInput(replayFixture()), {
			noise: true,
		});
		const profile = await prepareEngineContext(buildInput(profileFixture()), {
			noise: true,
		});
		if (replay === "insufficient_history" || profile === "insufficient_history")
			throw new Error("fixture has no forecast");
		// the first-demand rule gave 01:00 (replay) and 00:00 (profile)
		expect(replay.workStartMinute).toBe(8 * 60 + 15);
		expect(profile.workStartMinute).toBe(9 * 60 + 10);
	});

	test("REPORT: heavy 5-hour line's lowest point for plain resampling, unshrunk and shrunk kernel", async () => {
		const rows: string[] = [];
		const fixtures = {
			"replay, pre-warm on": buildInput(
				replayFixture({ settings: defaultSettings({ prewarm: true }) }),
			),
			"replay, pre-warm off": buildInput(replayFixture()),
			"profile, pre-warm off": buildInput(profileFixture()),
			"profile, pre-warm on": buildInput({
				...profileFixture(),
				settings: defaultSettings({ prewarm: true }),
			}),
		};
		for (const [name, input] of Object.entries(fixtures)) {
			const off = await heavyLow(input, "off");
			const unshrunk = await heavyLow(input, "unshrunk");
			const shrunk = await heavyLow(input, "shrunk");
			expect([off, unshrunk, shrunk].every((x) => Number.isFinite(x))).toBe(
				true,
			);
			rows.push(
				`${name}: plain ${off}, unshrunk ${unshrunk}, shrunk ${shrunk}`,
			);
		}
		console.info(
			`[engine] REPORT heavy low point (each run plans on its own scenarios: noise mode and changed advice combined)\n  ${rows.join("\n  ")}`,
		);
	});
});
