import { quantileSorted } from "simple-statistics";

/**
 * Quantile of quota left behind level pNN: pNN of demand is the value that quota left is at or
 * above in (100 - NN) % of the simulated days.
 */
export function quotaQuantile(level: number): number {
	return (100 - level) / 100;
}

/**
 * Pointwise level lines over simulated days. `series[s][i]` is simulated day s at sample i.
 * Each column is sorted once; every level reads the same sorted column, so the lines are ordered
 * at every index (a higher level is never above a lower one).
 */
export function levelLines(
	series: ArrayLike<number>[],
	length: number,
	levels: number[],
): Float64Array[] {
	const lines = levels.map(() => new Float64Array(length));
	const quantiles = levels.map(quotaQuantile);
	const column = new Float64Array(series.length);
	for (let i = 0; i < length; i++) {
		for (let s = 0; s < series.length; s++) column[s] = series[s][i];
		column.sort();
		for (let l = 0; l < levels.length; l++)
			lines[l][i] =
				series.length === 0
					? 0
					: quantileSorted(column as unknown as number[], quantiles[l]);
	}
	return lines;
}

/** The pNN-of-demand value of one set of per-day values (same quantile rule as levelLines). */
export function levelOf(values: ArrayLike<number>, level: number): number {
	if (values.length === 0) return 0;
	const sorted = Float64Array.from(values).sort();
	return quantileSorted(sorted as unknown as number[], quotaQuantile(level));
}
