import type { PaceBand, PaceNow } from "./types";

const EDGES_MIN = [0, 60, 120, 240, 480, 960, 1440, 2880, 5760, 10080];
const LABELS = [
	"0-1h",
	"1-2h",
	"2-4h",
	"4-8h",
	"8-16h",
	"16h-1d",
	"1-2d",
	"2-4d",
	"4-7d",
];

/** The nine distance bands ahead of now; centres 30, 90, 180, 360, 720, 1200, 2160, 4320, 7920 min. */
export const PACE_BANDS: readonly PaceBand[] = LABELS.map((id, k) => {
	const fromMin = EDGES_MIN[k] as number;
	const toMin = EDGES_MIN[k + 1] as number;
	return { id, fromMin, toMin, centreMin: (fromMin + toMin) / 2 };
});

/** The plain lines: every band at m = 1. */
export function plainPace(
	status: PaceNow["status"],
	fittedAt: PaceNow["fittedAt"] = null,
): PaceNow {
	return {
		status,
		fittedAt,
		bands: PACE_BANDS.map((b) => ({
			band: b.id,
			centreMin: b.centreMin,
			m: 1,
			feature: null,
			ratio: null,
			coef: null,
			clipped: false,
			lambda: null,
		})),
	};
}

/** Log multiplier linear between band centres, flat before the first centre and after the last (sandbox mech.ts logmAt). */
export function paceMultiplierAt(pace: PaceNow, aheadMin: number): number {
	const bands = pace.bands;
	if (bands.length === 0) return 1;
	const first = bands[0] as PaceNow["bands"][number];
	if (aheadMin <= first.centreMin) return first.m;
	for (let k = 0; k + 1 < bands.length; k++) {
		const a = bands[k] as PaceNow["bands"][number];
		const b = bands[k + 1] as PaceNow["bands"][number];
		if (aheadMin <= b.centreMin) {
			const t = (aheadMin - a.centreMin) / (b.centreMin - a.centreMin);
			return Math.exp((1 - t) * Math.log(a.m) + t * Math.log(b.m));
		}
	}
	return (bands[bands.length - 1] as PaceNow["bands"][number]).m;
}
