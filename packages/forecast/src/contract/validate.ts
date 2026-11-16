import { FORECAST_CONTRACT_VERSION } from "../types";
import { FIXED_PERCENTILES, NAMED_LEVELS } from "./levels";

type Obj = Record<string, unknown>;

const REASONS = ["insufficient_history", "error", "disabled"] as const;
const STOP_LEVELS = ["light", "typical", "heavy"] as const;
const FAN_KEY = /^p([1-9][0-9]?)$/;
/** One decimal per part: rounding may move the sum by up to 0.05 per part. */
const ROUNDING_PER_PART = 0.05;
const EPSILON = 1e-9;
/** Points carry one decimal (spec section 3); tolerance for float noise. */
const DECIMAL_TOLERANCE = 1e-6;

function isOneDecimal(v: number): boolean {
	return Math.abs(v * 10 - Math.round(v * 10)) <= DECIMAL_TOLERANCE;
}

function isObj(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isPoints(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && value >= -EPSILON
	);
}

interface Interval {
	start: number;
	end: number;
}

/**
 * Check a value against the forecast endpoint specification (contract
 * version 1, spec revision 2, docs/forecast-endpoint.md): fields and types,
 * array lengths, the ordering of every level at every index, jumps as exactly
 * two entries, stops inside the projection, `fan` keys `pNN`. Unknown fields
 * are allowed (clients ignore them). Returns one message per problem, each
 * starting with the path of the field; empty means the value conforms.
 */
export function validateForecastResponse(value: unknown): string[] {
	const errors: string[] = [];
	const err = (path: string, message: string) =>
		errors.push(`${path} ${message}`);

	if (!isObj(value)) {
		err("response", "must be a JSON object");
		return errors;
	}

	const has = (key: string) => {
		if (key in value) return true;
		err(key, "is missing");
		return false;
	};

	if (
		has("contractVersion") &&
		value.contractVersion !== FORECAST_CONTRACT_VERSION
	)
		err("contractVersion", `must be ${FORECAST_CONTRACT_VERSION}`);

	const computedAt = value.computedAt;
	const computedAtOk = has("computedAt") && isTime(computedAt);
	if ("computedAt" in value && !computedAtOk)
		err("computedAt", "must be an integer epoch-ms time");

	let available: boolean | null = null;
	if (has("available")) {
		if (typeof value.available === "boolean") available = value.available;
		else err("available", "must be a boolean");
	}

	if (has("reason")) {
		if (available === true && value.reason !== null)
			err("reason", "must be null when available is true");
		if (
			available === false &&
			!REASONS.includes(value.reason as (typeof REASONS)[number])
		)
			err(
				"reason",
				`must be one of ${REASONS.join(", ")} when available is false`,
			);
	}

	let accounts: string[] = [];
	if (has("accounts")) {
		if (
			Array.isArray(value.accounts) &&
			value.accounts.every((a) => typeof a === "string" && a !== "")
		) {
			accounts = value.accounts as string[];
			if (new Set(accounts).size !== accounts.length)
				err("accounts", "must not repeat an id");
		} else err("accounts", "must be a list of account id strings");
	}

	if (has("levels")) {
		const levels = value.levels;
		if (!isObj(levels)) err("levels", "must be an object");
		else
			for (const [name, percentile] of Object.entries(NAMED_LEVELS))
				if (levels[name] !== percentile)
					err(`levels.${name}`, `must be ${percentile}`);
	}

	for (const key of ["day", "week"] as const) {
		if (!has(key)) continue;
		const block = value[key];
		if (available === false) {
			if (block !== null) err(key, "must be null when available is false");
		} else if (block === null) {
			if (available === true)
				err(key, "must be an object when available is true");
		} else if (!isObj(block)) {
			err(key, "must be an object or null");
		} else if (computedAtOk) {
			validateBlock(block, key, computedAt as number, accounts, err);
		}
	}

	if (has("fable")) {
		const fable = value.fable;
		if (!isObj(fable)) err("fable", "must be an object");
		else {
			if (available === false && Object.keys(fable).length > 0)
				err("fable", "must be {} when available is false");
			for (const [id, entry] of Object.entries(fable)) {
				if (available === true && !accounts.includes(id))
					err(`fable.${id}`, "is not a counted account");
				if (!isObj(entry) || !(entry.outAt === null || isTime(entry.outAt)))
					err(`fable.${id}.outAt`, "must be an integer epoch-ms time or null");
			}
			if (available === true)
				for (const id of accounts)
					if (!(id in fable)) err("fable", `is missing counted account ${id}`);
		}
	}

	if ("prewarm" in value && value.prewarm !== undefined)
		validatePrewarm(value.prewarm, err);

	return errors;
}

