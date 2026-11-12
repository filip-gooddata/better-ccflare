/**
 * Scenario-based receding-horizon search scored by the lowest point (design 4.7): candidate plans
 * are simulated over all simulated days and ranked leximin on the heavy lines; the first step of
 * the best plan is applied and the search runs again at the next usage poll.
 */
import { quantileSorted } from "simple-statistics";
import { addLocalDays, atLocalMinute, localDayStart } from "../time";
import type { EpochMs, MoveAdvice, PlacementAdvice, Plan } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { moveCostUnits } from "./move-cost";
import { levelLines } from "./percentile";
import {
	isOpenNow,
	onDemandPlan,
	type SimPlan,
	simulate,
	warmSessions,
} from "./simulate";
import { yieldToEventLoop } from "./yield";

const MINUTE_MS = 60_000;
/** The planner plans against the heavy day: 90th percentile of demand (settled decision 3). */
const HEAVY_LEVEL = 90;
/** Typical day: 50th percentile of demand (score item 4). */
const TYPICAL_LEVEL = 50;
/** A level line at or below this many points counts as zero (it rounds to 0.0 in the response). */
const ZERO_LINE_POINTS = 0.05;
/** Scores closer than this (shares of the pool) are equal: float noise, not a difference. */
const SCORE_EPS = 1e-9;
/** Openings tried, minutes after now: now and the next few hours, enough to place a 5-hour window across a work day. */
const OPEN_AHEAD_MIN = [0, 30, 60, 120, 180, 240] as const;
/** With pre-warm on, openings also tried this many minutes before the learned work start: reaches across the night. */
const OPEN_BEFORE_WORK_START_MIN = [300, 240, 180, 120, 60] as const;
/** Most live sessions tried as move candidates (largest recent use first): keeps the search bounded. */
const MAX_MOVE_SESSIONS = 3;
/** Placement tiers: accounts whose best plans differ by at most this many points on items 1, 2 and 4 share a tier. */
const TIER_TOLERANCE_POINTS = 0.5;
/** Placement tiers: and by at most this many minutes of heavy stops (score item 3). */
const TIER_TOLERANCE_STOP_MIN = 5;
/** Gains below this many points are not named in a placement reason. */
const REASON_MIN_GAIN_POINTS = 0.05;

/** Leximin score of one plan; shares are of the pool (100 × counted accounts). */
export interface PlanScore {
	/** Item 1: the smaller of the heavy 5-hour (next 24 h) and heavy weekly (week horizon) low-point shares. */
	item1: number;
	/** Item 2: the other one. */
	item2: number;
	/** Item 3: minutes of heavy stops in which demand goes unserved. */
	stopMinutes: number;
	/** Item 4: the smaller low-point share on the typical lines. */
	typicalShare: number;
	/** Heavy 5-hour low point over the next 24 h, in points. */
	dayLowPoints: number;
	/** Heavy weekly low point over the week horizon, in points. */
	weekLowPoints: number;
	/** 100 × counted accounts. */
	poolPoints: number;
}

/**
 * Unserved demand units as points: units × the mean 5-hour k of the counted accounts (the points the
 * pool would have spent on them). Used for `minStopPoints`.
 */
export function unservedPoints(ctx: EngineContext, units: number): number {
	const ks = ctx.accounts.map(
		(a) => ctx.calibration.fiveHour[a.accountId] ?? 0,
	);
	const mean = ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : 0;
	return units * mean;
}

function lowestUntil(
	line: Float64Array,
	times: EpochMs[],
	until: EpochMs,
): number {
	let low = Number.POSITIVE_INFINITY;
	for (let i = 0; i < times.length && times[i] <= until; i++)
		if (line[i] < low) low = line[i];
	return Number.isFinite(low) ? low : 0;
}

