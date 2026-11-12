/**
 * Demand units: one unit is one million weighted tokens. TOKEN_WEIGHT and
 * MODEL_FACTOR are the single place these numbers live.
 */
import {
	BUCKET_MS,
	type EpochMs,
	type ModelFamily,
	type TokenUsage,
} from "./types";

export const TOKEN_WEIGHT = {
	input: 1,
	output: 5,
	cacheWrite5m: 1.25,
	cacheWrite1h: 2,
	cacheRead: 0.1,
} as const;

export const MODEL_FACTOR: Readonly<Record<ModelFamily, number>> = {
	opus: 1,
	fable: 2,
	sonnet: 0.6,
	haiku: 0.2,
	other: 1,
};

/** Same match order as getModelFamily in @better-ccflare/core. */
const FAMILY_PATTERNS = ["fable", "opus", "haiku", "sonnet"] as const;

export function modelFamily(model: string | null): ModelFamily {
	if (!model) return "other";
	const normalized = model.toLowerCase();
	for (const family of FAMILY_PATTERNS) {
		if (normalized.includes(family)) return family;
	}
	return "other";
}

function count(n: number | null): number {
	return n !== null && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Cache writes with an unknown split count at the 1-hour weight, as does the
 * part of cacheWriteTokens a known split leaves unaccounted for.
 */
export function demandUnits(usage: TokenUsage): number {
	const cacheWrite = count(usage.cacheWriteTokens);
	let write5m = 0;
	let write1h = cacheWrite;
	if (usage.cacheWrite5mTokens !== null || usage.cacheWrite1hTokens !== null) {
		write5m = count(usage.cacheWrite5mTokens);
		const split1h = count(usage.cacheWrite1hTokens);
		write1h = split1h + Math.max(0, cacheWrite - write5m - split1h);
	}
	const weighted =
		count(usage.inputTokens) * TOKEN_WEIGHT.input +
		count(usage.outputTokens) * TOKEN_WEIGHT.output +
		write5m * TOKEN_WEIGHT.cacheWrite5m +
		write1h * TOKEN_WEIGHT.cacheWrite1h +
		count(usage.cacheReadTokens) * TOKEN_WEIGHT.cacheRead;
	return (weighted * MODEL_FACTOR[modelFamily(usage.model)]) / 1_000_000;
}

export function isFableUsage(usage: TokenUsage): boolean {
	return modelFamily(usage.model) === "fable";
}

export function bucketStart(at: EpochMs): EpochMs {
	return Math.floor(at / BUCKET_MS) * BUCKET_MS;
}
