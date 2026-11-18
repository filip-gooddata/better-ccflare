import { learnDays } from "../daily";
import type { LearnInput, PoolTau, RowScores } from "../types";
import { demandLosses, gridPreference } from "./demand-crps";

/** Row 2 grid in order: tau 0..Infinity with today's hard 3-day rule between 2 and 4. */
export const POOL_CANDIDATES: PoolTau[] = [
	0,
	1,
	2,
	"hard3",
	4,
	8,
	16,
	Infinity,
];
const PRESENT = POOL_CANDIDATES.indexOf("hard3");

/**
 * Row 2 (pool shrinkage): per held-out day, CRPS of its total against the
 * day-type pool mixture (hard3 = days.ts poolFor plus the scenarios.ts empty-pool
 * fallback; tau = w own + (1 - w) all, w = n/(n + tau)), at the lookback and
 * half-life settings.
 */
export function scorePool(input: LearnInput): RowScores<PoolTau> {
	const days = learnDays(input.series, input.now, input.workDays);
	const { units, loss } = demandLosses(
		days,
		POOL_CANDIDATES.map((pool) => ({
			pool,
			lookbackDays: input.historyLookbackDays,
			halfLifeDays: input.historyHalfLifeDays,
		})),
		"lowo",
	);
	return {
		row: "pool",
		candidates: [...POOL_CANDIDATES],
		presentIndex: PRESENT,
		preference: gridPreference(POOL_CANDIDATES.length, PRESENT, false),
		units,
		loss,
	};
}
