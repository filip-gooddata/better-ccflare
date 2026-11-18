/**
 * The planner as a forecast-worker job: the one planner call the worker makes, its budget and
 * timeout, and the buffers that move across the worker boundary each way.
 */
import { FORECAST_MIN_SPACING_MS } from "../spacing";
import type { Plan } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import {
	openingGrid,
	type PlannerSearch,
	type PlanScore,
	planForecast,
} from "./planner";
import {
	chooseScenarioCount,
	prebuiltScenarioSource,
	type ScenarioCount,
} from "./scenario-count";
import { isOpenNow } from "./simulate";

/** The planner's compute budget: half the minimum spacing, so a forecast never runs into the next. */
export const PLAN_BUDGET_MS = FORECAST_MIN_SPACING_MS / 2;

/**
 * The plan job's hard timeout, which only catches a worker that never answers. The budget cuts
 * the optional search; the stages that always complete, worker start and the copies are not
 * bounded by it and run several times slower on a loaded machine. Four spacings (the refit's
 * two minutes) keep a slow plan a late forecast instead of an error that replaces the kept one.
 */
export const PLAN_JOB_TIMEOUT_MS = 4 * FORECAST_MIN_SPACING_MS;

/** Input fields the planner never reads; left out of the copy the worker gets. */
const UNREAD_INPUT = ["history", "accountHistory", "readings"] as const;

/**
 * The context the worker plans on: ctx without the demand history and readings the planner
 * does not read, and without the log detail. Copying them cost the forwarding thread tens of
 * milliseconds per forecast.
 */
export function planJobContext(ctx: EngineContext): EngineContext {
	const input = { ...ctx.input };
	for (const key of UNREAD_INPUT) input[key] = [];
	const { inputs: _inputs, ...planned } = ctx;
	return { ...planned, input };
}

/**
 * Tests only: a scenario ladder other than SCENARIO_LADDER_START..SCENARIO_LADDER_TOP. ctx must
 * hold at least `top` simulated days.
 */
export interface ScenarioLadderOverride {
	start: number;
	top: number;
}

export interface PlanJobOptions {
	/**
	 * Instant on the `now` clock after which the job stops optional work: further scenario-count
	 * rungs, then the planner's optional search. One deadline for both.
	 */
	deadline: number;
	/** Monotonic clock of `deadline`. */
	now: () => number;
	ladder?: ScenarioLadderOverride;
}

/** What computeForecast reads from the planner, and what the job chose and searched. */
export interface PlanJobResult {
	plan: Plan;
	result: SimulationResult;
	score: PlanScore;
	/** The baseline's traces stay in the worker. */
	baseline: { score: PlanScore };
	/** Design row 21: the scenario count N the plan was searched over, and why the climb stopped. */
	scenarioCount: Pick<
		ScenarioCount,
		"n" | "rungs" | "stopReason" | "targetPoints" | "timing"
	>;
	/** Distinct candidate plans simulated, the baseline included. */
	candidates: number;
	search: PlannerSearch;
}

/**
 * The plan simulations the search always runs, for the climb's cost estimate: the baseline,
 * every stage-1 single of each closed account, and the final simulation of the chosen plan. An
 * optimistic heuristic: it leaves out the plans whose number depends on the scores. Of those,
 * stage 2, the preference and the placement plans always run; the deadline cuts combinations,
 * refinement and moves.
 */
export function planSearchSize(ctx: EngineContext): number {
	const closed = ctx.accounts.filter((_, j) => !isOpenNow(ctx, j)).length;
	return 2 + closed * openingGrid(ctx).length;
}

/**
 * Chooses N over the days ctx holds (design row 21), then plans over exactly those N days under
 * the same deadline. The count's baseline is not reused: planForecast simulates its own.
 */
export async function runPlanJob(
	ctx: EngineContext,
	{ deadline, now, ladder }: PlanJobOptions,
): Promise<PlanJobResult> {
	const {
		ctx: counted,
		n,
		rungs,
		stopReason,
		targetPoints,
		timing,
	} = await chooseScenarioCount(ctx, prebuiltScenarioSource(ctx.scenarios), {
		deadline,
		now,
		start: ladder?.start,
		top: ladder?.top,
		searchPlans: planSearchSize(ctx),
	});
	const { plan, result, score, baseline, candidates, search } =
		await planForecast(counted, { deadline, now });
	return {
		plan,
		result,
		score,
		baseline: { score: baseline.score },
		scenarioCount: { n, rungs, stopReason, targetPoints, timing },
		candidates,
		search,
	};
}

function uniqueBuffers(views: ArrayBufferView[]): ArrayBuffer[] {
	const buffers = new Set<ArrayBuffer>();
	for (const view of views) buffers.add(view.buffer as ArrayBuffer);
	return [...buffers];
}

/** The scenario buffers, moved to the worker: after planning the caller reads no scenario. */
export function planJobTransfer(ctx: EngineContext): ArrayBuffer[] {
	return uniqueBuffers([...ctx.scenarios.units, ...ctx.scenarios.fable]);
}

/** The chosen plan's trace buffers, moved back to the caller. */
export function planReplyTransfer(reply: PlanJobResult): ArrayBuffer[] {
	return uniqueBuffers(
		reply.result.traces.flatMap((t) => [t.day, t.week, t.unserved]),
	);
}
