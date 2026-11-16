import { BUCKET_MS, type EpochMs } from "../../types";
import { PACE_BANDS } from "./bands";
import {
	buildCalendar,
	DAY_TYPES,
	type PaceCalendar,
	PRESENT_GROUP,
} from "./calendar";
import { compareDayTypes } from "./daytypes";
import {
	baselinePrefix,
	baselineProfile,
	GrammarContext,
	lr,
	paceGrammar,
	prefix,
	type SpanSums,
} from "./grammar";
import { type BandRows, bandRows, kernelW, unitOf } from "./rows";
import { bh, ridge, signFlipP } from "./stats";
import type {
	PaceBandFit,
	PaceCandidate,
	PaceCellFit,
	PaceFitState,
	PaceSeries,
} from "./types";

/**
 * The refit (sandbox model3b.ts, round-3 rule as ruled): the 101-candidate
 * grammar, selection pooled over day types with one feature per band,
 * leave-one-ISO-week-out folds, screen with a sign-flip score, BH at q = 0.10
 * and the evidence floor, a step kept only above one standard error, and per
 * hour cell a ridge strength by the one-standard-error rule and an
 * out-of-fold R^2 gate. The sandbox never ran pooled selection with the
 * 101-candidate grammar together; this does.
 */

export const Q = 0.1;
export const floorOf = (m: number) => Math.ceil(Math.log2(m / Q));
const LAMBDAS = [0, 0.03, 0.1, 0.3, 1, 3];
const MAX_FEATURES = 1;
const STEP_SE = [1, 2];
const POOL = 10;
const MIN_TRAIN = 10;

interface Fold {
	week: number;
	P: SpanSums;
}

/** Per band and fold: targets and the train/test flags of the band's rows. */
interface BandFolds {
	y: Float64Array[];
	train: Uint8Array[];
	test: Uint8Array[];
}

interface CellRows {
	ks: number[];
	w: number[];
}

interface Ridge {
	mean: number[];
	sd: number[];
	lo: number[];
	hi: number[];
	coef: number[];
	y0: number;
}

/** Weighted ridge on standardised features with training-range clips (sandbox model.ts fitRidge). */
function fitRidge(
	y: Float64Array,
	X: Float64Array[],
	tr: number[],
	tw: number[],
	lambda: number,
): Ridge {
	let W = 0;
	for (const w of tw) W += w;
	const mean = X.map((x) => {
		let s = 0;
		tr.forEach((k, i) => {
			s += (tw[i] as number) * (x[k] as number);
		});
		return s / W;
	});
	const sd = X.map((x, q) => {
		let s = 0;
		tr.forEach((k, i) => {
			s += (tw[i] as number) * ((x[k] as number) - (mean[q] as number)) ** 2;
		});
		return Math.sqrt(s / W) || 1;
	});
	let y0 = 0;
	tr.forEach((k, i) => {
		y0 += (tw[i] as number) * (y[k] as number);
	});
	y0 /= W;
	const lo = X.map((x) =>
		tr.reduce((m, k) => Math.min(m, x[k] as number), Number.POSITIVE_INFINITY),
	);
	const hi = X.map((x) =>
		tr.reduce((m, k) => Math.max(m, x[k] as number), Number.NEGATIVE_INFINITY),
	);
	const coef = X.length
		? ridge(
				tr.map((k) =>
					X.map(
						(x, q) =>
							((x[k] as number) - (mean[q] as number)) / (sd[q] as number),
					),
				),
				tr.map((k) => (y[k] as number) - y0),
				lambda,
				tw,
			)
		: [];
	return { mean, sd, lo, hi, coef, y0 };
}

function predict(f: Ridge, X: Float64Array[], k: number): number {
	let s = f.y0;
	for (let q = 0; q < X.length; q++) {
		const v = Math.min(
			f.hi[q] as number,
			Math.max(f.lo[q] as number, (X[q] as Float64Array)[k] as number),
		);
		s +=
			((f.coef[q] as number) * (v - (f.mean[q] as number))) /
			(f.sd[q] as number);
	}
	return s;
}

const meanSd = (d: number[]) => {
	const mu = d.reduce((s, x) => s + x, 0) / d.length;
	const sd = Math.sqrt(
		d.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, d.length - 1),
	);
	return { mu, sd };
};

