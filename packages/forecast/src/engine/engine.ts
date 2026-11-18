/**
 * Entry point of the forecast engine: one computation from a ForecastInput to the
 * HTTP response and the plan. Stages: day table, availability, calibration (ratio of
 * sums), horizon, scenarios (smoothed bootstrap), planner (receding-horizon search),
 * response. Yields to the event loop between stages; the stages yield inside.
 */

import {
	createForecastWorkerRunner,
	type ForecastWorkerRunner,
} from "../service/forecast-worker-runner";
import { localDayStart } from "../time";
import type {
	AccountId,
	AccountLimits,
	Calibration,
	CalibrationLimitDetail,
	EpochMs,
	ForecastBlock,
	ForecastEngine,
	ForecastInput,
	ForecastInputsDetail,
	ForecastResult,
	InputsCapDetail,
	InputsLimitDetail,
	LimitWindow,
	UnavailableDetail,
	UnavailableReason,
} from "../types";
import {
	calibrateWithEvidence,
	type LimitEvidence,
	MIN_CALIBRATION_POINTS,
} from "./calibration";
import {
	activeDays,
	buildDayTable,
	demandLookbackDays,
	historyAvailable,
	MIN_ACTIVE_DAYS,
	MIN_POOL_DAYS,
	poolFor,
	WORK_START_RECENT_DAYS,
	workStartMinute,
} from "./days";
import { computeHorizon } from "./horizon";
import type { LearnedDemand } from "./learn/types";
import type {
	DayTable,
	EngineContext,
	NoiseMode,
	NoiseOptions,
	PlanLowPoints,
	RecordedDay,
} from "./model";
import { applyPace, buildPaceSeries, type PaceNow, plainPace } from "./pace";
import { capBinds, capRatio } from "./past";
import {
	PLAN_BUDGET_MS,
	PLAN_JOB_TIMEOUT_MS,
	type PlanJobResult,
	planJobContext,
	planJobTransfer,
	type ScenarioLadderOverride,
} from "./plan-job";
import { buildResponseSliced, unavailableResponse } from "./response";
import { SCENARIO_LADDER_TOP } from "./scenario-count";
import {
	buildScenarios,
	datePool,
	resolveNoiseMode,
	servedPartition,
} from "./scenarios";
import { yieldToEventLoop } from "./yield";

const HOUR_MS = 3_600_000;

/**
 * Kernel noise of the smoothed bootstrap: `noiseMode` wins; else `noise` true or absent is the
 * shrunk kernel (the service's only mode), false is plain resampling. `unshrunk` and `off`
 * exist for measurement.
 */
export interface ForecastEngineOptions extends NoiseOptions {
	/**
	 * Runs the planner off the calling thread. Absent: each computation gets its own forecast
	 * worker runner, so computations stay independent of each other.
	 */
	planRunner?: ForecastWorkerRunner;
	/**
	 * Tests only: a fixed scenario ladder and plan budget, so a test's values do not depend on the
	 * machine's load. Production uses SCENARIO_LADDER_START..SCENARIO_LADDER_TOP and PLAN_BUDGET_MS.
	 */
	planJob?: PlanJobOverride;
}

export interface PlanJobOverride {
	ladder?: ScenarioLadderOverride;
	budgetMs?: number;
}

export function createForecastEngine(
	options: ForecastEngineOptions = {},
): ForecastEngine {
	const noiseMode = resolveNoiseMode(options);
	return {
		async compute(input: ForecastInput): Promise<ForecastResult> {
			try {
				const runner = options.planRunner ?? createForecastWorkerRunner();
				return await computeForecast(
					input,
					noiseMode,
					runner,
					options.planJob ?? {},
				);
			} catch {
				return unavailable(input, "error");
			}
		},
	};
}

/** The pace model's two steps at a computation; a parameter so tests can plant them. */
export interface PaceFit {
	buildPaceSeries: typeof buildPaceSeries;
	applyPace: typeof applyPace;
}

/**
 * Today's pace (E4) for this computation. Off: the plain lines, whatever state was passed.
 * No state yet: the plain lines, unfitted. Otherwise the state applied to the pooled
 * demand series up to now, with censoring read from every account's readings (also an
 * account that cannot take work now: censoring concerns past buckets it may have served).
 * Neither pace step runs when off or unfitted.
 */
