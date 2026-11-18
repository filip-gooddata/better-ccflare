import { isUsageExhausted } from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import {
	type AnyUsageData,
	extractFiveHourWindow,
	extractModelFamilyWindows,
	extractWeeklyWindow,
	type UsageData,
	usageCache,
} from "@better-ccflare/providers";
import { getFamilyBlock } from "./model-capacity";

/**
 * The local answer for a request that must not reach an account because a
 * limit of that account is full. Anthropic-shaped: Claude Code reads the
 * `anthropic-ratelimit-unified-*` headers for its limit UI, so the proxy
 * either replays the account's last real upstream 429 or builds one from the
 * account's usage readings (DESIGN.md, no extra usage part 1, section 2).
 */

/** Which limit the answer describes. */
export type LimitBinding =
	| { kind: "five_hour" }
	| { kind: "seven_day" }
	| { kind: "family"; family: string };

export interface LocalLimitInput {
	binding: LimitBinding;
	/** Binding window reset (epoch ms). */
	resetMs: number | null;
	/** Utilization in percent (100 = full). */
	fiveHour?: { utilization: number; resetMs: number | null } | null;
	sevenDay?: { utilization: number; resetMs: number | null } | null;
	overage?: {
		usedCredits: number | null;
		monthlyLimit: number | null;
		disabledReason?: string | null;
	} | null;
}

const H = "anthropic-ratelimit-unified";
const RESET_HEADER = `${H}-reset`;
const CLAIM_HEADER = `${H}-representative-claim`;
const DISABLED_REASON_HEADER = `${H}-overage-disabled-reason`;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Upstream's value on every observed 429; the value it sends with extra usage off is unknown. */
const DEFAULT_DISABLED_REASON = "org_spend_cap_reached";
/** The weekly status turns `allowed_warning` at 75 % on the observed 429s. */
const WEEKLY_WARNING_PERCENT = 75;
/** Anthropic's own text for a rate_limit_error. */
const LOCAL_LIMIT_MESSAGE =
	"This request would exceed your account's rate limit. Please try again later.";

function retryAfterSeconds(resetMs: number | null, now: number): number {
	if (resetMs === null) return DEFAULT_RETRY_AFTER_SECONDS;
	return Math.max(1, Math.floor(resetMs / 1000 - now / 1000));
}

function epochSeconds(ms: number): string {
	return String(Math.floor(ms / 1000));
}

