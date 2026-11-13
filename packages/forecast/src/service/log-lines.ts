/**
 * The service's two summary log lines (design amendment 3, C2): the end of the transcript
 * backfill, and why there is no forecast. Both are built only from numbers, dates, fixed
 * words and account ids, never from text a transcript or a path could have supplied.
 */
import type { EpochMs, ForecastResult, UnavailableDetail } from "../types";

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
	const parts: string[] = [];
	const keys: string[] = [];
	for (const l of detail.limits) {
		const who = `${l.accountId}/${l.limit}`;
		const decided = `instances=${l.instances} points=${l.points}/${l.minPoints}`;
		parts.push(
			`${who}: ${decided} units=${Math.round(l.units * 10) / 10} k=${l.k}`,
		);
		// The unit sum grows with every request; only whether it is positive decides.
		keys.push(`${who}: ${decided} units>0=${l.units > 0} k=${l.k}`);
	}
	return {
		line: `${head} rule=calibration ${parts.join("; ")}`,
		key: `${head} rule=calibration ${keys.join("; ")}`,
	};
}

/**
 * Logs why there is no forecast when the reason, the rule or a deciding number changes, else
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