export function currentPace(
	input: ForecastInput,
	fit: PaceFit = { buildPaceSeries, applyPace },
): PaceNow {
	if (!input.settings.paceConditioning) return plainPace("off");
	const state = input.demandModel;
	if (!state) return plainPace("unfitted");
	const series = fit.buildPaceSeries({
		history: input.history,
		historyFrom: input.historyFrom,
		now: input.now,
		readings: input.readings,
		accounts: input.accounts.map((a) => a.accountId),
		timeZone: input.pace.timeZone,
	});
	return fit.applyPace(state, series, input.now, true);
}

/**
 * The scenario day table under F2 rows 4 and 5: the served lookback (never
 * above the setting nor DEMAND_LOOKBACK_MAX_DAYS, also without learned demand)
 * and half-life. At the settings' values it is the gate's own table;
 * availability, work start and calibration keep the settings.
 */
function scenarioDayTable(
	input: ForecastInput,
	table: DayTable,
	learned: LearnedDemand | null,
): DayTable {
	const { historyLookbackDays, historyHalfLifeDays } = input.settings;
	const cap = demandLookbackDays(historyLookbackDays);
	const lookbackDays = Math.min(learned?.lookbackDays ?? cap, cap);
	const halfLifeDays = learned?.halfLifeDays ?? historyHalfLifeDays;
	if (
		lookbackDays === historyLookbackDays &&
		halfLifeDays === historyHalfLifeDays
	)
		return table;
	return buildDayTable(input, { lookbackDays, halfLifeDays });
}

/** The demand model's summary for the log line; null without one. */
function paceModelDetail(
	input: ForecastInput,
): ForecastInputsDetail["paceModel"] {
	const s = input.demandModel;
	if (!s) return null;
	return {
		fittedAt: s.fittedAt,
		days: s.days,
		weeks: s.weeks,
		cellsEstablished: s.cellsEstablished,
		cellsTotal: s.cellsTotal,
		belowFloor: s.belowFloor,
	};
}

/**
 * Day table, availability, calibration, horizon and scenarios: the context the planner and
 * the response builder run on, or why there is no forecast. May throw on malformed input.
 */
export async function prepareEngineContext(
	input: ForecastInput,
	options: NoiseOptions,
): Promise<EngineContext | "insufficient_history"> {
	const prepared = await prepare(input, options);
	return "rule" in prepared ? "insufficient_history" : prepared;
}

/**
 * The context, or the rule that answered insufficient_history with its numbers. `scenarioDays`
 * set: that many simulated days (the scenario ladder's top); absent: settings.simulatedDays.
 */
async function prepare(
	input: ForecastInput,
	options: NoiseOptions,
	scenarioDays?: number,
): Promise<EngineContext | UnavailableDetail> {
	checkInput(input);
	const counted = input.accounts.filter((a) => a.counted);
	if (counted.length === 0) return { rule: "no_counted_account" };

	const learned = input.learnedDemand ?? null;
	const table = buildDayTable(input);
	if (!historyAvailable(table, learned ? learned.poolTau : "hard3"))
		return historyDetail(table);
	await yieldToEventLoop();

	const { calibration, evidence } = calibrateWithEvidence(input, counted);
	if (!calibrated(calibration, counted))
		return calibrationDetail(calibration, evidence);
	const timeZone = input.pace.timeZone;
	const horizon = computeHorizon(input.now, counted, timeZone);
	await yieldToEventLoop();

	const pace = currentPace(input);
	const scenarioTable = scenarioDayTable(input, table, learned);
	const scenarios = await buildScenarios(
		input,
		scenarioTable,
		horizon,
		options,
		pace,
		scenarioDays === undefined ? undefined : { from: 0, to: scenarioDays },
	);
	await yieldToEventLoop();
	const workStart = workStartMinute(
		table,
		timeZone,
		learned ? learned.workStartSharePct : input.settings.workStartSharePct,
		learned ? learned.workStartSample : WORK_START_RECENT_DAYS,
	);
	// today's served draw pool, as the scenarios draw it (R3-8)
	const pool = datePool(
		scenarioTable,
		localDayStart(input.now, timeZone),
		input.pace,
		{ poolTau: learned?.poolTau, partition: servedPartition(input) },
	);
	return {
		input,
		now: input.now,
		timeZone,
		accounts: counted,
		horizon,
		table,
		calibration,
		scenarios,
		workStartMinute: workStart,
		inputs: {
			pace: scenarios.diagnostics.pace,
			paceModel: paceModelDetail(input),
			pool: {
				name: poolName(scenarioTable),
				days: pool.length,
				medianUnits: weightedQuantile(pool, 0.5),
				p90Units: weightedQuantile(pool, 0.9),
			},
			workStartMinute: workStart,
			limits: inputLimits(counted, calibration, evidence, input.now),
			caps: counted.map((a) => inputCap(a, calibration, input.now)),
		},
	};
}