/** Upstream's fraction grammar: `1.0`, `0.17`, `2.06`. */
function fraction(value: number): string {
	const rounded = Math.round(value * 100) / 100;
	return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

function firstOfNextMonthUtc(now: number): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function claimFor(binding: LimitBinding): string {
	if (binding.kind === "family")
		return `seven_day_${binding.family.toLowerCase()}`;
	return binding.kind;
}

/**
 * Build the Anthropic-shaped 429 from readings. Field by field (exact /
 * approximate, as DESIGN.md section 2's table):
 * - status 429, `content-type: application/json`: exact.
 * - `retry-after` = max(1, floor(reset_s − now_s)): exact formula; 60 when
 *   the binding reset is unknown. A cooldown answer
 *   ({@link buildLocalCooldownResponse}) counts to the cooldown end instead.
 * - `x-should-retry: true`, `-unified-status: rejected`: exact. A cooldown
 *   answer omits `-unified-status`: no limit is full.
 * - `-unified-reset`: exact (binding window's reset). Omitted when unknown,
 *   and on a cooldown answer (a cooldown end is not a quota reset).
 * - `-unified-representative-claim`: approximate. `five_hour` / `seven_day`
 *   from the binding; a family binding sends `seven_day_<family>` (lower
 *   case), a name never observed upstream. `_overage_included` variants are
 *   not derivable. Omitted on a cooldown answer.
 * - `-5h-status`: exact from utilization ≥ 100 (`rejected`, else `allowed`).
 *   `-5h-reset`: exact. `-5h-utilization`: approximate (integer percent up to
 *   one poll old, as a fraction). `-5h-surpassed-threshold: 1.0`: approximate,
 *   only when ≥ 100. All 5h headers omitted without a five-hour reading; the
 *   reset alone omitted when unknown.
 * - `-7d-status`: approximate (`rejected` ≥ 100, `allowed_warning` ≥ 75, else
 *   `allowed`). `-7d-reset`: exact. `-7d-utilization`: approximate.
 *   `-7d-surpassed-threshold`: approximate, `0.75` with `allowed_warning`,
 *   `1.0` with `rejected`, absent otherwise. Omitted like the 5h set.
 * - `-fallback-percentage: 0.5`: constant copied, meaning unknown.
 * - `-overage-status: rejected`: exact for an account the proxy refuses.
 * - `-overage-disabled-reason`: approximate; the last real value seen for the
 *   account, else `org_spend_cap_reached`.
 * - `-overage-reset`: exact (1st of next month 00:00Z).
 * - `-overage-utilization`: approximate, used_credits / monthly_limit; omitted
 *   when either is unknown or the limit is 0.
 * - `-overage-surpassed-threshold: 1.0`: approximate.
 * - `-upgrade-paths: overage`: constant copied.
 * - `date`: now. No `request-id` (a local one cannot be genuine).
 * - Body: `{"type":"error","error":{"type":"rate_limit_error","message":…}}`
 *   with a fixed message; the real 429's text was never inspected.
 * Always plain JSON, also for a streaming request (upstream does the same).
 */
export function buildLocalLimitResponse(
	input: LocalLimitInput,
	now: number = Date.now(),
): Response {
	return buildLocal429(input.binding, input.resetMs, input, now);
}

/** The usage readings a local 429 reports, without a binding limit. */
export type LocalLimitReadings = Pick<
	LocalLimitInput,
	"fiveHour" | "sevenDay" | "overage"
>;

/**
 * The local 429 for an account out only on a cooldown (no full limit): still
 * a 429 with `x-should-retry: true`, but it claims no limit. No
 * `-unified-status`, no `-unified-representative-claim` and no
 * `-unified-reset` (a cooldown end is not a quota reset); `retry-after`
 * counts to the cooldown end (60 when unknown). The window and overage
 * headers come from the readings alone, as in {@link buildLocalLimitResponse}.
 */
export function buildLocalCooldownResponse(
	readings: LocalLimitReadings | null,
	cooldownResetMs: number | null,
	now: number = Date.now(),
): Response {
	return buildLocal429(null, cooldownResetMs, readings ?? {}, now);
}

function buildLocal429(
	binding: LimitBinding | null,
	resetMs: number | null,
	input: LocalLimitReadings,
	now: number,
): Response {
	const headers = new Headers({
		"content-type": "application/json",
		"retry-after": String(retryAfterSeconds(resetMs, now)),
		"x-should-retry": "true",
		[`${H}-fallback-percentage`]: "0.5",
		[`${H}-overage-status`]: "rejected",
		[DISABLED_REASON_HEADER]:
			input.overage?.disabledReason || DEFAULT_DISABLED_REASON,
		[`${H}-overage-reset`]: epochSeconds(firstOfNextMonthUtc(now)),
		[`${H}-overage-surpassed-threshold`]: "1.0",
		[`${H}-upgrade-paths`]: "overage",
		date: new Date(now).toUTCString(),
	});
	if (binding) {
		headers.set(`${H}-status`, "rejected");
		headers.set(`${H}-representative-claim`, claimFor(binding));
		if (resetMs !== null) headers.set(RESET_HEADER, epochSeconds(resetMs));
	}

	const five = input.fiveHour;
	if (five) {
		const full = five.utilization >= 100;
		headers.set(`${H}-5h-status`, full ? "rejected" : "allowed");
		if (five.resetMs !== null)
			headers.set(`${H}-5h-reset`, epochSeconds(five.resetMs));
		headers.set(`${H}-5h-utilization`, fraction(five.utilization / 100));
		if (full) headers.set(`${H}-5h-surpassed-threshold`, "1.0");
	}

	const seven = input.sevenDay;
	if (seven) {
		const status =
			seven.utilization >= 100
				? "rejected"
				: seven.utilization >= WEEKLY_WARNING_PERCENT
					? "allowed_warning"
					: "allowed";
		headers.set(`${H}-7d-status`, status);
		if (seven.resetMs !== null)
			headers.set(`${H}-7d-reset`, epochSeconds(seven.resetMs));
		headers.set(`${H}-7d-utilization`, fraction(seven.utilization / 100));
		if (status === "allowed_warning")
			headers.set(`${H}-7d-surpassed-threshold`, "0.75");
		else if (status === "rejected")
			headers.set(`${H}-7d-surpassed-threshold`, "1.0");
	}

	const used = input.overage?.usedCredits;
	const limit = input.overage?.monthlyLimit;
	if (typeof used === "number" && typeof limit === "number" && limit > 0) {
		headers.set(`${H}-overage-utilization`, fraction(used / limit));
	}

	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: LOCAL_LIMIT_MESSAGE },
		}),
		{ status: 429, statusText: "Too Many Requests", headers },
	);
}

