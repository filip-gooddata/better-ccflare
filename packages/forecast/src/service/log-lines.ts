/**
 * The service's summary log lines: the end of the transcript backfill and why there is no
 * forecast (design amendment 3, C2), and what an available forecast was computed from
 * (amendment 4, D2). All are built only from numbers, dates, fixed words and account ids,
 * never from text a transcript or a path could have supplied.
 */
import type { PlanLowPoints } from "../engine/model";
import type {
	EpochMs,
	ForecastInputsDetail,
	ForecastResult,
	UnavailableDetail,
} from "../types";

const HOUR_MS = 3_600_000;
const BACKFILL_STATUSES = new Set(["done", "already_done", "no_dir"]);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function field(source: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(source, key) ? source[key] : undefined;
}

function count(source: Record<string, unknown>, key: string): string {
	const v = field(source, key);
	return typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
}

function day(source: Record<string, unknown>, key: string): string {
	const v = field(source, key);
	return typeof v === "string" && DAY_KEY.test(v) ? v : "none";
}

/** One INFO line with the backfill's counts, its days with demand, cut-over, status and run time. */
export function backfillLine(result: unknown, runMs: number): string {
	const r =
		result !== null && typeof result === "object"
			? (result as Record<string, unknown>)
			: {};
	const status = field(r, "status");
	const cutover = field(r, "cutover");
	const days = count(r, "demandDays");
	return [
		"forecast backfill finished",
		`status=${typeof status === "string" && BACKFILL_STATUSES.has(status) ? status : "unknown"}`,
		`files=${count(r, "files")}`,
		`unreadable=${count(r, "unreadable")}`,
		`lines=${count(r, "lines")}`,
		`stored=${count(r, "responses")}`,
		`skipped: noUsage=${count(r, "skipped")}`,
		`duplicate=${count(r, "deduped")}`,
		`afterCutover=${count(r, "afterCutover")}`,
		`malformed=${count(r, "malformed")}`,
		`unkeyed=${count(r, "unkeyed")}`,
		`rows=${count(r, "rows")}`,
		`cleared=${count(r, "cleared")}`,
		`days=${days}`,
		`first=${day(r, "firstDemandDay")}`,
		`last=${day(r, "lastDemandDay")}`,
		`cutover=${typeof cutover === "number" && Number.isFinite(cutover) ? new Date(cutover).toISOString() : "none"}`,
		`ms=${Number.isFinite(runMs) ? Math.max(0, Math.round(runMs)) : "?"}`,
	].join(" ");
}

/** One INFO line with the usage-detail backfill's counts, status and run time; counts only. */
export function usageDetailBackfillLine(
	result: unknown,
	runMs: number,
): string {
	const r =
		result !== null && typeof result === "object"
			? (result as Record<string, unknown>)
			: {};
	const status = field(r, "status");
	return [
		"forecast usage detail backfill finished",
		`status=${typeof status === "string" && BACKFILL_STATUSES.has(status) ? status : "unknown"}`,
		`files=${count(r, "files")}`,
		`unreadable=${count(r, "unreadable")}`,
		`lines=${count(r, "lines")}`,
		`malformed=${count(r, "malformed")}`,
		`tokenRows=${count(r, "tokenRows")}`,
		`requests=${count(r, "sessionRequests")}`,
		`ms=${Number.isFinite(runMs) ? Math.max(0, Math.round(runMs)) : "?"}`,
	].join(" ");
}

/** The printed line, and the key that decides whether it says something new. */
function describe(result: Extract<ForecastResult, { available: false }>): {
	line: string;
	key: string;
} {
	const head = `forecast unavailable reason=${result.reason}`;
	const detail: UnavailableDetail | undefined = result.detail;
	if (!detail) return { line: head, key: head };
	if (detail.rule === "no_counted_account") {
		const line = `${head} rule=no_counted_account`;
		return { line, key: line };
	}
	if (detail.rule === "history") {
		const line = `${head} rule=history recordedDays=${detail.recordedDays}/${detail.minRecordedDays} pool=${detail.pool}:${detail.poolDays}/${detail.minPoolDays}`;
		return { line, key: line };
	}
	const parts = detail.limits.map(
		(l) =>
			`${l.accountId}/${l.limit}: instances=${l.instances} points=${l.points}/${l.minPoints} units=${Math.round(l.units * 10) / 10} k=${l.k}`,
	);
	const line = `${head} rule=calibration ${parts.join("; ")}`;
	return { line, key: line };
}

/** At most one forecast-inputs line per this span (design amendment 4, D2). */
export const INPUTS_MIN_SPACING_MS = 10 * 60_000;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const POOLS = new Set(["workday", "monday", "weekend", "weekdays"]);
const LIMITS = new Set(["five_hour", "seven_day", "seven_day_fable"]);
const SOURCES = new Set(["own", "borrowed", "none"]);

function fixed(v: unknown, digits: number): string {
	return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "?";
}

function num(v: unknown): string {
	return typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
}

function word(v: unknown, allowed: Set<string>): string {
	return typeof v === "string" && allowed.has(v) ? v : "?";
}

function accountId(v: unknown): string {
	return typeof v === "string" && ACCOUNT_ID.test(v) ? v : "?";
}

function clock(minute: unknown): string {
	if (typeof minute !== "number" || !Number.isInteger(minute)) return "none";
	if (minute < 0 || minute >= 1440) return "none";
	const hh = String(Math.floor(minute / 60)).padStart(2, "0");
	const mm = String(minute % 60).padStart(2, "0");
	return `${hh}:${mm}`;
}