/** Heavy unserved demand per sample: the 90th percentile of unserved units over the simulated days. */
function heavyUnserved(result: SimulationResult, length: number): Float64Array {
	const out = new Float64Array(length);
	const column = new Float64Array(result.traces.length);
	if (column.length === 0) return out;
	for (let i = 0; i < length; i++) {
		for (let s = 0; s < column.length; s++)
			column[s] = result.traces[s].unserved[i];
		column.sort();
		out[i] = quantileSorted(column as unknown as number[], HEAVY_LEVEL / 100);
	}
	return out;
}

/** Leximin items 1 to 4 of design 4.7 for one simulated plan. */
export function scorePlan(
	ctx: EngineContext,
	result: SimulationResult,
): PlanScore {
	const times = result.axis.times;
	const length = times.length;
	const poolPoints = 100 * ctx.accounts.length;
	const [heavyDay, typicalDay] = levelLines(
		result.traces.map((t) => t.day),
		length,
		[HEAVY_LEVEL, TYPICAL_LEVEL],
	);
	const [heavyWeek, typicalWeek] = levelLines(
		result.traces.map((t) => t.week),
		length,
		[HEAVY_LEVEL, TYPICAL_LEVEL],
	);
	const { fineEnd, weekEnd } = ctx.horizon;
	const dayLowPoints = lowestUntil(heavyDay, times, fineEnd);
	const weekLowPoints = lowestUntil(heavyWeek, times, weekEnd);
	const share = (points: number) => (poolPoints > 0 ? points / poolPoints : 0);
	const dayShare = share(dayLowPoints);
	const weekShare = share(weekLowPoints);
	const typicalShare = Math.min(
		share(lowestUntil(typicalDay, times, fineEnd)),
		share(lowestUntil(typicalWeek, times, weekEnd)),
	);

	// Heavy stops: maximal runs where the heavy 5-hour line is zero, counted only when the heavy
	// unserved demand inside them reaches minStopPoints.
	const unserved = heavyUnserved(result, length);
	const minStop = ctx.input.settings.minStopPoints;
	let stopMinutes = 0;
	let i = 1;
	while (i < length) {
		if (heavyDay[i - 1] > ZERO_LINE_POINTS || heavyDay[i] > ZERO_LINE_POINTS) {
			i++;
			continue;
		}
		const runStart = times[i - 1];
		let runUnserved = 0;
		while (
			i < length &&
			heavyDay[i - 1] <= ZERO_LINE_POINTS &&
			heavyDay[i] <= ZERO_LINE_POINTS
		) {
			runUnserved += unserved[i];
			i++;
		}
		if (unservedPoints(ctx, runUnserved) >= minStop)
			stopMinutes += (times[i - 1] - runStart) / MINUTE_MS;
	}
	return {
		item1: Math.min(dayShare, weekShare),
		item2: Math.max(dayShare, weekShare),
		stopMinutes,
		typicalShare,
		dayLowPoints,
		weekLowPoints,
		poolPoints,
	};
}

/** Leximin order: negative when `a` is the better plan (sorts first), positive when `b` is. */
export function compareScores(a: PlanScore, b: PlanScore): number {
	if (Math.abs(a.item1 - b.item1) > SCORE_EPS) return b.item1 - a.item1;
	if (Math.abs(a.item2 - b.item2) > SCORE_EPS) return b.item2 - a.item2;
	if (Math.abs(a.stopMinutes - b.stopMinutes) > SCORE_EPS)
		return a.stopMinutes - b.stopMinutes;
	if (Math.abs(a.typicalShare - b.typicalShare) > SCORE_EPS)
		return b.typicalShare - a.typicalShare;
	return 0;
}

function equalWithinTier(a: PlanScore, b: PlanScore): boolean {
	const tol = TIER_TOLERANCE_POINTS / Math.max(1, a.poolPoints);
	return (
		Math.abs(a.item1 - b.item1) <= tol &&
		Math.abs(a.item2 - b.item2) <= tol &&
		Math.abs(a.typicalShare - b.typicalShare) <= tol &&
		Math.abs(a.stopMinutes - b.stopMinutes) <= TIER_TOLERANCE_STOP_MIN
	);
}

/** Gain of score item 1 from `base` to `next`, in points. */
function item1GainPoints(next: PlanScore, base: PlanScore): number {
	return (next.item1 - base.item1) * next.poolPoints;
}

