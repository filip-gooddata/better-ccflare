import { BUCKET_MS } from "../../types";
import type { PaceSeries, PaceSeriesInput } from "./types";

/** A bucket is censored when every account reads at least this on its five_hour or seven_day window. */
export const CENSOR_PCT = 99.5;

/**
 * Pooled five-minute demand and censoring over [historyFrom, now) (sandbox lib.ts loadSeries).
 * A reading holds from its time until its reset; readings before historyFrom carry in.
 */
export function buildPaceSeries(input: PaceSeriesInput): PaceSeries {
	const start = Math.floor(input.historyFrom / BUCKET_MS) * BUCKET_MS;
	const n = Math.max(0, Math.ceil((input.now - start) / BUCKET_MS));
	const units = new Float64Array(n);
	for (const h of input.history) {
		const i = Math.floor((h.start - start) / BUCKET_MS);
		if (i >= 0 && i < n) units[i] = (units[i] as number) + h.units;
	}
	const censored = new Uint8Array(n);
	const R = input.readings
		.filter((r) => r.window === "five_hour" || r.window === "seven_day")
		.sort((a, b) => a.at - b.at);
	const accounts = input.accounts.length
		? input.accounts
		: [...new Set(R.map((r) => r.accountId))];
	if (accounts.length && R.length) {
		const state = new Map<string, { pct: number; resetsAt: number | null }>();
		let k = 0;
		for (let i = 0; i < n; i++) {
			const t = start + i * BUCKET_MS + BUCKET_MS / 2;
			while (k < R.length && (R[k] as { at: number }).at <= t) {
				const r = R[k] as (typeof R)[number];
				state.set(`${r.accountId}/${r.window}`, {
					pct: r.usedPct,
					resetsAt: r.resetsAt,
				});
				k++;
			}
			const out = accounts.every((a) =>
				["five_hour", "seven_day"].some((w) => {
					const s = state.get(`${a}/${w}`);
					return (
						!!s &&
						s.pct >= CENSOR_PCT &&
						(s.resetsAt === null || t < s.resetsAt)
					);
				}),
			);
			if (out) censored[i] = 1;
		}
	}
	return { start, units, censored, timeZone: input.timeZone };
}
