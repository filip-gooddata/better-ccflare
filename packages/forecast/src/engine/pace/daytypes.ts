import { mean, sampleStandardDeviation } from "simple-statistics";
import { type PaceCalendar, PRESENT_GROUP } from "./calendar";
import {
	baselinePrefix,
	baselineProfile,
	type GrammarContext,
	lr,
	type SpanSums,
	WEEKDAYS,
} from "./grammar";
import { type BandRows, kernelW } from "./rows";
import type { PaceCandidate, PaceFitState } from "./types";

/**
 * Day-type comparison at each refit (learned-inputs DESIGN row 1): a diagnostic, not a validation for switching. Reports
 * only; the served model keeps the present day types. Each weekday partition
 * is scored by the out-of-fold loss of the E4 model under that segmentation,
 * on the same leave-one-ISO-week-out folds: the baseline per (group, slot)
 * is refitted per fold, and per (band, group, origin hour) cell a one-feature
 * weighted least squares on the band's served pooled selection, kernel
 * weighted and clipped to its training range (no feature: the cell mean).
 * The selection, the ridge strength search and the R^2 gate are not re-run
 * per partition: that bounds the cost (about 30 partitions) and scores every
 * partition with the same features, so only the segmentation differs.
 * Loss: per ISO week the mean squared error of log((U + 2) / (B + 2)) over
 * the week's rows of every band at the row's own hour cell; loss is the mean
 * over weeks, se its standard error. A merge is accepted while the paired
 * per-week difference to the current partition has mean <= its SE.
 */

const MIN_TRAIN = 10;
type Partition = number[][];

/** Partitions from merging two cyclically adjacent groups (Sun+Mon included); groups given in cyclic order. */
export function cyclicMerges(groups: Partition): Partition[] {
	const G = groups.length;
	const out: Partition[] = [];
	for (let i = 0; i < G && G > 1; i++) {
		if (G === 2 && i === 1) break;
		const j = (i + 1) % G;
		const merged = [...(groups[i] as number[]), ...(groups[j] as number[])];
		out.push(
			j > i
				? [...groups.slice(0, i), merged, ...groups.slice(j + 1)]
				: [...groups.slice(1, G - 1), merged],
		);
	}
	return out;
}

export function partitionId(groups: Partition): string {
	const named = groups
		.map((g) => {
			if (g.length === 7) {
				const z = g.indexOf(0);
				return [...g.slice(z), ...g.slice(0, z)];
			}
			return g;
		})
		.sort((a, b) => (a[0] as number) - (b[0] as number))
		.map((g) => g.map((d) => WEEKDAYS[d]).join(""));
	return `merged:${named.join("|")}`;
}

const groupOfPartition = (groups: Partition): number[] => {
	const g = new Array<number>(7).fill(0);
	groups.forEach((members, k) => {
		for (const d of members) g[d] = k;
	});
	return g;
};

export interface CompareInput {
	cal: PaceCalendar;
	ctx: GrammarContext;
	units: ArrayLike<number>;
	censored: ArrayLike<number>;
	PU: Float64Array;
	PC: Float64Array;
	cut: number;
	cutDay: number;
	weeks: number[];
	rows: BandRows[];
	features: (PaceCandidate | null)[];
}

/** Kernel hours and weights per half-hour origin slot. */
const KERNEL_BY_SLOT: { h: number; w: number }[][] = Array.from(
	{ length: 48 },
	(_, s) => {
		const out: { h: number; w: number }[] = [];
		for (let h = 0; h < 24; h++) {
			const w = kernelW(s * 30, h);
			if (w > 0) out.push({ h, w });
		}
		return out;
	},
);

