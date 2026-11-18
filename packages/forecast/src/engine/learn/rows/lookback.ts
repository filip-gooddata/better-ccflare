import { demandLookbackDays } from "../../days";
import { learnDays } from "../daily";
import type { LearnInput, RowScores } from "../types";
import { demandLosses, gridPreference } from "./demand-crps";

const STEP = 14;
const FIRST = 28;

/** Row 4 grid: 14k from 28 up to the (capped) setting, plus the setting; never above it. */
export function lookbackCandidates(setting: number): number[] {
	const out: number[] = [];
	for (let w = FIRST; w < setting; w += STEP) out.push(w);
	out.push(setting);
	return out;
}

/**
 * Row 4 (demand lookback): per held-out day, CRPS of its total against the
 * hard3 pool of training days within |distance| <= W, at the half-life setting.
 */
export function scoreLookback(input: LearnInput): RowScores<number> {
	const setting = demandLookbackDays(input.historyLookbackDays);
	const candidates = lookbackCandidates(setting);
	const present = candidates.length - 1;
	const days = learnDays(input.series, input.now, input.workDays);
	const { units, loss } = demandLosses(
		days,
		candidates.map((lookbackDays) => ({
			pool: "hard3" as const,
			lookbackDays,
			halfLifeDays: input.historyHalfLifeDays,
		})),
		"lowo",
	);
	return {
		row: "lookback",
		candidates,
		presentIndex: present,
		preference: gridPreference(candidates.length, present, false),
		units,
		loss,
	};
}
