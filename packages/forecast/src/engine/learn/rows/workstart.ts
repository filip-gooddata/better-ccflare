import { median } from "simple-statistics";
import { localParts } from "../../../time";
import { BUCKET_MS } from "../../../types";
import { shareReachedAt } from "../../days";
import { type LearnDay, learnDays, lowoFolds } from "../daily";
import type { LearnInput, RowScores } from "../types";

/** Row 16 grids (DESIGN-F2 section 2); the setting always joins its grid. */
export const WS_SHARE_GRID: readonly number[] = [1, 2, 4, 8, 16];
export const WS_SAMPLE_GRID: readonly number[] = [5, 10, 20];

interface Grid {
	candidates: number[];
	presentIndex: number;
	preference: number[];
}

/** The grid plus the present, ascending; preference = rank by grid-index distance from the present, ties to the smaller index. */
export function gridWithPresent(
	grid: readonly number[],
	present: number,
): Grid {
	const candidates = [...new Set([...grid, present])].sort((a, b) => a - b);
	const presentIndex = candidates.indexOf(present);
	const order = candidates
		.map((_, i) => i)
		.sort(
			(a, b) =>
				Math.abs(a - presentIndex) - Math.abs(b - presentIndex) || a - b,
		);
	const preference = new Array<number>(candidates.length);
	order.forEach((c, rank) => {
		preference[c] = rank;
	});
	return { candidates, presentIndex, preference };
}

/**
 * Observed work-start bucket of a day: the first active bucket after the day's
 * longest run of zero-demand buckets that ends before the day's demand median
 * (the first bucket at which the cumulative units reach half the total; ties
 * between equally long runs go to the later one). Without such a run, the
 * first active bucket; -1 without demand. Overnight spillover before the
 * night's break therefore does not count as the work start.
 */
export function observedWorkStartBucket(curve: Float64Array): number {
	const first = curve.findIndex((u) => u > 0);
	if (first < 0) return -1;
	const mid = shareReachedAt(curve, 50) as number;
	let best = -1;
	let bestLen = 0;
	let run = 0;
	for (let b = 0; b < mid; b++) {
		if ((curve[b] as number) > 0) {
			run = 0;
			continue;
		}
		run++;
		if ((curve[b + 1] as number) > 0 && run >= bestLen) {
			bestLen = run;
			best = b + 1;
		}
	}
	return best >= 0 ? best : first;
}

/**
 * Out-of-fold work-start loss per (share, sample) pair. Units: held-out work
 * days (by `workDays`) that are uncensored and active, leave-one-ISO-week-out.
 * Observed = `observedWorkStartBucket` of the held-out day, local minute.
 * Predicted = days.ts's work start: per training work day the minute its
 * cumulative demand reaches `sharePct` (`shareReachedAt`), median over the
 * `sample` training work days with demand nearest in time (ties to the earlier
 * day), rounded. No such training day: NaN.
 */
export function workStartLosses(
	input: LearnInput,
	pairs: readonly { sharePct: number; sample: number }[],
): { units: number[]; loss: Float64Array[] } {
	const days = learnDays(input.series, input.now, input.workDays);
	const tz = input.series.timeZone;
	const minuteOf = (d: LearnDay, bucket: number) =>
		localParts(d.startMs + bucket * BUCKET_MS, tz).minuteOfDay;
	const shares = [...new Set(pairs.map((p) => p.sharePct))];
	// per share, per day: the work-start minute, null when the share is never reached
	const startOf = new Map<number, (number | null)[]>();
	for (const share of shares)
		startOf.set(
			share,
			days.map((d) => {
				if (!d.isWorkday) return null;
				const b = shareReachedAt(d.curve, share);
				return b === null ? null : minuteOf(d, b);
			}),
		);

	const units: number[] = [];
	const rows: number[][] = pairs.map(() => []);
	for (const fold of lowoFolds(days)) {
		const train = fold.train
			.map((i) => days[i] as LearnDay)
			.filter((d) => d.isWorkday);
		for (const h of fold.heldOut) {
			const day = days[h] as LearnDay;
			if (!day.isWorkday || !day.active) continue;
			units.push(h);
			const observed = minuteOf(day, observedWorkStartBucket(day.curve));
			const nearest = [...train].sort(
				(a, b) =>
					Math.abs(a.startMs - day.startMs) -
						Math.abs(b.startMs - day.startMs) || a.startMs - b.startMs,
			);
			pairs.forEach((p, c) => {
				const starts = startOf.get(p.sharePct) as (number | null)[];
				const minutes: number[] = [];
				for (const d of nearest) {
					if (minutes.length >= p.sample) break;
					const m = starts[d.dayIndex];
					if (m !== null && m !== undefined) minutes.push(m);
				}
				(rows[c] as number[]).push(
					minutes.length === 0
						? Number.NaN
						: Math.abs(Math.round(median(minutes)) - observed),
				);
			});
		}
	}
	return { units, loss: rows.map((r) => Float64Array.from(r)) };
}

/** Row 16 as one 1-D search over `grid` around `present`, the other parameter held by `pairOf`. */
export function workStartRow(
	row: string,
	input: LearnInput,
	grid: readonly number[],
	present: number,
	pairOf: (v: number) => { sharePct: number; sample: number },
): RowScores<number> {
	const g = gridWithPresent(grid, present);
	const { units, loss } = workStartLosses(input, g.candidates.map(pairOf));
	return { row, ...g, units, loss };
}