export function fitPaceModel(series: PaceSeries, now: EpochMs): PaceFitState {
	const grammar = paceGrammar();
	const m = grammar.length;
	const floor = floorOf(m);
	const n = series.units.length;
	const cut = Math.max(
		0,
		Math.min(n, Math.floor((now - series.start) / BUCKET_MS)),
	);
	const cal = buildCalendar(series.start, cut, series.timeZone);
	const ctx = new GrammarContext(cal);
	const cutDay = cut > 0 ? (cal.dayIdx[cut - 1] as number) : 0;
	const PU = prefix(series.units, cut);
	const PC = prefix(series.censored, cut);
	const rows = bandRows(cal, cut);

	const profile = (trainDay: (d: number) => boolean) =>
		baselineProfile(
			cal,
			series.units,
			series.censored,
			PRESENT_GROUP,
			3,
			trainDay,
		);
	const sums = (prof: Float64Array[]): SpanSums => ({
		PU,
		PC,
		PB: baselinePrefix(cal, prof, PRESENT_GROUP, cut),
	});

	const weeks: number[] = [];
	const r0 = rows[0] as BandRows;
	for (let q = 0; q < r0.n; q++) {
		const w = r0.week[q] as number;
		if (weeks[weeks.length - 1] !== w && !weeks.includes(w)) weeks.push(w);
	}
	const folds: Fold[] = weeks.map((wk) => ({
		week: wk,
		P: sums(
			profile(
				(d) => (cal.days[d] as { week: number }).week !== wk && d < cutDay,
			),
		),
	}));
	const finalProfile = profile((d) => d < cutDay);
	const finalSums = sums(finalProfile);

	const bands: PaceBandFit[] = [];
	const belowFloor: PaceFitState["belowFloor"] = [];
	let cellsEstablished = 0;
	for (const R of rows) {
		const res = fitBand(cal, ctx, grammar, R, folds, finalSums, floor);
		bands.push(res.fit);
		cellsEstablished += res.fit.cells.length;
		belowFloor.push(...res.below);
	}

	const days = cal.days.filter(
		(D, d) => d < cutDay && D.end - D.first >= 270,
	).length;
	const dayTypeComparison = compareDayTypes({
		cal,
		ctx,
		units: series.units,
		censored: series.censored,
		PU,
		PC,
		cut,
		cutDay,
		weeks,
		rows,
		features: bands.map((b) => b.feature),
	});
	const baseline = {} as PaceFitState["baseline"];
	DAY_TYPES.forEach((t, g) => {
		baseline[t] = Array.from(finalProfile[g] as Float64Array);
	});
	return {
		fittedAt: now,
		days,
		weeks: weeks.length,
		candidates: m,
		floor,
		cellsEstablished,
		cellsTotal: PACE_BANDS.length * DAY_TYPES.length * 24,
		belowFloor,
		baseline,
		bands,
		selected: bands.map((b) => ({
			band: b.band,
			feature: b.feature?.id ?? null,
		})),
		dayTypeComparison,
	};
}

interface Stat {
	cand: number;
	nUnits: number;
	r2: number;
	p: number;
	/** BH rejection at q within the band's candidates. */
	bh: boolean;
	pass: boolean;
}

