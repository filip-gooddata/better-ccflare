import { afterEach, describe, expect, it } from "bun:test";
import { setUseExtraUsage } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import {
	clearLimitRefusalCache,
	rememberLimitRefusal,
} from "../limit-response";
import {
	clearFamilyExhaustionCache,
	createModelFamilyExhaustedResponse,
	getFamilyExhaustionOrigin,
	isAccountExhaustedForModel,
	isFamilyExhausted,
	markFamilyExhausted,
	resolveOverageStatus,
} from "../model-capacity";

afterEach(() => {
	clearFamilyExhaustionCache();
});

// ── isAccountExhaustedForModel ────────────────────────────────────────────────

describe("isAccountExhaustedForModel", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const futureReset = new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString();
	const pastReset = new Date(NOW - 60 * 60 * 1000).toISOString();

	const scopedLimits = (
		percent: number,
		displayName = "Fable",
		resetsAt: string | null = futureReset,
		extra?: Record<string, unknown>,
	) =>
		({
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: resetsAt,
					scope: {
						model: { id: null, display_name: displayName },
						surface: null,
					},
				},
			],
			...extra,
		}) as never;

	// Exclusion-expecting fixtures carry an explicit unavailable-overage signal
	// (see the dedicated extra-usage block below).
	const overageOff = { spend: { enabled: false } };

	it("reports exhausted when the matching family's weekly_scoped cap is >=100% with a future reset", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable", futureReset, overageOff),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
		expect(result.resetAt).toBe(new Date(futureReset).getTime());
	});

	it("reports exhausted for utilization above 100% too", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(143, "Fable", futureReset, overageOff),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
	});

	it("does NOT report exhausted just below the 100% boundary", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(99.9, "Fable", futureReset, overageOff),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
		expect(result.resetAt).toBeNull();
	});

	it("does not exclude a different family's request (e.g. sonnet vs an exhausted fable cap)", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable"),
			"claude-sonnet-4-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the scoped row's display name has no known family mapping", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Mystery Model"),
			"claude-opus-4-8",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the request model's own family is unknown", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable"),
			"gpt-4-turbo-unknown",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the scoped cap's reset has already passed (stale telemetry)", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable", pastReset),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when there is no telemetry at all", () => {
		expect(isAccountExhaustedForModel(null, "claude-fable-5", NOW)).toEqual({
			exhausted: false,
			resetAt: null,
		});
		expect(
			isAccountExhaustedForModel(undefined, "claude-fable-5", NOW),
		).toEqual({ exhausted: false, resetAt: null });
	});

	it("fails open when no model is given", () => {
		expect(
			isAccountExhaustedForModel(scopedLimits(100), null, NOW).exhausted,
		).toBe(false);
		expect(
			isAccountExhaustedForModel(scopedLimits(100), undefined, NOW).exhausted,
		).toBe(false);
	});

	it("ignores a weekly_all (account-wide) cap — only weekly_scoped rows drive exhaustion", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: futureReset,
					scope: null,
				},
			],
		} as never;
		expect(
			isAccountExhaustedForModel(data, "claude-sonnet-4-5", NOW).exhausted,
		).toBe(false);
	});

	// ── v3 S4: overage tri-state — only `unavailable` may exclude ──────────────

	// Paid overage is not capacity: a 100% family is exhausted whatever the
	// overage/spend signals or the (ignored) "use extra usage" setting say.
	describe("extra usage never keeps a full family available", () => {
		afterEach(() => {
			setUseExtraUsage(false);
		});

		const legacy = (
			is_enabled: boolean,
			utilization: number | null = null,
		) => ({
			extra_usage: {
				is_enabled,
				monthly_limit: null,
				used_credits: null,
				utilization,
			},
		});

		it("stays exhausted when extra_usage.is_enabled is explicitly false and no spend block exists", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, legacy(false));
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("stays exhausted when overage is reported enabled but the use-extra-usage switch is off", () => {
			for (const extra of [legacy(true), { spend: { enabled: true } }]) {
				const data = scopedLimits(100, "Fable", futureReset, extra);
				expect(
					isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
				).toBe(true);
			}
		});

		it("stays exhausted when spend.enabled is true but spend is at or over its limit, switch on", () => {
			setUseExtraUsage(true);
			for (const percent of [100, 205]) {
				const data = scopedLimits(100, "Fable", futureReset, {
					spend: { enabled: true, percent },
				});
				expect(
					isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
				).toBe(true);
			}
		});

		it("stays exhausted when legacy extra usage is enabled but used up, switch on", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, legacy(true, 100));
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("stays exhausted with the setting on and extra usage left (spend under its limit)", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, {
				spend: { enabled: true, percent: 40 },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("stays exhausted with the setting on and legacy extra_usage enabled", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, legacy(true));
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("stays exhausted when no overage signal exists at all (no extra usage known)", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset);
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("stays exhausted with spend.enabled=true over legacy extra_usage.is_enabled=false, setting on", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, {
				...legacy(false),
				spend: { enabled: true },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("newer spend.enabled=false takes precedence over legacy extra_usage.is_enabled=true", () => {
			setUseExtraUsage(true);
			const data = scopedLimits(100, "Fable", futureReset, {
				...legacy(true),
				spend: { enabled: false },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});
	});

	// ── v3 S8/codex-6: two weekly_scoped rows for the same family (e.g. distinct surfaces) ──

	describe("multiple weekly_scoped rows for the same family", () => {
		const twoRows = (percentA: number, percentB: number) =>
			({
				limits: [
					{
						kind: "weekly_scoped",
						percent: percentA,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						percent: percentB,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				// Overage confirmed unavailable — "unknown" would correctly fail open.
				spend: { enabled: false },
			}) as never;

		it("fails open when only ONE of two same-family rows is exhausted", () => {
			const result = isAccountExhaustedForModel(
				twoRows(100, 40),
				"claude-fable-5",
				NOW,
			);
			expect(result.exhausted).toBe(false);
		});

		it("excludes only when ALL same-family rows are exhausted", () => {
			const result = isAccountExhaustedForModel(
				twoRows(100, 100),
				"claude-fable-5",
				NOW,
			);
			expect(result.exhausted).toBe(true);
		});

		// The normalizer drops rows with a null/unparsable reset or a missing
		// percent. A dropped same-family row is unproven capacity — the "ALL
		// rows exhausted" rule must fail open, not conclude exhaustion from
		// the surviving rows alone (fresh windows legitimately report
		// resets_at: null in production payloads).
		it("fails open when a second same-family row was dropped by the normalizer (resets_at null)", () => {
			const data = {
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						percent: 40,
						resets_at: null,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				spend: { enabled: false },
			} as never;
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});

		it("fails open when a second same-family row was dropped by the normalizer (percent missing)", () => {
			const data = {
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				spend: { enabled: false },
			} as never;
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});
	});

	// A full family row whose reset is missing or unparsable is still full:
	// letting it through would bill overage, so it counts as exhausted with
	// an unknown reset. A row with no percent stays unknown utilization.
	describe("full family rows with no usable reset", () => {
		const fableRow = (
			percent: number | undefined,
			resetsAt: string | null | undefined,
			surface: string,
		) => ({
			kind: "weekly_scoped",
			...(percent === undefined ? {} : { percent }),
			...(resetsAt === undefined ? {} : { resets_at: resetsAt }),
			scope: { model: { id: null, display_name: "Fable" }, surface },
		});
		const laterReset = new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString();

		it("counts a 100% row with resets_at null as exhausted with an unknown reset", () => {
			const data = { limits: [fableRow(100, null, "cli")] } as never;
			expect(isAccountExhaustedForModel(data, "claude-fable-5", NOW)).toEqual({
				exhausted: true,
				resetAt: null,
			});
		});

		it("counts a 100% row with no resets_at field or an unparsable one as exhausted", () => {
			for (const resetsAt of [undefined, "not-a-date"]) {
				const data = { limits: [fableRow(100, resetsAt, "cli")] } as never;
				expect(isAccountExhaustedForModel(data, "claude-fable-5", NOW)).toEqual(
					{ exhausted: true, resetAt: null },
				);
			}
		});

		it("reports an unknown reset when any full row has no reset", () => {
			const data = {
				limits: [fableRow(100, futureReset, "cli"), fableRow(120, null, "api")],
			} as never;
			expect(isAccountExhaustedForModel(data, "claude-fable-5", NOW)).toEqual({
				exhausted: true,
				resetAt: null,
			});
		});

		it("reports the latest reset when every full row has one", () => {
			const data = {
				limits: [
					fableRow(100, futureReset, "cli"),
					fableRow(100, laterReset, "api"),
				],
			} as never;
			expect(isAccountExhaustedForModel(data, "claude-fable-5", NOW)).toEqual({
				exhausted: true,
				resetAt: new Date(laterReset).getTime(),
			});
		});

		it("stays not exhausted when a row has no percent", () => {
			const data = {
				limits: [fableRow(100, null, "cli"), fableRow(undefined, null, "api")],
			} as never;
			expect(isAccountExhaustedForModel(data, "claude-fable-5", NOW)).toEqual({
				exhausted: false,
				resetAt: null,
			});
		});

		it("stays not exhausted when a full row's reset has passed", () => {
			const data = {
				limits: [fableRow(100, null, "cli"), fableRow(100, pastReset, "api")],
			} as never;
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});
	});
});

// ── resolveOverageStatus (v3 tri-state resolver, codex-3) ──────────────────────

describe("resolveOverageStatus", () => {
	it("returns 'unknown' when neither spend nor extra_usage is present", () => {
		expect(resolveOverageStatus({} as never)).toBe("unknown");
		expect(resolveOverageStatus(null)).toBe("unknown");
		expect(resolveOverageStatus(undefined)).toBe("unknown");
	});

	it("returns 'unavailable' from legacy extra_usage.is_enabled=false", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			} as never),
		).toBe("unavailable");
	});

	it("returns 'available' from legacy extra_usage.is_enabled=true", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			} as never),
		).toBe("available");
	});

	it("prefers spend.enabled over extra_usage.is_enabled when both present", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: false },
			} as never),
		).toBe("unavailable");
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: true },
			} as never),
		).toBe("available");
	});

	it("returns 'unknown' when spend is present but its enabled field is absent", () => {
		expect(resolveOverageStatus({ spend: {} } as never)).toBe("unknown");
	});
});

