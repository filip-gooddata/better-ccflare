import { getModelFamily, isUseExtraUsageEnabled } from "@better-ccflare/core";
import {
	type AnyUsageData,
	hasExtraUsageCapacity,
} from "@better-ccflare/providers";
import {
	buildLocalLimitResponse,
	localLimitResponseForAccount,
} from "./limit-response";
import { collectWindows } from "./usage-throttling";

export interface ModelExhaustionResult {
	exhausted: boolean;
	/** Epoch ms of the scoped cap's reset, when known. */
	resetAt: number | null;
}

export type OverageStatus = "available" | "unavailable" | "unknown";

/**
 * Tri-state resolver for whether an account's overage/pay-as-you-go billing
 * would still serve requests past a 100%-exhausted weekly_scoped cap.
 * Precedence: the newer `spend.enabled` field (2026 API) wins over the
 * legacy `extra_usage.is_enabled` field when both are present; when neither
 * resolves to an actual boolean, the status is "unknown" — not assumed
 * disabled — since a missing/contradictory signal says nothing about the
 * account's real billing state.
 */
export function resolveOverageStatus(
	usageData: AnyUsageData | null | undefined,
): OverageStatus {
	const data = usageData as
		| {
				spend?: { enabled?: boolean } | null;
				extra_usage?: { is_enabled?: boolean } | null;
		  }
		| null
		| undefined;

	if (data?.spend && typeof data.spend.enabled === "boolean") {
		return data.spend.enabled ? "available" : "unavailable";
	}
	if (data?.extra_usage && typeof data.extra_usage.is_enabled === "boolean") {
		return data.extra_usage.is_enabled ? "available" : "unavailable";
	}
	return "unknown";
}

/**
 * Counts the RAW weekly_scoped limits[] rows attributable to `family`,
 * regardless of whether their percent/resets_at values are usable. The
 * normalizer ({@link collectWindows}) silently drops rows with a missing
 * percent or an unparsable/absent reset — fresh windows legitimately carry
 * `resets_at: null` — so the "ALL rows exhausted" check below must compare
 * against this raw count: a dropped partial row is unproven capacity, and
 * unproven capacity means fail open, not "exhausted by omission".
 */
function countRawScopedFamilyRows(
	usageData: AnyUsageData | null | undefined,
	family: string,
): number {
	const limits = (usageData as { limits?: unknown[] } | null | undefined)
		?.limits;
	if (!Array.isArray(limits)) return 0;
	let count = 0;
	for (const entry of limits) {
		const row = entry as {
			kind?: string;
			scope?: { model?: { display_name?: string | null } | null } | null;
		} | null;
		if (!row || row.kind !== "weekly_scoped") continue;
		const name = row.scope?.model?.display_name?.trim();
		if (!name) continue;
		if (getModelFamily(name) === family) count++;
	}
	return count;
}

/**
 * Checks whether the account's weekly per-model (weekly_scoped) cap for the
 * given model's family is fully exhausted: EVERY weekly_scoped row for that
 * family is at percent >= 100 with a reset still in the future (a single
 * non-exhausted row — e.g. a distinct surface — means the family still has
 * usable capacity), AND extra usage may not carry the request past the cap.
 * Paid overage is not capacity: it keeps the family available only when the
 * process-wide "use extra usage" switch is on AND the account has extra usage
 * left (hasExtraUsageCapacity: enabled and under its spend limit) — the same
 * rule the account-level five-hour/weekly gating uses. An overage merely
 * reported as enabled, with the switch off or the spend limit reached, does
 * not keep the family available.
 *
 * Fails open (returns {exhausted:false}) whenever the family can't be
 * confidently attributed: unknown request-model family, a scoped row whose
 * display name has no known family mapping, a reset that has already
 * passed (stale telemetry), a family row the normalizer had to drop
 * (missing percent / unusable reset — see {@link countRawScopedFamilyRows}),
 * or missing telemetry altogether. A false positive here removes a working
 * account from rotation; a false negative just costs one extra 429
 * round-trip, so the asymmetry favors not excluding.
 */
export function isAccountExhaustedForModel(
	usageData: AnyUsageData | null | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
): ModelExhaustionResult {
	const family = model ? getModelFamily(model) : null;
	if (!family) return { exhausted: false, resetAt: null };

	const familyRows = collectWindows(usageData ?? null).filter(
		(window) => window.scoped && window.modelFamily === family,
	);
	if (familyRows.length === 0) return { exhausted: false, resetAt: null };

	// A raw family row the normalizer dropped (missing percent, resets_at
	// null/unparsable) is unproven capacity — "all remaining rows exhausted"
	// would be exhaustion by omission, so fail open instead.
	if (countRawScopedFamilyRows(usageData, family) !== familyRows.length) {
		return { exhausted: false, resetAt: null };
	}

	const exhaustedRows = familyRows.filter(
		(window) => window.utilization >= 100 && window.resetAtMs > now,
	);
	if (exhaustedRows.length !== familyRows.length) {
		return { exhausted: false, resetAt: null };
	}

	if (
		isUseExtraUsageEnabled() &&
		hasExtraUsageCapacity(usageData, "anthropic")
	) {
		return { exhausted: false, resetAt: null };
	}

	const resetAt = Math.min(...exhaustedRows.map((window) => window.resetAtMs));
	return { exhausted: true, resetAt };
}

