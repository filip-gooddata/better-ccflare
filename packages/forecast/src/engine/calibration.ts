/**
 * Calibration (design 4.3): points of a limit per demand unit, per account and
 * limit, as a recency-weighted ratio of sums over window instances.
 */
import type {
	AccountDemandBucket,
	AccountId,
	AccountLimits,
	Calibration,
	EpochMs,
	ForecastInput,
	LimitReading,
	LimitWindow,
} from "../types";
import { BUCKET_MS } from "../types";

const DAY_MS = 86_400_000;

/** Least summed rise (unweighted points) for an account's own k: readings are whole percents, so below 5 points one rounding step is 10 % or more of the evidence. */
export const MIN_CALIBRATION_POINTS = 5;
/** The weighted unit sum must exceed this for an account's own k (a ratio needs a positive denominator). */
export const MIN_CALIBRATION_UNITS = 0;

/**
 * How far a reading's resetsAt may lie from its window instance's first reading and still
 * belong to it. The upstream sends one window's reset time with sub-second jitter (measured:
 * at most about 1 s), while a real new window moves it by hours (5-hour limit) or days
 * (weekly limits). Comparing with the instance's first reading, not the previous one, keeps
 * a slow drift from chaining two windows together.
 */
export const RESET_TIME_TOLERANCE_MS = 60_000;

/** Recency weight of something ageDays old: 0.5^(age / half-life) (exponential forgetting). */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
	if (!(halfLifeDays > 0)) return 1;
	return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

const LIMITS: { window: LimitWindow; key: keyof Calibration }[] = [
	{ window: "five_hour", key: "fiveHour" },
	{ window: "seven_day", key: "weekly" },
	{ window: "seven_day_fable", key: "fable" },
];

interface Evidence {
	/** Window instances inside the lookback with at least two readings. */
	instances: number;
	points: number;
	weightedPoints: number;
	weightedUnits: number;
	/** First reading of the oldest and last reading of the newest counted instance. */
	oldestAt: EpochMs | null;
	newestAt: EpochMs | null;
}

/** Demand of sorted buckets inside [from, to), each bucket counted by its proportional overlap. */
function unitsBetween(
	buckets: AccountDemandBucket[],
	from: EpochMs,
	to: EpochMs,
	fable: boolean,
): number {
	let lo = 0;
	let hi = buckets.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((buckets[mid] as AccountDemandBucket).start + BUCKET_MS <= from)
			lo = mid + 1;
		else hi = mid;
	}
	let sum = 0;
	for (let i = lo; i < buckets.length; i++) {
		const b = buckets[i] as AccountDemandBucket;
		if (b.start >= to) break;
		const overlap = Math.min(b.start + BUCKET_MS, to) - Math.max(b.start, from);
		if (overlap > 0)
			sum += ((fable ? b.fableUnits : b.units) * overlap) / BUCKET_MS;
	}
	return sum;
}

function ownK(e: Evidence | undefined): number | null {
	if (
		!e ||
		e.points < MIN_CALIBRATION_POINTS ||
		!(e.weightedUnits > MIN_CALIBRATION_UNITS)
	)
		return null;
	return e.weightedPoints / e.weightedUnits;
}

/** `cur` continues the window instance that `head` opened and `prev` last extended (amendment 3, C1). */
function sameInstance(
	head: LimitReading,
	prev: LimitReading,
	cur: LimitReading,
): boolean {
	return (
		head.resetsAt !== null &&
		cur.resetsAt !== null &&
		Math.abs(cur.resetsAt - head.resetsAt) <= RESET_TIME_TOLERANCE_MS &&
		cur.usedPct >= prev.usedPct
	);
}

/**
 * k = Σ w·Δpoints ÷ Σ w·units over window instances (ratio of sums, not a mean of
 * ratios). A window instance is a maximal run of consecutive readings of one account
 * and limit whose resetsAt is non-null and within RESET_TIME_TOLERANCE_MS of the run's
 * first reading, and whose level never falls (a fall means the upstream counter was
 * reset inside the window; each side is its own evidence). Δpoints = last − first, never negative;
 * units = the account's proxy-sourced demand between the two readings; w = the
 * recency weight of the instance's last reading. Instances ending before the
 * lookback are ignored. A missing k falls back to the largest own k of the other
 * counted accounts (with two accounts: the other one's; the largest errs on the
 * safe side). Five-hour and weekly without any k: the key is missing. Fable
 * without any k: null.
 */