type Err = (path: string, message: string) => void;

function validateSeries(
	path: string,
	times: unknown,
	err: Err,
	first: number | null,
): number[] | null {
	if (!Array.isArray(times)) {
		err(path, "must be a list of integer epoch-ms times");
		return null;
	}
	let ok = true;
	for (let i = 0; i < times.length; i++) {
		const t = times[i];
		if (!isTime(t)) {
			err(`${path}[${i}]`, "must be an integer epoch-ms time");
			ok = false;
			continue;
		}
		if (i === 0) {
			if (first !== null && t !== first) {
				err(`${path}[0]`, `must be computedAt (${first})`);
				ok = false;
			}
			continue;
		}
		const prev = times[i - 1] as number;
		if (t < prev) {
			err(`${path}[${i}]`, `goes back in time (${t} after ${prev})`);
			ok = false;
		} else if (t === prev && i >= 2 && times[i - 2] === t) {
			err(
				`${path}[${i}]`,
				"repeats a time a third time; a jump is exactly two entries",
			);
			ok = false;
		}
	}
	if (first !== null && times.length === 0) {
		err(path, "must not be empty");
		ok = false;
	}
	return ok ? (times as number[]) : null;
}

function validateValues(
	path: string,
	values: unknown,
	length: number,
	err: Err,
	max?: number,
): number[] | null {
	if (!Array.isArray(values)) {
		err(path, "must be a list of numbers");
		return null;
	}
	let ok = true;
	if (values.length !== length) {
		err(path, `has ${values.length} entries, its time axis has ${length}`);
		ok = false;
	}
	for (let i = 0; i < values.length; i++) {
		if (!isPoints(values[i])) {
			err(`${path}[${i}]`, "must be a finite number of points, not below 0");
			ok = false;
		} else if (!isOneDecimal(values[i])) {
			err(`${path}[${i}]`, `(${values[i]}) must have at most one decimal`);
			ok = false;
		} else if (max !== undefined && values[i] > max + EPSILON) {
			err(
				`${path}[${i}]`,
				`(${values[i]}) is above ${max}, 100 points per counted account`,
			);
			ok = false;
		}
	}
	return ok ? (values as number[]) : null;
}

function parseInterval(
	path: string,
	value: unknown,
	err: Err,
): Interval | null {
	if (!isObj(value) || !isTime(value.start) || !isTime(value.end)) {
		err(path, "must be { start, end } with integer epoch-ms times");
		return null;
	}
	if (value.end <= value.start) {
		err(path, "must end after it starts");
		return null;
	}
	return { start: value.start, end: value.end };
}

function parseIntervalList(
	path: string,
	value: unknown,
	err: Err,
): Interval[] | null {
	if (!Array.isArray(value)) {
		err(path, "must be a list of { start, end }");
		return null;
	}
	const out: Interval[] = [];
	let ok = true;
	value.forEach((entry, i) => {
		const interval = parseInterval(`${path}[${i}]`, entry, err);
		if (!interval) {
			ok = false;
			return;
		}
		const prev = out[out.length - 1];
		if (prev && interval.start < prev.end) {
			err(`${path}[${i}]`, "is out of time order or overlaps the one before");
			ok = false;
		}
		out.push(interval);
	});
	return ok ? out : null;
}

