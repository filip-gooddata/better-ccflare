import { demandLookbackDays } from "../../days";
import { learnDays } from "../daily";
import type { LearnInput, RowScores } from "../types";
import { demandLosses } from "./demand-crps";

const GRID = [3.5, 7, 14, 28, 56, Number.POSITIVE_INFINITY];

/** Row 5 grid: doubling 3.5..56 and Infinity (equal weights), the setting inserted in order. */
export function halflifeCandidates(setting: number): number[] {
	if (GRID.includes(setting)) return [...GRID];
	return [...GRID, setting].sort((a, b) => a - b);
}

/** Row 5 preference ranks on the ascending grid: the present 0, then half-life descending (Infinity first). */
export function halflifePreference(size: number, present: number): number[] {
	const rank = new Array<number>(size);
	rank[present] = 0;
	let r = 1;
	for (let i = size - 1; i >= 0; i--) if (i !== present) rank[i] = r++;
	return rank;
}

/**
 * Row 5 (demand half-life): per held-out day, CRPS of its total against the
 * hard3 pool with weights 0.5^(|distance|/h), at the lookback setting.
 * Preference: the setting, then the longer half-life first (R3-6).
 */
export function scoreHalflife(input: LearnInput): RowScores<number> {
	const setting = input.historyHalfLifeDays;
	const candidates = halflifeCandidates(setting);
	const present = candidates.indexOf(setting);
	const days = learnDays(input.series, input.now, input.workDays);
	const { units, loss } = demandLosses(
		days,
		candidates.map((halfLifeDays) => ({
			pool: "hard3" as const,
			lookbackDays: demandLookbackDays(input.historyLookbackDays),
			halfLifeDays,
		})),
		"lowo",
	);
	return {
		row: "halflife",
		candidates,
		presentIndex: present,
		preference: halflifePreference(candidates.length, present),
		units,
		loss,
	};
}
