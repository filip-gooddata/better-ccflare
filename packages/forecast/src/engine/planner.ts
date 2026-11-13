/**
 * Scenario-based receding-horizon search scored by the lowest point (design 4.7, amendment 5 E2):
 * candidate plans are simulated over all simulated days and ranked by how low the heavy day sinks,
 * unserved demand counted below zero; the first step of the best plan is applied and the search runs
 * again at the next usage poll.
 */
import { addLocalDays, atLocalMinute, localDayStart } from "../time";
import type { EpochMs, MoveAdvice, PlacementAdvice, Plan } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { moveCostUnits } from "./move-cost";
import { levelOf } from "./percentile";
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
/** Typical day: 50th percentile of demand (tie-break 2). */
const TYPICAL_LEVEL = 50;
/** Scores closer than this (points) are equal: float noise, not a difference. */
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
/** Scores whose low points differ by at most this many points are tied (amendment 5, E2); also the placement tiers. */
const TIER_TOLERANCE_POINTS = 0.5;
/** Gains below this many points are not named in a placement reason. */
const REASON_MIN_GAIN_POINTS = 0.05;

/**
 * Score of one plan (design amendment 5, E2), in points of the pool (100 × counted accounts). Higher
 * is better. Compared by compareScores: lowPoint; within TIER_TOLERANCE_POINTS the other limit's
 * low, then typicalLow, then fewer departures.
 */
export interface PlanScore {
	/** S: the smaller of dayLowPoints and weekLowPoints. */
	lowPoint: number;
	/** The larger of the two: the other limit's low. */
	otherLow: number;
	/**
	 * Heavy 5-hour low over the next 24 h: the 10th percentile over simulated days of each day's own
	 * minimum of the pooled 5-hour line minus k5 × the demand unserved so far (below zero allowed).
	 */
	dayLowPoints: number;
	/** The same for the weekly line up to the week horizon, with kW. */
	weekLowPoints: number;
	/** The smaller of the two lows on the typical day (50th percentile over days). */
	typicalLow: number;
	/** Changes from on demand: planned openings or holds, a preference, a move. */
	departures: number;
	/** 100 × counted accounts. */
	poolPoints: number;
}

/** Mean k of the counted accounts in one calibration table. */
function meanK(ctx: EngineContext, table: Record<string, number>): number {
	const ks = ctx.accounts.map((a) => table[a.accountId] ?? 0);
	return ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : 0;
}

/**
 * Unserved demand units as points: units × the mean 5-hour k of the counted accounts (the points the
 * pool would have spent on them).
 */
export function unservedPoints(ctx: EngineContext, units: number): number {
	return units * meanK(ctx, ctx.calibration.fiveHour);
}

/** Changes of a plan from on demand. */
export function departuresOf(plan: SimPlan): number {
	return (
		plan.openAt.filter((at) => at != null).length +
		(plan.preferred !== null ? 1 : 0) +
		(plan.move !== null ? 1 : 0)
	);
}

/**
 * Per simulated day, the lowest point of line − k × cumulative unserved units over samples up to
 * `until`: unserved demand is lost and stays counted below zero for the rest of the day.
 */
function dayLows(
	result: SimulationResult,
	line: "day" | "week",
	k: number,
	until: EpochMs,
): Float64Array {
	const times = result.axis.times;
	return Float64Array.from(result.traces, (trace) => {
		const values = trace[line];
		let lost = 0;
		let low = Number.POSITIVE_INFINITY;
		for (let i = 0; i < times.length && times[i] <= until; i++) {
			if (i > 0) lost += trace.unserved[i];
			const value = values[i] - k * lost;
			if (value < low) low = value;
		}
		return Number.isFinite(low) ? low : 0;
	});
}

/** The score S and its tie-breaks (amendment 5, E2) for one simulated plan. */
export function scorePlan(
	ctx: EngineContext,
	result: SimulationResult,
	plan: SimPlan | null = null,
): PlanScore {
	const { fineEnd, weekEnd } = ctx.horizon;
	const day = dayLows(
		result,
		"day",
		meanK(ctx, ctx.calibration.fiveHour),
		fineEnd,
	);
	const week = dayLows(
		result,
		"week",
		meanK(ctx, ctx.calibration.weekly),
		weekEnd,
	);
	const dayLowPoints = levelOf(day, HEAVY_LEVEL);
	const weekLowPoints = levelOf(week, HEAVY_LEVEL);
	return {
		lowPoint: Math.min(dayLowPoints, weekLowPoints),
		otherLow: Math.max(dayLowPoints, weekLowPoints),
		dayLowPoints,
		weekLowPoints,
		typicalLow: Math.min(
			levelOf(day, TYPICAL_LEVEL),
			levelOf(week, TYPICAL_LEVEL),
		),
		departures: plan ? departuresOf(plan) : 0,
		poolPoints: 100 * ctx.accounts.length,
	};
}

/** Higher first when a and b differ by more than `tol`; 0 otherwise. */
function higher(a: number, b: number, tol: number): number {
	return Math.abs(a - b) > tol ? b - a : 0;
}

