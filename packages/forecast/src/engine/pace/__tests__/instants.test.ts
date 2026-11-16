import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPace } from "../index";
import type { PaceFitState, PaceNow } from "../types";

/**
 * The four instants of DESIGN-E4 §12 (Europe/Prague local time) as frozen regression fixtures.
 * Each fixture holds the state fitted on .toolchain/forecast/e4-design/out/series-r3.json cut at
 * the instant (product backfill usage numbers, series from the local midnight before the first
 * bucket), the last 16 days of that series, and the expected band multipliers and features from an
 * independent oracle: the sandbox itself (e4-design/sandbox model3b.ts grammar3 {lags, cal},
 * cells3 pooled, folds3, screen3, select3 with one feature pooled, e4Bands3 at the instant). The
 * product matched it to 2e-16 when frozen; clipped comes from the product. The generator and its log:
 * .toolchain/forecast/e4-build/logs/model-fit-gen-instants.*.
 */
type Fixture = {
	label: string;
	now: number;
	series: {
		start: number;
		units: number[];
		censored: number[];
		timeZone: string;
	};
	state: PaceFitState;
	expected: PaceNow["bands"];
};

const fixtures = JSON.parse(
	readFileSync(join(import.meta.dir, "fixtures", "instants.json"), "utf8"),
) as Fixture[];

describe("frozen instants", () => {
	test("four instants are frozen", () => {
		expect(fixtures.map((f) => f.label)).toEqual([
			"Thu 2026-11-12 10:00",
			"Thu 2026-11-12 13:00",
			"Fri 2026-11-13 10:40",
			"Fri 2026-11-13 12:06",
		]);
	});
	for (const f of fixtures)
		test(f.label, () => {
			const out = applyPace(
				f.state,
				{
					start: f.series.start,
					units: Float64Array.from(f.series.units),
					censored: Uint8Array.from(f.series.censored),
					timeZone: f.series.timeZone,
				},
				f.now,
				true,
			);
			expect(out.status).toBe("fitted");
			expect(out.fittedAt).toBe(f.now);
			out.bands.forEach((b, k) => {
				const e = f.expected[k] as PaceNow["bands"][number];
				expect(b.band).toBe(e.band);
				expect(b.feature).toBe(e.feature);
				expect(b.clipped).toBe(e.clipped);
				expect(b.m).toBeCloseTo(e.m, 9);
			});
		});
});
