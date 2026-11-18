/**
 * Scenario count N (design row 21): the smallest N on a doubling ladder whose Monte Carlo
 * standard error of the score S is below half the tier tolerance, bounded by compute time.
 *
 * Measured once, on the on-demand (no-change) plan. The SE comes from repeated balanced
 * half-splits of the N simulated days: for each split, S_A and S_B are scorePlan's S (and its day
 * and week p10s) over each half, and SE = RMS(S_A - S_B) / 2. Var(S_A - S_B) is twice the variance
 * of S at N / 2, which is twice its variance at N, so the RMS over 2 is the SE at N. SE_SPLITS
 * splits is a bounded computational heuristic, not a confidence guarantee.
 *
 * Climbing relies on the prefix property: simulated day s is the same whatever the total N
 * (scenarios.ts draws each date from its own generator in day order), and a day's simulated
 * trace does not depend on the other days (DayRun.reset per day). So each rung only builds and
 * simulates the added days.
 */
import type { ForecastInput } from "../types";
import type {
	DayTable,
	EngineContext,
	Horizon,
	NoiseOptions,
	Scenarios,
	SimTrace,
	SimulationResult,
} from "./model";
import type { PaceNow } from "./pace";
import { scorePlan, TIER_TOLERANCE_POINTS } from "./planner";
import { createRng } from "./rng";
import { buildScenarios } from "./scenarios";
import { onDemandPlan, simulate } from "./simulate";
import { yieldToEventLoop } from "./yield";

/** First rung of the ladder. */
export const SCENARIO_LADDER_START = 100;
/** Last rung: the ladder doubles from SCENARIO_LADDER_START up to this. */
export const SCENARIO_LADDER_TOP = 1600;
/** Half-splits per SE measurement (R): a bounded computational heuristic. */
export const SE_SPLITS = 64;
/**
 * Plan simulations the candidate search is assumed to run after N is chosen, when the caller
 * does not pass its own estimate: used only to reserve time for the search before climbing.
 */
export const DEFAULT_SEARCH_PLANS = 32;

/** Rungs from `start`, doubling, up to and including `top`. */
export function scenarioLadder(
	start = SCENARIO_LADDER_START,
	top = SCENARIO_LADDER_TOP,
): number[] {
	const rungs: number[] = [];
	for (let n = start; n <= top; n *= 2) rungs.push(n);
	return rungs;
}

/** SE target in points: half the tier tolerance. */
export function seTargetPoints(): number {
	return TIER_TOLERANCE_POINTS / 2;
}

/** Simulated days [from, to); day s must be the same whatever range it is asked in. */
export type ScenarioSource = (from: number, to: number) => Promise<Scenarios>;

/** Days [from, to) built on demand (buildScenarios with a day range). */
export function scenarioRangeSource(
	input: ForecastInput,
	table: DayTable,
	horizon: Horizon,
	options: NoiseOptions,
	pace: PaceNow,
): ScenarioSource {
	return (from, to) =>
		buildScenarios(input, table, horizon, options, pace, { from, to });
}

/** Days [from, to) of scenarios already built (e.g. the top rung built once in prepare()). */
export function prebuiltScenarioSource(scenarios: Scenarios): ScenarioSource {
	return async (from, to) => {
		if (to > scenarios.units.length)
			throw new Error(
				`scenario source holds ${scenarios.units.length} days, asked for ${to}`,
			);
		return {
			...scenarios,
			units: scenarios.units.slice(from, to),
			fable: scenarios.fable.slice(from, to),
		};
	};
}

export interface HalfSplitSe {
	/** SE of S = min(day p10, week p10), points. */
	se: number;
	/** Marginal SE of the day p10 (diagnostic). */
	seDay: number;
	/** Marginal SE of the week p10 (diagnostic). */
	seWeek: number;
	/** scorePlan over all the days. */
	lowPoint: number;
	dayLowPoints: number;
	weekLowPoints: number;
}

/**
 * Half-split SE of S over the result's days: SE_SPLITS random balanced splits drawn from a
 * generator seeded with `seed`, each half scored by scorePlan.
 */
export function halfSplitSe(
	ctx: EngineContext,
	result: SimulationResult,
	seed: string,
	splits = SE_SPLITS,
): HalfSplitSe {
	const full = scorePlan(ctx, result);
	const n = result.traces.length;
	const half = Math.floor(n / 2);
	const rng = createRng(seed);
	const order = Array.from({ length: n }, (_, i) => i);
	let sum = 0;
	let sumDay = 0;
	let sumWeek = 0;
	for (let r = 0; r < splits; r++) {
		for (let i = n - 1; i > 0; i--) {
			const j = rng.int(i + 1);
			const t = order[i] as number;
			order[i] = order[j] as number;
			order[j] = t;
		}
		const pick = (from: number, to: number): SimulationResult => ({
			...result,
			traces: order.slice(from, to).map((i) => result.traces[i] as SimTrace),
		});
		const a = scorePlan(ctx, pick(0, half));
		const b = scorePlan(ctx, pick(half, 2 * half));
		sum += (a.lowPoint - b.lowPoint) ** 2;
		sumDay += (a.dayLowPoints - b.dayLowPoints) ** 2;
		sumWeek += (a.weekLowPoints - b.weekLowPoints) ** 2;
	}
	const rms = (s: number) => (splits > 0 ? Math.sqrt(s / splits) / 2 : 0);
	return {
		se: rms(sum),
		seDay: rms(sumDay),
		seWeek: rms(sumWeek),
		lowPoint: full.lowPoint,
		dayLowPoints: full.dayLowPoints,
		weekLowPoints: full.weekLowPoints,
	};
}