function orNone(v: number | null, digits: number): string {
	return v === null ? "none" : fixed(v, digits);
}

/**
 * One INFO line with what an available forecast was computed from: the day factor, the
 * recent rate, today's pool, the learned work start, every k with the hours ago of the
 * oldest and newest reading it counted, and each account's weekly cap on the day line
 * (r = k5 / kW, and whether it binds now). Numbers, fixed words and account ids only.
 */
export function inputsLine(
	d: ForecastInputsDetail & Partial<PlanLowPoints>,
): string {
	const f = d.dayFactor;
	const limits = d.limits.map(
		(l) =>
			`${accountId(l.accountId)}/${word(l.limit, LIMITS)}=${l.k === null ? "none" : fixed(l.k, 4)} ${word(l.source, SOURCES)} instances=${num(l.instances)} points=${num(l.points)} oldestH=${orNone(l.oldestHoursAgo, 1)} newestH=${orNone(l.newestHoursAgo, 1)}`,
	);
	const caps = d.caps.map(
		(c) =>
			`${accountId(c.accountId)} r=${c.ratio === null ? "none" : fixed(c.ratio, 2)} binds=${c.binds === true ? "yes" : "no"}`,
	);
	return [
		"forecast inputs",
		`dayFactor a=${fixed(f.a, 3)}`,
		`clamped=${fixed(f.clamped, 3)}`,
		`w=${fixed(f.weight, 4)}`,
		`raw=${fixed(f.raw, 3)}`,
		`Y=${fixed(f.y, 2)}`,
		`M=${fixed(f.m, 2)}`,
		`c=${fixed(f.c, 2)}`,
		`recentRate=${fixed(d.recentRatePerHour, 2)}/h`,
		`pool=${word(d.pool.name, POOLS)}:${num(d.pool.days)}`,
		`median=${orNone(d.pool.medianUnits, 1)}`,
		`p90=${orNone(d.pool.p90Units, 1)}`,
		`workStart=${clock(d.workStartMinute)}`,
		`k: ${limits.join("; ")}`,
		`cap: ${caps.join("; ")}`,
		...lowPointFields(d),
	].join(" ");
}

/** The planner's S for the chosen plan and for on demand (amendment 5, E5), when the engine gave them. */
function lowPointFields(d: Partial<PlanLowPoints>): string[] {
	const { lowPoint, lowPointOnDemand } = d;
	if (
		typeof lowPoint !== "number" ||
		typeof lowPointOnDemand !== "number" ||
		!Number.isFinite(lowPoint) ||
		!Number.isFinite(lowPointOnDemand)
	)
		return [];
	return [
		`lowPoint=${fixed(lowPoint, 1)}`,
		`lowPointOnDemand=${fixed(lowPointOnDemand, 1)}`,
	];
}

/**
 * What a new line must differ in: a rounded to 0.1 and each k rounded to 0.05. The reading
 * ages, r and the cap's binds flag stay out, like the other printed numbers: the ages move at
 * every computation, r follows the keyed k5 and kW, and binds can flip at each computation
 * while an account's two quotas left sit near each other (serving lowers both at the same
 * rate). A line written for another reason carries their current values.
 */
function inputsKey(d: ForecastInputsDetail): string {
	const a = Number.isFinite(d.dayFactor.a)
		? String(Math.round(d.dayFactor.a * 10))
		: "?";
	const sorted = [...d.limits].sort(
		(x, y) =>
			x.accountId.localeCompare(y.accountId) || x.limit.localeCompare(y.limit),
	);
	const ks = sorted.map(
		(l) =>
			`${l.accountId}/${l.limit}=${l.k === null || !Number.isFinite(l.k) ? "none" : Math.round(l.k * 20)}`,
	);
	return [a, ...ks].join(" ");
}

/**
 * Logs the forecast's inputs at the first available computation, then when a (to 0.1) or a k
 * (to 0.05) differs from the last line written, at most once per INPUTS_MIN_SPACING_MS: a
 * change inside the span is written by the first computation after it, with the state then.
 */
export function createInputsLog(log: (msg: string) => void): {
	record(result: ForecastResult, now: EpochMs): void;
} {
	let lastKey: string | null = null;
	let lastAt: EpochMs = 0;
	return {
		record(result, now) {
			if (!result.available || !result.inputs) return;
			const key = inputsKey(result.inputs);
			if (lastKey !== null) {
				if (key === lastKey) return;
				if (now - lastAt < INPUTS_MIN_SPACING_MS) return;
			}
			lastKey = key;
			lastAt = now;
			log(inputsLine(result.inputs));
		},
	};
}

/**
 * Logs why there is no forecast when the reason, the rule or a printed number changes, else
 * at most once an hour; and once when the forecast is available again.
 */
export function createAvailabilityLog(log: (msg: string) => void): {
	record(result: ForecastResult, now: EpochMs): void;
} {
	let lastKey: string | null = null;
	let lastAt: EpochMs = 0;
	return {
		record(result, now) {
			if (result.available) {
				if (lastKey !== null) log("forecast available again");
				lastKey = null;
				return;
			}
			const { line, key } = describe(result);
			if (key === lastKey && now - lastAt < HOUR_MS) return;
			lastKey = key;
			lastAt = now;
			log(line);
		},
	};
}