export function calibrate(
	input: ForecastInput,
	counted: AccountLimits[],
): Calibration {
	return calibrateWithEvidence(input, counted).calibration;
}

/** What one account's limit gave the calibration: the numbers its own-k rule compares. */
export interface LimitEvidence {
	accountId: AccountId;
	window: LimitWindow;
	instances: number;
	/** Summed rise, unweighted (against MIN_CALIBRATION_POINTS). */
	points: number;
	/** Recency-weighted unit sum (must exceed MIN_CALIBRATION_UNITS). */
	units: number;
	/** The account's own k, or null when it borrows one or has none. */
	ownK: number | null;
	/** First reading of the oldest and last reading of the newest counted instance. */
	oldestAt: EpochMs | null;
	newestAt: EpochMs | null;
}

/** `calibrate` plus the evidence per counted account and limit, for saying why there is no k. */
export function calibrateWithEvidence(
	input: ForecastInput,
	counted: AccountLimits[],
): { calibration: Calibration; evidence: LimitEvidence[] } {
	const ids = new Set(counted.map((a) => a.accountId));
	const halfLife = input.settings.historyHalfLifeDays;
	const since = input.now - input.settings.historyLookbackDays * DAY_MS;

	const buckets = new Map<AccountId, AccountDemandBucket[]>();
	for (const b of input.accountHistory) {
		if (!ids.has(b.accountId)) continue;
		let list = buckets.get(b.accountId);
		if (!list) {
			list = [];
			buckets.set(b.accountId, list);
		}
		list.push(b);
	}
	for (const list of buckets.values()) list.sort((x, y) => x.start - y.start);

	const series = new Map<string, LimitReading[]>();
	for (const r of input.readings) {
		if (!ids.has(r.accountId)) continue;
		const key = `${r.accountId}\u0000${r.window}`;
		let list = series.get(key);
		if (!list) {
			list = [];
			series.set(key, list);
		}
		list.push(r);
	}

	const evidence = new Map<string, Evidence>();
	for (const [key, list] of series) {
		list.sort((x, y) => x.at - y.at);
		const first = list[0] as LimitReading;
		const own = buckets.get(first.accountId) ?? [];
		const fable = first.window === "seven_day_fable";
		const e: Evidence = {
			instances: 0,
			points: 0,
			weightedPoints: 0,
			weightedUnits: 0,
			oldestAt: null,
			newestAt: null,
		};
		let runStart = 0;
		for (let i = 1; i <= list.length; i++) {
			const prev = list[i - 1] as LimitReading;
			const cur = list[i];
			const head = list[runStart] as LimitReading;
			if (cur && sameInstance(head, prev, cur)) continue;
			runStart = i;
			if (head.resetsAt === null || prev === head || prev.at < since) continue;
			const delta = Math.max(0, prev.usedPct - head.usedPct);
			const units = unitsBetween(own, head.at, prev.at, fable);
			const w = recencyWeight((input.now - prev.at) / DAY_MS, halfLife);
			e.instances++;
			e.points += delta;
			e.weightedPoints += w * delta;
			e.weightedUnits += w * units;
			if (e.oldestAt === null || head.at < e.oldestAt) e.oldestAt = head.at;
			if (e.newestAt === null || prev.at > e.newestAt) e.newestAt = prev.at;
		}
		evidence.set(key, e);
	}

	const result: Calibration = { fiveHour: {}, weekly: {}, fable: {} };
	const report: LimitEvidence[] = [];
	for (const { window, key } of LIMITS) {
		const own = new Map<AccountId, number | null>();
		for (const a of counted) {
			const e = evidence.get(`${a.accountId}\u0000${window}`);
			const k = ownK(e);
			own.set(a.accountId, k);
			report.push({
				accountId: a.accountId,
				window,
				instances: e?.instances ?? 0,
				points: e?.points ?? 0,
				units: e?.weightedUnits ?? 0,
				ownK: k,
				oldestAt: e?.oldestAt ?? null,
				newestAt: e?.newestAt ?? null,
			});
		}
		for (const a of counted) {
			let k = own.get(a.accountId) ?? null;
			if (k === null) {
				for (const [id, other] of own)
					if (id !== a.accountId && other !== null && (k === null || other > k))
						k = other;
			}
			if (key === "fable") result.fable[a.accountId] = k;
			else if (k !== null) result[key][a.accountId] = k;
		}
	}
	return { calibration: result, evidence: report };
}
