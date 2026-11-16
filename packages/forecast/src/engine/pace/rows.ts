import { PACE_BANDS } from "./bands";
import type { PaceCalendar } from "./calendar";

/** Origin clock hour cells weight rows by a triangular kernel of half-width 3 h (sandbox lib.ts kernelW). */
export const KERNEL_H = 3;
export function kernelW(minute: number, hour: number): number {
	let d = Math.abs(minute / 60 - hour);
	d = Math.min(d, 24 - d);
	return Math.max(0, 1 - d / KERNEL_H);
}

/** Rows of one distance band: origins every 30 minutes whose target [a, b) ends by the cut (sandbox model.ts rows). */
export interface BandRows {
	band: number;
	/** Evidence counted in weeks for every candidate (bands from 1 d). */
	weekUnits: boolean;
	n: number;
	o: Int32Array;
	a: Int32Array;
	b: Int32Array;
	/** Present day type of the target's first bucket. */
	cls: Uint8Array;
	/** Weekday (0 = Monday) of the target's first bucket. */
	wd: Uint8Array;
	minute: Int16Array;
	day: Int32Array;
	week: Int32Array;
}

export function bandRows(cal: PaceCalendar, cut: number): BandRows[] {
	return PACE_BANDS.map((band, k) => {
		const from = band.fromMin / 5;
		const to = band.toMin / 5;
		const origins: number[] = [];
		for (let o = 0; o < cut; o++)
			if ((cal.minute[o] as number) % 30 === 0 && o + to <= cut)
				origins.push(o);
		const n = origins.length;
		const r: BandRows = {
			band: k,
			weekUnits: band.fromMin >= 1440,
			n,
			o: Int32Array.from(origins),
			a: new Int32Array(n),
			b: new Int32Array(n),
			cls: new Uint8Array(n),
			wd: new Uint8Array(n),
			minute: new Int16Array(n),
			day: new Int32Array(n),
			week: new Int32Array(n),
		};
		origins.forEach((o, q) => {
			const a = o + from;
			r.a[q] = a;
			r.b[q] = o + to;
			r.cls[q] = cal.dtype[a] as number;
			r.wd[q] = cal.wd[a] as number;
			r.minute[q] = cal.minute[o] as number;
			const d = cal.dayIdx[o] as number;
			r.day[q] = d;
			r.week[q] = (cal.days[d] as { week: number }).week;
		});
		return r;
	});
}

/** Unit of independence of a row: its week for week-scale candidates or bands from 1 d, else its day. */
export const unitOf = (r: BandRows, q: number, long: boolean): number =>
	long || r.weekUnits ? -1 - (r.week[q] as number) : (r.day[q] as number);