/**
 * Time to climb from `from` to `to` days and still run the candidate search: build and simulate
 * the added days, measure the SE again (its cost scales with N), and simulate `searchPlans` plans
 * over all `to` days.
 */
export function climbCostMs(c: {
	from: number;
	to: number;
	buildMsPerDay: number;
	simMsPerDay: number;
	/** SE measurement time at `from` days. */
	seMs: number;
	searchPlans: number;
}): number {
	const added = c.to - c.from;
	return (
		added * (c.buildMsPerDay + c.simMsPerDay) +
		(c.seMs * c.to) / c.from +
		c.searchPlans * c.to * c.simMsPerDay
	);
}

export interface ScenarioCountRung {
	n: number;
	se: number;
	seDay: number;
	seWeek: number;
}

export type ScenarioCountStop = "target-met" | "budget" | "ladder-top";

export interface ScenarioCount {
	n: number;
	rungs: ScenarioCountRung[];
	stopReason: ScenarioCountStop;
	/** ctx with exactly n scenario days, frozen for the candidate search. */
	ctx: EngineContext;
	/** The on-demand plan simulated over those n days. */
	baseline: SimulationResult;
	/** Measured costs, for the log and for the caller's own budgeting. */
	timing: { buildMsPerDay: number; simMsPerDay: number; seMs: number };
}

export interface ScenarioCountOptions {
	/** Monotonic deadline, same clock as `now`. */
	deadline: number;
	now?: () => number;
	start?: number;
	top?: number;
	/** SE target in points; defaults to seTargetPoints(). */
	targetPoints?: number;
	splits?: number;
	/** Plan simulations the candidate search will run; defaults to DEFAULT_SEARCH_PLANS. */
	searchPlans?: number;
	/** Seed for the split generator; defaults to today's day key. */
	seed?: string;
}

/**
 * Chooses N: builds and simulates the first rung, then climbs while the SE of S is at or above
 * the target, the ladder has a next rung, and the remaining time covers climbCostMs. The first
 * rung is always built, even past the deadline. ctx.scenarios is replaced by the source's days.
 */
export async function chooseScenarioCount(
	ctx: EngineContext,
	source: ScenarioSource,
	options: ScenarioCountOptions,
): Promise<ScenarioCount> {
	const now = options.now ?? (() => performance.now());
	const ladder = scenarioLadder(options.start, options.top);
	const target = options.targetPoints ?? seTargetPoints();
	const splits = options.splits ?? SE_SPLITS;
	const searchPlans = options.searchPlans ?? DEFAULT_SEARCH_PLANS;
	const seed = `${options.seed ?? ctx.table.today.key}/scenario-count`;
	const plan = onDemandPlan(ctx);
	if (ladder.length === 0) throw new Error("empty scenario ladder");

	const units: Float32Array[] = [];
	const fable: Float32Array[] = [];
	const traces: SimTrace[] = [];
	let scenarios: Scenarios | undefined;
	let baseline: SimulationResult | undefined;
	let built = 0;
	let buildMs = 0;
	let simMs = 0;
	let seMs = 0;
	const rungs: ScenarioCountRung[] = [];
	let stopReason: ScenarioCountStop = "ladder-top";

	for (let r = 0; r < ladder.length; r++) {
		const n = ladder[r] as number;
		let t = now();
		const added = await source(built, n);
		buildMs += now() - t;
		units.push(...added.units);
		fable.push(...added.fable);
		scenarios = { ...added, units: units.slice(), fable: fable.slice() };
		await yieldToEventLoop();
		t = now();
		const extra = await simulate({ ...ctx, scenarios: added }, plan);
		simMs += now() - t;
		traces.push(...extra.traces);
		baseline = { ...extra, traces: traces.slice() };
		built = n;
		await yieldToEventLoop();
		t = now();
		const se = halfSplitSe({ ...ctx, scenarios }, baseline, seed, splits);
		seMs = now() - t;
		rungs.push({ n, se: se.se, seDay: se.seDay, seWeek: se.seWeek });

		if (se.se < target) {
			stopReason = "target-met";
			break;
		}
		const next = ladder[r + 1];
		if (next === undefined) {
			stopReason = "ladder-top";
			break;
		}
		const cost = climbCostMs({
			from: n,
			to: next,
			buildMsPerDay: buildMs / built,
			simMsPerDay: simMs / built,
			seMs,
			searchPlans,
		});
		if (cost > options.deadline - now()) {
			stopReason = "budget";
			break;
		}
	}

	if (!scenarios || !baseline) throw new Error("no scenario rung built");
	return {
		n: built,
		rungs,
		stopReason,
		ctx: { ...ctx, scenarios },
		baseline,
		timing: {
			buildMsPerDay: buildMs / built,
			simMsPerDay: simMs / built,
			seMs,
		},
	};
}
