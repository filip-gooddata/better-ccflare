import { getModelFamily } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	type UsageData,
	type UsageWindow,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { blockFamily } from "./model-capacity";
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

/**
 * How long a mark holds when no header gave its reset: a full week, the
 * longest window. A newer usage reading showing recovery releases it sooner.
 */
const UNKNOWN_RESET_HOLD_MS = 7 * 24 * 3_600_000;

const lastRefreshAt = new Map<string, number>();
/** The latest usage entry each account got from headers, not from a read. */
const headerWritten = new Map<string, UsageData>();
/** What the cache held before the first of those header writes. */
const readingsBeforeMark = new Map<string, UsageData | null>();

function holdsHeaderMark(accountId: string): boolean {
	const current = usageCache.get(accountId);
	return current !== null && current === headerWritten.get(accountId);
}

/**
 * The usage readings to judge a refusal by: what the cache held before the
 * header mark when it still holds that mark, else the cache as is. The 429
 * family classifier must see the account's own readings, not the mark this
 * same response just wrote; selection keeps reading the mark.
 */
export function readingsBeforeHeaderMark(accountId: string): UsageData | null {
	if (holdsHeaderMark(accountId)) {
		return readingsBeforeMark.get(accountId) ?? null;
	}
	return (usageCache.get(accountId) as UsageData | null) ?? null;
}

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

function headerWindowOut(parsed: UnifiedLimitHeaders): boolean {
	return windowIsOut(parsed.fiveHour) || windowIsOut(parsed.sevenDay);
}

type CacheWindowKey = "five_hour" | "seven_day";

function claimOf(parsed: UnifiedLimitHeaders): string {
	return parsed.representativeClaim?.trim().toLowerCase() ?? "";
}

/**
 * The model family a `seven_day_<family>` claim names, or null. Only a suffix
 * that is itself a known family counts, so `seven_day_overage_included` and
 * other account-level variants are not mistaken for one.
 */
function familyOfClaim(parsed: UnifiedLimitHeaders): string | null {
	const claim = claimOf(parsed);
	if (!claim.startsWith("seven_day_")) return null;
	const suffix = claim.slice("seven_day_".length);
	return getModelFamily(suffix) === suffix ? suffix : null;
}

/**
 * The account-wide window to mark full when the response says the account is
 * out but neither window header crossed on its own: the window an account-wide
 * claim (`five_hour`, `seven_day`) names; with no claim or one that names no
 * family, the fuller of the two. A family claim marks no window: that is the
 * family block's business. This runs before the 429 classifiers, which read
 * the same cache to tell a family refusal from an account one, so an overall
 * rejection without a claim marks nothing either while the readings show a
 * family row spent: the classifier may call that refusal family-scoped. Any
 * other unclaimed rejection the classifier benches account-wide anyway, so
 * the mark only makes that exclusion immediate.
 */
function bindingWindow(
	parsed: UnifiedLimitHeaders,
	previous: UsageData,
	now: number,
): CacheWindowKey | null {
	const claim = claimOf(parsed);
	if (claim === "five_hour") return "five_hour";
	if (claim === "seven_day") return "seven_day";
	if (familyOfClaim(parsed) !== null) return null;
	if (!parsed.overageInUse && hasSpentFamilyRow(previous, now)) return null;
	const five = parsed.fiveHour.utilization ?? -1;
	const seven = parsed.sevenDay.utilization ?? -1;
	return seven > five ? "seven_day" : "five_hour";
}

function hasSpentFamilyRow(usage: UsageData, now: number): boolean {
	if (!Array.isArray(usage.limits)) return false;
	return usage.limits.some((limit) => {
		if (limit?.kind !== "weekly_scoped") return false;
		if (typeof limit.percent !== "number" || limit.percent < 100) return false;
		const resetMs = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
		return !Number.isFinite(resetMs) || resetMs > now;
	});
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
	windowOut: boolean,
): void {
	if (!holdsHeaderMark(accountId)) {
		readingsBeforeMark.set(
			accountId,
			(usageCache.get(accountId) as UsageData | null) ?? null,
		);
	}
	const previous = (usageCache.get(accountId) ?? {}) as UsageData;
	const next: UsageData = { ...previous };
	const forced = windowOut ? null : bindingWindow(parsed, previous, Date.now());
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
	usageCache.set(accountId, next, { holdUntil: markHoldUntil(next) });
	headerWritten.set(accountId, next);
}

/**
 * When a header mark may expire by age: the latest reset of the windows it
 * marks full. Until then only a newer write (a poll that started after the
 * mark, or another header mark) replaces it, so the account stays out until
 * its reset or a reading that shows it recovered, not just for the cache's
 * ten minutes.
 */
