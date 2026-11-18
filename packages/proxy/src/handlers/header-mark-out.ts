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
 * crossed on its own: the representative claim when it names one, else the
 * fuller of the two, else the five-hour window. A model-family claim names
 * no plan-wide window; the usage re-read brings in the family row instead.
 */
function bindingWindow(parsed: UnifiedLimitHeaders): CacheWindowKey | null {
	const claim = parsed.representativeClaim;
	if (claim) {
		if (claim.startsWith("five_hour")) return "five_hour";
		if (claim === "seven_day" || claim === "seven_day_overage_included") {
			return "seven_day";
		}
		return null;
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
}

function refreshUsageSoon(accountId: string, now: number): void {
	const last = lastRefreshAt.get(accountId);
	if (last !== undefined && now - last < HEADER_REFRESH_MIN_INTERVAL_MS) {
		return;
	}
	lastRefreshAt.set(accountId, now);
	usageCache.refreshNow(accountId).catch((error: unknown) => {
		log.warn(
			`Usage re-read after a full-limit response failed for ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

/**
 * Marks an Anthropic account out for the next request when a response's
 * headers show it has run out: overage in use, a five-hour or weekly
 * utilization at 1.0, or a unified status of `rejected`. The header numbers go
 * into the usage cache at once (the selector and `collectLimitBlockedAccounts`
 * read it synchronously), usage is re-read without waiting for the poll, and
 * overage in use also benches the account until the unified reset. Only
 * headers are read; the body of the response being served is never touched.
 *
 * `applyCooldown` is false when the response was already handled as a rate
 * limit, which benched the account itself.
 */
export function applyHeaderMarkOut(
	response: Response,
	account: Account,
	ctx: ProxyContext,
	options: { applyCooldown: boolean },
): void {
	if ((account.provider ?? "anthropic") !== "anthropic") return;
	if (ctx.provider.name !== "anthropic") return;

	const parsed = readUnifiedLimitHeaders(response.headers);
	const windowOut =
		windowIsOut(parsed.fiveHour) || windowIsOut(parsed.sevenDay);
	const overallRejected = parsed.status === "rejected";
	if (!windowOut && !overallRejected && !parsed.overageInUse) return;

	const now = Date.now();
	writeUsageFromHeaders(
		account.id,
		parsed,
		windowOut ? null : bindingWindow(parsed),
	);
	log.warn(
		`[ccflare] account=${account.name} limit_header_mark overage_in_use=${parsed.overageInUse} status=${parsed.status ?? "none"} 5h=${parsed.fiveHour.utilization ?? "?"}/${parsed.fiveHour.status ?? "?"} 7d=${parsed.sevenDay.utilization ?? "?"}/${parsed.sevenDay.status ?? "?"} reset=${parsed.resetMs !== null ? new Date(parsed.resetMs).toISOString() : "none"}`,
	);

	if (
		options.applyCooldown &&
		parsed.overageInUse &&
		parsed.resetMs !== null &&
		parsed.resetMs > now
	) {
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

	refreshUsageSoon(account.id, now);
}

/** Test-only: forgets the re-read throttle between cases. */
export function resetHeaderMarkOutForTests(): void {
	lastRefreshAt.clear();
}