// ── markFamilyExhausted / isFamilyExhausted (negative cache) ───────────────────

describe("markFamilyExhausted / isFamilyExhausted", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

	it("is not exhausted before anything is marked", () => {
		expect(isFamilyExhausted("acc-1", "fable", NOW)).toBe(false);
	});

	it("marks and reports exhaustion until the given untilMs", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW)).toBe(true);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 30_000)).toBe(true);
	});

	it("expires after untilMs and evicts the entry", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 60_001)).toBe(false);
		// Still false on a second check (entry evicted, not just skipped).
		expect(isFamilyExhausted("acc-1", "fable", NOW + 60_001)).toBe(false);
	});

	// v3 Fix1: the TTL is ALWAYS the fixed 5-minute default now — there is no
	// longer a longer-lived seeding path from a scoped reset (findScopedResetAt
	// is removed). Any untilMs the caller passes beyond 5 minutes must still be
	// honored (callers may deliberately want a shorter cap), but nothing in
	// model-capacity.ts itself extends the TTL past 5 minutes on its own.
	it("defaults to a 5-minute TTL when no untilMs is given", () => {
		markFamilyExhausted("acc-1", "fable", null, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 4 * 60 * 1000)).toBe(true);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 6 * 60 * 1000)).toBe(
			false,
		);
	});

	it("defaults to a 5-minute TTL when untilMs is already in the past", () => {
		markFamilyExhausted("acc-1", "fable", NOW - 1000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 4 * 60 * 1000)).toBe(true);
	});

	it("is isolated per (accountId, family) pair", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-2", "fable", NOW)).toBe(false);
		expect(isFamilyExhausted("acc-1", "sonnet", NOW)).toBe(false);
	});

	// ── v3 Revision v2 Fix1: signal provenance ────────────────────────────────

	describe("signal provenance (telemetry_confirmed vs recent_upstream_rejection)", () => {
		it("defaults to 'recent_upstream_rejection' origin when not specified (today's only caller: reactive out_of_credits)", () => {
			markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBe(
				"recent_upstream_rejection",
			);
		});

		it("stores an explicitly-passed 'telemetry_confirmed' origin", () => {
			markFamilyExhausted(
				"acc-1",
				"fable",
				NOW + 60_000,
				NOW,
				"telemetry_confirmed",
			);
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBe(
				"telemetry_confirmed",
			);
		});

		it("returns null for the origin when nothing is marked, or after expiry", () => {
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBeNull();
			markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
			expect(
				getFamilyExhaustionOrigin("acc-1", "fable", NOW + 60_001),
			).toBeNull();
		});
	});
});