/** Opening times tried for a closed window, ascending, inside [now, fineEnd). */
export function openingGrid(ctx: EngineContext): EpochMs[] {
	const { now } = ctx;
	const end = ctx.horizon.fineEnd;
	const times = new Set<EpochMs>();
	for (const minutes of OPEN_AHEAD_MIN) times.add(now + minutes * MINUTE_MS);
	if (ctx.input.settings.prewarm && ctx.workStartMinute !== null) {
		const minute = Math.round(ctx.workStartMinute);
		const today = localDayStart(now, ctx.timeZone);
		for (const day of [today, addLocalDays(today, 1, ctx.timeZone)]) {
			const start = atLocalMinute(day, minute, ctx.timeZone);
			for (const lead of OPEN_BEFORE_WORK_START_MIN)
				times.add(start - lead * MINUTE_MS);
		}
	}
	return [...times].filter((t) => t >= now && t < end).sort((a, b) => a - b);
}

interface Evaluated {
	plan: SimPlan;
	result: SimulationResult;
	score: PlanScore;
}

function planKey(plan: SimPlan): string {
	return JSON.stringify(plan);
}

function better(a: Evaluated, b: Evaluated | null): boolean {
	return b === null || compareScores(a.score, b.score) < 0;
}

export async function planForecast(ctx: EngineContext): Promise<{
	plan: Plan;
	result: SimulationResult;
	score: PlanScore;
	baseline: { result: SimulationResult; score: PlanScore };
	/** Distinct candidate plans simulated, the baseline included. */
	candidates: number;
}> {
	const cache = new Map<string, Evaluated>();
	const evaluate = async (plan: SimPlan): Promise<Evaluated> => {
		const key = planKey(plan);
		const known = cache.get(key);
		if (known) return known;
		if (cache.size > 0) await yieldToEventLoop();
		const result = await simulate(ctx, plan);
		const evaluated = { plan, result, score: scorePlan(ctx, result) };
		cache.set(key, evaluated);
		return evaluated;
	};
	const withOpening = (plan: SimPlan, j: number, at: EpochMs | null) => ({
		...plan,
		openAt: plan.openAt.map((v, x) => (x === j ? at : v)),
	});

	const baseline = await evaluate(onDemandPlan(ctx));
	let best = baseline;
	const n = ctx.accounts.length;
	const closed = ctx.accounts
		.map((_, j) => j)
		.filter((j) => !isOpenNow(ctx, j));
	const openMin = ctx.input.settings.openMinGainPoints;
	const moveMin = ctx.input.settings.moveMinGainPoints;

	// 1. Openings, one closed account at a time (coordinate search).
	const grid = openingGrid(ctx);
	for (const j of closed) {
		let bestOpening: Evaluated | null = null;
		for (const at of grid) {
			const candidate = await evaluate(withOpening(best.plan, j, at));
			if (
				item1GainPoints(candidate.score, best.score) >= openMin &&
				better(candidate, bestOpening)
			)
				bestOpening = candidate;
		}
		if (bestOpening) best = bestOpening;
	}

	// 2. Order for unattached demand now: each account preferred in turn.
	const preferred: Evaluated[] = [];
	for (let j = 0; j < n; j++)
		preferred.push(await evaluate({ ...best.plan, preferred: j }));
	for (const candidate of preferred)
		if (better(candidate, best)) best = candidate;

	// An opening stays only while it still earns openMinGainPoints in the final combination.
	for (const j of closed) {
		if (best.plan.openAt[j] == null) continue;
		const without = await evaluate(withOpening(best.plan, j, null));
		if (item1GainPoints(best.score, without.score) < openMin) best = without;
	}

	// 3. At most one move of one warm live session; it pays its move cost inside the simulation.
	let move: MoveAdvice | null = null;
	const indexOf = new Map(ctx.accounts.map((a, j) => [a.accountId, j]));
	const movable = warmSessions(ctx)
		.filter((s) => s.recentUnits > 0)
		.sort((a, b) => b.recentUnits - a.recentUnits)
		.slice(0, MAX_MOVE_SESSIONS);
	let bestMove: Evaluated | null = null;
	let bestMoveSession: (typeof movable)[number] | null = null;
	const noMove = best;
	for (const session of movable) {
		for (let to = 0; to < n; to++) {
			if (to === indexOf.get(session.accountId)) continue;
			const candidate = await evaluate({
				...noMove.plan,
				move: { sessionId: session.sessionId, to },
			});
			if (
				item1GainPoints(candidate.score, noMove.score) >= moveMin &&
				better(candidate, bestMove)
			) {
				bestMove = candidate;
				bestMoveSession = session;
			}
		}
	}
	if (bestMove?.plan.move && bestMoveSession) {
		best = bestMove;
		const to = bestMove.plan.move.to;
		const target = ctx.accounts[to].accountId;
		const gain = item1GainPoints(bestMove.score, noMove.score);
		move = {
			sessionId: bestMoveSession.sessionId,
			from: bestMoveSession.accountId,
			to: target,
			rule: "forecast-move",
			reason: `low-point+${gain.toFixed(1)}`,
			gainPoints: round1(gain),
			costPoints: round1(
				moveCostUnits(bestMoveSession) *
					(ctx.calibration.fiveHour[target] ?? 0),
			),
		};
	}

	const openAt: Record<string, EpochMs | null> = {};
	for (const j of closed)
		openAt[ctx.accounts[j].accountId] = best.plan.openAt[j] ?? null;

	return {
		plan: {
			computedAt: ctx.now,
			openAt,
			placement: placementOf(ctx, preferred, baseline, best.plan),
			moves: move ? [move] : [],
			workStartMinute: ctx.workStartMinute,
		},
		result: best.result,
		score: best.score,
		baseline: { result: baseline.result, score: baseline.score },
		candidates: cache.size,
	};
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Tiers from the plans that prefer each account; null when every account is in one tier. */
function placementOf(
	ctx: EngineContext,
	preferred: Evaluated[],
	baseline: Evaluated,
	plan: SimPlan,
): PlacementAdvice | null {
	if (preferred.length < 2) return null;
	const order = preferred
		.map((evaluated, j) => ({ evaluated, j }))
		.sort(
			(a, b) =>
				compareScores(a.evaluated.score, b.evaluated.score) || a.j - b.j,
		);
	const tiers: number[][] = [];
	let head: PlanScore | null = null;
	for (const { evaluated, j } of order) {
		if (head && equalWithinTier(head, evaluated.score))
			tiers[tiers.length - 1].push(j);
		else {
			tiers.push([j]);
			head = evaluated.score;
		}
	}
	if (tiers.length < 2) return null;
	const first = tiers[0][0];
	const top = preferred[first].score;
	const gain = item1GainPoints(top, baseline.score);
	const opens = !isOpenNow(ctx, first);
	let reason: string;
	if (opens && plan.openAt[first] != null && gain >= REASON_MIN_GAIN_POINTS)
		reason = `open-ahead+${gain.toFixed(1)}`;
	else if (gain >= REASON_MIN_GAIN_POINTS)
		reason = `low-point+${gain.toFixed(1)}`;
	else if (resetsFirst(ctx, first)) reason = "reset-soon";
	else reason = "lexi-order";
	return {
		tiers: tiers.map((tier) => tier.map((j) => ctx.accounts[j].accountId)),
		rule: opens ? "forecast-open" : "forecast-lookahead",
		reason,
	};
}

/** The account's open window resets before every other open window. */
function resetsFirst(ctx: EngineContext, index: number): boolean {
	const own = ctx.accounts[index].fiveHour.resetsAt;
	if (!isOpenNow(ctx, index) || own === null) return false;
	return ctx.accounts.every(
		(a, j) =>
			j === index ||
			!isOpenNow(ctx, j) ||
			(a.fiveHour.resetsAt !== null && a.fiveHour.resetsAt >= own),
	);
}