/** Mean loss per week (weeks without scored rows dropped) under a weekday-to-group map. */
function weekLosses(
	I: CompareInput,
	groupOf: number[],
	groups: number,
): number[] {
	const { cal, ctx } = I;
	const out: number[] = [];
	const S = 7; // sw, sx, sy, sxx, sxy, lo, hi
	for (const wk of I.weeks) {
		const inWeek = (d: number) => (cal.days[d] as { week: number }).week === wk;
		const prof = baselineProfile(
			cal,
			I.units,
			I.censored,
			groupOf,
			groups,
			(d) => !inWeek(d) && d < I.cutDay,
		);
		const P: SpanSums = {
			PU: I.PU,
			PC: I.PC,
			PB: baselinePrefix(cal, prof, groupOf, I.cut),
		};
		let loss = 0;
		let count = 0;
		I.rows.forEach((R, k) => {
			const c = I.features[k] ?? null;
			const acc = new Float64Array(groups * 24 * S);
			const cnt = new Int32Array(groups * 24);
			for (let g = 0; g < groups * 24; g++) {
				acc[g * S + 5] = Number.POSITIVE_INFINITY;
				acc[g * S + 6] = Number.NEGATIVE_INFINITY;
			}
			const y = new Float64Array(R.n);
			const x = new Float64Array(R.n);
			for (let q = 0; q < R.n; q++) {
				const o = R.o[q] as number;
				const a = R.a[q] as number;
				const b = R.b[q] as number;
				y[q] = lr(P, a, b);
				x[q] = c ? ctx.value(c, P, o, a, b) : 0;
				if (Number.isNaN(y[q] as number) || Number.isNaN(x[q] as number))
					continue;
				const touches =
					inWeek(cal.dayIdx[a] as number) ||
					inWeek(cal.dayIdx[b - 1] as number) ||
					inWeek(R.day[q] as number);
				if (touches) continue;
				const g = groupOf[R.wd[q] as number] as number;
				for (const { h, w } of KERNEL_BY_SLOT[(R.minute[q] as number) / 30] as {
					h: number;
					w: number;
				}[]) {
					const cell = g * 24 + h;
					const base = cell * S;
					const xv = x[q] as number;
					const yv = y[q] as number;
					acc[base] = (acc[base] as number) + w;
					acc[base + 1] = (acc[base + 1] as number) + w * xv;
					acc[base + 2] = (acc[base + 2] as number) + w * yv;
					acc[base + 3] = (acc[base + 3] as number) + w * xv * xv;
					acc[base + 4] = (acc[base + 4] as number) + w * xv * yv;
					acc[base + 5] = Math.min(acc[base + 5] as number, xv);
					acc[base + 6] = Math.max(acc[base + 6] as number, xv);
					cnt[cell] = (cnt[cell] as number) + 1;
				}
			}
			for (let q = 0; q < R.n; q++) {
				if (!inWeek(R.day[q] as number)) continue;
				const yv = y[q] as number;
				const xv = x[q] as number;
				if (Number.isNaN(yv) || Number.isNaN(xv)) continue;
				const g = groupOf[R.wd[q] as number] as number;
				const cell = g * 24 + (Math.round((R.minute[q] as number) / 60) % 24);
				const base = cell * S;
				let yhat = 0;
				if ((cnt[cell] as number) >= MIN_TRAIN) {
					const sw = acc[base] as number;
					const mx = (acc[base + 1] as number) / sw;
					const my = (acc[base + 2] as number) / sw;
					const vx = (acc[base + 3] as number) / sw - mx * mx;
					const beta =
						c && vx > 1e-9
							? ((acc[base + 4] as number) / sw - mx * my) / vx
							: 0;
					const xc = Math.min(
						acc[base + 6] as number,
						Math.max(acc[base + 5] as number, xv),
					);
					yhat = my + beta * (xc - mx);
				}
				loss += (yv - yhat) ** 2;
				count++;
			}
		});
		if (count) out.push(loss / count);
	}
	return out;
}

const summary = (l: number[]) => ({
	loss: l.length ? mean(l) : 0,
	se: l.length >= 2 ? sampleStandardDeviation(l) / Math.sqrt(l.length) : 0,
});

export function compareDayTypes(
	I: CompareInput,
): PaceFitState["dayTypeComparison"] {
	const score = (groupOf: number[], groups: number) =>
		weekLosses(I, groupOf, groups);
	const fixed: [string, number[], number][] = [
		["present", [...PRESENT_GROUP], 3],
		["one", [0, 0, 0, 0, 0, 0, 0], 1],
		["workday-weekend", [0, 0, 0, 0, 0, 1, 1], 2],
	];
	const out: PaceFitState["dayTypeComparison"] = fixed.map(
		([partition, g, groups]) => ({
			partition,
			groups,
			...summary(score(g, groups)),
		}),
	);
	let cur: Partition = [[0], [1], [2], [3], [4], [5], [6]];
	let curL = score(groupOfPartition(cur), 7);
	while (cur.length > 1) {
		let best: { p: Partition; l: number[]; loss: number } | null = null;
		for (const p of cyclicMerges(cur)) {
			const l = score(groupOfPartition(p), p.length);
			const loss = summary(l).loss;
			if (!best || loss < best.loss) best = { p, l, loss };
		}
		if (!best) break;
		const d = best.l.map((v, i) => v - (curL[i] as number));
		const accept =
			d.length >= 2
				? mean(d) <= sampleStandardDeviation(d) / Math.sqrt(d.length)
				: d.length === 0 || (d[0] as number) <= 0;
		if (!accept) break;
		cur = best.p;
		curL = best.l;
	}
	out.push({
		partition: partitionId(cur),
		groups: cur.length,
		...summary(curL),
	});
	return out;
}