function markHoldUntil(usage: UsageData): number {
	const now = Date.now();
	let until = now;
	for (const window of [usage.five_hour, usage.seven_day]) {
		if (!window || window.utilization < 100) continue;
		const resetMs = window.resets_at
			? Date.parse(window.resets_at)
			: Number.NaN;
		until = Math.max(
			until,
			Number.isFinite(resetMs) ? resetMs : now + UNKNOWN_RESET_HOLD_MS,
		);
	}
	return until;
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
			if (!holdsHeaderMark(accountId)) return;
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
	const windowOut = headerWindowOut(parsed);
	const overallRejected = parsed.status === "rejected" && !options.keepalive;
	if (!windowOut && !overallRejected && !parsed.overageInUse) return;

	const family = parsed.overageInUse ? familyOfClaim(parsed) : null;
	if (family !== null && !windowOut) {
		// Served on credits for one family: block that family until the reset,
		// keep the account for the others. The claim names the family upstream
		// charged, which is the family this account sends (after its model
		// mapping), and a standing block excludes it in every routing mode.
		// Without a reset header the account's weekly reset bounds it, else a
		// full week.
		const now = Date.now();
		const until =
			[parsed.resetMs, parsed.sevenDay.resetMs].find(
				(reset): reset is number => reset !== null && reset > now,
			) ?? now + UNKNOWN_RESET_HOLD_MS;
		blockFamily(account.id, family, until, "header", now);
	} else {
		writeUsageFromHeaders(account.id, parsed, windowOut);
	}
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
	// A family claim is blocked per family (observeLimitHeaders), not benched.
	if (familyOfClaim(parsed) !== null && !headerWindowOut(parsed)) return;
	const benchedAt = Date.now();
	if (parsed.resetMs === null || parsed.resetMs <= benchedAt) return;
	applyRateLimitCooldown(
		account,
		{
			resetTime: parsed.resetMs,
			reason: "overage_in_use",
			preserveStreak: true,
		},
		ctx,
	);
	if (holdsOverageBench(account, benchedAt)) {
		pendingBenches.set(account.id, {
			ctx,
			benchedAt,
			until: account.rate_limited_until as number,
		});
	}
}

/**
 * Whether `account` sits on an `overage_in_use` bench that has not reached
 * its reset. Such a bench is a hard admission block: no bypass admits the
 * account, and no later success clears it. It ends at its reset or when a
 * usage reading taken after it shows the account below its limits.
 */
export function holdsOverageBench(
	account: Pick<Account, "rate_limited_until" | "rate_limited_reason">,
	now: number = Date.now(),
): boolean {
	return (
		account.rate_limited_reason === "overage_in_use" &&
		account.rate_limited_until != null &&
		account.rate_limited_until > now
	);
}

/**
 * SQL condition, true for an accounts row whose cooldown a success may clear:
 * anything but an `overage_in_use` bench still ahead of its reset. Takes one
 * parameter, the current time in epoch ms.
 */
export const SUCCESS_MAY_CLEAR_COOLDOWN_SQL =
	"(COALESCE(rate_limited_reason, '') <> 'overage_in_use' OR rate_limited_until IS NULL OR rate_limited_until <= ?)";

interface PendingBench {
	ctx: ProxyContext;
	benchedAt: number;
	until: number;
}

/** Overage benches this process applied, waiting for a recovering reading. */
const pendingBenches = new Map<string, PendingBench>();

function windowBelowLimit(window: UsageWindow | undefined): boolean {
	return (
		window !== undefined &&
		window !== null &&
		typeof window.utilization === "number" &&
		window.utilization < 100
	);
}

/**
 * Releases an overage bench when a usage poll whose request went out after
 * the bench shows both the five-hour and the weekly window below 100 %. A
 * reading already on the wire when the account was benched proves nothing,
 * and neither does one that lacks a window. The database write only clears
 * the bench it was told about, never a newer one.
 */
function releaseBenchOnRecovery(
	accountId: string,
	data: unknown,
	requestedAt: number,
): void {
	const bench = pendingBenches.get(accountId);
	if (!bench) return;
	const now = Date.now();
	if (bench.until <= now) {
		pendingBenches.delete(accountId);
		return;
	}
	if (requestedAt < bench.benchedAt) return;
	const { five_hour: five, seven_day: seven } = data as UsageData;
	if (!windowBelowLimit(five) || !windowBelowLimit(seven)) return;
	pendingBenches.delete(accountId);
	log.info(
		`Releasing overage_in_use bench of ${accountId}: a usage reading taken after it shows five-hour ${five?.utilization}% and weekly ${seven?.utilization}%`,
	);
	bench.ctx.asyncWriter.enqueue(async () => {
		await bench.ctx.dbOps
			.getAdapter()
			.run(
				"UPDATE accounts SET rate_limited_until = NULL, rate_limited_reason = NULL WHERE id = ? AND rate_limited_reason = 'overage_in_use' AND rate_limited_until <= ?",
				[accountId, bench.until],
			);
	});
}

// Optional call: test doubles of the providers module may lack it.
usageCache.onPolledReading?.(releaseBenchOnRecovery);

/** Test-only: forgets the re-read throttle between cases. */
export function resetHeaderMarkOutForTests(): void {
	lastRefreshAt.clear();
	headerWritten.clear();
	readingsBeforeMark.clear();
	pendingBenches.clear();
}
