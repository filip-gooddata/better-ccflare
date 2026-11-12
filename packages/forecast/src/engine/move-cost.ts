import type { LiveSession } from "../types";
import { MODEL_FACTOR, TOKEN_WEIGHT } from "../units";

/** Observed lifetimes at or above this count as the 1-hour cache: halfway between the two real lifetimes (5 min, 1 h). */
const ONE_HOUR_LIFETIME_FROM_MS = 30 * 60_000;

/**
 * Move cost of a live session in demand units: its context re-read as a cache write on the target
 * instead of a cache read where it sits. An unknown lifetime is priced at the 1-hour weight, the
 * higher of the two, so an unknown session never looks cheaper to move than it is (same rule as
 * demandUnits for cache writes with an unknown split).
 */
export function moveCostUnits(session: LiveSession): number {
	const writeWeight =
		session.cacheTtlMs !== null &&
		session.cacheTtlMs < ONE_HOUR_LIFETIME_FROM_MS
			? TOKEN_WEIGHT.cacheWrite5m
			: TOKEN_WEIGHT.cacheWrite1h;
	const tokens =
		Number.isFinite(session.contextTokens) && session.contextTokens > 0
			? session.contextTokens
			: 0;
	return (
		(tokens *
			(writeWeight - TOKEN_WEIGHT.cacheRead) *
			MODEL_FACTOR[session.family]) /
		1_000_000
	);
}
