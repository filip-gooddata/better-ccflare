/** Percentiles behind the three named levels (spec section 4). Fixed. */
export const NAMED_LEVELS = { light: 10, typical: 50, heavy: 90 } as const;

/** Percentiles that are never fan levels because a named level carries them. */
export const FIXED_PERCENTILES: readonly number[] = [10, 50, 90];

/**
 * Default fan: the six levels PaceBar draws its three usage bands from. Not evenly spaced,
 * so no count gives it; `fanLevelsForCount(6)` is 20, 30, 40, 60, 70, 80.
 */
export const DEFAULT_FAN_LEVELS: readonly number[] = Object.freeze([
	12, 24, 38, 62, 76, 88,
]);

/** Largest fan count: every whole percentile strictly between 10 and 50 and between 50 and 90. */
export const MAX_FAN_LEVEL_COUNT = 78;

/**
 * The fan of `count` levels: an even count from 0 to 78, half below 50 and half above.
 * With h = count / 2, the lower half is round(10 + 40k / (h + 1)) for k = 1…h (halves
 * round up), the upper half mirrors it as 100 minus each lower level. 38 gives every 2
 * points 12…48 and 52…88. Throws a RangeError for any other count.
 */
export function fanLevelsForCount(count: number): number[] {
	if (
		!Number.isInteger(count) ||
		count < 0 ||
		count > MAX_FAN_LEVEL_COUNT ||
		count % 2 !== 0
	)
		throw new RangeError(
			`fan level count must be an even whole number from 0 to ${MAX_FAN_LEVEL_COUNT}, got ${count}`,
		);
	const half = count / 2;
	const lower = Array.from({ length: half }, (_, i) =>
		Math.round(10 + (40 * (i + 1)) / (half + 1)),
	);
	return [...lower, ...lower.map((p) => 100 - p).reverse()];
}

/** The `fan` key of a percentile: 12 → "p12". */
export function fanKey(percentile: number): string {
	return `p${percentile}`;
}
