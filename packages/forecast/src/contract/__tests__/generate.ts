import type { ForecastBlock, ForecastResponse } from "../../types";
import { fanKey, fanLevelsForCount } from "../levels";

const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";
const FIVE_MIN = 5 * 60_000;
const HOUR = 3_600_000;

/**
 * A synthetic, full-size block: `points` time points with one exact jump in
 * the middle, every level from p10 to p90 (named and fan) monotone in the
 * percentile at every index, and one heavy stop that the typical line also
 * reaches inside.
 */
function block(
	computedAt: number,
	step: number,
	points: number,
	fanLevels: readonly number[],
): ForecastBlock {
	const times: number[] = [computedAt];
	const jumpAt = Math.floor(points / 2);
	for (let i = 1; times.length < points; i++) {
		const t = computedAt + i * step;
		times.push(t);
		if (times.length === jumpAt) times.push(t);
	}
	const jumpTime = times[jumpAt];
	const depth = (p: number) => 20 + p; // higher percentile → lower line
	const line = (p: number) =>
		times.map((t, i) => {
			if (i === 0) return 150;
			if (t < jumpTime || (t === jumpTime && i === jumpAt - 1)) {
				const fall = 150 - (depth(p) * i * 4) / jumpAt;
				return Math.max(0, Math.round(fall * 10) / 10);
			}
			return Math.round((200 - (p * (i - jumpAt)) / points) * 10) / 10;
		});
	const fan: Record<string, number[]> = {};
	for (const p of fanLevels) fan[fanKey(p)] = line(p);
	const heavy = line(90);
	const typical = line(50);
	const firstZero = (values: number[]) => values.indexOf(0);
	const heavyZero = firstZero(heavy);
	const typicalZero = firstZero(typical);
	return {
		past: {
			times: [computedAt - 2 * HOUR, computedAt - HOUR, computedAt],
			values: [200, 180, 150],
		},
		times,
		light: line(10),
		typical,
		heavy,
		fan,
		stops: {
			light: [],
			typical:
				typicalZero > 0 ? [{ start: times[typicalZero], end: jumpTime }] : [],
			heavy: heavyZero > 0 ? [{ start: times[heavyZero], end: jumpTime }] : [],
		},
		stopNow: null,
		pastStops: [],
		shortfall:
			typicalZero > 0
				? {
						stop: { start: times[typicalZero], end: jumpTime },
						points: 12.5,
						lastAccount: ACCOUNT_B,
						perAccount: { [ACCOUNT_B]: 6, [ACCOUNT_A]: 6.5 },
					}
				: null,
	};
}

/** A full-size response with 41 lines (a fan of 38 levels unless given), about 300 day and 170 week points. */
export function generateFullResponse(
	fanLevels: readonly number[] = fanLevelsForCount(38),
): ForecastResponse {
	const computedAt = Date.UTC(2026, 10, 12, 12, 20);
	return {
		contractVersion: 1,
		computedAt,
		available: true,
		reason: null,
		accounts: [ACCOUNT_A, ACCOUNT_B],
		levels: { light: 10, typical: 50, heavy: 90 },
		day: block(computedAt, FIVE_MIN, 300, fanLevels),
		week: block(computedAt, HOUR, 170, fanLevels),
		fable: {
			[ACCOUNT_A]: { outAt: null },
			[ACCOUNT_B]: { outAt: computedAt + 30 * HOUR },
		},
		prewarm: {
			enabled: false,
			planned: [{ accountId: ACCOUNT_A, openAt: computedAt + HOUR }],
			last: [
				{
					accountId: ACCOUNT_A,
					kind: "test",
					scheduledAt: computedAt - HOUR,
					firedAt: computedAt - HOUR + 2_000,
					exitCode: 0,
					windowOpened: true,
					resetsAt: computedAt + 4 * HOUR,
				},
			],
		},
	};
}
