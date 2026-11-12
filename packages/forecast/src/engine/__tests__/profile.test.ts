/**
 * The aggregated usage profile (research 14-usage-profile: daily totals and the mean hourly
 * shape per weekday) through compute(), and the kernel-noise REPORT on both fixtures.
 */
import { describe, expect, test } from "bun:test";
import type { ForecastBlock, ForecastInput } from "../../types";
import { createForecastEngine } from "../engine";
import {
	buildInput,
	defaultSettings,
	profileFixture,
	replayFixture,
} from "./fixtures-engine";

async function heavyLow(input: ForecastInput, noise: boolean): Promise<number> {
	const result = await createForecastEngine({ noise }).compute(input);
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

	test("REPORT: heavy 5-hour line's lowest point with and without kernel noise", async () => {
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
			const on = await heavyLow(input, true);
			const off = await heavyLow(input, false);
			expect(Number.isFinite(on) && Number.isFinite(off)).toBe(true);
			rows.push(`${name}: noise on ${on}, off ${off}`);
		}
		console.info(`[engine] REPORT heavy low point\n  ${rows.join("\n  ")}`);
	});
});
