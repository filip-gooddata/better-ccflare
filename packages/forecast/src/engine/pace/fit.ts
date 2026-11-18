import { BUCKET_MS, type EpochMs } from "../../types";
import { PACE_BANDS } from "./bands";
import {
	buildCalendar,
	DAY_TYPES,
	groupNames,
	isPresentGroup,
	normalizeGroup,
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

/** A fold of the out-of-fold served loss: held-out week, the days its test targets span, baseline without them. */
interface ScoreFold extends Fold {
	lo: number;
	hi: number;
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

export function fitPaceModel(
	series: PaceSeries,
	now: EpochMs,
	partition: ArrayLike<number> = PRESENT_GROUP,
): PaceFitState {
	const present = isPresentGroup(partition);
	const group: ArrayLike<number> = present
		? PRESENT_GROUP
		: normalizeGroup(partition);
	const names: string[] = present ? [...DAY_TYPES] : groupNames(group);
	const grammar = paceGrammar();
	const m = grammar.length;
	const floor = floorOf(m);
	const n = series.units.length;
	const cut = Math.max(
		0,
		Math.min(n, Math.floor((now - series.start) / BUCKET_MS)),
	);
	const cal = buildCalendar(series.start, cut, series.timeZone, group);
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
			group,
			names.length,
			trainDay,
		);
	const sums = (prof: Float64Array[]): SpanSums => ({
		PU,
		PC,
		PB: baselinePrefix(cal, prof, group, cut),
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
	// Scoring folds of the out-of-fold served loss: the held-out week's targets
	// reach up to a week past it, so the baseline and the refitted cells train
	// without every local day from the week's first to the last day any of its
	// test rows' targets touch (E4's selection folds above are unchanged).
	const support = new Map<number, [number, number]>();
	for (const R of rows)
		for (let q = 0; q < R.n; q++) {
			const wk = R.week[q] as number;
			const lo = R.day[q] as number;
			const hi = cal.dayIdx[(R.b[q] as number) - 1] as number;
			const s = support.get(wk);
			if (!s) support.set(wk, [lo, hi]);
			else support.set(wk, [Math.min(s[0], lo), Math.max(s[1], hi)]);
		}
	const scoreFolds: ScoreFold[] = weeks.map((wk) => {
		const [lo, hi] = support.get(wk) as [number, number];
		return {
			week: wk,
			lo,
			hi,
			P: sums(profile((d) => (d < lo || d > hi) && d < cutDay)),
		};
	});

	const bands: PaceBandFit[] = [];
	const belowFloor: PaceFitState["belowFloor"] = [];
	let cellsEstablished = 0;
	const oofByUnit = new Map<number, number>();
	for (const R of rows) {
		const res = fitBand(
			cal,
			ctx,
			grammar,
			R,
			folds,
			finalSums,
			floor,
			names,
			scoreFolds,
		);
		bands.push(res.fit);
		cellsEstablished += res.fit.cells.length;
		belowFloor.push(...res.below);
		for (const [u, l] of res.oof) oofByUnit.set(u, (oofByUnit.get(u) ?? 0) + l);
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
	names.forEach((t, g) => {
		baseline[t] = Array.from(finalProfile[g] as Float64Array);
	});
	return {
		fittedAt: now,
		days,
		weeks: weeks.length,
		candidates: m,
		floor,
		cellsEstablished,
		cellsTotal: PACE_BANDS.length * names.length * 24,
		belowFloor,
		baseline,
		bands,
		selected: bands.map((b) => ({
			band: b.band,
			feature: b.feature?.id ?? null,
		})),
		dayTypeComparison,
		oof: (() => {
			const units = [...oofByUnit.keys()].sort((a, b) => a - b);
			return { units, loss: units.map((u) => oofByUnit.get(u) as number) };
		})(),
		...(present ? {} : { dayTypes: { names, group: Array.from(group) } }),
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
	names: string[],
	scoreFolds: ScoreFold[],
): {
	fit: PaceBandFit;
	below: PaceFitState["belowFloor"];
	oof: Map<number, number>;
} {
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
				dayType: names[Math.floor(key / 24)] as string,
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
	// Out-of-fold loss of the SERVED band, as applyPace serves it: a test row's
	// prediction is the multiplier exponent coef * (clip(x) - mean) / sd (no
	// intercept) of the cell (target group, origin hour) refitted on the fold's
	// training rows at the cell's lambda (scoring folds: baseline and training
	// rows clear of every day the held-out week's targets touch); the plain line (0) when the band has no
	// feature, the cell is not served, the feature is missing or the fold is too
	// small. Summed per ISO week (the held-out fold).
	const oof = new Map<number, number>();
	const served = new Map<number, number>();
	if (feature)
		for (const c of cells)
			served.set(names.indexOf(c.dayType) * 24 + c.hour, c.lambda);
	const cellRows = new Map<number, CellRows>();
	if (served.size)
		for (let q = 0; q < R.n; q++)
			for (const key of served.keys()) {
				const w = kernelW(R.minute[q] as number, key % 24);
				if (w <= 0 || (R.cls[q] as number) !== Math.floor(key / 24)) continue;
				let c = cellRows.get(key);
				if (!c) {
					c = { ks: [], w: [] };
					cellRows.set(key, c);
				}
				c.ks.push(q);
				c.w.push(w);
			}
	for (const f of scoreFolds) {
		// targets and feature against this fold's baseline; training rows touch no day of [lo, hi]
		const y = new Float64Array(R.n);
		const train = new Uint8Array(R.n);
		const test = F.test[
			folds.findIndex((g) => g.week === f.week)
		] as Uint8Array;
		for (let q = 0; q < R.n; q++) {
			const a = R.a[q] as number;
			const b = R.b[q] as number;
			y[q] = lr(f.P, a, b);
			const from = Math.min(R.day[q] as number, cal.dayIdx[a] as number);
			const to = cal.dayIdx[b - 1] as number;
			train[q] = to < f.lo || from > f.hi ? 1 : 0;
		}
		const x = feature ? column(feature, f.P) : null;
		const fits = new Map<number, Ridge | null>();
		const fitOf = (key: number): Ridge | null => {
			if (fits.has(key)) return fits.get(key) as Ridge | null;
			const cr = cellRows.get(key);
			let r: Ridge | null = null;
			if (cr && x) {
				const tr: number[] = [];
				const tw: number[] = [];
				cr.ks.forEach((k, i) => {
					if (
						train[k] &&
						!Number.isNaN(y[k] as number) &&
						!Number.isNaN(x[k] as number)
					) {
						tr.push(k);
						tw.push(cr.w[i] as number);
					}
				});
				if (tr.length >= MIN_TRAIN)
					r = fitRidge(y, [x], tr, tw, served.get(key) as number);
			}
			fits.set(key, r);
			return r;
		};
		const u = -1 - f.week;
		for (let q = 0; q < R.n; q++) {
			if (!test[q]) continue;
			const yv = y[q] as number;
			if (Number.isNaN(yv)) continue;
			let yhat = 0;
			if (x && !Number.isNaN(x[q] as number)) {
				const key =
					(R.cls[q] as number) * 24 +
					(Math.round((R.minute[q] as number) / 60) % 24);
				const r = served.has(key) ? fitOf(key) : null;
				if (r) {
					const xc = Math.min(
						r.hi[0] as number,
						Math.max(r.lo[0] as number, x[q] as number),
					);
					yhat =
						((r.coef[0] as number) * (xc - (r.mean[0] as number))) /
						(r.sd[0] as number);
				}
			}
			oof.set(u, (oof.get(u) ?? 0) + (yv - yhat) ** 2);
		}
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
		oof,
	};
}
