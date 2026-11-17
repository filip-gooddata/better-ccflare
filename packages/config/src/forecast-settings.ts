import { isAbsolute, join } from "node:path";
import {
	DEFAULT_FAN_LEVELS,
	FIXED_PERCENTILES,
	type ForecastSettings,
} from "@better-ccflare/forecast";

/** Config-file keys of the forecast settings (snake_case, like `session_pace_*`). */
export interface ForecastConfigData {
	forecast_enabled?: unknown;
	forecast_routing?: unknown;
	forecast_prewarm?: unknown;
	forecast_prewarm_test?: unknown;
	forecast_claude_path?: unknown;
	forecast_prewarm_model?: unknown;
	forecast_prewarm_max_per_day?: unknown;
	forecast_simulated_days?: unknown;
	forecast_time_shift_min?: unknown;
	forecast_transcripts_dir?: unknown;
	forecast_fan_levels?: unknown;
	forecast_min_stop_points?: unknown;
	forecast_move_min_gain_points?: unknown;
	forecast_open_min_gain_points?: unknown;
	forecast_history_half_life_days?: unknown;
	forecast_history_lookback_days?: unknown;
	forecast_session_turnover_min?: unknown;
	forecast_work_start_share_pct?: unknown;
	forecast_pace_conditioning?: unknown;
}

type FileKey = keyof ForecastConfigData;

interface NumberSpec {
	field: keyof ForecastSettings;
	env: string;
	key: FileKey;
	fallback: number;
	min: number;
	max: number;
	integer: boolean;
}

/**
 * Every numeric forecast setting: environment variable, config key, default
 * and clamp range. Exported so the documentation test can list them.
 */
export const FORECAST_NUMBER_SETTINGS: readonly NumberSpec[] = [
	n("prewarmMaxPerDay", "PREWARM_MAX_PER_DAY", 4, 0, 24, true),
	n("simulatedDays", "SIMULATED_DAYS", 400, 50, 2000, true),
	n("timeShiftMin", "TIME_SHIFT_MIN", 30, 0, 120, false),
	n("minStopPoints", "MIN_STOP_POINTS", 1, 0, 100, false),
	n("moveMinGainPoints", "MOVE_MIN_GAIN_POINTS", 2, 0, 100, false),
	n("openMinGainPoints", "OPEN_MIN_GAIN_POINTS", 1, 0, 100, false),
	n("historyHalfLifeDays", "HISTORY_HALF_LIFE_DAYS", 14, 1, 365, false),
	n("historyLookbackDays", "HISTORY_LOOKBACK_DAYS", 84, 7, 365, true),
	n("sessionTurnoverMin", "SESSION_TURNOVER_MIN", 60, 1, 1440, false),
	n("workStartSharePct", "WORK_START_SHARE_PCT", 5, 1, 50, false),
];

function n(
	field: keyof ForecastSettings,
	suffix: string,
	fallback: number,
	min: number,
	max: number,
	integer: boolean,
): NumberSpec {
	return {
		field,
		env: `FORECAST_${suffix}`,
		key: `forecast_${suffix.toLowerCase()}` as FileKey,
		fallback,
		min,
		max,
		integer,
	};
}

export const DEFAULT_TRANSCRIPTS_DIR = "~/.claude/projects";
export const DEFAULT_PREWARM_MODEL = "haiku";
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const ISO_WITH_ZONE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const NONE = "none";

export interface ForecastResolveInput {
	env: Record<string, string | undefined>;
	file: ForecastConfigData;
	home: string;
	/** Called once per distinct invalid input (the caller dedupes). */
	warn: (source: string, raw: unknown, expected: string, using: string) => void;
}

type Raw = { source: string; value: unknown; fromEnv: boolean } | null;

/** Environment first (a non-empty value), then the config file key. */
function pick(input: ForecastResolveInput, env: string, key: FileKey): Raw {
	const fromEnv = input.env[env];
	if (fromEnv !== undefined && fromEnv !== "")
		return { source: env, value: fromEnv, fromEnv: true };
	if (key in input.file && input.file[key] !== undefined)
		return { source: key, value: input.file[key], fromEnv: false };
	return null;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function resolveBoolean(
	input: ForecastResolveInput,
	env: string,
	key: FileKey,
	fallback: boolean,
): boolean {
	const raw = pick(input, env, key);
	if (!raw) return fallback;
	if (typeof raw.value === "boolean") return raw.value;
	if (raw.fromEnv) {
		const s = String(raw.value).trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(s)) return true;
		if (["false", "0", "no", "off"].includes(s)) return false;
	}
	input.warn(raw.source, raw.value, "true or false", String(fallback));
	return fallback;
}

function resolveNumber(input: ForecastResolveInput, spec: NumberSpec): number {
	const raw = pick(input, spec.env, spec.key);
	if (!raw) return spec.fallback;
	const value =
		typeof raw.value === "number"
			? raw.value
			: raw.fromEnv && String(raw.value).trim() !== ""
				? Number(raw.value)
				: Number.NaN;
	if (!Number.isFinite(value)) {
		input.warn(
			raw.source,
			raw.value,
			`a number from ${spec.min} to ${spec.max}`,
			String(spec.fallback),
		);
		return spec.fallback;
	}
	const rounded = spec.integer ? Math.round(value) : value;
	return Math.min(spec.max, Math.max(spec.min, rounded));
}