const LIMIT_KEYS: Record<LimitWindow, keyof Calibration> = {
	five_hour: "fiveHour",
	seven_day: "weekly",
	seven_day_fable: "fable",
};

/** Every counted account's five-hour, weekly and Fable k, its source and its evidence (amendment 4, D2). */
function inputLimits(
	counted: AccountLimits[],
	calibration: Calibration,
	evidence: LimitEvidence[],
	now: EpochMs,
): InputsLimitDetail[] {
	const ago = (at: EpochMs | null | undefined) =>
		at === null || at === undefined ? null : (now - at) / HOUR_MS;
	const limits: InputsLimitDetail[] = [];
	for (const a of counted) {
		for (const limit of Object.keys(LIMIT_KEYS) as LimitWindow[]) {
			const e = evidence.find(
				(x) => x.accountId === a.accountId && x.window === limit,
			);
			const k = calibration[LIMIT_KEYS[limit]][a.accountId];
			const has = typeof k === "number" && Number.isFinite(k);
			limits.push({
				accountId: a.accountId,
				limit,
				k: has ? k : null,
				source: e && e.ownK !== null ? "own" : has ? "borrowed" : "none",
				instances: e?.instances ?? 0,
				points: e?.points ?? 0,
				oldestHoursAgo: ago(e?.oldestAt),
				newestHoursAgo: ago(e?.newestAt),
			});
		}
	}
	return limits;
}

/** An account's weekly cap on the day line at the computation: r = k5 / kW and whether it binds. */
function inputCap(
	a: AccountLimits,
	calibration: Calibration,
	now: EpochMs,
): InputsCapDetail {
	const ratio = capRatio(calibration, a.accountId);
	return { accountId: a.accountId, ratio, binds: capBinds(a, now, ratio) };
}

/** Recency-weighted quantile of the pool's daily units: the smallest total whose cumulative weight reaches q. */
function weightedQuantile(pool: RecordedDay[], q: number): number | null {
	const days = pool
		.filter((d) => d.weight > 0)
		.sort((x, y) => x.total - y.total);
	const sum = days.reduce((acc, d) => acc + d.weight, 0);
	if (!(sum > 0)) return null;
	let acc = 0;
	for (const d of days) {
		acc += d.weight;
		if (acc >= q * sum * (1 - 1e-12)) return d.total;
	}
	return days[days.length - 1]?.total ?? null;
}

/** Today's pool: its own day type, or "weekdays" when monday and workday pool together. */
function poolName(
	table: DayTable,
): "workday" | "monday" | "weekend" | "weekdays" {
	const type = table.today.type;
	const own = table.days.filter((d) => d.type === type).length;
	return own >= MIN_POOL_DAYS || type === "weekend" ? type : "weekdays";
}

/**
 * The planner in the forecast worker, under the spacing-derived budget and timeout. The scenario
 * buffers move to the worker; ctx keeps everything buildResponse reads. A failed job throws, so
 * the computation reports `error` as any other engine failure does.
 */
async function planInWorker(
	ctx: EngineContext,
	runner: ForecastWorkerRunner,
	override: PlanJobOverride,
): Promise<PlanJobResult> {
	const outcome = await runner.run(
		"plan",
		{
			ctx: planJobContext(ctx),
			budgetMs: override.budgetMs ?? PLAN_BUDGET_MS,
			...(override.ladder ? { ladder: override.ladder } : {}),
		},
		{ timeoutMs: PLAN_JOB_TIMEOUT_MS, transfer: planJobTransfer(ctx) },
	);
	if (outcome.status !== "ok")
		throw new Error(
			`plan job ${outcome.status === "timeout" ? "timeout" : outcome.reason}`,
		);
	return outcome.result;
}

