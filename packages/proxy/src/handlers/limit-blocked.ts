import {
	getModelFamily,
	isUsageExhausted,
	mapModelName,
	splitModelRouting,
} from "@better-ccflare/core";
import {
	extractFiveHourWindow,
	extractModelFamilyWindows,
	extractWeeklyWindow,
	getRepresentativeUsageSnapshotForProvider,
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
	buildLocalLimitResponse,
	getCachedLimitRefusal,
	localLimitInputForAccount,
	localLimitResponseForAccount,
} from "./limit-response";
import {
	getFamilyBlock,
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
 *   checked on BOTH windows rather than only the representative one. A full
 *   window is always recorded: extra usage, spend and the (ignored) "use extra
 *   usage" setting never make it usable. A provider without those two windows
 *   falls back to the representative snapshot the prefilter uses, reported as
 *   `weekly`.
 * - `family`: the model-family filter in selectAccountsForRequest. A standing
 *   family block counts in every mode, with the block's own end as its reset.
 *   Full family telemetry counts in every mode too
 *   (isAccountExhaustedForModel; extra usage plays no part there either);
 *   only the reactive 429 mark needs capacity routing on. A telemetry reset
 *   is the LATEST exhausted family row, since the account serves the family
 *   again only once every row has reset, and unknown (null) when a full row
 *   carries no usable reset. A reactive 429 mark carries only a TTL guess,
 *   not a reset, so it counts as unknown (null) unless exhausted telemetry
 *   rows give the real one.
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
	const family = model ? getModelFamily(model) : null;
	const capacityRoutingEnabled = isCapacityRoutingEnabled(ctx);

	const blocked: LimitBlockedAccount[] = [];
	for (const account of accounts) {
		if (account.paused || account.requires_reauth) continue;
		if (isProviderExcluded(account, excludedProviders)) continue;
		if (forcedModel !== null && !accountServesModel(account, forcedModel)) {
			continue;
		}
		const limits = limitsInForce(
			account,
			model,
			family,
			capacityRoutingEnabled,
			now,
		);
		if (limits.length > 0) blocked.push({ account, limits });
	}
	return blocked;
}

function limitsInForce(
	account: Account,
	model: string | undefined,
	family: string | null,
	capacityRoutingEnabled: boolean,
	now: number,
): AccountLimit[] {
	const limits: AccountLimit[] = [];
	if (account.rate_limited_until != null && account.rate_limited_until > now) {
		limits.push({ kind: "cooldown", resetAt: account.rate_limited_until });
	}

	const provider = account.provider ?? "anthropic";
	const usage = usageCache.get(account.id);
	if (usage) {
		const windowLimit = (
			kind: "five_hour" | "weekly",
			window: StrategyUsageWindow | null,
		): void => {
			if (
				window &&
				isUsageExhausted(window.utilization, window.resetsAt, now)
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
				isUsageExhausted(snapshot.utilization, snapshot.resetMs, now)
			) {
				limits.push({ kind: "weekly", resetAt: snapshot.resetMs ?? null });
			}
		}
	}

	if (model) {
		const familyLimit = familyLimitInForce(
			account,
			model,
			family,
			capacityRoutingEnabled,
			now,
		);
		if (familyLimit) limits.push(familyLimit);
	}
	return limits;
}

function familyLimitInForce(
	account: Account,
	model: string,
	family: string | null,
	capacityRoutingEnabled: boolean,
	now: number,
): AccountLimit | null {
	// Blocks are recorded for the family upstream refused: the family of the
	// model this account actually sends (mapModelName honors "force account
	// model", which turns mapping off).
	const upstreamModel = splitModelRouting(mapModelName(model, account)).model;
	const upstreamFamily = getModelFamily(upstreamModel) ?? family;
	// A client alias with no family of its own still counts when the account
	// maps it to a family.
	if (!upstreamFamily) return null;
	const block = getFamilyBlock(account.id, upstreamFamily, now);
	if (block)
		return { kind: "family", family: upstreamFamily, resetAt: block.until };

	// Telemetry is read for the family the account actually sends (the
	// mapping's primary model), the same family the block above uses.
	const usage = usageCache.get(account.id);
	const telemetry = isAccountExhaustedForModel(
		usage,
		getModelFamily(upstreamModel) ? upstreamModel : model,
		now,
	);
	if (telemetry.exhausted) {
		return {
			kind: "family",
			family: upstreamFamily,
			resetAt: telemetry.resetAt,
		};
	}
	if (!capacityRoutingEnabled || !family) return null;

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

	if (getFamilyExhaustionOrigin(account.id, family, now)) {
		return { kind: "family", family, resetAt: latestRowReset };
	}
	return null;
}

/**
 * Whether failover path C may hold this request's limit refusals and answer
 * with one: the strategy has `selectWhenAllLimited` and the request does not
 * own its routing. A request naming an account (`x-better-ccflare-account-id`,
 * which auto-refresh and keepalive probes send too) or bypassing session
 * routing gets the answer of the account it reached, so its refusals are not
 * held.
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
 * Whether an empty selection may be answered with the local limit 429 of the
 * account the all-limited rule ranks first. Nothing is forwarded on that path,
 * so a bypass-session request is answered too. A request naming an account is
 * not: its answer describes the account it named ({@link fullLimitAnswer}).
 */
function isLocalLimitAnswerEligible(
	ctx: ProxyContext,
	meta: RequestMeta,
): boolean {
	return (
		ctx.strategy.selectWhenAllLimited !== undefined &&
		!meta.headers?.get("x-better-ccflare-account-id")
	);
}

