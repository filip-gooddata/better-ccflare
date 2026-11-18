/**
 * Scenario-based receding-horizon search scored by the lowest point (design 4.7, amendment 5 E2):
 * candidate plans are simulated over all simulated days and ranked by how low the heavy day sinks,
 * unserved demand counted below zero; the first step of the best plan is applied and the search runs
 * again at the next usage poll.
 */
import type { EpochMs, MoveAdvice, PlacementAdvice, Plan } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { moveCostUnits } from "./move-cost";
import { localPeaks, quarterHourGrid, refineMarks } from "./opening-grid";
import { levelOf } from "./percentile";
import {
	isOpenNow,
	onDemandPlan,
	type SimPlan,
	simulate,
	warmSessions,
} from "./simulate";
import { yieldToEventLoop } from "./yield";

/** The planner plans against the heavy day: 90th percentile of demand (settled decision 3). */
const HEAVY_LEVEL = 90;
/** Typical day: 50th percentile of demand (tie-break 2). */
const TYPICAL_LEVEL = 50;
/** Scores closer than this (points) are equal: float noise, not a difference. */
const SCORE_EPS = 1e-9;
/** Scores whose low points differ by at most this many points are tied (amendment 5, E2); also the placement tiers. */
export const TIER_TOLERANCE_POINTS = 0.5;
/** Decimals of every reported gain and cost: reason tokens and the numeric move fields. */
const REPORT_DECIMALS = 1;
/** The reported step, 0.1 points. */
export const REPORT_STEP_POINTS = 10 ** -REPORT_DECIMALS;
/** Gains below half the reported step print as 0.0, so they are not named in a placement reason (row 53). */
export const REASON_MIN_GAIN_POINTS = REPORT_STEP_POINTS / 2;

/** Options of one planner search. */
export interface PlanSearchOptions {
	/** Monotonic clock in ms; default performance.now. */
	now?: () => number;
	/**
	 * On the `now` clock; none: unbounded. Checked before each simulation it may cut: combinations of
	 * two or more openings, coordinate refinement and moves. A simulation admitted just before it
	 * passes still runs (the search yields to the event loop first), and the work planForecast always
	 * completes runs after it.
	 */
	deadline?: number;
	/** The simulation; default simulate. A seam for tests that watch what the search keeps. */
	simulate?: typeof simulate;
}

/** What one planner search covered. */
export interface PlannerSearch {
	/** Stage-1 opening times: now and every local quarter hour to the fine horizon (shared by every closed account). */
	stage1: number;
	/** Stage-2 opening times added around the peaks, summed over closed accounts. */
	stage2: number;
	/** Local peaks of the single-opening score curve, per closed account. */
	peaks: Record<string, number>;
	/** Opening combinations (rows with at least one opening) simulated or looked up, of those available. */
	combos: { evaluated: number; available: number };
	/**
	 * Coordinate refinement after the combinations: passes started, plans looked up (cache hits
	 * included) and times the best plan changed. Goes beyond the ruled peak beam (open decision).
	 */
	refine: { passes: number; evaluated: number; improved: number };
	/** Move candidates (session, destination) simulated, of those available. */
	moves: { evaluated: number; available: number };
	/** True when the deadline stopped combinations or moves before all were tried. */
	cutByDeadline: boolean;
	/** Search time on the options' clock. */
	elapsedMs: number;
}

/**
 * Score of one plan (design amendment 5, E2), in points of the pool (100 × counted accounts). Higher
 * is better. Ranked by rankTiers: lowPoint, otherLow and typicalLow each kept within
 * TIER_TOLERANCE_POINTS of the best value still in play, then fewer departures.
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

/** A score item compared with TIER_TOLERANCE_POINTS, in ranking order (amendment 5, E2). */
export type ScoreStage = "low-point" | "other-low" | "typical-low";

const TOLERANCE_STAGES: readonly [ScoreStage, (s: PlanScore) => number][] = [
	["low-point", (s) => s.lowPoint],
	["other-low", (s) => s.otherLow],
	["typical-low", (s) => s.typicalLow],
];

