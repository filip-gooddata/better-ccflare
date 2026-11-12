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
/** Best single openings per closed account carried into the combination search. */
const OPENING_BEAM = 3;
/** Most opening combinations simulated: (beam + 1)^closed accounts stays within it for up to 3 accounts. */
const MAX_OPENING_COMBOS = 64;
/** Most live sessions tried as move candidates (largest recent use first): keeps the search bounded. */
const MAX_MOVE_SESSIONS = 3;
/** Placement tiers: accounts whose best plans differ by at most this many points on items 1, 2 and 4 share a tier. */
const TIER_TOLERANCE_POINTS = 0.5;
/** Placement tiers: and by at most this many minutes of heavy stops (score item 3). */
const TIER_TOLERANCE_STOP_MIN = 5;
/**
 * Design amendment A2(b): an opening that leaves score items 1 and 2 equal within the tier tolerance
 * is still chosen when it cuts the heavy stop minutes (item 3) by at least one 5-minute simulation step.
 */
export const OPEN_MIN_STOP_GAIN_MIN = 5;
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

/**
 * Heavy unserved demand of a run of samples [from, to): each simulated day's unserved units summed
 * over the run, then the 90th percentile over the days (a pointwise percentile summed over the run
 * would add losses of different days).
 */
function heavyRunUnserved(
	result: SimulationResult,
	from: number,
	to: number,
): number {
	const days = result.traces.length;
	if (days === 0) return 0;
	const sums = new Float64Array(days);
	for (let s = 0; s < days; s++) {
		const unserved = result.traces[s].unserved;
		let sum = 0;
		for (let i = from; i < to; i++) sum += unserved[i];
		sums[s] = sum;
	}
	sums.sort();
	return quantileSorted(sums as unknown as number[], HEAVY_LEVEL / 100);
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
	const minStop = ctx.input.settings.minStopPoints;
	let stopMinutes = 0;
	let i = 1;
	while (i < length) {
		if (heavyDay[i - 1] > ZERO_LINE_POINTS || heavyDay[i] > ZERO_LINE_POINTS) {
			i++;
			continue;
		}
		const runStart = times[i - 1];
		const first = i;
		while (
			i < length &&
			heavyDay[i - 1] <= ZERO_LINE_POINTS &&
			heavyDay[i] <= ZERO_LINE_POINTS
		) {
			i++;
		}
		if (unservedPoints(ctx, heavyRunUnserved(result, first, i)) >= minStop)
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

/**
 * The opening rule (design 4.7, amendment A2): a plan with openings ahead of need, `next`, earns them
 * over the same plan without them, `base`, when (a) score item 1 rises by at least `openMinGainPoints`,
 * or (b) items 1 and 2 are equal within the tier tolerance and the heavy stop minutes fall by at least
 * OPEN_MIN_STOP_GAIN_MIN.
 */
export function openingEarns(
	next: PlanScore,
	base: PlanScore,
	openMinGainPoints: number,
): boolean {
	if (item1GainPoints(next, base) >= openMinGainPoints) return true;
	const tol = TIER_TOLERANCE_POINTS / Math.max(1, next.poolPoints);
	return (
		Math.abs(next.item1 - base.item1) <= tol &&
		Math.abs(next.item2 - base.item2) <= tol &&
		stopGainMinutes(next, base) >= OPEN_MIN_STOP_GAIN_MIN - SCORE_EPS
	);
}

/** Fall of score item 3 (heavy stop minutes) from `base` to `next`. */
function stopGainMinutes(next: PlanScore, base: PlanScore): number {
	return base.stopMinutes - next.stopMinutes;
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

	// 1. Openings: each closed account's grid alone, then every combination of each account's best
	// few openings (two openings may gain only together).
	const grid = openingGrid(ctx);
	const beams: (EpochMs | null)[][] = [];
	for (const j of closed) {
		const singles: { at: EpochMs; evaluated: Evaluated }[] = [];
		for (const at of grid)
			singles.push({
				at,
				evaluated: await evaluate(withOpening(baseline.plan, j, at)),
			});
		beams.push([
			null,
			...openingBeam(
				singles.map((x) => ({ at: x.at, score: x.evaluated.score })),
				baseline.score,
				openMin,
			),
		]);
	}
	let bestOpening: Evaluated | null = null;
	for (const combo of combinations(beams, MAX_OPENING_COMBOS)) {
		const openAt = [...baseline.plan.openAt];
		closed.forEach((j, x) => {
			openAt[j] = combo[x];
		});
		const candidate = await evaluate({ ...baseline.plan, openAt });
		if (
			openingEarns(candidate.score, baseline.score, openMin) &&
			better(candidate, bestOpening)
		)
			bestOpening = candidate;
	}
	if (bestOpening) best = bestOpening;

	// 2. Order for unattached demand now: each account preferred in turn.
	for (let j = 0; j < n; j++) {
		const candidate = await evaluate({ ...best.plan, preferred: j });
		if (better(candidate, best)) best = candidate;
	}

	// An opening stays only while it still earns its place (openingEarns) in the final combination;
	// dropping one can change what another earns, so repeat until nothing drops.
	for (let dropped = true; dropped; ) {
		dropped = false;
		for (const j of closed) {
			if (best.plan.openAt[j] == null) continue;
			const without = await evaluate(withOpening(best.plan, j, null));
			if (!openingEarns(best.score, without.score, openMin)) {
				best = without;
				dropped = true;
			}
		}
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
			if (to === indexOf.get(session.accountId) || !canTakeWorkNow(ctx, to))
				continue;
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

	// Placement tiers are scored against the final plan (openings and move included).
	const finalPreferred: Evaluated[] = [];
	for (let j = 0; j < n; j++)
		finalPreferred.push(await evaluate({ ...best.plan, preferred: j }));

	const openAt: Record<string, EpochMs | null> = {};
	for (const j of closed)
		openAt[ctx.accounts[j].accountId] = best.plan.openAt[j] ?? null;

	return {
		plan: {
			computedAt: ctx.now,
			openAt,
			placement: placementOf(ctx, finalPreferred, baseline, best.plan),
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
	// forecast-open: new sessions go to a closed window that the plan opens now.
	const plannedAt = plan.openAt[first];
	const opens =
		!isOpenNow(ctx, first) &&
		(plan.preferred === first || (plannedAt != null && plannedAt <= ctx.now));
	let reason: string;
	const ahead =
		plannedAt != null
			? openingReason(
					gain,
					stopGainMinutes(top, baseline.score),
					ctx.input.settings.openMinGainPoints,
				)
			: null;
	if (ahead) reason = ahead;
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

/**
 * Reason token for a placement whose first account the plan opens ahead of need: `open-ahead+<points>`
 * when score item 1 gains `openMinGainPoints` (rule a), else `open-ahead-stop-<minutes>min` when the heavy
 * stop minutes fall by OPEN_MIN_STOP_GAIN_MIN (rule b), else `open-ahead+<points>` for a smaller gain
 * still worth naming; null otherwise.
 */
export function openingReason(
	gainPoints: number,
	stopGainMin: number,
	openMinGainPoints: number,
): string | null {
	const points = `open-ahead+${gainPoints.toFixed(1)}`;
	if (gainPoints >= openMinGainPoints && gainPoints >= REASON_MIN_GAIN_POINTS)
		return points;
	if (stopGainMin >= OPEN_MIN_STOP_GAIN_MIN - SCORE_EPS)
		return `open-ahead-stop-${Math.round(stopGainMin)}min`;
	return gainPoints >= REASON_MIN_GAIN_POINTS ? points : null;
}

/**
 * Best single openings of one closed account carried into the combination search: the OPENING_BEAM
 * best by score, except that the last place goes to the best opening that earns its place alone
 * (openingEarns) when none of the others does; a tie that shortens the heavy stop may rank below
 * openings that raise item 1 too little to count.
 */
export function openingBeam(
	singles: { at: EpochMs; score: PlanScore }[],
	baseline: PlanScore,
	openMinGainPoints: number,
): EpochMs[] {
	const sorted = [...singles].sort((x, y) => compareScores(x.score, y.score));
	const beam = sorted.slice(0, OPENING_BEAM);
	const earns = (x: { score: PlanScore }) =>
		openingEarns(x.score, baseline, openMinGainPoints);
	if (beam.length === OPENING_BEAM && !beam.some(earns)) {
		const earner = sorted.slice(OPENING_BEAM).find(earns);
		if (earner) beam[OPENING_BEAM - 1] = earner;
	}
	return beam.map((x) => x.at);
}

/** Cartesian product of the choices, or only the one-change-at-a-time rows when it exceeds `limit`. */
function combinations<T>(choices: T[][], limit: number): T[][] {
	const size = choices.reduce((product, c) => product * c.length, 1);
	if (size > limit) {
		const rows: T[][] = [choices.map((c) => c[0])];
		choices.forEach((c, x) => {
			for (const value of c.slice(1))
				rows.push(choices.map((d, y) => (y === x ? value : d[0])));
		});
		return rows;
	}
	let rows: T[][] = [[]];
	for (const c of choices)
		rows = rows.flatMap((row) => c.map((value) => [...row, value]));
	return rows;
}

/** Not paused by a cooldown, weekly not used up, and no full 5-hour window. */
function canTakeWorkNow(ctx: EngineContext, index: number): boolean {
	const a = ctx.accounts[index];
	if (a.blockedUntil !== null && a.blockedUntil > ctx.now) return false;
	if (
		a.weekly.usedPct >= 100 &&
		(a.weekly.resetsAt === null || a.weekly.resetsAt > ctx.now)
	)
		return false;
	return !(isOpenNow(ctx, index) && a.fiveHour.usedPct >= 100);
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
