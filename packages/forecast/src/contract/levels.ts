/** Percentiles behind the three named levels (spec section 4). Fixed. */
export const NAMED_LEVELS = { light: 10, typical: 50, heavy: 90 } as const;

/** Percentiles that are never fan levels because a named level carries them. */
export const FIXED_PERCENTILES: readonly number[] = [10, 50, 90];

/** Default fan: every 2 percentile points, 12…48 and 52…88 (38 levels). */
export const DEFAULT_FAN_LEVELS: readonly number[] = Object.freeze(
	Array.from({ length: 39 }, (_, i) => 12 + 2 * i).filter((p) => p !== 50),
);

/** The `fan` key of a percentile: 12 → "p12". */
export function fanKey(percentile: number): string {
	return `p${percentile}`;
}