function sameInterval(a: Interval, b: Interval): boolean {
	return a.start === b.start && a.end === b.end;
}

function validateBlock(
	block: Obj,
	key: "day" | "week",
	computedAt: number,
	accounts: string[],
	err: Err,
): void {
	const has = (field: string) => {
		if (field in block) return true;
		err(`${key}.${field}`, "is missing");
		return false;
	};

	if (has("past")) {
		const past = block.past;
		if (!isObj(past)) err(`${key}.past`, "must be { times, values }");
		else {
			const times = validateSeries(`${key}.past.times`, past.times, err, null);
			if (times) {
				const values = validateValues(
					`${key}.past.values`,
					past.values,
					times.length,
					err,
				);
				// Quota left only rises at a reset, which is drawn as two entries with one time.
				if (values)
					for (let i = 1; i < values.length; i++)
						if (
							values[i] > values[i - 1] + EPSILON &&
							times[i] !== times[i - 1]
						)
							err(
								`${key}.past.values[${i}]`,
								`rises from ${values[i - 1]} without a jump: a reset must be two entries with the same time`,
							);
				const last = times[times.length - 1];
				if (last !== undefined && last > computedAt)
					err(`${key}.past.times`, "must not reach past computedAt");
			}
		}
	}

	const times = has("times")
		? validateSeries(`${key}.times`, block.times, err, computedAt)
		: null;
	const pool = accounts.length > 0 ? 100 * accounts.length : undefined;

	// The pointwise lines in percentile order: light, the fan, heavy. typical is one
	// simulated day, ordered only against light and heavy.
	const lines: { percentile: number; path: string; values: number[] | null }[] =
		[];
	const named: Record<string, number[] | null> = {};
	for (const name of STOP_LEVELS) {
		if (!has(name)) continue;
		const path = `${key}.${name}`;
		const values = times
			? validateValues(path, block[name], times.length, err, pool)
			: null;
		named[name] = values;
		if (name !== "typical")
			lines.push({ percentile: NAMED_LEVELS[name], path, values });
	}
	if (has("fan")) {
		const fan = block.fan;
		if (!isObj(fan)) err(`${key}.fan`, "must be an object keyed pNN");
		else
			for (const [fanKey, series] of Object.entries(fan)) {
				const path = `${key}.fan.${fanKey}`;
				const match = FAN_KEY.exec(fanKey);
				const percentile = match ? Number(match[1]) : Number.NaN;
				if (!match || FIXED_PERCENTILES.includes(percentile)) {
					err(
						path,
						"is not a fan key: expected p1…p99 without leading zero, other than p10, p50, p90",
					);
					continue;
				}
				const values = times
					? validateValues(path, series, times.length, err, pool)
					: null;
				lines.push({ percentile, path, values });
			}
	}
	lines.sort((a, b) => a.percentile - b.percentile);
	const ordered = (
		upper: (typeof lines)[number],
		lower: (typeof lines)[number],
	) => {
		if (!times || !upper.values || !lower.values) return;
		for (let i = 0; i < times.length; i++)
			if (lower.values[i] > upper.values[i] + EPSILON)
				err(
					`${lower.path}[${i}]`,
					`(${lower.values[i]}) is above ${upper.path}[${i}] (${upper.values[i]}); levels must not rise with the percentile`,
				);
	};
	for (let l = 1; l < lines.length; l++) ordered(lines[l - 1], lines[l]);
	if (has("typical")) {
		const line = (name: "light" | "typical" | "heavy") => ({
			percentile: NAMED_LEVELS[name],
			path: `${key}.${name}`,
			values: named[name] ?? null,
		});
		if (has("light")) ordered(line("light"), line("typical"));
		if (has("heavy")) ordered(line("typical"), line("heavy"));
	}

	const stops: Partial<Record<(typeof STOP_LEVELS)[number], Interval[]>> = {};
	if (has("stops")) {
		const raw = block.stops;
		if (!isObj(raw)) err(`${key}.stops`, "must be { light, typical, heavy }");
		else
			for (const level of STOP_LEVELS) {
				const path = `${key}.stops.${level}`;
				if (!(level in raw)) {
					err(path, "is missing");
					continue;
				}
				const list = parseIntervalList(path, raw[level], err);
				if (!list) continue;
				stops[level] = list;
				if (times) checkStopsOnLine(path, list, times, named[level], err);
			}
		// light ⊂ typical ⊂ heavy
		const nest = (
			inner: (typeof STOP_LEVELS)[number],
			outer: (typeof STOP_LEVELS)[number],
		) => {
			const outerList = stops[outer];
			stops[inner]?.forEach((s, i) => {
				if (
					outerList &&
					!outerList.some((o) => o.start <= s.start && s.end <= o.end)
				)
					err(
						`${key}.stops.${inner}[${i}]`,
						`lies outside every ${outer} stop`,
					);
			});
		};
		nest("light", "typical");
		nest("typical", "heavy");
	}

	let stopNow: Interval | null = null;
	if (has("stopNow") && block.stopNow !== null) {
		stopNow = parseInterval(`${key}.stopNow`, block.stopNow, err);
		if (stopNow && !(stopNow.start <= computedAt && computedAt < stopNow.end)) {
			err(`${key}.stopNow`, "must have begun by computedAt and end after it");
			stopNow = null;
		}
	}

	if (has("pastStops")) {
		const list = parseIntervalList(`${key}.pastStops`, block.pastStops, err);
		list?.forEach((s, i) => {
			if (s.end > computedAt)
				err(`${key}.pastStops[${i}]`, "must have ended by computedAt");
		});
	}

	if (has("shortfall") && block.shortfall !== null) {
		validateShortfall(
			block.shortfall,
			`${key}.shortfall`,
			stopNow,
			stops.typical,
			accounts,
			err,
		);
	}
}

