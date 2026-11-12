import {
	getModelFamily,
	isUsageExhausted,
	isUseExtraUsageEnabled,
} from "@better-ccflare/core";
import {
	extractFiveHourWindow,
	extractModelFamilyWindows,
	extractWeeklyWindow,
	getRepresentativeUsageSnapshotForProvider,
	hasExtraUsageCapacity,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	AccountLimit,
	LimitBlockedAccount,
	RequestMeta,
	StrategyUsageWindow,
} from "@better-ccflare/types";
import {
	accountServesModel,
	isCapacityRoutingEnabled,
	isForceAccountModelEnabled,
	isProviderExcludedBy as isProviderExcluded,
	requestExcludedProviders,
} from "./account-selector";
import {
	getFamilyExhaustionOrigin,
	isAccountExhaustedForModel,
} from "./model-capacity";
import type { ProxyContext } from "./proxy-types";

/**
 * Accounts that today's normal-path filters removed for limits and nothing
 * else, each with every limit still in force at `now`.
 *
 * The non-limit filters run first and are final: a paused or re-auth account,
 * one whose provider the request excludes, and one that cannot serve the model
 * while "force account model" is on are never listed, whatever their limits.
 *
 * Each limit mirrors the filter that removes the account today:
 * - `cooldown`: a future `rate_limited_until` (the strategies' isAccountAvailable).
 * - `five_hour` / `weekly`: the usage-cap prefilter in getOrderedAccounts,
 *   checked on BOTH windows rather than only the representative one, with the
 *   same extra-usage exception (the "use extra usage" switch AND provider
 *   capacity). A provider without those two windows falls back to the
 *   representative snapshot the prefilter uses, reported as `weekly`.
 * - `family`: the model-scoped capacity filter, only when it runs for this
 *   request, with its own overage rule (resolveOverageStatus, no global
 *   switch). Its reset is the LATEST exhausted family row, since the account
 *   serves the family again only once every row has reset. A reactive 429
 *   mark carries only a TTL guess, not a reset, so it counts as unknown
 *   (null) unless exhausted telemetry rows give the real one.
 */
export function collectLimitBlockedAccounts(
	accounts: Account[],
	ctx: ProxyContext,
	meta: RequestMeta,
	model: string | undefined,
	now: number,
): LimitBlockedAccount[] {
	const excludedProviders = requestExcludedProviders(meta);
	const forcedModel = model && isForceAccountModelEnabled(ctx) ? model : null;
	const family =
		model && isCapacityRoutingEnabled(ctx) ? getModelFamily(model) : null;

	const blocked: LimitBlockedAccount[] = [];
	for (const account of accounts) {
		if (account.paused || account.requires_reauth) continue;
		if (isProviderExcluded(account, excludedProviders)) continue;
		if (forcedModel !== null && !accountServesModel(account, forcedModel)) {
			continue;
		}
		const limits = limitsInForce(account, model, family, now);
		if (limits.length > 0) blocked.push({ account, limits });
	}
	return blocked;
}

function limitsInForce(
	account: Account,
	model: string | undefined,
	family: string | null,
	now: number,
): AccountLimit[] {
	const limits: AccountLimit[] = [];
	if (account.rate_limited_until != null && account.rate_limited_until > now) {
		limits.push({ kind: "cooldown", resetAt: account.rate_limited_until });
	}

	const provider = account.provider ?? "anthropic";
	const usage = usageCache.get(account.id);
	if (usage) {
		const extraUsage =
			isUseExtraUsageEnabled() && hasExtraUsageCapacity(usage, provider);
		const windowLimit = (
			kind: "five_hour" | "weekly",
			window: StrategyUsageWindow | null,
		): void => {
			if (
				window &&
				isUsageExhausted(window.utilization, window.resetsAt, now, extraUsage)
			) {
				limits.push({ kind, resetAt: window.resetsAt });
			}
		};
		const before = limits.length;
		windowLimit("five_hour", extractFiveHourWindow(usage, provider));
		windowLimit("weekly", extractWeeklyWindow(usage, provider));
		if (limits.length === before) {
			const snapshot = getRepresentativeUsageSnapshotForProvider(
				usage,
				provider,
			);
			if (
				snapshot &&
				isUsageExhausted(
					snapshot.utilization,
					snapshot.resetMs,
					now,
					snapshot.extraUsageAvailable,
				)
			) {
				limits.push({ kind: "weekly", resetAt: snapshot.resetMs ?? null });
			}
		}
	}

	if (model && family) {
		const familyLimit = familyLimitInForce(account, model, family, now);
		if (familyLimit) limits.push(familyLimit);
	}
	return limits;
}