/**
 * The best-anchored selection of one tier (amendment 5, E2): at each tolerance stage in turn, the
 * plans whose value is within TIER_TOLERANCE_POINTS of the best value among the plans still kept
 * stay; each other plan drops at that stage. Anchoring to the best value, not to bins or pairs, makes
 * the result independent of where values sit and of the input order.
 */
function selectTier<T>(
	items: readonly T[],
	scoreOf: (item: T) => PlanScore,
): { kept: T[]; dropped: { item: T; stage: ScoreStage }[] } {
	let kept = [...items];
	const dropped: { item: T; stage: ScoreStage }[] = [];
	for (const [stage, value] of TOLERANCE_STAGES) {
		const best = Math.max(...kept.map((x) => value(scoreOf(x))));
		const next: T[] = [];
		for (const x of kept) {
			if (best - value(scoreOf(x)) <= TIER_TOLERANCE_POINTS + SCORE_EPS)
				next.push(x);
			else dropped.push({ item: x, stage });
		}
		kept = next;
	}
	return { kept, dropped };
}

/**
 * Order inside a tier: fewer departures from on demand, then the exact S, other low and typical low
 * (higher first), then the key ascending. A total order, so the order does not depend on the input.
 */
function compareInTier(
	a: PlanScore,
	b: PlanScore,
	keyA: string | number,
	keyB: string | number,
): number {
	return (
		a.departures - b.departures ||
		b.lowPoint - a.lowPoint ||
		b.otherLow - a.otherLow ||
		b.typicalLow - a.typicalLow ||
		(keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
	);
}

/**
 * Plans ranked into tiers, best first (amendment 5, E2): the first tier is selectTier of all plans,
 * the next selectTier of the rest, and so on; each tier is ordered by compareInTier. `drops[t]` is
 * the stage on which a plan left the selection of tier t, for every tier before its own; `droppedAt`
 * is the last of them (null in the first tier). `keyOf` must differ between distinct plans; it is the
 * final tie-break.
 */
export function rankTiers<T>(
	items: readonly T[],
	scoreOf: (item: T) => PlanScore,
	keyOf: (item: T) => string | number,
): RankedPlan<T>[][] {
	const tiers: RankedPlan<T>[][] = [];
	let rest: RankedPlan<T>[] = items.map((item) => ({
		item,
		droppedAt: null,
		drops: [],
	}));
	while (rest.length > 0) {
		const { kept, dropped } = selectTier(rest, (x) => scoreOf(x.item));
		tiers.push(
			kept.sort((a, b) =>
				compareInTier(
					scoreOf(a.item),
					scoreOf(b.item),
					keyOf(a.item),
					keyOf(b.item),
				),
			),
		);
		rest = dropped.map(({ item, stage }) => ({
			item: item.item,
			droppedAt: stage,
			drops: [...item.drops, stage],
		}));
	}
	return tiers;
}

/** One plan in rankTiers' result. */
export interface RankedPlan<T> {
	item: T;
	droppedAt: ScoreStage | null;
	drops: ScoreStage[];
}

/** The best plan by rankTiers, or null for none. */
export function selectBest<T>(
	items: readonly T[],
	scoreOf: (item: T) => PlanScore,
	keyOf: (item: T) => string | number,
): T | null {
	if (items.length === 0) return null;
	const { kept } = selectTier(items, scoreOf);
	return kept.reduce((best, x) =>
		compareInTier(scoreOf(x), scoreOf(best), keyOf(x), keyOf(best)) < 0
			? x
			: best,
	);
}

/**
 * Two plans in the order rankTiers gives them: negative when `a` ranks first, positive when `b`
 * does, 0 when nothing but a key would separate them. For two plans only: ranking more than two
 * goes through rankTiers, since pairwise tolerance comparisons can cycle.
 */
export function compareScores(a: PlanScore, b: PlanScore): number {
	const { dropped } = selectTier([a, b], (s) => s);
	if (dropped.length > 0) return dropped[0].item === b ? -1 : 1;
	return compareInTier(a, b, 0, 0);
}

/** The stage on which `next` drops against `top` when only the two are ranked; null within one tier. */
function pairStage(top: PlanScore, next: PlanScore): ScoreStage | null {
	const { dropped } = selectTier([top, next], (s) => s);
	return dropped.find((d) => d.item === next)?.stage ?? null;
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
 * Reason token (amendment 2, B4) naming the score item on which `top` ranks before `next`, and its
 * gain: `low-point+<points>`, `weekly-low+<points>` or `five-hour-low+<points>` (the other limit),
 * `typical-low+<points>`. `stage` is the item on which `next` dropped (rankTiers droppedAt); by
 * default the stage of the two ranked alone. Within one tier: null when departures decide or nothing
 * differs, else the first item, in stage order, whose exact values differ.
 */
export function decidingReason(
	top: PlanScore,
	next: PlanScore,
	stage: ScoreStage | null = pairStage(top, next),
): string | null {
	// The reported step, or one significant digit for a gain that would show as 0.0.
	const points = (value: number) =>
		Math.abs(value) >= REASON_MIN_GAIN_POINTS
			? value.toFixed(REPORT_DECIMALS)
			: String(Number(value.toPrecision(1)));
	const other = () =>
		top.weekLowPoints >= top.dayLowPoints ? "weekly-low" : "five-hour-low";
	const token = (s: ScoreStage, value: (x: PlanScore) => number) =>
		`${s === "other-low" ? other() : s}+${points(value(top) - value(next))}`;
	if (stage) {
		const found = TOLERANCE_STAGES.find(([s]) => s === stage);
		return found ? token(stage, found[1]) : null;
	}
	if (top.departures !== next.departures) return null;
	for (const [s, value] of TOLERANCE_STAGES)
		if (value(top) !== value(next)) return token(s, value);
	return null;
}

/**
 * Stage-1 opening times for a closed window, ascending: now and every local quarter hour in
 * (now, fineEnd). The same with pre-warm on or off: with it off, the simulation opens a window only
 * when demand is routed to it at or after the planned time.
 */
export function openingGrid(ctx: EngineContext): EpochMs[] {
	return quarterHourGrid(ctx.now, ctx.horizon.fineEnd, ctx.timeZone);
}

/** A simulated plan and its score. The simulation itself (about 9 MB for 400 days) is not kept. */
interface Evaluated {
	plan: SimPlan;
	score: PlanScore;
}

function planKey(plan: SimPlan): string {
	return JSON.stringify(plan);
}

/** The best of the candidates by rankTiers, the plan key breaking exact ties. */
function bestOf(candidates: Evaluated[]): Evaluated | null {
	return selectBest(
		candidates,
		(x) => x.score,
		(x) => planKey(x.plan),
	);
}

/**
 * The best plan for the coming hours. Always searched in full, so the plan is valid whatever the
 * deadline: the baseline, every stage-1 and stage-2 single opening (and so every combination with one
 * opening), the preference order, the pruning of openings and the placement. The deadline in
 * `options` stops only the combinations of two or more openings, taken in order of their openings'
 * single scores, and the move candidates, taken largest recent use first.
 */
export async function planForecast(
	ctx: EngineContext,
	options: PlanSearchOptions = {},
): Promise<{
	plan: Plan;
	result: SimulationResult;
	score: PlanScore;
	baseline: { result: SimulationResult; score: PlanScore };
	/** Distinct candidate plans simulated, the baseline included. */
	candidates: number;
	/** Every candidate plan simulated with its score, in the order simulated (the baseline first). */
	scored: { plan: SimPlan; score: PlanScore }[];
	search: PlannerSearch;
}> {
	const clock = options.now ?? (() => performance.now());
	const run = options.simulate ?? simulate;
	const startedAt = clock();
	const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
	let cutByDeadline = false;
	const timeLeft = () => {
		if (clock() < deadline) return true;
		cutByDeadline = true;
		return false;
	};
	// Scores only: the search simulates hundreds of plans, and keeping every simulation would hold
	// gigabytes. The baseline's simulation is kept; the chosen plan's is simulated again at the end.
	const cache = new Map<string, Evaluated>();
	let baselineResult: SimulationResult | null = null;
	const evaluate = async (plan: SimPlan): Promise<Evaluated> => {
		const key = planKey(plan);
		const known = cache.get(key);
		if (known) return known;
		if (cache.size > 0) await yieldToEventLoop();
		const result = await run(ctx, plan);
		baselineResult ??= result;
		const evaluated = { plan, score: scorePlan(ctx, result, plan) };
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

	// 1. Openings: each closed account's stage-1 grid alone, then stage 2 around each local peak of
	// that curve; the beam is every peak of the refined curve. Then the combinations of the beams (two
	// openings may gain only together), in order of their openings' single scores.
	const grid = openingGrid(ctx);
	const end = ctx.horizon.fineEnd;
	let stage2 = 0;
	const peaks: Record<string, number> = {};
	const beams: EpochMs[][] = [];
	const singleTimes: EpochMs[][] = [];
	for (const j of closed) {
		const singles = new Map<EpochMs, PlanScore>();
		const single = async (at: EpochMs) => {
			if (singles.has(at)) return;
			singles.set(
				at,
				(await evaluate(withOpening(baseline.plan, j, at))).score,
			);
		};
		for (const at of grid) await single(at);
		for (const peak of singlePeaks(singles))
			for (const at of refineMarks(peak, ctx.now, end, ctx.timeZone)) {
				if (singles.has(at)) continue;
				stage2++;
				await single(at);
			}
		peaks[ctx.accounts[j].accountId] = singlePeaks(singles).length;
		singleTimes.push([...singles.keys()].sort((a, b) => a - b));
		beams.push(
			openingBeam(
				[...singles].map(([at, score]) => ({ at, score })),
				baseline.score,
				openMin,
			),
		);
	}
	let combosEvaluated = 0;
	const earners: Evaluated[] = [];
	for (const row of openingCombinations(beams)) {
		const opened = row.filter((x) => x >= 0).length;
		if (opened >= 2 && !timeLeft()) break;
		const openAt = [...baseline.plan.openAt];
		closed.forEach((j, x) => {
			openAt[j] = row[x] >= 0 ? beams[x][row[x]] : null;
		});
		const candidate = await evaluate({ ...baseline.plan, openAt });
		combosEvaluated++;
		if (openingEarns(candidate.score, baseline.score, openMin))
			earners.push(candidate);
	}
	best = bestOf(earners) ?? best;

	// Coordinate refinement (beyond the peak beam: staggered openings sit on slopes, not peaks): each
	// closed account's full single grid with the others held at the best so far, under the same opening
	// gate; repeated until nothing changes, never returning to a plan already chosen, until the deadline.
	const refine = { passes: 0, evaluated: 0, improved: 0 };
	const chosen = new Set([planKey(best.plan)]);
	// The other accounts' openings at each account's last scan: a scan against the same ones is not repeated.
	const scannedAgainst: (string | null)[] = closed.map(() => null);
	refining: for (let changed = closed.length > 0; changed; ) {
		changed = false;
		refine.passes++;
		for (const [x, j] of closed.entries()) {
			const others = JSON.stringify(withOpening(best.plan, j, null).openAt);
			if (scannedAgainst[x] === others) continue;
			scannedAgainst[x] = others;
			const tried: Evaluated[] = [best];
			let cut = false;
			for (const at of [null, ...singleTimes[x]]) {
				if (!timeLeft()) {
					cut = true;
					break;
				}
				const candidate = await evaluate(withOpening(best.plan, j, at));
				refine.evaluated++;
				if (
					candidate !== best &&
					!chosen.has(planKey(candidate.plan)) &&
					openingEarns(candidate.score, baseline.score, openMin)
				)
					tried.push(candidate);
			}
			const next = bestOf(tried);
			if (next && next !== best && compareScores(next.score, best.score) < 0) {
				best = next;
				chosen.add(planKey(best.plan));
				refine.improved++;
				changed = true;
			}
			// Cut by the deadline: the best of the part scanned is kept, then the search moves on.
			if (cut) break refining;
		}
	}

	// 2. Order for unattached demand now: each account preferred in turn, ranked with the plan so far.
	const preferences: Evaluated[] = [best];
	for (let j = 0; j < n; j++)
		preferences.push(await evaluate({ ...best.plan, preferred: j }));
	best = bestOf(preferences) ?? best;

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

	// 3. At most one move of one warm live session; it pays its move cost inside the simulation. Every
	// warm session with recent use, largest first, until the deadline.
	let move: MoveAdvice | null = null;
	const indexOf = new Map(ctx.accounts.map((a, j) => [a.accountId, j]));
	const movable = warmSessions(ctx)
		.filter((s) => s.recentUnits > 0)
		.sort((a, b) => b.recentUnits - a.recentUnits);
	const moveCandidates = movable.flatMap((session) =>
		ctx.accounts
			.map((_, to) => to)
			.filter(
				(to) =>
					to !== indexOf.get(session.accountId) && canTakeWorkNow(ctx, to),
			)
			.map((to) => ({ sessionId: session.sessionId, to })),
	);
	let movesEvaluated = 0;
	const moves: Evaluated[] = [];
	const noMove = best;
	for (const candidateMove of moveCandidates) {
		if (!timeLeft()) break;
		const candidate = await evaluate({ ...noMove.plan, move: candidateMove });
		movesEvaluated++;
		if (lowPointGain(candidate.score, noMove.score) >= moveMin)
			moves.push(candidate);
	}
	const bestMove = bestOf(moves);
	const bestMoveSession =
		movable.find((s) => s.sessionId === bestMove?.plan.move?.sessionId) ?? null;
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
			reason: `low-point+${gain.toFixed(REPORT_DECIMALS)}`,
			gainPoints: toReportStep(gain),
			costPoints: toReportStep(
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
	if (baselineResult === null) throw new Error("baseline not simulated");
	const baselineSim: SimulationResult = baselineResult;
	// The simulation is deterministic for one context, so the chosen plan's is the one it was scored on.
	const bestResult =
		best === baseline ? baselineSim : await run(ctx, best.plan);

	return {
		plan: {
			computedAt: ctx.now,
			openAt,
			placement: placementOf(ctx, finalPreferred, baseline, best),
			moves: move ? [move] : [],
			workStartMinute: ctx.workStartMinute,
		},
		result: bestResult,
		score: best.score,
		baseline: { result: baselineSim, score: baseline.score },
		candidates: cache.size,
		scored: [...cache.values()].map(({ plan, score }) => ({ plan, score })),
		search: {
			stage1: grid.length,
			stage2,
			peaks,
			combos: {
				evaluated: combosEvaluated,
				available: openingCombinationCount(beams),
			},
			refine,
			moves: { evaluated: movesEvaluated, available: moveCandidates.length },
			cutByDeadline,
			elapsedMs: clock() - startedAt,
		},
	};
}

/** A value rounded to the reported step. */
function toReportStep(value: number): number {
	const scale = 10 ** REPORT_DECIMALS;
	return Math.round(value * scale) / scale;
}

/** Opening times of one account's singles that are local peaks of its score curve, best first. */
function singlePeaks(singles: Map<EpochMs, PlanScore>): EpochMs[] {
	const ranked = rankedOpenings(
		[...singles].map(([at, score]) => ({ at, score })),
	);
	const rank = new Map(ranked.map((x, r) => [x.at, r]));
	const curve = [...singles.keys()].sort((a, b) => a - b);
	return localPeaks(curve, (at) => rank.get(at) ?? 0).sort(
		(a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
	);
}

/** Singles in rankTiers order, the earlier opening breaking exact ties. */
function rankedOpenings(
	singles: { at: EpochMs; score: PlanScore }[],
): { at: EpochMs; score: PlanScore }[] {
	return rankTiers(
		singles,
		(x) => x.score,
		(x) => x.at,
	).flatMap((tier) => tier.map(({ item }) => item));
}

/**
 * Opening combinations over the beams as rows of beam indices (-1: no opening), every row with at
 * least one opening, generated lazily: first those with exactly one (each a single already scored),
 * then the rest in order of the sum of their openings' beam positions (best singles first), then by
 * the row itself (lexicographic, -1 first). Nothing is built beyond the rows taken.
 */
export function* openingCombinations(
	beams: readonly EpochMs[][],
): Generator<number[]> {
	const lens = beams.map((b) => b.length);
	const longest = Math.max(0, ...lens);
	for (let sum = 0; sum < longest; sum++)
		for (let x = lens.length - 1; x >= 0; x--)
			if (sum < lens[x]) yield lens.map((_, y) => (y === x ? sum : -1));
	// Largest position sum still reachable from account x onwards.
	const reach = lens.map((_, x) =>
		lens.slice(x).reduce((total, len) => total + Math.max(len - 1, 0), 0),
	);
	const row: number[] = [];
	function* withSum(
		x: number,
		left: number,
		opened: number,
	): Generator<number[]> {
		if (x === lens.length) {
			if (left === 0 && opened >= 2) yield [...row];
			return;
		}
		for (let i = -1; i < lens[x]; i++) {
			const part = Math.max(i, 0);
			if (part > left) break;
			if (left - part > (reach[x + 1] ?? 0)) continue;
			row.push(i);
			yield* withSum(x + 1, left - part, opened + (i >= 0 ? 1 : 0));
			row.pop();
		}
	}
	for (let sum = 0; sum <= (reach[0] ?? 0); sum++) yield* withSum(0, sum, 0);
}

/** How many rows openingCombinations yields: every choice per account, less the row with none. */
export function openingCombinationCount(beams: readonly EpochMs[][]): number {
	return beams.reduce((product, beam) => product * (beam.length + 1), 1) - 1;
}

/**
 * Accounts grouped into the rankTiers tiers of their preference plans, best first, the account index
 * breaking exact ties; with each account's tier number and the stages on which it dropped.
 */
function tiersOf(scored: { score: PlanScore; j: number }[]): {
	tiers: number[][];
	rankOf: Map<number, { tier: number; drops: ScoreStage[] }>;
} {
	const ranked = rankTiers(
		scored,
		(x) => x.score,
		(x) => x.j,
	);
	const rankOf = new Map<number, { tier: number; drops: ScoreStage[] }>();
	ranked.forEach((tier, t) => {
		for (const { item, drops } of tier) rankOf.set(item.j, { tier: t, drops });
	});
	return {
		tiers: ranked.map((tier) => tier.map(({ item }) => item.j)),
		rankOf,
	};
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
	const { tiers, rankOf } = tiersOf(
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
		reason = `low-point+${gain.toFixed(REPORT_DECIMALS)}`;
	else if (resetsFirst(ctx, first)) reason = "reset-soon";
	else {
		// The stage on which the second account dropped from the first account's tier (null inside
		// one tier). A held second account that ranked above the first is behind it by the hold, not
		// by score: no score item is named.
		const second = ordered[1][0];
		const firstTier = rankOf.get(first)?.tier ?? 0;
		const rank = rankOf.get(second);
		const tier = rank?.tier ?? firstTier;
		reason =
			(tier < firstTier
				? null
				: decidingReason(
						top,
						preferred[second].score,
						tier === firstTier ? null : (rank?.drops[firstTier] ?? null),
					)) ?? "no-preference";
	}
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
		? `open-ahead+${gainPoints.toFixed(REPORT_DECIMALS)}`
		: null;
}

/**
 * Single openings of one closed account carried into the combination search, best first: every
 * local peak of its score curve in time order (rankTiers order, the earlier opening breaking exact
 * ties, so a plateau peaks once), and the best opening that earns its place alone (openingEarns)
 * when no peak does; a tie that shortens the heavy stop may rank below openings that raise item 1
 * too little to count.
 */
export function openingBeam(
	singles: { at: EpochMs; score: PlanScore }[],
	baseline: PlanScore,
	openMinGainPoints: number,
): EpochMs[] {
	const ranked = rankedOpenings(singles);
	const beam = singlePeaks(new Map(singles.map((x) => [x.at, x.score])));
	const earns = (x: { score: PlanScore }) =>
		openingEarns(x.score, baseline, openMinGainPoints);
	const inBeam = new Set(beam);
	if (!ranked.some((x) => inBeam.has(x.at) && earns(x))) {
		const earner = ranked.find((x) => !inBeam.has(x.at) && earns(x));
		if (earner) beam.push(earner.at);
	}
	return beam;
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