/**
 * A projected stop starts after computedAt (a begun stop is stopNow only),
 * lies inside the projection, starts on an axis point where its line is 0,
 * stays 0 until it ends, and is maximal: the entry before its start is above
 * 0, and so is the entry at its end when the end is an axis point before the
 * end of the projection. The end itself need not lie on the axis.
 */
function checkStopsOnLine(
	path: string,
	list: Interval[],
	times: number[],
	line: number[] | null | undefined,
	err: Err,
): void {
	const first = times[0];
	const last = times[times.length - 1];
	list.forEach((stop, s) => {
		const p = `${path}[${s}]`;
		if (stop.start <= first || stop.end > last) {
			err(
				p,
				`lies outside the projection: must start after ${first} and end by ${last}`,
			);
			return;
		}
		if (!line) return;
		// With a jump, the first entry at a time is the value before it, the last the value after.
		const firstAt = times.indexOf(stop.start);
		if (firstAt < 0) {
			err(p, "must start on a time-axis point where its line is 0");
			return;
		}
		const startAt = times.lastIndexOf(stop.start);
		if (line[startAt] > EPSILON) {
			err(p, "must start on a time-axis point where its line is 0");
			return;
		}
		// The entry before the first zero at the start time; an unchanged level
		// may carry its 0 twice there when another level jumps at that time.
		let zeroAt = firstAt;
		while (zeroAt < startAt && line[zeroAt] > EPSILON) zeroAt++;
		if (line[zeroAt - 1] <= EPSILON)
			err(p, "is not maximal: its line is already 0 before its start");
		for (let i = startAt + 1; i < times.length && times[i] < stop.end; i++)
			if (line[i] > EPSILON) {
				err(p, `has its line above 0 inside it (at index ${i})`);
				return;
			}
		// The end is the first moment above 0 again: the first entry at or after it is above 0.
		if (stop.end < last) {
			let endAt = times.findIndex((t) => t >= stop.end);
			if (times[endAt] === stop.end) endAt = times.lastIndexOf(stop.end);
			if (line[endAt] <= EPSILON)
				err(p, "is not maximal: its line is still 0 at or after its end");
		}
	});
}