function fitBand(
	cal: PaceCalendar,
	ctx: GrammarContext,
	grammar: PaceCandidate[],
	R: BandRows,
	folds: Fold[],
	finalSums: SpanSums,
	floor: number,
): { fit: PaceBandFit; below: PaceFitState["belowFloor"] } {
	const id = (PACE_BANDS[R.band] as { id: string }).id;
	const inWeek = (d: number, wk: number) =>
		(cal.days[d] as { week: number }).week === wk;
	const F: BandFolds = { y: [], train: [], test: [] };
	for (const f of folds) {
		const y = new Float64Array(R.n);
		const train = new Uint8Array(R.n);
		const test = new Uint8Array(R.n);
		for (let q = 0; q < R.n; q++) {
			const a = R.a[q] as number;
			const b = R.b[q] as number;
			y[q] = lr(f.P, a, b);
			const day = R.day[q] as number;
			const touches =
				inWeek(cal.dayIdx[a] as number, f.week) ||
				inWeek(cal.dayIdx[b - 1] as number, f.week) ||
				inWeek(day, f.week);
			train[q] = touches ? 0 : 1;
			test[q] = inWeek(day, f.week) ? 1 : 0;
		}
		F.y.push(y);
		F.train.push(train);
		F.test.push(test);
	}

	const column = (c: PaceCandidate, P: SpanSums): Float64Array => {
		const x = new Float64Array(R.n);
		for (let q = 0; q < R.n; q++)
			x[q] = ctx.value(
				c,
				P,
				R.o[q] as number,
				R.a[q] as number,
				R.b[q] as number,
			);
		return x;
	};
	const cols = new Map<number, Float64Array[]>();
	const colsOf = (j: number) => {
		let c = cols.get(j);
		if (!c) {
			c = folds.map((f) => column(grammar[j] as PaceCandidate, f.P));
			cols.set(j, c);
		}
		return c;
	};

	// screen (sandbox model3b.ts screen3) on the band's one pooled selection cell
	const stats: Stat[] = grammar.map((cand, j) => {
		const X = folds.map((f) => column(cand, f.P));
		let sse0 = 0;
		let sse1 = 0;
		const unit = new Map<number, number>();
		folds.forEach((_, fi) => {
			const x = X[fi] as Float64Array;
			const y = F.y[fi] as Float64Array;
			const train = F.train[fi] as Uint8Array;
			const test = F.test[fi] as Uint8Array;
			let sx = 0;
			let sy = 0;
			let sxx = 0;
			let sxy = 0;
			let w = 0;
			for (let q = 0; q < R.n; q++) {
				if (!train[q]) continue;
				const xv = x[q] as number;
				const yv = y[q] as number;
				if (Number.isNaN(xv) || Number.isNaN(yv)) continue;
				sx += xv;
				sy += yv;
				sxx += xv * xv;
				sxy += xv * yv;
				w++;
			}
			if (w < MIN_TRAIN) return;
			const vx = sxx / w - (sx / w) ** 2;
			const beta = vx > 1e-9 ? (sxy / w - (sx / w) * (sy / w)) / vx : 0;
			const a = sy / w - beta * (sx / w);
			const y0 = sy / w;
			for (let q = 0; q < R.n; q++) {
				if (!test[q]) continue;
				const xv = x[q] as number;
				const yv = y[q] as number;
				if (Number.isNaN(xv) || Number.isNaN(yv)) continue;
				const e0 = (yv - y0) ** 2;
				const e1 = (yv - a - beta * xv) ** 2;
				sse0 += e0;
				sse1 += e1;
				const u = unitOf(R, q, cand.long);
				unit.set(u, (unit.get(u) ?? 0) + e0 - e1);
			}
		});
		const d = [...unit.values()];
		return {
			cand: j,
			nUnits: d.length,
			r2: sse0 > 0 ? 1 - sse1 / sse0 : 0,
			p: signFlipP(d),
			bh: false,
			pass: false,
		};
	});
	const rej = bh(
		stats.map((s) => s.p),
		Q,
	);
	stats.forEach((s, i) => {
		s.bh = rej.has(i);
		s.pass = s.bh && s.r2 > 0 && s.nUnits >= floor;
	});

	// blocked-CV loss of a ridge model on `sel` over the rows valid for `valid` (sandbox model3b.ts cv)
	const cv = (
		cr: CellRows,
		sel: number[],
		valid: number[],
		lambda: number,
		long: boolean,
	) => {
		let sse = 0;
		const unit = new Map<number, number>();
		const vc = valid.map(colsOf);
		const sc = sel.map(colsOf);
		folds.forEach((_, fi) => {
			const y = F.y[fi] as Float64Array;
			const ok = (k: number) =>
				!Number.isNaN(y[k] as number) &&
				vc.every((c) => !Number.isNaN((c[fi] as Float64Array)[k] as number));
			const tr: number[] = [];
			const tw: number[] = [];
			const train = F.train[fi] as Uint8Array;
			const test = F.test[fi] as Uint8Array;
			cr.ks.forEach((k, i) => {
				if (train[k] && ok(k)) {
					tr.push(k);
					tw.push(cr.w[i] as number);
				}
			});
			if (tr.length < MIN_TRAIN) return;
			const X = sc.map((c) => c[fi] as Float64Array);
			const fit = fitRidge(y, X, tr, tw, lambda);
			cr.ks.forEach((k, i) => {
				if (!test[k] || !ok(k)) return;
				const e =
					(cr.w[i] as number) * ((y[k] as number) - predict(fit, X, k)) ** 2;
				sse += e;
				const u = unitOf(R, k, long);
				unit.set(u, (unit.get(u) ?? 0) + e);
			});
		});
		return { sse, unit };
	};

	// forward selection on the pooled cell (sandbox model3b.ts select3, maxFeatures 1, pooled)
	const all: CellRows = { ks: [], w: [] };
	for (let q = 0; q < R.n; q++) {
		all.ks.push(q);
		all.w.push(1);
	}
	const pool = stats
		.filter((s) => s.pass)
		.sort((a, b) => a.p - b.p || b.r2 - a.r2)
		.slice(0, POOL)
		.map((s) => s.cand);
	let sel: number[] = [];
	const steps: { gain: number; se: number; n: number }[] = [];
	while (sel.length < MAX_FEATURES && pool.length) {
		let best: { j: number; gain: number; se: number; n: number } | null = null;
		for (const j of pool) {
			if (sel.includes(j)) continue;
			const valid = [...sel, j];
			const long = valid.some((v) => (grammar[v] as PaceCandidate).long);
			const base = cv(all, sel, valid, 0, long);
			const withJ = cv(all, valid, valid, 0, long);
			const d = [...base.unit.keys()].map(
				(u) => (base.unit.get(u) as number) - (withJ.unit.get(u) ?? 0),
			);
			if (d.length < 3) continue;
			const { mu, sd } = meanSd(d);
			const se = sd / Math.sqrt(d.length);
			if (
				mu > (STEP_SE[sel.length] as number) * se &&
				(!best || mu > best.gain)
			)
				best = { j, gain: mu, se, n: d.length };
		}
		if (!best) break;
		sel = [...sel, best.j];
		steps.push(best);
	}

	// hour cells: band x target day type x origin hour, kernel weights
	const hourCellFits = (sel: number[]): PaceCellFit[] => {
		const cells: PaceCellFit[] = [];
		if (!sel.length) return cells;
		const long = sel.some((v) => (grammar[v] as PaceCandidate).long);
		const hourCells = new Map<number, CellRows>();
		for (let q = 0; q < R.n; q++)
			for (let h = 0; h < 24; h++) {
				const w = kernelW(R.minute[q] as number, h);
				if (w <= 0) continue;
				const key = (R.cls[q] as number) * 24 + h;
				let c = hourCells.get(key);
				if (!c) {
					c = { ks: [], w: [] };
					hourCells.set(key, c);
				}
				c.ks.push(q);
				c.w.push(w);
			}
		const finalX = sel.map((j) =>
			column(grammar[j] as PaceCandidate, finalSums),
		);
		const finalY = new Float64Array(R.n);
		for (let q = 0; q < R.n; q++)
			finalY[q] = lr(finalSums, R.a[q] as number, R.b[q] as number);
		for (const key of [...hourCells.keys()].sort((a, b) => a - b)) {
			const cr = hourCells.get(key) as CellRows;
			const res = LAMBDAS.map((l) => cv(cr, sel, sel, l, long));
			const nul = cv(cr, [], sel, 0, long);
			const bestI = res.reduce(
				(bi, r, i) => (r.sse < (res[bi] as { sse: number }).sse ? i : bi),
				0,
			);
			const bestRes = res[bestI] as { unit: Map<number, number> };
			const units = [...bestRes.unit.keys()];
			let lambda = 0;
			let r2 = 0;
			for (let i = LAMBDAS.length - 1; i >= 0; i--) {
				const ri = res[i] as { sse: number; unit: Map<number, number> };
				const d = units.map(
					(u) => (ri.unit.get(u) as number) - (bestRes.unit.get(u) as number),
				);
				const { mu, sd } = meanSd(d);
				if (mu <= sd / Math.sqrt(d.length)) {
					lambda = LAMBDAS[i] as number;
					r2 = 1 - ri.sse / nul.sse;
					break;
				}
			}
			if (!(r2 > 0)) continue;
			// final fit on all rows before the cut (sandbox model3b.ts finalFit3)
			const tr: number[] = [];
			const tw: number[] = [];
			cr.ks.forEach((k, i) => {
				if (
					!Number.isNaN(finalY[k] as number) &&
					finalX.every((x) => !Number.isNaN(x[k] as number))
				) {
					tr.push(k);
					tw.push(cr.w[i] as number);
				}
			});
			if (!tr.length) continue;
			const fit = fitRidge(finalY, finalX, tr, tw, lambda);
			cells.push({
				dayType: DAY_TYPES[Math.floor(key / 24)] as PaceCellFit["dayType"],
				hour: key % 24,
				lambda,
				r2,
				mean: fit.mean[0] as number,
				sd: fit.sd[0] as number,
				lo: fit.lo[0] as number,
				hi: fit.hi[0] as number,
				coef: fit.coef[0] as number,
				y0: fit.y0,
				rows: tr.length,
			});
		}
		return cells;
	};
	const cells = hourCellFits(sel);

	const step = steps[0];
	const feature =
		sel.length && cells.length
			? (grammar[sel[0] as number] as PaceCandidate)
			: null;
	const below: PaceFitState["belowFloor"] = [];
	if (!feature) {
		// Passed every screening test but the evidence floor: BH and positive out-of-fold R^2.
		// Listed per hour cell that would pass the same per-cell gate once selected.
		const cand = stats
			.filter((s) => s.bh && s.r2 > 0 && s.nUnits < floor)
			.sort((a, b) => a.p - b.p || b.r2 - a.r2)[0];
		if (cand)
			for (const c of hourCellFits([cand.cand]))
				below.push({
					band: id,
					feature: (grammar[cand.cand] as PaceCandidate).id,
					units: cand.nUnits,
					dayType: c.dayType,
					hour: c.hour,
				});
	}
	return {
		fit: {
			band: id,
			feature,
			gainSE: feature && step ? step.gain / step.se : null,
			units: feature && step ? step.n : null,
			cells: feature ? cells : [],
		},
		below,
	};
}
