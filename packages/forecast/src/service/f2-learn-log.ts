import type { LearnedDemand } from "../engine/learn";

/**
 * The `forecast f2 learn` line (DESIGN-F2 section 3), logged right after
 * `forecast e4 refit`. Numbers only. Foundation placeholder, filled in Part A.
 */
export function formatF2LearnLine(
	learned: LearnedDemand,
	jobMs: number,
): string {
	return `forecast f2 learn ms=${Math.round(jobMs)} learnMs=${learned.ms}`;
}
