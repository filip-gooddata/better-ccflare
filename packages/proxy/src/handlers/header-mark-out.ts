import { Logger } from "@better-ccflare/logger";
import {
	type UsageData,
	type UsageWindow,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";

const log = new Logger("HeaderMarkOut");

const PREFIX = "anthropic-ratelimit-unified-";

/**
 * Shortest gap between two header-triggered usage re-reads for one account. A
 * burst of responses that all report the same full window then costs one
 * usage fetch, not one per response.
 */
export const HEADER_REFRESH_MIN_INTERVAL_MS = 30_000;

const lastRefreshAt = new Map<string, number>();
/** The latest usage entry each account got from headers, not from a read. */
const headerWritten = new Map<string, UsageData>();

interface WindowHeaders {
	utilization: number | null;
	status: string | null;
	resetMs: number | null;
}

export interface UnifiedLimitHeaders {
	status: string | null;
	resetMs: number | null;
	overageInUse: boolean;
	representativeClaim: string | null;
	fiveHour: WindowHeaders;
	sevenDay: WindowHeaders;
}

function readNumber(headers: Headers, name: string): number | null {
	const raw = headers.get(PREFIX + name);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function readEpochSecondsAsMs(headers: Headers, name: string): number | null {
	const seconds = readNumber(headers, name);
	return seconds === null || seconds <= 0 ? null : seconds * 1000;
}

function readWindow(headers: Headers, key: "5h" | "7d"): WindowHeaders {
	return {
		utilization: readNumber(headers, `${key}-utilization`),
		status: headers.get(`${PREFIX}${key}-status`),
		resetMs: readEpochSecondsAsMs(headers, `${key}-reset`),
	};
}

export function readUnifiedLimitHeaders(headers: Headers): UnifiedLimitHeaders {
	return {
		status: headers.get(`${PREFIX}status`),
		resetMs: readEpochSecondsAsMs(headers, "reset"),
		overageInUse: headers.get(`${PREFIX}overage-in-use`) === "true",
		representativeClaim: headers.get(`${PREFIX}representative-claim`),
		fiveHour: readWindow(headers, "5h"),
		sevenDay: readWindow(headers, "7d"),
	};
}

function windowIsOut(window: WindowHeaders): boolean {
	return (
		(window.utilization !== null && window.utilization >= 1) ||
		window.status === "rejected"
	);
}

type CacheWindowKey = "five_hour" | "seven_day";

/**
 * The window to mark full when the response says the account is out
 * (overage in use, or overall status rejected) but neither window header
 * crossed on its own: the one the representative claim names, else (no claim,
 * a model-family claim or one not seen before) the fuller of the two, so the
 * whole account is out until the re-read says otherwise.
 */
function bindingWindow(parsed: UnifiedLimitHeaders): CacheWindowKey {
	const claim = parsed.representativeClaim?.trim().toLowerCase() ?? "";
	if (claim === "five_hour") return "five_hour";
	if (claim === "seven_day" || claim === "seven_day_overage_included") {
		return "seven_day";
	}
	const five = parsed.fiveHour.utilization ?? -1;
	const seven = parsed.sevenDay.utilization ?? -1;
	return seven > five ? "seven_day" : "five_hour";
}

function cacheWindow(
	header: WindowHeaders,
	previous: UsageWindow | undefined,
	forceFull: boolean,
	fallbackResetMs: number | null,
): UsageWindow | undefined {
	const out = forceFull || windowIsOut(header);
	if (header.utilization === null && !out) return previous;
	const percent = (header.utilization ?? 0) * 100;
	const resetMs = header.resetMs ?? (out ? fallbackResetMs : null);
	return {
		utilization: out ? Math.max(100, percent) : percent,
		resets_at:
			resetMs !== null
				? new Date(resetMs).toISOString()
				: (previous?.resets_at ?? null),
	};
}

function writeUsageFromHeaders(
	accountId: string,
	parsed: UnifiedLimitHeaders,
	forced: CacheWindowKey | null,
): void {
	const previous = (usageCache.get(accountId) ?? {}) as UsageData;
	const next: UsageData = { ...previous };
	const five = cacheWindow(
		parsed.fiveHour,
		previous.five_hour,
		forced === "five_hour",
		parsed.resetMs,
	);
	const seven = cacheWindow(
		parsed.sevenDay,
		previous.seven_day,
		forced === "seven_day",
		parsed.resetMs,
	);
	if (five) next.five_hour = five;
	if (seven) next.seven_day = seven;
	usageCache.set(accountId, next);
	headerWritten.set(accountId, next);
}

function logRefreshFailure(accountId: string, error: unknown): void {
	log.warn(
		`Usage re-read after a full-limit response failed for ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * Re-reads the account usage now, at most once per
 * {@link HEADER_REFRESH_MIN_INTERVAL_MS}. A poll already in flight when the
 * mark was written is dropped by the cache generation guard, and refreshNow
 * joins that poll instead of starting its own; if the cache still holds a
 * header mark once it settles, one more re-read follows.
 */
function refreshUsageSoon(accountId: string, now: number): void {
	const last = lastRefreshAt.get(accountId);
	if (last !== undefined && now - last < HEADER_REFRESH_MIN_INTERVAL_MS) {
		return;
	}
	lastRefreshAt.set(accountId, now);
	usageCache
		.refreshNow(accountId)
		.then(() => {
			const current = usageCache.get(accountId);
			if (current === null || current !== headerWritten.get(accountId)) {
				return;
			}
			return usageCache.refreshNow(accountId);
		})
		.catch((error: unknown) => logRefreshFailure(accountId, error));
}

function isAnthropicAccount(account: Account): boolean {
	const provider = account.provider ?? "anthropic";
	return provider === "anthropic" || provider === "claude-oauth";
}

/**
 * Reads the unified rate-limit headers of an upstream Anthropic response as it
 * arrives, before any classification and before its body is forwarded. When
 * they show the account out (overage in use, a five-hour or weekly utilization
 * at 1.0, a five-hour or weekly status of `rejected`, or an overall status of
 * `rejected`), the header numbers go into the usage cache at once, which the
 * selector and `collectLimitBlockedAccounts` read synchronously, so the next
 * selection skips the account; usage is then re-read without waiting for the
 * poll. Only headers are read: the response itself is served in full.
 *
 * A keepalive burst refusal carries an overall `rejected` that says nothing
 * about the account quota, so for keepalive replays only window and overage
 * evidence counts.
 */
export function observeLimitHeaders(
	response: Response,
	account: Account,
	options: { keepalive?: boolean } = {},
): void {
	if (!isAnthropicAccount(account)) return;

	const parsed = readUnifiedLimitHeaders(response.headers);
	const windowOut =
		windowIsOut(parsed.fiveHour) || windowIsOut(parsed.sevenDay);
	const overallRejected = parsed.status === "rejected" && !options.keepalive;
	if (!windowOut && !overallRejected && !parsed.overageInUse) return;

	writeUsageFromHeaders(
		account.id,
		parsed,
		windowOut ? null : bindingWindow(parsed),
	);
	log.warn(
		`[ccflare] account=${account.name} limit_header_mark overage_in_use=${parsed.overageInUse} status=${parsed.status ?? "none"} 5h=${parsed.fiveHour.utilization ?? "?"}/${parsed.fiveHour.status ?? "?"} 7d=${parsed.sevenDay.utilization ?? "?"}/${parsed.sevenDay.status ?? "?"} reset=${parsed.resetMs !== null ? new Date(parsed.resetMs).toISOString() : "none"}`,
	);
	refreshUsageSoon(account.id, Date.now());
}

/**
 * Benches an Anthropic account until `unified-reset` when a served response
 * says it ran on extra usage. Called after the success path has cleared any
 * older bench, so the response that reports overage benches the account for
 * the next request instead of being undone by its own success. The account is
 * not paused, and the streak, ramp and circuit breaker stay untouched.
 */
export function applyOverageCooldown(
	response: Response,
	account: Account,
	ctx: ProxyContext,
): void {
	if (!isAnthropicAccount(account)) return;
	const parsed = readUnifiedLimitHeaders(response.headers);
	if (!parsed.overageInUse) return;
	if (parsed.resetMs === null || parsed.resetMs <= Date.now()) return;
	applyRateLimitCooldown(
		account,
		{
			resetTime: parsed.resetMs,
			reason: "overage_in_use",
			preserveStreak: true,
		},
		ctx,
	);
}

/** Test-only: forgets the re-read throttle between cases. */
export function resetHeaderMarkOutForTests(): void {
	lastRefreshAt.clear();
	headerWritten.clear();
}
