import { getModelFamily } from "@better-ccflare/core";
import type { AnyUsageData } from "@better-ccflare/providers";
import type { FamilyBlockSource } from "./model-capacity";
import { collectWindows, type UsageWindowSnapshot } from "./usage-throttling";

/**
 * Which limit an upstream 429 refusal concerned.
 *
 * - `family`: one model family's weekly limit on this account; the account
 *   still serves every other family.
 * - `account`: an account-wide limit (five-hour session or weekly_all).
 * - `unclassified`: the evidence does not settle it.
 */
export type RefusalScope =
	| {
			scope: "family";
			family: string;
			/** Epoch ms when the family's limit resets. */
			until: number;
			source: FamilyBlockSource;
			detail: string;
	  }
	| { scope: "account"; detail: string }
	| { scope: "unclassified"; detail: string };

export interface ClassifyRefusalScopeInput {
	headers: Headers;
	usageData: AnyUsageData | null | undefined;
	model: string | null | undefined;
	now: number;
	/** Reset named by the response itself (epoch ms), or null when none was. */
	headerResetAt: number | null;
}

const REPRESENTATIVE_CLAIM_HEADER =
	"anthropic-ratelimit-unified-representative-claim";

/** Claims that name an account-wide window. */
const ACCOUNT_CLAIMS = new Set(["five_hour", "seven_day"]);

/** collectWindows names for the account-wide session and weekly_all windows. */
const ACCOUNT_WINDOWS = new Set(["five_hour", "seven_day"]);

/**
 * Decides whether a 429 refused the request for the requested model's family
 * only or for the whole account.
 *
 * The refusal's reset time cannot tell them apart: an account's weekly family
 * limit and its weekly_all limit can reset at the same instant. So the
 * decision rests on what names the binding limit: the representative-claim
 * header when it names one, else the account's usage readings (the family at
 * 100 % while the five-hour and weekly_all windows still have room).
 * Overage and spend signals play no part.
 */
export function classifyRefusalScope({
	headers,
	usageData,
	model,
	now,
	headerResetAt,
}: ClassifyRefusalScopeInput): RefusalScope {
	const family = model ? getModelFamily(model) : null;
	if (!family) {
		return {
			scope: "unclassified",
			detail: `unknown model family for model=${model ?? "none"}`,
		};
	}

	const windows = collectWindows(usageData ?? null);
	const familyRows = windows.filter(
		(window) => window.scoped && window.modelFamily === family,
	);

	const claim = headers.get(REPRESENTATIVE_CLAIM_HEADER)?.trim().toLowerCase();
	if (claim) {
		if (ACCOUNT_CLAIMS.has(claim)) {
			return { scope: "account", detail: `representative-claim=${claim}` };
		}
		if (claim.includes(family)) {
			const futureResets = familyRows
				.map((window) => window.resetAtMs)
				.filter((resetAtMs) => resetAtMs > now);
			if (futureResets.length > 0) {
				return {
					scope: "family",
					family,
					until: Math.min(...futureResets),
					source: "header",
					detail: `representative-claim=${claim}, reset from usage`,
				};
			}
			if (headerResetAt != null && headerResetAt > now) {
				return {
					scope: "family",
					family,
					until: headerResetAt,
					source: "header",
					detail: `representative-claim=${claim}, reset from response`,
				};
			}
			return {
				scope: "unclassified",
				detail: `representative-claim=${claim} but no future ${family} reset known`,
			};
		}
	}

	const accountRows = windows.filter(
		(window) => !window.scoped && ACCOUNT_WINDOWS.has(window.window),
	);
	const exhaustedAccountRow = accountRows.find(
		(window) => window.utilization >= 100 && window.resetAtMs > now,
	);
	if (exhaustedAccountRow) {
		return {
			scope: "account",
			detail: `${describeWindow(exhaustedAccountRow)} exhausted`,
		};
	}
	if (accountRows.length === 0) {
		return { scope: "unclassified", detail: "no usage readings" };
	}

	const accountSummary = accountRows.map(describeWindow).join(", ");
	if (familyRows.length === 0) {
		return {
			scope: "unclassified",
			detail: `no ${family} weekly reading; ${accountSummary}`,
		};
	}
	if (countRawScopedFamilyRows(usageData, family) !== familyRows.length) {
		return {
			scope: "unclassified",
			detail: `a ${family} weekly reading lacks percent or reset; ${accountSummary}`,
		};
	}
	const exhaustedFamilyRows = familyRows.filter(
		(window) => window.utilization >= 100 && window.resetAtMs > now,
	);
	if (exhaustedFamilyRows.length !== familyRows.length) {
		return {
			scope: "unclassified",
			detail: `${familyRows.map(describeWindow).join(", ")} below 100 %; ${accountSummary}`,
		};
	}
	return {
		scope: "family",
		family,
		until: Math.min(...exhaustedFamilyRows.map((window) => window.resetAtMs)),
		source: "usage",
		detail: `${familyRows.map(describeWindow).join(", ")}; ${accountSummary}`,
	};
}

function describeWindow(window: UsageWindowSnapshot): string {
	return `${window.window} ${window.utilization}% resets ${new Date(window.resetAtMs).toISOString()}`;
}

/**
 * Raw weekly_scoped rows of `family`, counted before the normalizer drops
 * rows without a percent or a usable reset. Same rule as model-capacity.ts:
 * a dropped row is unproven capacity, so "every row at 100 %" must not hold
 * by omission.
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

const RATE_LIMIT_HEADER_PATTERNS = [
	/^anthropic-ratelimit-/,
	/^x-ratelimit-/,
	/^retry-after$/,
	/^x-should-retry$/,
];

/**
 * `name=value` pairs of the response's rate-limit headers, sorted by name and
 * joined with "; ", or "none". An allow-list: no other header can appear.
 */
export function rateLimitHeaderSummary(headers: Headers): string {
	const pairs: Array<[string, string]> = [];
	headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (RATE_LIMIT_HEADER_PATTERNS.some((pattern) => pattern.test(lower))) {
			pairs.push([lower, value]);
		}
	});
	if (pairs.length === 0) return "none";
	return pairs
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}
