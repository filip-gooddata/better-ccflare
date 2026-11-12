import { describe, expect, test } from "bun:test";
import { BUCKET_MS, type TokenUsage } from "../types";
import {
	bucketStart,
	demandUnits,
	isFableUsage,
	MODEL_FACTOR,
	modelFamily,
	TOKEN_WEIGHT,
} from "../units";

function usage(partial: Partial<TokenUsage>): TokenUsage {
	return {
		model: "claude-opus-5-5",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite5mTokens: null,
		cacheWrite1hTokens: null,
		...partial,
	};
}

describe("modelFamily", () => {
	test("matches family names case-insensitively", () => {
		expect(modelFamily("claude-opus-5-5")).toBe("opus");
		expect(modelFamily("claude-fable-5-2")).toBe("fable");
		expect(modelFamily("Claude-Sonnet-5-5")).toBe("sonnet");
		expect(modelFamily("CLAUDE-HAIKU-5-5")).toBe("haiku");
	});

	test("unknown, empty and null models are other", () => {
		expect(modelFamily("gpt-4o")).toBe("other");
		expect(modelFamily("")).toBe("other");
		expect(modelFamily(null)).toBe("other");
	});
});

describe("constants", () => {
	test("weights and factors", () => {
		expect(TOKEN_WEIGHT).toEqual({
			input: 1,
			output: 5,
			cacheWrite5m: 1.25,
			cacheWrite1h: 2,
			cacheRead: 0.1,
		});
		expect(MODEL_FACTOR).toEqual({
			opus: 1,
			fable: 2,
			sonnet: 0.6,
			haiku: 0.2,
			other: 1,
		});
	});
});

describe("demandUnits", () => {
	test("one million opus input tokens is one unit", () => {
		expect(demandUnits(usage({ inputTokens: 1_000_000 }))).toBeCloseTo(1, 12);
	});

	test("weights each token kind", () => {
		expect(demandUnits(usage({ outputTokens: 1_000_000 }))).toBeCloseTo(5, 12);
		expect(demandUnits(usage({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(
			0.1,
			12,
		);
	});

	test("applies the model factor", () => {
		const m = (model: string | null) =>
			demandUnits(usage({ model, outputTokens: 1_000_000 }));
		expect(m("claude-sonnet-5-5")).toBeCloseTo(3, 12);
		expect(m("claude-fable-5-2")).toBeCloseTo(10, 12);
		expect(m("claude-haiku-5-5")).toBeCloseTo(1, 12);
		expect(m("some-other-model")).toBeCloseTo(5, 12);
		expect(m(null)).toBeCloseTo(5, 12);
	});

	test("unknown cache-write split counts at the 1-hour weight", () => {
		expect(demandUnits(usage({ cacheWriteTokens: 1_000_000 }))).toBeCloseTo(
			2,
			12,
		);
	});

	test("known split uses each weight", () => {
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 1_000_000,
					cacheWrite5mTokens: 1_000_000,
					cacheWrite1hTokens: 0,
				}),
			),
		).toBeCloseTo(1.25, 12);
	});

	test("a split with one side null treats that side as zero", () => {
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 1_000_000,
					cacheWrite5mTokens: 1_000_000,
					cacheWrite1hTokens: null,
				}),
			),
		).toBeCloseTo(1.25, 12);
	});

	test("remainder of a short split counts at the 1-hour weight", () => {
		// 400k×1.25 + 100k×2 + 500k×2 = 1.7M
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 1_000_000,
					cacheWrite5mTokens: 400_000,
					cacheWrite1hTokens: 100_000,
				}),
			),
		).toBeCloseTo(1.7, 12);
	});

	test("sums all kinds", () => {
		// 1M + 5×200k + 1.25×100k + 2×100k + 0.1×1M = 2.425M, × sonnet 0.6
		expect(
			demandUnits(
				usage({
					model: "claude-sonnet-5-5",
					inputTokens: 1_000_000,
					outputTokens: 200_000,
					cacheWriteTokens: 200_000,
					cacheWrite5mTokens: 100_000,
					cacheWrite1hTokens: 100_000,
					cacheReadTokens: 1_000_000,
				}),
			),
		).toBeCloseTo(2.425 * 0.6, 12);
	});

	test("negative and non-finite counts are zero", () => {
		expect(
			demandUnits(
				usage({
					inputTokens: -5,
					outputTokens: Number.NaN,
					cacheReadTokens: Number.POSITIVE_INFINITY,
					cacheWriteTokens: Number.NEGATIVE_INFINITY,
				}),
			),
		).toBe(0);
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 1_000_000,
					cacheWrite5mTokens: -1,
					cacheWrite1hTokens: Number.NaN,
				}),
			),
		).toBeCloseTo(2, 12);
	});

	test("zero usage is zero", () => {
		expect(demandUnits(usage({}))).toBe(0);
	});
});

describe("isFableUsage", () => {
	test("true only for the fable family", () => {
		expect(isFableUsage(usage({ model: "claude-fable-5-2" }))).toBe(true);
		expect(isFableUsage(usage({ model: "claude-opus-5-5" }))).toBe(false);
		expect(isFableUsage(usage({ model: null }))).toBe(false);
	});
});

describe("bucketStart", () => {
	test("floors to a multiple of BUCKET_MS", () => {
		expect(bucketStart(0)).toBe(0);
		expect(bucketStart(BUCKET_MS - 1)).toBe(0);
		expect(bucketStart(BUCKET_MS * 7)).toBe(BUCKET_MS * 7);
		expect(bucketStart(BUCKET_MS * 7 + 1)).toBe(BUCKET_MS * 7);
		const now = Date.UTC(2026, 10, 12, 9, 47, 31, 5);
		expect(bucketStart(now)).toBe(Date.UTC(2026, 10, 12, 9, 45));
	});
});

describe("demandUnits cache-write split policy", () => {
	test("a split with the 5-minute side null treats it as zero", () => {
		// 1h: 300k×2, remainder 700k×2 = 2M
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 1_000_000,
					cacheWrite5mTokens: null,
					cacheWrite1hTokens: 300_000,
				}),
			),
		).toBeCloseTo(2, 12);
	});

	test("a split above cacheWriteTokens is counted as reported", () => {
		expect(
			demandUnits(
				usage({
					cacheWriteTokens: 0,
					cacheWrite5mTokens: 1_000_000,
					cacheWrite1hTokens: 1_000_000,
				}),
			),
		).toBeCloseTo(3.25, 12);
	});
});