/**
 * The fixed TIER_TOLERANCE_POINTS-wide bin of a score value. Values in one bin tie; comparing bins,
 * not pairwise distances, keeps the order transitive (pairwise "within 0.5" can cycle).
 */
function bin(value: number): number {
	return Math.floor(value / TIER_TOLERANCE_POINTS);
}

/** Higher bin first; 0 when a and b share a bin. */
function higherBin(a: number, b: number): number {
	return bin(b) - bin(a);
}

/**
 * Score order (amendment 5, E2): negative when `a` is the better plan (sorts first), positive when `b`
 * is. S higher by its TIER_TOLERANCE_POINTS bin; in one bin the other limit's low, then the typical
 * low (also by bin), then fewer departures from on demand; then the exact values in the same order.
 */
export function compareScores(a: PlanScore, b: PlanScore): number {
	return (
		higherBin(a.lowPoint, b.lowPoint) ||
		higherBin(a.otherLow, b.otherLow) ||
		higherBin(a.typicalLow, b.typicalLow) ||
		a.departures - b.departures ||
		higher(a.lowPoint, b.lowPoint, SCORE_EPS) ||
		higher(a.otherLow, b.otherLow, SCORE_EPS) ||
		higher(a.typicalLow, b.typicalLow, SCORE_EPS)
	);
}

function equalWithinTier(a: PlanScore, b: PlanScore): boolean {
	return (
		bin(a.lowPoint) === bin(b.lowPoint) &&
		bin(a.otherLow) === bin(b.otherLow) &&
		bin(a.typicalLow) === bin(b.typicalLow)
	);
}

/** Gain of S from `base` to `next`, in points. */
function lowPointGain(next: PlanScore, base: PlanScore): number {
	return next.lowPoint - base.lowPoint;
}

/**
 * The opening rule (amendment 5, E2 and E3): a plan whose opening times differ from on demand, `next`,
 * earns them over the same plan without them, `base`, when S rises by at least `openMinGainPoints`. An
 * earlier opening and a hold (a later one) are gated alike; the tie-breaks never earn one.
 */
export function openingEarns(
	next: PlanScore,
	base: PlanScore,
	openMinGainPoints: number,
): boolean {
	return lowPointGain(next, base) >= openMinGainPoints - SCORE_EPS;
}

/**
 * Reason token (amendment 2, B4) naming the first score item, in compareScores order, on which `top`
 * differs from `next`, and its gain: `low-point+<points>`, `weekly-low+<points>` or
 * `five-hour-low+<points>` (the other limit), `typical-low+<points>`. Null when they differ only in
 * departures or not at all. `top` is expected to sort before `next`.
 */
export function decidingReason(top: PlanScore, next: PlanScore): string | null {
	// One decimal, or one significant digit for a gain that would show as 0.0.
	const points = (value: number) =>
		Math.abs(value) >= REASON_MIN_GAIN_POINTS
			? value.toFixed(1)
			: String(Number(value.toPrecision(1)));
	const other = () =>
		top.weekLowPoints >= top.dayLowPoints ? "weekly-low" : "five-hour-low";
	const differs = [
		(a: number, b: number) => bin(a) !== bin(b),
		(a: number, b: number) => Math.abs(a - b) > SCORE_EPS,
	];
	for (const differ of differs) {
		if (differ(top.lowPoint, next.lowPoint))
			return `low-point+${points(top.lowPoint - next.lowPoint)}`;
		if (differ(top.otherLow, next.otherLow))
			return `${other()}+${points(top.otherLow - next.otherLow)}`;
		if (differ(top.typicalLow, next.typicalLow))
			return `typical-low+${points(top.typicalLow - next.typicalLow)}`;
	}
	return null;
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
	/** Every candidate plan simulated with its score, in the order simulated (the baseline first). */
	scored: { plan: SimPlan; score: PlanScore }[];
}> {
	const cache = new Map<string, Evaluated>();
	const evaluate = async (plan: SimPlan): Promise<Evaluated> => {
		const key = planKey(plan);
		const known = cache.get(key);
		if (known) return known;
		if (cache.size > 0) await yieldToEventLoop();
		const result = await simulate(ctx, plan);
		const evaluated = { plan, result, score: scorePlan(ctx, result, plan) };
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
				lowPointGain(candidate.score, noMove.score) >= moveMin &&
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
		const gain = lowPointGain(bestMove.score, noMove.score);
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
			placement: placementOf(ctx, finalPreferred, baseline, best),
			moves: move ? [move] : [],
			workStartMinute: ctx.workStartMinute,
		},
		result: best.result,
		score: best.score,
		baseline: { result: baseline.result, score: baseline.score },
		candidates: cache.size,
		scored: [...cache.values()].map(({ plan, score }) => ({ plan, score })),
	};
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Accounts grouped into tiers of plan scores equal within the tier tolerance, best first. */
function tiersOf(scored: { score: PlanScore; j: number }[]): number[][] {
	const order = [...scored].sort(
		(a, b) => compareScores(a.score, b.score) || a.j - b.j,
	);
	const tiers: number[][] = [];
	let head: PlanScore | null = null;
	for (const { score, j } of order) {
		if (head && equalWithinTier(head, score)) tiers[tiers.length - 1].push(j);
		else {
			tiers.push([j]);
			head = score;
		}
	}
	return tiers;
}