// ── Per-account cache of the last real upstream 429 ────────────────────────

export interface CachedLimitRefusal {
	status: number;
	statusText: string;
	headers: Headers;
	body: Uint8Array;
	/** The refusal's `anthropic-ratelimit-unified-reset`, epoch ms. */
	resetMs: number;
	/** Its `-unified-representative-claim`, lower case; null when absent. */
	claim: string | null;
	capturedAt: number;
}

const refusalCache = new Map<string, CachedLimitRefusal>();
/** Last real overage-disabled-reason per account; outlives its refusal. */
const lastDisabledReason = new Map<string, string>();

/** A refusal's unified reset (epoch ms), or null when absent or unparseable. */
export function limitRefusalResetMs(headers: Headers): number | null {
	const raw = headers.get(RESET_HEADER);
	if (raw === null || !/^\d+(\.\d+)?$/.test(raw.trim())) return null;
	const ms = Number(raw.trim()) * 1000;
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Keep an account's upstream limit refusal for later local answers. Only a
 * 429 whose unified reset parses and is ahead of `now`; headers and body are
 * copied, so later changes to the caller's objects do not reach the cache.
 */
export function rememberLimitRefusal(
	accountId: string,
	refusal: {
		status: number;
		statusText: string;
		headers: Headers;
		body: Uint8Array;
	},
	now: number = Date.now(),
): void {
	if (refusal.status !== 429) return;
	const reason = refusal.headers.get(DISABLED_REASON_HEADER);
	if (reason) lastDisabledReason.set(accountId, reason);
	const resetMs = limitRefusalResetMs(refusal.headers);
	if (resetMs === null || resetMs <= now) return;
	refusalCache.set(accountId, {
		status: refusal.status,
		statusText: refusal.statusText,
		headers: new Headers(refusal.headers),
		body: refusal.body.slice(),
		resetMs,
		claim:
			refusal.headers.get(CLAIM_HEADER)?.trim().toLowerCase() || null,
		capturedAt: now,
	});
}

/** The account's cached refusal while its reset is still ahead, else null. */
export function getCachedLimitRefusal(
	accountId: string,
	now: number = Date.now(),
): CachedLimitRefusal | null {
	const cached = refusalCache.get(accountId);
	if (!cached) return null;
	if (cached.resetMs <= now) {
		refusalCache.delete(accountId);
		return null;
	}
	if (cached.capturedAt >= cached.resetMs || cached.capturedAt > now)
		return null;
	return cached;
}

/** Test-only: forget every cached refusal and disabled reason. */
export function clearLimitRefusalCache(): void {
	refusalCache.clear();
	lastDisabledReason.clear();
}

/**
 * Copy of `headers` with only `retry-after` (max(1, floor(reset_s − now_s))
 * from `anthropic-ratelimit-unified-reset`) and `date` (now) rewritten. A
 * missing or unparseable reset leaves `retry-after` as it was.
 */
export function rebaseLimitRefusalHeaders(
	headers: Headers,
	now: number = Date.now(),
): Headers {
	const out = new Headers(headers);
	const resetMs = limitRefusalResetMs(headers);
	if (resetMs !== null)
		out.set("retry-after", String(retryAfterSeconds(resetMs, now)));
	out.set("date", new Date(now).toUTCString());
	return out;
}

// ── Readings ───────────────────────────────────────────────────────────────

/**
 * Full as admission counts it (isUsageExhausted): at >= 100 % with its reset
 * ahead or unknown.
 */
function isFull(
	window: { utilization: number; resetMs: number | null } | null | undefined,
	now: number,
): boolean {
	return !!window && isUsageExhausted(window.utilization, window.resetMs, now);
}

/**
 * Whether the family is out on this account and its latest known reset. Out
 * when the caller says so (`familyOut`), on a block, or on a usage row at
 * >= 100 % whose reset is ahead or unknown (as admission counts it).
 */
function familyReading(
	accountId: string,
	data: AnyUsageData,
	provider: string,
	family: string,
	familyResetMs: number | null | undefined,
	familyOut: boolean,
	now: number,
): { out: boolean; resetMs: number | null } {
	let out = familyOut;
	const resets: number[] = [];
	if (typeof familyResetMs === "number" && familyResetMs > now)
		resets.push(familyResetMs);
	const block = getFamilyBlock(accountId, family, now);
	if (block) resets.push(block.until);
	for (const w of extractModelFamilyWindows(data, provider, family)) {
		if (!isUsageExhausted(w.utilization, w.resetsAt, now)) continue;
		out = true;
		if (w.resetsAt !== null) resets.push(w.resetsAt);
	}
	if (resets.length > 0) return { out: true, resetMs: Math.max(...resets) };
	return { out, resetMs: null };
}

/**
 * Readings for one account from the usage cache. Binding: among the full
 * limits (the family when `family` is given and it is out: `familyOut`, a
 * block, or a full family window; five-hour; weekly) the one with the latest
 * known reset, when the account is usable again; ties go to the family. Full
 * means what admission counts as exhausted: at >= 100 % with the reset ahead
 * or unknown. A full limit with an unknown reset binds only when no full
 * limit has a known one (its reset is then omitted and retry-after is 60).
 * If none is full, the window with the latest reset among those at ≥ 100 %,
 * else five_hour. Null when no usage is cached.
 */
export function localLimitInputForAccount(
	accountId: string,
	opts: {
		family?: string | null;
		familyResetMs?: number | null;
		/** The caller's admission holds `family` out on this account. */
		familyOut?: boolean;
		now?: number;
		provider?: string;
	} = {},
): LocalLimitInput | null {
	const now = opts.now ?? Date.now();
	const provider = opts.provider ?? "anthropic";
	const data = usageCache.get(accountId);
	if (!data) return null;

	const toReading = (
		w: { utilization: number; resetsAt: number | null } | null,
	) => (w ? { utilization: w.utilization, resetMs: w.resetsAt } : null);
	const fiveHour = toReading(extractFiveHourWindow(data, provider));
	const sevenDay = toReading(extractWeeklyWindow(data, provider));

	const extra = (data as UsageData).extra_usage;
	const knownReason = lastDisabledReason.get(accountId) ?? null;
	const overage = extra
		? {
				usedCredits:
					typeof extra.used_credits === "number" ? extra.used_credits : null,
				monthlyLimit:
					typeof extra.monthly_limit === "number" ? extra.monthly_limit : null,
				disabledReason: knownReason,
			}
		: knownReason
			? { usedCredits: null, monthlyLimit: null, disabledReason: knownReason }
			: null;

	let binding: LimitBinding = { kind: "five_hour" };
	let resetMs: number | null = fiveHour?.resetMs ?? null;
	const familyReset = opts.family
		? familyReading(
				accountId,
				data,
				provider,
				opts.family,
				opts.familyResetMs,
				opts.familyOut ?? false,
				now,
			)
		: null;
	const windows: Array<{
		binding: LimitBinding;
		reading: { utilization: number; resetMs: number | null } | null;
	}> = [
		{ binding: { kind: "five_hour" }, reading: fiveHour },
		{ binding: { kind: "seven_day" }, reading: sevenDay },
	];
	const anyFull = windows.some((w) => isFull(w.reading, now));
	const candidates: Array<{ binding: LimitBinding; resetMs: number | null }> =
		[];
	for (const w of windows) {
		const qualifies = anyFull
			? isFull(w.reading, now)
			: (w.reading?.utilization ?? 0) >= 100;
		if (qualifies && w.reading)
			candidates.push({ binding: w.binding, resetMs: w.reading.resetMs });
	}
	// A full family competes with the full account-wide windows: the account
	// is usable again only when every full limit has reset, so the latest
	// reset binds. A window at >= 100 % whose reset has passed (not full)
	// never outranks a full family.
	if (opts.family && familyReset?.out) {
		if (!anyFull) candidates.length = 0;
		candidates.unshift({
			binding: { kind: "family", family: opts.family },
			resetMs: familyReset.resetMs,
		});
	}
	let best: (typeof candidates)[number] | null = null;
	for (const c of candidates) {
		if (!best || (c.resetMs ?? -Infinity) > (best.resetMs ?? -Infinity))
			best = c;
	}
	if (best) {
		binding = best.binding;
		resetMs = best.resetMs;
	}

	return { binding, resetMs, fiveHour, sevenDay, overage };
}

/** The limit a real refusal's representative claim names, or null. */
function bindingOfClaim(claim: string | null): LimitBinding | null {
	if (!claim) return null;
	if (claim === "five_hour") return { kind: "five_hour" };
	if (claim === "seven_day" || claim === "seven_day_overage_included")
		return { kind: "seven_day" };
	const family = /^seven_day_([a-z0-9]+)$/.exec(claim)?.[1];
	return family ? { kind: "family", family } : null;
}

function sameBinding(a: LimitBinding, b: LimitBinding | null): boolean {
	if (!b || a.kind !== b.kind) return false;
	return (
		a.kind !== "family" ||
		(b.kind === "family" && a.family.toLowerCase() === b.family.toLowerCase())
	);
}

/**
 * The local answer for an account the request must not reach, out on
 * `family` when one is given (the caller's admission holds that family out).
 * The binding limit comes from {@link localLimitInputForAccount}, or with no
 * cached usage is the family, else five_hour. The cached real 429 is replayed
 * (headers rebased, body as received, sanitized like a proxied response, plus
 * `x-better-ccflare-request-id`) only while its reset is ahead and its claim
 * names that same binding limit, so one family's refusal never answers for
 * another family or an account-wide limit. Otherwise a 429 built from the
 * readings, or with only the binding reset known. Always status 429, plain
 * JSON even for a streaming request.
 */
export function localLimitResponseForAccount(
	account: { id: string; name?: string },
	opts: {
		requestId?: string;
		family?: string | null;
		familyResetMs?: number | null;
		now?: number;
	} = {},
): Response {
	const now = opts.now ?? Date.now();
	const input = localLimitInputForAccount(account.id, {
		family: opts.family,
		familyResetMs: opts.familyResetMs,
		familyOut: !!opts.family,
		now,
	}) ?? {
		binding: opts.family
			? { kind: "family", family: opts.family }
			: { kind: "five_hour" },
		resetMs: opts.familyResetMs ?? null,
	};
	const cached = getCachedLimitRefusal(account.id, now);
	if (cached && sameBinding(input.binding, bindingOfClaim(cached.claim))) {
		const headers = sanitizeProxyHeaders(
			rebaseLimitRefusalHeaders(cached.headers, now),
		);
		if (opts.requestId)
			headers.set("x-better-ccflare-request-id", opts.requestId);
		return new Response(cached.body.slice(), {
			status: 429,
			statusText: cached.statusText,
			headers,
		});
	}
	const response = buildLocalLimitResponse(input, now);
	if (opts.requestId)
		response.headers.set("x-better-ccflare-request-id", opts.requestId);
	return response;
}