// ── createModelFamilyExhaustedResponse ──────────────────────────────────────────

describe("createModelFamilyExhaustedResponse", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const LIMIT_MESSAGE =
		"This request would exceed your account's rate limit. Please try again later.";

	function atNow<T>(fn: () => T): T {
		const realNow = Date.now;
		Date.now = () => NOW;
		try {
			return fn();
		} finally {
			Date.now = realNow;
		}
	}

	afterEach(() => {
		usageCache.clear();
		clearLimitRefusalCache();
	});

	// The no-extra-usage local 429: Anthropic's own shape, body without the
	// proxy's code/family/resetAt, the unified headers Claude Code reads.
	it("returns the Anthropic-shaped local 429 for the family binding", async () => {
		const resetAt = NOW + 90_000;
		const response = atNow(() =>
			createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt,
				origin: "telemetry_confirmed",
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("90");
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("x-should-retry")).toBe("true");
		expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
			"rejected",
		);
		expect(
			response.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("seven_day_fable");
		expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(
			String(resetAt / 1000),
		);
		expect(await response.json()).toEqual({
			type: "error",
			error: { type: "rate_limit_error", message: LIMIT_MESSAGE },
		});
	});

	it("falls back to a default Retry-After of 60s when resetAt is unknown", () => {
		const response = createModelFamilyExhaustedResponse({
			family: "sonnet",
			resetAt: null,
			origin: "recent_upstream_rejection",
		});
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(
			response.headers.get("anthropic-ratelimit-unified-reset"),
		).toBeNull();
	});

	it("answers for the named account: replays its fresh cached 429", async () => {
		const reset = Math.floor((Date.now() + 2 * 3_600_000) / 1000);
		rememberLimitRefusal("acc-family", {
			status: 429,
			statusText: "Too Many Requests",
			headers: new Headers({
				"anthropic-ratelimit-unified-reset": String(reset),
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"retry-after": "1",
			}),
			body: new TextEncoder().encode("upstream-body"),
		});
		const response = createModelFamilyExhaustedResponse({
			family: "fable",
			resetAt: Date.now() + 3_600_000,
			origin: "family_blocked",
			accountId: "acc-family",
		});
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("upstream-body");
		expect(
			response.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("five_hour");
	});

	describe("Retry-After", () => {
		it("is at least 1 when resetAt has already passed", () => {
			const response = atNow(() =>
				createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW - 5_000,
					origin: "telemetry_confirmed",
				}),
			);
			expect(response.headers.get("Retry-After")).toBe("1");
		});

		it("is 1 when resetAt is only a fraction of a second away", () => {
			const response = atNow(() =>
				createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW + 500,
					origin: "telemetry_confirmed",
				}),
			);
			expect(response.headers.get("Retry-After")).toBe("1");
		});

		it("counts the whole wait when resetAt is days away, as upstream does", () => {
			const response = atNow(() =>
				createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW + 3 * 24 * 60 * 60 * 1000,
					origin: "telemetry_confirmed",
				}),
			);
			expect(response.headers.get("Retry-After")).toBe(String(3 * 24 * 3600));
		});
	});

	// The fixed Anthropic text names no window, so no origin can misattribute
	// a cooldown or a reactive mark to weekly capacity.
	it("uses the same neutral message for every origin", async () => {
		for (const origin of [
			"telemetry_confirmed",
			"recent_upstream_rejection",
			"cooldown_masked",
			"family_blocked",
		] as const) {
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt: NOW + 90_000,
				origin,
			});
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message).toBe(LIMIT_MESSAGE);
		}
	});
});
