/**
 * Entry point of the forecast engine: one computation from a ForecastInput to the
 * HTTP response and the plan. Stages: day table, availability, calibration (ratio of
 * sums), horizon, scenarios (smoothed bootstrap), planner (receding-horizon search),
 * response. Yields to the event loop between stages; the stages yield inside.
 */
import type {
	AccountId,
	AccountLimits,
	Calibration,
	CalibrationLimitDetail,
	ForecastBlock,
	ForecastEngine,
	ForecastInput,
	ForecastResult,
	UnavailableDetail,
	UnavailableReason,
} from "../types";
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
import type { DayTable, EngineContext, NoiseMode, NoiseOptions } from "./model";
import { planForecast } from "./planner";
import { buildResponse, unavailableResponse } from "./response";
import { buildScenarios, resolveNoiseMode } from "./scenarios";
import { yieldToEventLoop } from "./yield";

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
	return {
		input,
		now: input.now,
		timeZone,
		accounts: counted,
		horizon,
		table,
		calibration,
		scenarios,
		workStartMinute: workStartMinute(
			table,
			timeZone,
			input.settings.workStartSharePct,
		),
	};
}

async function computeForecast(
	input: ForecastInput,
	noiseMode: NoiseMode,
): Promise<ForecastResult> {
	const ctx = await prepare(input, { noiseMode });
	if ("rule" in ctx) return unavailable(input, "insufficient_history", ctx);
	const { plan, result } = await planForecast(ctx);
	await yieldToEventLoop();

	const response = buildResponse(ctx, result);
	checkBlock(response.day);
	checkBlock(response.week);
	return { available: true, response, plan };
}

function historyDetail(table: DayTable): UnavailableDetail {
	const type = table.today.type;
	const own = table.days.filter((d) => d.type === type).length;
	return {
		rule: "history",
		recordedDays: table.days.length,
		minRecordedDays: MIN_RECORDED_DAYS,
		pool: own >= MIN_POOL_DAYS || type === "weekend" ? type : "weekdays",
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
