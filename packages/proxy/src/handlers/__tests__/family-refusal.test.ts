import { describe, expect, it } from "bun:test";
import {
	classifyRefusalScope,
	rateLimitHeaderSummary,
} from "../family-refusal";

// Measured 2026-11-13 on account `gooddata`: Fable weekly at 100 %, five-hour
// and weekly_all with room, weekly resets coinciding, overage spend enabled.
const NOW = Date.parse("2026-11-13T12:00:00Z");
const FABLE_RESET = "2026-11-15T14:00:00.367Z";
const FIVE_HOUR_RESET = "2026-11-13T13:00:00Z";
const WEEKLY_RESET = "2026-11-15T14:00:00Z";

function usage({
	session = 79,
	weeklyAll = 89,
	fable = 100 as number | null,
	fableReset = FABLE_RESET as string | null,
	extraRows = [] as unknown[],
} = {}) {
	return {
		limits: [
			{ kind: "session", percent: session, resets_at: FIVE_HOUR_RESET },
			{ kind: "weekly_all", percent: weeklyAll, resets_at: WEEKLY_RESET },
			{
				kind: "weekly_scoped",
				percent: fable,
				resets_at: fableReset,
				scope: { model: { display_name: "Fable" } },
			},
			...extraRows,
		],
		spend: {
			enabled: true,
			used: { amount: 205, currency: "USD", exponent: 2 },
			limit: { amount: 100, currency: "USD", exponent: 2 },
		},
	} as never;
}

const classify = (
	overrides: Partial<Parameters<typeof classifyRefusalScope>[0]> = {},
) =>
	classifyRefusalScope({
		headers: new Headers(),
		usageData: usage(),
		model: "claude-fable-5-2",
		now: NOW,
		headerResetAt: null,
		...overrides,
	});

describe("classifyRefusalScope", () => {
	it("classifies the measured replay as a Fable family refusal until the Fable reset", () => {
		const result = classify();
		expect(result.scope).toBe("family");
		if (result.scope !== "family") return;
		expect(result.family).toBe("fable");
		expect(result.source).toBe("usage");
		expect(result.until).toBe(Date.parse(FABLE_RESET));
	});

	it("is account-wide when the five-hour session is at 100 %", () => {
		expect(classify({ usageData: usage({ session: 100 }) }).scope).toBe(
			"account",
		);
	});

	it("is account-wide when weekly_all is at 100 %", () => {
		expect(classify({ usageData: usage({ weeklyAll: 100 }) }).scope).toBe(
			"account",
		);
	});

	it("ignores an account window at 100 % whose reset has passed", () => {
		const data = {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: "2026-11-13T11:00:00Z",
				},
				{ kind: "weekly_all", percent: 89, resets_at: WEEKLY_RESET },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: FABLE_RESET,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;
		expect(classify({ usageData: data }).scope).toBe("family");
	});

	it("is unclassified without usage readings", () => {
		const result = classify({ usageData: null });
		expect(result.scope).toBe("unclassified");
		expect(result.detail).toBe("no usage readings");
	});

	it("is unclassified when the family is below 100 %", () => {
		expect(classify({ usageData: usage({ fable: 97 }) }).scope).toBe(
			"unclassified",
		);
	});

	it("is unclassified when the family's reset has passed", () => {
		expect(
			classify({ usageData: usage({ fableReset: "2026-11-13T11:00:00Z" }) })
				.scope,
		).toBe("unclassified");
	});

	it("is unclassified when a family row lacks a reset", () => {
		const data = usage({
			extraRows: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: null,
					scope: { model: { display_name: "Fable (surface B)" } },
				},
			],
		});
		expect(classify({ usageData: data }).scope).toBe("unclassified");
	});

	it("is unclassified when there is no reading for the family", () => {
		expect(classify({ model: "claude-opus-5-5" }).scope).toBe("unclassified");
	});

	it("is unclassified for an unknown model family", () => {
		expect(classify({ model: "gpt-6-luna" }).scope).toBe("unclassified");
		expect(classify({ model: null }).scope).toBe("unclassified");
	});

	it.each([
		"five_hour",
		"seven_day",
	])("is account-wide for representative-claim %s even with the family at 100 %", (claim) => {
		const result = classify({
			headers: new Headers({
				"anthropic-ratelimit-unified-representative-claim": claim,
			}),
		});
		expect(result.scope).toBe("account");
	});

	it("is a family refusal for representative-claim seven_day_fable on a Fable request", () => {
		const result = classify({
			headers: new Headers({
				"anthropic-ratelimit-unified-representative-claim": "seven_day_fable",
			}),
			usageData: usage({ fable: 97 }),
		});
		expect(result.scope).toBe("family");
		if (result.scope !== "family") return;
		expect(result.source).toBe("header");
		expect(result.until).toBe(Date.parse(FABLE_RESET));
	});

	it("takes the response reset for a family claim without usage", () => {
		const resetAt = NOW + 3_600_000;
		const result = classify({
			headers: new Headers({
				"anthropic-ratelimit-unified-representative-claim": "seven_day_fable",
			}),
			usageData: null,
			headerResetAt: resetAt,
		});
		expect(result).toMatchObject({
			scope: "family",
			until: resetAt,
			source: "header",
		});
	});

	it("is unclassified for a family claim with no future reset known", () => {
		const result = classify({
			headers: new Headers({
				"anthropic-ratelimit-unified-representative-claim": "seven_day_fable",
			}),
			usageData: null,
			headerResetAt: NOW - 1,
		});
		expect(result.scope).toBe("unclassified");
	});

	it("ignores a claim naming another family and falls back to usage", () => {
		const result = classify({
			headers: new Headers({
				"anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
			}),
		});
		expect(result).toMatchObject({ scope: "family", source: "usage" });
	});
});

describe("rateLimitHeaderSummary", () => {
	it("lists only rate-limit headers, sorted by name", () => {
		const headers = new Headers({
			authorization: "Bearer secret",
			cookie: "a=b",
			"set-cookie": "c=d",
			"x-api-key": "sk-secret",
			"content-type": "application/json",
			"retry-after": "60",
			"x-should-retry": "false",
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-representative-claim": "seven_day_fable",
			"x-ratelimit-reset": "123",
		});
		expect(rateLimitHeaderSummary(headers)).toBe(
			"anthropic-ratelimit-unified-representative-claim=seven_day_fable; " +
				"anthropic-ratelimit-unified-status=rejected; " +
				"retry-after=60; x-ratelimit-reset=123; x-should-retry=false",
		);
	});

	it("says none when no rate-limit header is present", () => {
		expect(
			rateLimitHeaderSummary(new Headers({ authorization: "Bearer x" })),
		).toBe("none");
	});
});