/** An absolute path after `~` expansion; `null` or "none" (or "" in the file) switch it off. */
function resolvePath(
	input: ForecastResolveInput,
	env: string,
	key: FileKey,
	fallback: string | null,
): string | null {
	const raw = pick(input, env, key);
	const resolvedFallback =
		fallback === null ? null : expandHome(fallback, input.home);
	if (!raw) return resolvedFallback;
	if (raw.value === null) return null;
	if (typeof raw.value === "string") {
		const trimmed = raw.value.trim();
		if (trimmed === "" || trimmed.toLowerCase() === NONE) return null;
		const expanded = expandHome(trimmed, input.home);
		if (isAbsolute(expanded)) return expanded;
	}
	input.warn(
		raw.source,
		raw.value,
		`an absolute path (a leading ~ is expanded), or "${NONE}"`,
		String(resolvedFallback),
	);
	return resolvedFallback;
}

function resolveModel(input: ForecastResolveInput): string {
	const raw = pick(input, "FORECAST_PREWARM_MODEL", "forecast_prewarm_model");
	if (!raw) return DEFAULT_PREWARM_MODEL;
	if (typeof raw.value === "string" && MODEL_ALIAS.test(raw.value.trim()))
		return raw.value.trim();
	input.warn(
		raw.source,
		raw.value,
		"a model alias or id (letters, digits, . _ : - [ ])",
		DEFAULT_PREWARM_MODEL,
	);
	return DEFAULT_PREWARM_MODEL;
}

function resolveFanLevels(input: ForecastResolveInput): number[] {
	const raw = pick(input, "FORECAST_FAN_LEVELS", "forecast_fan_levels");
	const fallback = [...DEFAULT_FAN_LEVELS];
	if (!raw) return fallback;
	let list: unknown[] | null = null;
	if (Array.isArray(raw.value)) list = raw.value;
	else if (raw.fromEnv && typeof raw.value === "string") {
		const s = raw.value.trim();
		list =
			s.toLowerCase() === NONE
				? []
				: s.split(",").map((part) => {
						const t = part.trim();
						return t === "" ? Number.NaN : Number(t);
					});
	}
	if (
		list === null ||
		!list.every(
			(p) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 99,
		)
	) {
		input.warn(
			raw.source,
			raw.value,
			`a list of whole percentiles from 1 to 99 (comma-separated in the environment, "${NONE}" for no fan)`,
			"every 2 points 12…48 and 52…88",
		);
		return fallback;
	}
	return [...new Set(list as number[])]
		.filter((p) => !FIXED_PERCENTILES.includes(p))
		.sort((a, b) => a - b);
}

function parseAt(value: unknown): number | null {
	if (typeof value === "number")
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	if (typeof value !== "string") return null;
	const s = value.trim();
	if (/^\d+$/.test(s)) {
		const ms = Number(s);
		return Number.isSafeInteger(ms) ? ms : null;
	}
	if (!ISO_WITH_ZONE.test(s)) return null;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : null;
}

function resolvePrewarmTest(
	input: ForecastResolveInput,
): ForecastSettings["prewarmTest"] {
	const raw = pick(input, "FORECAST_PREWARM_TEST", "forecast_prewarm_test");
	if (!raw || raw.value === null) return null;
	let value = raw.value;
	if (raw.fromEnv && typeof value === "string") {
		if (value.trim().toLowerCase() === NONE) return null;
		try {
			value = JSON.parse(value);
		} catch {
			value = undefined;
		}
	}
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { account?: unknown }).account === "string" &&
		(value as { account: string }).account.trim() !== ""
	) {
		const at = parseAt((value as { at?: unknown }).at);
		if (at !== null)
			return { account: (value as { account: string }).account.trim(), at };
	}
	input.warn(
		raw.source,
		raw.value,
		'{ "account": <name or id>, "at": <ISO time with zone, or epoch ms> }, or null',
		"null",
	);
	return null;
}

/**
 * Resolve every forecast setting: environment variable over config file
 * over default; numbers clamped to their range; an invalid value is reported
 * through `warn` and replaced by the default.
 */
export function resolveForecastSettings(
	input: ForecastResolveInput,
): ForecastSettings {
	const numbers = Object.fromEntries(
		FORECAST_NUMBER_SETTINGS.map((spec) => [
			spec.field,
			resolveNumber(input, spec),
		]),
	) as Record<string, number>;
	return {
		enabled: resolveBoolean(
			input,
			"FORECAST_ENABLED",
			"forecast_enabled",
			true,
		),
		routing: resolveBoolean(
			input,
			"FORECAST_ROUTING",
			"forecast_routing",
			true,
		),
		prewarm: resolveBoolean(
			input,
			"FORECAST_PREWARM",
			"forecast_prewarm",
			false,
		),
		prewarmTest: resolvePrewarmTest(input),
		claudePath: resolvePath(
			input,
			"FORECAST_CLAUDE_PATH",
			"forecast_claude_path",
			null,
		),
		prewarmModel: resolveModel(input),
		prewarmMaxPerDay: numbers.prewarmMaxPerDay,
		simulatedDays: numbers.simulatedDays,
		timeShiftMin: numbers.timeShiftMin,
		transcriptsDir: resolvePath(
			input,
			"FORECAST_TRANSCRIPTS_DIR",
			"forecast_transcripts_dir",
			DEFAULT_TRANSCRIPTS_DIR,
		),
		fanLevels: resolveFanLevels(input),
		minStopPoints: numbers.minStopPoints,
		moveMinGainPoints: numbers.moveMinGainPoints,
		openMinGainPoints: numbers.openMinGainPoints,
		historyHalfLifeDays: numbers.historyHalfLifeDays,
		historyLookbackDays: numbers.historyLookbackDays,
		sessionTurnoverMin: numbers.sessionTurnoverMin,
		workStartSharePct: numbers.workStartSharePct,
		paceConditioning: resolveBoolean(
			input,
			"FORECAST_PACE_CONDITIONING",
			"forecast_pace_conditioning",
			true,
		),
	};
}