async function computeForecast(
	input: ForecastInput,
	noiseMode: NoiseMode,
	runner: ForecastWorkerRunner,
	override: PlanJobOverride,
): Promise<ForecastResult> {
	// The ladder's top rung of scenario days, built here once; the job picks N among them (row 21).
	const ctx = await prepare(
		input,
		{ noiseMode },
		override.ladder?.top ?? SCENARIO_LADDER_TOP,
	);
	if ("rule" in ctx) return unavailable(input, "insufficient_history", ctx);
	const { plan, result, score, baseline } = await planInWorker(
		ctx,
		runner,
		override,
	);

	const response = await buildResponseSliced(ctx, result);
	checkBlock(response.day);
	checkBlock(response.week);
	if (!ctx.inputs) return { available: true, response, plan };
	const lowPoints: PlanLowPoints = {
		lowPoint: score.lowPoint,
		lowPointOnDemand: baseline.score.lowPoint,
	};
	return {
		available: true,
		response,
		plan,
		inputs: { ...ctx.inputs, ...lowPoints },
	};
}

function historyDetail(table: DayTable): UnavailableDetail {
	const type = table.today.type;
	return {
		rule: "history",
		// F2 row 3: active days (days with demand) against their floor
		recordedDays: activeDays(table),
		minRecordedDays: MIN_ACTIVE_DAYS,
		pool: poolName(table),
		poolDays: poolFor(table, type).length,
		minPoolDays: MIN_POOL_DAYS,
	};
}

function calibrationDetail(
	calibration: Calibration,
	evidence: LimitEvidence[],
): UnavailableDetail {
	const limits: CalibrationLimitDetail[] = [];
	for (const e of evidence) {
		if (e.window === "seven_day_fable") continue;
		const ks =
			e.window === "five_hour" ? calibration.fiveHour : calibration.weekly;
		limits.push({
			accountId: e.accountId,
			limit: e.window,
			instances: e.instances,
			points: e.points,
			minPoints: MIN_CALIBRATION_POINTS,
			units: e.units,
			k:
				e.ownK !== null
					? "own"
					: Number.isFinite(ks[e.accountId])
						? "borrowed"
						: "none",
		});
	}
	return { rule: "calibration", limits };
}

function calibrated(
	calibration: {
		fiveHour: Record<AccountId, number>;
		weekly: Record<AccountId, number>;
	},
	counted: AccountLimits[],
): boolean {
	return counted.every(
		(a) =>
			Number.isFinite(calibration.fiveHour[a.accountId]) &&
			Number.isFinite(calibration.weekly[a.accountId]),
	);
}

/** Inputs the stages would turn into silent nonsense rather than an exception. */
function checkInput(input: ForecastInput): void {
	const { now, settings } = input;
	if (!Number.isFinite(now)) throw new Error("now");
	if (!Number.isInteger(settings.simulatedDays) || settings.simulatedDays < 1) {
		throw new Error("simulatedDays");
	}
	if (!Number.isFinite(input.historyFrom)) throw new Error("historyFrom");
	for (const a of input.accounts) {
		if (
			!Number.isFinite(a.fiveHour.usedPct) ||
			!Number.isFinite(a.weekly.usedPct)
		) {
			throw new Error("usedPct");
		}
	}
}

/** A non-finite value in a line means a stage went wrong; the spec has no shape for it. */
function checkBlock(block: ForecastBlock | null): void {
	if (block === null) return;
	const lines = [
		block.light,
		block.typical,
		block.heavy,
		...Object.values(block.fan),
	];
	for (const line of lines) {
		for (const v of line) if (!Number.isFinite(v)) throw new Error("line");
	}
}

function unavailable(
	input: ForecastInput,
	reason: UnavailableReason,
	detail?: UnavailableDetail,
): ForecastResult {
	return {
		available: false,
		reason,
		response: unavailableResponse(safeNow(input), reason, safeAccounts(input)),
		plan: null,
		...(detail ? { detail } : {}),
	};
}

function safeNow(input: ForecastInput): number {
	try {
		return Number.isFinite(input.now) ? input.now : 0;
	} catch {
		return 0;
	}
}

function safeAccounts(input: ForecastInput): AccountId[] {
	try {
		return input.accounts
			.filter((a) => a.counted)
			.map((a) => a.accountId)
			.filter((id) => typeof id === "string");
	} catch {
		return [];
	}
}