/**
 * Closed account that can take work and whose planned routing-opening has come (pre-warm off),
 * earliest planned first; -1 when none. The next new session carries it out: the advice sends new
 * sessions there until the window is open, and the next computation sees it open (design 4.5).
 */
export function dueRoutingOpening(ctx: EngineContext, plan: SimPlan): number {
	if (ctx.input.settings.prewarm) return -1;
	let due = -1;
	plan.openAt.forEach((at, j) => {
		if (at == null || at > ctx.now || isOpenNow(ctx, j)) return;
		if (!canTakeWorkNow(ctx, j)) return;
		const dueAt = plan.openAt[due];
		if (due < 0 || (dueAt != null && at < dueAt)) due = j;
	});
	return due;
}

/**
 * Closed accounts that can take work now and that the plan does not hold (no opening time, or one
 * that has come): the simulation sends the next unattached demand to one of them (amendment 5, E1).
 */
function idleUnheld(ctx: EngineContext, plan: SimPlan): number[] {
	return ctx.accounts
		.map((_, j) => j)
		.filter((j) => {
			const at = plan.openAt[j];
			return (
				!isOpenNow(ctx, j) &&
				canTakeWorkNow(ctx, j) &&
				(at == null || at <= ctx.now)
			);
		});
}

/** Closed accounts the plan holds until a later opening time (amendment 5, E3). */
function heldClosed(ctx: EngineContext, plan: SimPlan): number[] {
	return ctx.accounts
		.map((_, j) => j)
		.filter((j) => {
			const at = plan.openAt[j];
			return !isOpenNow(ctx, j) && at != null && at > ctx.now;
		});
}

/**
 * Tiers from the plans that prefer each account; null when every account is in one tier. The live
 * router places a new session in the first tier that can take it, so the tiers carry the plan's
 * routing (amendment 5, E1 and E3): a due routing-opening (dueRoutingOpening) heads them with rule
 * forecast-open; else the idle accounts the plan does not hold head them, also forecast-open; an
 * account the plan holds closed goes behind every other.
 */
export function placementOf(
	ctx: EngineContext,
	preferred: Evaluated[],
	baseline: Evaluated,
	best: Evaluated,
): PlacementAdvice | null {
	if (preferred.length < 2) return null;
	const plan = best.plan;
	const tiers = tiersOf(
		preferred.map((evaluated, j) => ({ score: evaluated.score, j })),
	);
	const due = dueRoutingOpening(ctx, plan);
	const head = due >= 0 ? [due] : idleUnheld(ctx, plan);
	const held = heldClosed(ctx, plan).filter((j) => !head.includes(j));
	if (head.length > 0 && head.length < ctx.accounts.length) {
		const gain = lowPointGain(best.score, baseline.score);
		const reason =
			openingReason(gain) ??
			decidingReason(best.score, baseline.score) ??
			"no-preference";
		const rest = tiers
			.map((tier) => tier.filter((j) => !head.includes(j) && !held.includes(j)))
			.filter((tier) => tier.length > 0);
		return {
			tiers: [head, ...rest, ...(held.length > 0 ? [held] : [])].map((tier) =>
				tier.map((j) => ctx.accounts[j].accountId),
			),
			rule: "forecast-open",
			reason,
		};
	}
	const ordered = [
		...tiers.map((tier) => tier.filter((j) => !held.includes(j))),
		...tiers.map((tier) => tier.filter((j) => held.includes(j))),
	].filter((tier) => tier.length > 0);
	if (ordered.length < 2) return null;
	const first = ordered[0][0];
	const top = preferred[first].score;
	const gain = lowPointGain(top, baseline.score);
	// forecast-open: new sessions go to a closed window that the plan opens now.
	const plannedAt = plan.openAt[first];
	const opens =
		!isOpenNow(ctx, first) &&
		(plan.preferred === first || (plannedAt != null && plannedAt <= ctx.now));
	let reason: string;
	const ahead = plannedAt != null ? openingReason(gain) : null;
	if (ahead) reason = ahead;
	else if (gain >= REASON_MIN_GAIN_POINTS)
		reason = `low-point+${gain.toFixed(1)}`;
	else if (resetsFirst(ctx, first)) reason = "reset-soon";
	else
		reason =
			decidingReason(top, preferred[ordered[1][0]].score) ?? "no-preference";
	return {
		tiers: ordered.map((tier) => tier.map((j) => ctx.accounts[j].accountId)),
		rule: opens ? "forecast-open" : "forecast-lookahead",
		reason,
	};
}

/**
 * Reason token for a placement whose first account has a planned opening: `open-ahead+<points>`, the
 * gain of S over on demand, when it is worth naming; null otherwise.
 */
export function openingReason(gainPoints: number): string | null {
	return gainPoints >= REASON_MIN_GAIN_POINTS
		? `open-ahead+${gainPoints.toFixed(1)}`
		: null;
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