function familyLimitInForce(
	account: Account,
	model: string,
	family: string,
	now: number,
): AccountLimit | null {
	const usage = usageCache.get(account.id);
	const exhaustedRows = usage
		? extractModelFamilyWindows(
				usage,
				account.provider ?? "anthropic",
				family,
			).filter(
				(row) =>
					row.utilization >= 100 && row.resetsAt != null && row.resetsAt > now,
			)
		: [];
	const latestRowReset =
		exhaustedRows.length > 0
			? Math.max(...exhaustedRows.map((row) => row.resetsAt as number))
			: null;

	const telemetry = isAccountExhaustedForModel(usage, model, now);
	if (telemetry.exhausted) {
		return {
			kind: "family",
			family,
			resetAt: latestRowReset ?? telemetry.resetAt,
		};
	}
	if (getFamilyExhaustionOrigin(account.id, family, now)) {
		return { kind: "family", family, resetAt: latestRowReset };
	}
	return null;
}

/**
 * Whether the all-limited rule may route this request: the strategy has
 * `selectWhenAllLimited` and the request does not own its routing. A request
 * naming an account (`x-better-ccflare-account-id`, which auto-refresh and
 * keepalive probes send too) or bypassing session routing must reach only the
 * account it asked for, so neither selection nor failover path C may send it
 * anywhere else, and its refusals are not held.
 */
export function isAllLimitedRuleEligible(
	ctx: ProxyContext,
	meta: RequestMeta,
): boolean {
	return (
		ctx.strategy.selectWhenAllLimited !== undefined &&
		!meta.headers?.get("x-better-ccflare-account-id") &&
		meta.headers?.get("x-better-ccflare-bypass-session") !== "true"
	);
}

/**
 * The account to forward a request to when every account that could serve it
 * is out only on limits, or null when the request is not eligible for the rule
 * ({@link isAllLimitedRuleEligible}), nothing is limit-blocked, or the
 * strategy declines.
 *
 * `accounts` is the raw account list when the caller already holds it; it is
 * read from the database otherwise.
 */
export async function selectAllLimitedTarget(
	ctx: ProxyContext,
	meta: RequestMeta,
	model: string | undefined,
	now: number = Date.now(),
	accounts?: Account[],
): Promise<Account | null> {
	if (
		!ctx.strategy.selectWhenAllLimited ||
		!isAllLimitedRuleEligible(ctx, meta)
	) {
		return null;
	}
	const all = accounts ?? (await ctx.dbOps.getAllAccounts());
	const blocked = collectLimitBlockedAccounts(all, ctx, meta, model, now);
	if (blocked.length === 0) return null;
	return ctx.strategy.selectWhenAllLimited(blocked, meta);
}

const allLimitedSelections = new WeakMap<RequestMeta, string>();

/** Record that this request's selection came from the all-limited rule. */
export function markAllLimitedSelection(
	meta: RequestMeta,
	accountId: string,
): void {
	allLimitedSelections.set(meta, accountId);
}

/** Whether this request's selection came from the all-limited rule. */
export function isAllLimitedSelection(meta: RequestMeta): boolean {
	return allLimitedSelections.has(meta);
}
