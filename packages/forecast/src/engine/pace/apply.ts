import { BUCKET_MS, type EpochMs } from "../../types";
import { PACE_BANDS, plainPace } from "./bands";
import { buildCalendar, DAY_TYPES, PRESENT_GROUP } from "./calendar";
import {
	baselinePrefix,
	GrammarContext,
	prefix,
	type SpanSums,
} from "./grammar";
import type { PaceFitState, PaceNow, PaceSeries } from "./types";

/**
 * Applies a fitted state at `now` (sandbox mech.ts e4Bands / model3b.ts e4Bands3):
 * per band, the hour cell of the target's day type and the origin hour; the
 * selected feature from the series before now against the state's baseline,
 * clipped to the cell's training range; m = exp(coef * (clip(x) - mean) / sd).
 * A band without an established cell or with a censored or missing feature is a plain line.
 */
export function applyPace(
	state: PaceFitState | null,
	series: PaceSeries,
	now: EpochMs,
	enabled: boolean,
): PaceNow {
	if (!enabled) return plainPace("off");
	if (!state) return plainPace("unfitted");
	const out = plainPace("fitted", state.fittedAt);
	const o = Math.max(
		0,
		Math.min(series.units.length, Math.floor((now - series.start) / BUCKET_MS)),
	);
	const last = PACE_BANDS[PACE_BANDS.length - 1] as { toMin: number };
	const cal = buildCalendar(
		series.start,
		o + last.toMin / 5 + 1,
		series.timeZone,
	);
	const ctx = new GrammarContext(cal);
	const profile = DAY_TYPES.map((t) => state.baseline[t]);
	const P: SpanSums = {
		PU: prefix(series.units, o),
		PC: prefix(series.censored, o),
		PB: baselinePrefix(cal, profile, PRESENT_GROUP, o),
	};
	const hour = Math.round((cal.minute[o] as number) / 60) % 24;
	state.bands.forEach((fit, k) => {
		const band = PACE_BANDS[k];
		const c = fit.feature;
		if (!band || !c) return;
		const a = o + band.fromMin / 5;
		const b = o + band.toMin / 5;
		const dayType = DAY_TYPES[cal.dtype[a] as number];
		const cell = fit.cells.find(
			(x) => x.dayType === dayType && x.hour === hour,
		);
		if (!cell) return;
		const x = ctx.value(c, P, o, a, b);
		if (Number.isNaN(x)) return;
		const xc = Math.min(cell.hi, Math.max(cell.lo, x));
		out.bands[k] = {
			band: band.id,
			centreMin: band.centreMin,
			m: Math.exp((cell.coef * (xc - cell.mean)) / cell.sd),
			feature: c.id,
			ratio: c.family === "T" ? x : Math.exp(x),
			coef: cell.coef,
			clipped: x < cell.lo || x > cell.hi,
			lambda: cell.lambda,
		};
	});
	return out;
}
