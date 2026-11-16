/**
 * Entry point of the forecast engine: one computation from a ForecastInput to the
 * HTTP response and the plan. Stages: day table, availability, calibration (ratio of
 * sums), horizon, scenarios (smoothed bootstrap), planner (receding-horizon search),
 * response. Yields to the event loop between stages; the stages yield inside.
 */

import { localDayKey } from "../time";
import type {
	AccountId,
	AccountLimits,
	Calibration,
	CalibrationLimitDetail,
	EpochMs,
	ForecastBlock,
	ForecastEngine,
	ForecastInput,
	ForecastResult,
	InputsCapDetail,
	InputsLimitDetail,
	LimitWindow,
	UnavailableDetail,
	UnavailableReason,
} from "../types";
import { BUCKET_MS } from "../types";
import {
	calibrateWithEvidence,
	type LimitEvidence,
	MIN_CALIBRATION_POINTS,
} from "./calibration";
import {
	buildDayTable,
	historyAvailable,
	MIN_POOL_DAYS,
	MIN_RECORDED_DAYS,
	poolFor,
	workStartMinute,
} from "./days";
import { computeHorizon } from "./horizon";
import type {
	DayTable,
	EngineContext,
	NoiseMode,
	NoiseOptions,
	RecordedDay,
} from "./model";
import { capBinds, capRatio } from "./past";
import { planForecast } from "./planner";
import { buildResponse, unavailableResponse } from "./response";
import { buildScenarios, resolveNoiseMode } from "./scenarios";
import { serveDay } from "./served-day";
import { yieldToEventLoop } from "./yield";

const HOUR_MS = 3_600_000;

/**
 * Kernel noise of the smoothed bootstrap: `noiseMode` wins; else `noise` true or absent is the
 * shrunk kernel (the service's only mode), false is plain resampling. `unshrunk` and `off`
 * exist for measurement.
 */
export type ForecastEngineOptions = NoiseOptions;

export function createForecastEngine(
	options: ForecastEngineOptions = {},
): ForecastEngine {
	const noiseMode = resolveNoiseMode(options);
	return {
		async compute(input: ForecastInput): Promise<ForecastResult> {
			try {
				return await computeForecast(input, noiseMode);
			} catch {
				return unavailable(input, "error");
			}
		},
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

/** The context, or the rule that answered insufficient_history with its numbers. */
async function prepare(
	input: ForecastInput,
	options: NoiseOptions,
): Promise<EngineContext | UnavailableDetail> {
	checkInput(input);
	const counted = input.accounts.filter((a) => a.counted);
	if (counted.length === 0) return { rule: "no_counted_account" };

	const table = buildDayTable(input);
	if (!historyAvailable(table)) return historyDetail(table);
	await yieldToEventLoop();

	const { calibration, evidence } = calibrateWithEvidence(input, counted);
	if (!calibrated(calibration, counted))
		return calibrationDetail(calibration, evidence);
	const timeZone = input.pace.timeZone;
	const horizon = computeHorizon(input.now, counted, timeZone);
	await yieldToEventLoop();

	const scenarios = await buildScenarios(input, table, horizon, options);
	await yieldToEventLoop();
	const workStart = workStartMinute(
		table,
		timeZone,
		input.settings.workStartSharePct,
	);
	const pool = poolFor(table, table.today.type);
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
			dayFactor: scenarios.diagnostics.day,
			recentRatePerHour:
				(scenarios.diagnostics.recentRate * HOUR_MS) / BUCKET_MS,
			pool: {
				name: poolName(table),
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

async function computeForecast(
	input: ForecastInput,
	noiseMode: NoiseMode,
): Promise<ForecastResult> {
	const ctx = await prepare(input, { noiseMode });
	if ("rule" in ctx) return unavailable(input, "insufficient_history", ctx);
	const { plan, result } = await planForecast(ctx);
	await yieldToEventLoop();

	const servedDay = serveDay(
		result,
		ctx.horizon.dayEnd,
		localDayKey(ctx.now, ctx.timeZone),
		input.heldDay ?? null,
	);
	const response = buildResponse(ctx, result, servedDay.day);
	checkBlock(response.day);
	checkBlock(response.week);
	return ctx.inputs
		? { available: true, response, plan, inputs: ctx.inputs, servedDay }
		: { available: true, response, plan, servedDay };
}

function historyDetail(table: DayTable): UnavailableDetail {
	const type = table.today.type;
	return {
		rule: "history",
		recordedDays: table.days.length,
		minRecordedDays: MIN_RECORDED_DAYS,
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