// ── Negative cache ────────────────────────────────────────────────────────────
//
// Fed by observed out_of_credits 429s (proxy-operations.ts): a reactive
// signal that an (account, family) pair is exhausted, used alongside the
// telemetry-based check above because usageCache is only refreshed on a
// poll interval and can lag a real upstream rejection by several minutes.

const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Provenance of a negative-cache exhaustion mark, or (for "cooldown_masked"
 * only) of the aggregate {@link ModelFamilyExhaustionInfo} the account
 * selector reports: "telemetry_confirmed" means the account's own limits[]
 * telemetry showed the weekly_scoped cap at >=100%; "recent_upstream_rejection"
 * means the mark came only from an observed out_of_credits 429 without
 * corroborating telemetry; "cooldown_masked" means the account-selector's
 * capacity filter found every candidate capacity-exhausted, but a DIFFERENT
 * account with free capacity for the family exists and was merely dropped by
 * the strategy's rate-limit-cooldown check (isAccountAvailable) — so weekly
 * capacity is not the real blocker (only markFamilyExhausted/
 * isAccountCapacityExcluded ever produce "telemetry_confirmed" or
 * "recent_upstream_rejection"; "cooldown_masked" is set directly by the
 * account selector, never stored in the negative cache). Only a
 * telemetry_confirmed mark may claim "weekly capacity exhausted" in a
 * user-facing response — a purely reactive mark, or a cooldown-masked one,
 * uses wording that doesn't assert weekly exhaustion. "family_blocked" is
 * never stored in the negative cache either: the account selector reports it
 * for a standing family block (see Family blocks below), an upstream refusal
 * of the family on that account that lasts until the family's limit resets.
 */
export type FamilyExhaustionOrigin =
	| "telemetry_confirmed"
	| "recent_upstream_rejection"
	| "cooldown_masked"
	| "family_blocked";

interface ExhaustionEntry {
	until: number;
	origin: FamilyExhaustionOrigin;
}

const negativeCache = new Map<string, ExhaustionEntry>();

function negativeCacheKey(accountId: string, family: string): string {
	return `${accountId}:${family}`;
}

/**
 * Records that (accountId, family) is exhausted until `untilMs`. When
 * `untilMs` is missing or already in the past, falls back to a short
 * default TTL so a single 429 can't wedge the account out of rotation
 * indefinitely if the real reset time is never resolved. The TTL is always
 * this fixed default (or an explicit shorter `untilMs`) — there is no
 * longer-lived seeding from a scoped-cap reset; the cache only needs to
 * bridge the ~90s telemetry poll interval, not survive until the real
 * weekly reset.
 */
export function markFamilyExhausted(
	accountId: string,
	family: string,
	untilMs?: number | null,
	now: number = Date.now(),
	origin: FamilyExhaustionOrigin = "recent_upstream_rejection",
): void {
	const until =
		untilMs != null && untilMs > now
			? untilMs
			: now + DEFAULT_NEGATIVE_CACHE_TTL_MS;
	negativeCache.set(negativeCacheKey(accountId, family), { until, origin });
}

/** Whether (accountId, family) was recently marked exhausted and hasn't expired. */
export function isFamilyExhausted(
	accountId: string,
	family: string,
	now: number = Date.now(),
): boolean {
	const key = negativeCacheKey(accountId, family);
	const entry = negativeCache.get(key);
	if (!entry) return false;
	if (entry.until <= now) {
		negativeCache.delete(key);
		return false;
	}
	return true;
}

/**
 * Provenance of the current negative-cache mark for (accountId, family), or
 * null when nothing is marked (or the mark has expired — the entry is
 * evicted, matching {@link isFamilyExhausted}'s eviction behavior).
 */
export function getFamilyExhaustionOrigin(
	accountId: string,
	family: string,
	now: number = Date.now(),
): FamilyExhaustionOrigin | null {
	const key = negativeCacheKey(accountId, family);
	const entry = negativeCache.get(key);
	if (!entry) return null;
	if (entry.until <= now) {
		negativeCache.delete(key);
		return null;
	}
	return entry.origin;
}

/**
 * Expiry (epoch ms) of the current negative-cache mark for (accountId,
 * family), or null when nothing is marked / the mark has expired. Selection
 * feeds this into the all-exhausted response's earliest-reset aggregation so
 * Retry-After reflects when a reactively-sidelined account actually becomes
 * eligible again (minutes), not only telemetry reset times (potentially
 * days).
 */
export function getFamilyExhaustionUntil(
	accountId: string,
	family: string,
	now: number = Date.now(),
): number | null {
	const key = negativeCacheKey(accountId, family);
	const entry = negativeCache.get(key);
	if (!entry) return null;
	if (entry.until <= now) {
		negativeCache.delete(key);
		return null;
	}
	return entry.until;
}