function validateShortfall(
	value: unknown,
	path: string,
	stopNow: Interval | null,
	typicalStops: Interval[] | undefined,
	accounts: string[],
	err: Err,
): void {
	if (!isObj(value)) {
		err(path, "must be null or { stop, points, lastAccount, perAccount }");
		return;
	}
	const stop = parseInterval(`${path}.stop`, value.stop, err);
	const expected = stopNow ?? typicalStops?.[0] ?? null;
	if (stop) {
		if (expected === null) {
			if (typicalStops)
				err(
					path,
					"must be null when there is neither stopNow nor a typical stop",
				);
		} else if (!sameInterval(stop, expected))
			err(
				`${path}.stop`,
				stopNow ? "must be stopNow" : "must be the first typical stop",
			);
	}
	const points = value.points;
	if (!isPoints(points)) err(`${path}.points`, "must be a number not below 0");
	else if (!isOneDecimal(points))
		err(`${path}.points`, "must have at most one decimal");
	if (
		typeof value.lastAccount !== "string" ||
		!accounts.includes(value.lastAccount)
	)
		err(`${path}.lastAccount`, "must be a counted account");
	const per = value.perAccount;
	if (!isObj(per)) {
		err(`${path}.perAccount`, "must be an object of account id to points");
		return;
	}
	let sum = 0;
	let ok = true;
	for (const [id, part] of Object.entries(per)) {
		if (!accounts.includes(id))
			err(`${path}.perAccount.${id}`, "is not a counted account");
		if (!isPoints(part)) {
			err(`${path}.perAccount.${id}`, "must be a number not below 0");
			ok = false;
		} else {
			if (!isOneDecimal(part))
				err(`${path}.perAccount.${id}`, "must have at most one decimal");
			sum += part;
		}
	}
	const parts = Object.keys(per).length;
	if (
		ok &&
		isPoints(points) &&
		Math.abs(sum - points) > ROUNDING_PER_PART * (parts + 1) + EPSILON
	)
		err(`${path}.perAccount`, `sums to ${sum}, not to points (${points})`);
}

function validatePrewarm(value: unknown, err: Err): void {
	if (!isObj(value)) {
		err("prewarm", "must be { enabled, planned, last }");
		return;
	}
	if (typeof value.enabled !== "boolean")
		err("prewarm.enabled", "must be a boolean");
	if (!Array.isArray(value.planned)) err("prewarm.planned", "must be a list");
	else
		value.planned.forEach((p, i) => {
			if (!isObj(p) || typeof p.accountId !== "string" || !isTime(p.openAt))
				err(`prewarm.planned[${i}]`, "must be { accountId, openAt }");
		});
	if (!Array.isArray(value.last)) {
		err("prewarm.last", "must be a list");
		return;
	}
	if (value.last.length > 20)
		err("prewarm.last", "must hold at most 20 entries");
	let prevFired: number | null = null;
	value.last.forEach((r, i) => {
		const p = `prewarm.last[${i}]`;
		if (!isObj(r)) {
			err(p, "must be an object");
			return;
		}
		if (typeof r.accountId !== "string")
			err(`${p}.accountId`, "must be a string");
		if (r.kind !== "plan" && r.kind !== "test")
			err(`${p}.kind`, 'must be "plan" or "test"');
		if (!isTime(r.scheduledAt)) err(`${p}.scheduledAt`, "must be a time");
		if (!isTime(r.firedAt)) err(`${p}.firedAt`, "must be a time");
		if (!(r.exitCode === null || Number.isInteger(r.exitCode)))
			err(`${p}.exitCode`, "must be an integer or null");
		if (!(r.windowOpened === null || typeof r.windowOpened === "boolean"))
			err(`${p}.windowOpened`, "must be true, false or null");
		if (!(r.resetsAt === null || isTime(r.resetsAt)))
			err(`${p}.resetsAt`, "must be a time or null");
		if (isTime(r.firedAt)) {
			if (prevFired !== null && r.firedAt > prevFired)
				err(p, "is newer than the entry before; newest first");
			prevFired = r.firedAt;
		}
	});
}