/**
 * Whose limit a local 429 describes. `family` is set when the account is out
 * on the request's model family; `cooldownResetMs` when it is out on nothing
 * but a cooldown, whose end is then the reset the answer carries.
 */
export interface LocalLimitAnswer {
	account: Account;
	family: string | null;
	familyResetMs: number | null;
	cooldownResetMs: number | null;
}

function localLimitAnswerFor(entry: LimitBlockedAccount): LocalLimitAnswer {
	const family = entry.limits.find((limit) => limit.kind === "family");
	const onlyCooldown =
		entry.limits.length > 0 &&
		entry.limits.every((limit) => limit.kind === "cooldown");
	const cooldownResets = entry.limits
		.map((limit) => limit.resetAt)
		.filter((reset): reset is number => reset !== null);
	return {
		account: entry.account,
		family: family?.family ?? null,
		familyResetMs: family?.resetAt ?? null,
		cooldownResetMs:
			onlyCooldown && cooldownResets.length > 0
				? Math.max(...cooldownResets)
				: null,
	};
}

/**
 * When every account that could serve the request is out only on limits, the
 * account whose limit the local 429 describes: the one the strategy's
 * `selectWhenAllLimited` ranks first (for session-pace, the account usable
 * again first). Null when the request is not eligible, nothing is
 * limit-blocked, or the strategy declines. Nothing is forwarded to it.
 *
 * `accounts` is the raw account list when the caller already holds it; it is
 * read from the database otherwise.
 */
export async function selectAllLimitedAnswer(
	ctx: ProxyContext,
	meta: RequestMeta,
	model: string | undefined,
	now: number = Date.now(),
	accounts?: Account[],
): Promise<LocalLimitAnswer | null> {
	if (
		!ctx.strategy.selectWhenAllLimited ||
		!isLocalLimitAnswerEligible(ctx, meta)
	) {
		return null;
	}
	const all = accounts ?? (await ctx.dbOps.getAllAccounts());
	const blocked = collectLimitBlockedAccounts(all, ctx, meta, model, now);
	if (blocked.length === 0) return null;
	const target = ctx.strategy.selectWhenAllLimited(blocked, meta);
	if (!target) return null;
	const entry = blocked.find((b) => b.account.id === target.id);
	return entry
		? localLimitAnswerFor(entry)
		: {
				account: target,
				family: null,
				familyResetMs: null,
				cooldownResetMs: null,
			};
}

/** The account of {@link selectAllLimitedAnswer}, or null. */
export async function selectAllLimitedTarget(
	ctx: ProxyContext,
	meta: RequestMeta,
	model: string | undefined,
	now: number = Date.now(),
	accounts?: Account[],
): Promise<Account | null> {
	return (
		(await selectAllLimitedAnswer(ctx, meta, model, now, accounts))?.account ??
		null
	);
}

/**
 * The local 429 answer for `account` when it is at a full limit for this
 * request: its five-hour or weekly window, or the request model's family.
 * A cooldown alone does not count. Null when no full limit is in force.
 */
export function fullLimitAnswer(
	account: Account,
	ctx: ProxyContext,
	model: string | undefined,
	now: number = Date.now(),
): LocalLimitAnswer | null {
	const family = model ? getModelFamily(model) : null;
	const limits = limitsInForce(
		account,
		model,
		family,
		isCapacityRoutingEnabled(ctx),
		now,
	).filter((limit) => limit.kind !== "cooldown");
	if (limits.length === 0) return null;
	return localLimitAnswerFor({ account, limits });
}

const localLimitAnswers = new WeakMap<RequestMeta, LocalLimitAnswer>();

/**
 * Record that an empty selection for this request is answered with the local
 * 429 for `answer.account`. proxy.ts reads it before its other no-account
 * answers; a selection that is not empty ignores it.
 */
export function markLocalLimitAnswer(
	meta: RequestMeta,
	answer: LocalLimitAnswer,
): void {
	localLimitAnswers.set(meta, answer);
}

/** The answer recorded by {@link markLocalLimitAnswer}, if any. */
export function getLocalLimitAnswer(
	meta: RequestMeta,
): LocalLimitAnswer | undefined {
	return localLimitAnswers.get(meta);
}

/**
 * The local 429 for `answer`: the account's cached real 429 replayed with
 * retry-after and date rebased while its reset is ahead, else one built from
 * its usage readings. An account out only on a cooldown, with no cached
 * refusal, gets the built 429 with the cooldown end as its reset, since that
 * is when it can serve again.
 */
export function localLimitAnswerResponse(
	answer: LocalLimitAnswer,
	requestId: string,
	now: number = Date.now(),
): Response {
	if (
		answer.cooldownResetMs !== null &&
		!getCachedLimitRefusal(answer.account.id, now)
	) {
		const input = localLimitInputForAccount(answer.account.id, {
			now,
			provider: answer.account.provider ?? "anthropic",
		}) ?? { binding: { kind: "five_hour" as const }, resetMs: null };
		const response = buildLocalLimitResponse(
			{ ...input, resetMs: answer.cooldownResetMs },
			now,
		);
		response.headers.set("x-better-ccflare-request-id", requestId);
		return response;
	}
	return localLimitResponseForAccount(answer.account, {
		requestId,
		family: answer.family,
		familyResetMs: answer.familyResetMs,
		now,
	});
}
