/**
 * The planner as a forecast-worker job: the one planner call the worker makes, its budget and
 * timeout, and the buffers that move across the worker boundary each way.
 */
import { FORECAST_MIN_SPACING_MS } from "../spacing";
import type { Plan } from "../types";
import type { EngineContext, SimulationResult } from "./model";
import { type PlanScore, planForecast } from "./planner";

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

export interface PlanJobOptions {
	/** Instant on the `now` clock after which the planner stops optional search. */
	deadline: number;
	/** Monotonic clock of `deadline`. */
	now: () => number;
}

/** What computeForecast reads from the planner; the baseline's traces stay in the worker. */
export interface PlanJobResult {
	plan: Plan;
	result: SimulationResult;
	score: PlanScore;
	baseline: { score: PlanScore };
}

export async function runPlanJob(
	ctx: EngineContext,
	_options: PlanJobOptions,
): Promise<PlanJobResult> {
	const { plan, result, score, baseline } = await planForecast(ctx);
	return { plan, result, score, baseline: { score: baseline.score } };
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