/** Test-only: reset all negative-cache state between test cases. */
export function clearFamilyExhaustionCache(): void {
	negativeCache.clear();
}

/**
 * Drops every negative-cache entry for a removed account. Entries self-expire
 * via `until`, but a removed account's keys otherwise sit until that TTL
 * fires — this makes the clear proactive instead of waiting it out. Keyed as
 * `accountId:family`, so removal is a prefix scan rather than a single delete.
 */
export function clearFamilyExhaustionForAccount(accountId: string): void {
	const prefix = `${accountId}:`;
	for (const key of negativeCache.keys()) {
		if (key.startsWith(prefix)) negativeCache.delete(key);
	}
	clearFamilyBlocksForAccount(accountId);
}

// ── Family blocks ───────────────────────────────────────────────────────────
//
// Set when upstream refuses a request with a 429 that concerns one model
// family on one account (its weekly_scoped limit), as opposed to the account
// as a whole. The block excludes the account for that family until the
// family's limit resets, whatever the overage signal says, and leaves the
// account routable for every other family. Unlike the negative cache above it
// lasts until the named reset, not a fixed TTL. In memory only: after a
// restart the account's own weekly_scoped telemetry keeps the family out.

/** What told the classifier that the refusal concerned the family. */
export type FamilyBlockSource = "header" | "usage";

export interface FamilyBlock {
	accountId: string;
	family: string;
	/** Epoch ms when the family's limit resets and the block lifts. */
	until: number;
	source: FamilyBlockSource;
	/** Epoch ms when the block was recorded. */
	setAt: number;
}

const familyBlocks = new Map<string, FamilyBlock>();

/**
 * Blocks (accountId, family) until `untilMs`. A reset that is not in the
 * future records nothing and returns null. When a block already stands, the
 * later of the two resets is kept.
 */
export function blockFamily(
	accountId: string,
	family: string,
	untilMs: number,
	source: FamilyBlockSource,
	now: number = Date.now(),
): FamilyBlock | null {
	if (!Number.isFinite(untilMs) || untilMs <= now) return null;
	const key = negativeCacheKey(accountId, family);
	const existing = getFamilyBlock(accountId, family, now);
	if (existing && existing.until >= untilMs) return existing;
	const block: FamilyBlock = {
		accountId,
		family,
		until: untilMs,
		source,
		setAt: now,
	};
	familyBlocks.set(key, block);
	return block;
}

/** The standing block for (accountId, family), or null. Evicts an expired one. */
export function getFamilyBlock(
	accountId: string,
	family: string,
	now: number = Date.now(),
): FamilyBlock | null {
	const key = negativeCacheKey(accountId, family);
	const block = familyBlocks.get(key);
	if (!block) return null;
	if (block.until <= now) {
		familyBlocks.delete(key);
		return null;
	}
	return block;
}

/** Every standing block of one account. Evicts expired ones. */
export function getFamilyBlocksForAccount(
	accountId: string,
	now: number = Date.now(),
): FamilyBlock[] {
	const blocks: FamilyBlock[] = [];
	for (const [key, block] of familyBlocks) {
		if (block.accountId !== accountId) continue;
		if (block.until <= now) {
			familyBlocks.delete(key);
			continue;
		}
		blocks.push(block);
	}
	return blocks;
}

/** Drops every block of one account (account removed or reset by hand). */
export function clearFamilyBlocksForAccount(accountId: string): void {
	for (const [key, block] of familyBlocks) {
		if (block.accountId === accountId) familyBlocks.delete(key);
	}
}

/** Test-only: reset all family blocks between test cases. */
export function clearFamilyBlocks(): void {
	familyBlocks.clear();
}

// ── model_family_exhausted response ─────────────────────────────────────────

export interface ModelFamilyExhaustionInfo {
	family: string;
	resetAt: number | null;
	origin: FamilyExhaustionOrigin;
	/**
	 * The account the answer describes (the one usable again first). With it
	 * the answer is that account's local limit 429 (its cached real 429, else
	 * one built from its usage); without it, a 429 built from the family and
	 * `resetAt` alone.
	 */
	accountId?: string;
}

/**
 * The 429 returned when every candidate account for a request's model family
 * is out for that family, instead of failing over against accounts known to
 * reject it. It is the no-extra-usage local limit 429 (limit-response.ts):
 * Anthropic's status, unified headers and body shape, with the family as the
 * binding limit (claim `seven_day_<family>`, an approximate name) and
 * `retry-after` counted to `resetAt`. The body carries Anthropic's fixed
 * rate-limit text, which names no window, so no `origin` (a cooldown, a
 * reactive mark) is misattributed to weekly capacity; `origin` no longer
 * changes the response.
 */
export function createModelFamilyExhaustedResponse(
	info: ModelFamilyExhaustionInfo,
): Response {
	if (info.accountId) {
		return localLimitResponseForAccount(
			{ id: info.accountId },
			{ family: info.family, familyResetMs: info.resetAt },
		);
	}
	return buildLocalLimitResponse({
		binding: { kind: "family", family: info.family },
		resetMs: info.resetAt,
	});
}
