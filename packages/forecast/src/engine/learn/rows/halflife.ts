import { learnDays } from "../daily";
import type { LearnInput, RowScores } from "../types";
import { demandLosses, gridPreference } from "./demand-crps";

const GRID = [3.5, 7, 14, 28, 56, Number.POSITIVE_INFINITY];

/** Row 5 grid: doubling 3.5..56 and Infinity (equal weights), the setting inserted in order. */
export function halflifeCandidates(setting: number): number[] {
	if (GRID.includes(setting)) return [...GRID];
	return [...GRID, setting].sort((a, b) => a - b);
}

/**
 * Row 5 (demand half-life): per held-out day, CRPS of its total against the
 * hard3 pool with weights 0.5^(|distance|/h), at the lookback setting.
 * Preference: grid distance from the setting, ties to the longer half-life.
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
			lookbackDays: input.historyLookbackDays,
			halfLifeDays,
		})),
		"lowo",
	);
	return {
		row: "halflife",
		candidates,
		presentIndex: present,
		preference: gridPreference(candidates.length, present, true),
		units,
		loss,
	};
}
