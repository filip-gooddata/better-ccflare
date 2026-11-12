/**
 * Entry point of the forecast engine: one computation from a ForecastInput to the
 * HTTP response and the plan. Stages: day table, availability, calibration (ratio of
 * sums), horizon, scenarios (smoothed bootstrap), planner (receding-horizon search),
 * response. Yields to the event loop between stages; the stages yield inside.
 */
import type {
	AccountId,
	AccountLimits,
	ForecastBlock,
	ForecastEngine,
	ForecastInput,
	ForecastResult,
	UnavailableReason,
} from "../types";
import { calibrate } from "./calibration";
import { buildDayTable, historyAvailable, workStartMinute } from "./days";
import { computeHorizon } from "./horizon";
import type { EngineContext } from "./model";
import { planForecast } from "./planner";
import { buildResponse, unavailableResponse } from "./response";
import { buildScenarios } from "./scenarios";
import { yieldToEventLoop } from "./yield";

export interface ForecastEngineOptions {
	/** Kernel noise of the smoothed bootstrap; off gives plain resampling (for measurement). */
	noise?: boolean;
}

export function createForecastEngine(
	options: ForecastEngineOptions = {},
): ForecastEngine {
	const noise = options.noise ?? true;
	return {
		async compute(input: ForecastInput): Promise<ForecastResult> {
			try {
				return await computeForecast(input, noise);
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
	options: { noise: boolean },
): Promise<EngineContext | "insufficient_history"> {
	checkInput(input);
	const counted = input.accounts.filter((a) => a.counted);
	if (counted.length === 0) return "insufficient_history";

	const table = buildDayTable(input);
	if (!historyAvailable(table)) return "insufficient_history";
	await yieldToEventLoop();

	const calibration = calibrate(input, counted);
	if (!calibrated(calibration, counted)) return "insufficient_history";
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
	noise: boolean,
): Promise<ForecastResult> {
	const ctx = await prepareEngineContext(input, { noise });
	if (ctx === "insufficient_history") return unavailable(input, ctx);
	const { plan, result } = await planForecast(ctx);
	await yieldToEventLoop();

	const response = buildResponse(ctx, result);
	checkBlock(response.day);
	checkBlock(response.week);
	return { available: true, response, plan };
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
): ForecastResult {
	return {
		available: false,
		reason,
		response: unavailableResponse(safeNow(input), reason, safeAccounts(input)),
		plan: null,
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
