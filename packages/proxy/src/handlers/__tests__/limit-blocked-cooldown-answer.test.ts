import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import { localLimitAnswerResponse } from "../limit-blocked";
import {
	clearLimitRefusalCache,
	rememberLimitRefusal,
} from "../limit-response";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const NOW_S = NOW / 1000;
const R5 = NOW_S + 2 * 3600;
const R7 = NOW_S + 3 * 24 * 3600;
const H = "anthropic-ratelimit-unified";

const account = { id: "acc-c", name: "c", provider: "anthropic" } as never;

function cooldownAnswer(cooldownResetMs: number) {
	return {
		account,
		family: null,
		familyResetMs: null,
		cooldownResetMs,
	};
}

beforeEach(() => {
	usageCache.clear();
	clearLimitRefusalCache();
});
afterEach(() => {
	usageCache.clear();
	clearLimitRefusalCache();
});

describe("localLimitAnswerResponse for an account out only on a cooldown", () => {
	it("claims no limit, invents no reset and counts retry-after to the cooldown end", () => {
		usageCache.set("acc-c", {
			five_hour: {
				utilization: 35,
				resets_at: new Date(R5 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(R7 * 1000).toISOString(),
			},
		} as never);
		const res = localLimitAnswerResponse(
			cooldownAnswer(NOW + 4 * 60_000),
			"req-1",
			NOW,
		);
		const h = res.headers;
		expect(res.status).toBe(429);
		expect(h.get("retry-after")).toBe("240");
		expect(h.get(`${H}-status`)).toBeNull();
		expect(h.get(`${H}-representative-claim`)).toBeNull();
		expect(h.get(`${H}-reset`)).toBeNull();
		expect(h.get(`${H}-5h-status`)).toBe("allowed");
		expect(h.get(`${H}-7d-status`)).toBe("allowed");
		expect(h.get("x-better-ccflare-request-id")).toBe("req-1");
	});

	it("does not replay a cached full-limit refusal for a cooldown-only account", () => {
		rememberLimitRefusal(
			"acc-c",
			{
				status: 429,
				statusText: "Too Many Requests",
				headers: new Headers({
					[`${H}-status`]: "rejected",
					[`${H}-reset`]: String(R5),
					[`${H}-representative-claim`]: "five_hour",
					"retry-after": String(R5 - NOW_S),
				}),
				body: new TextEncoder().encode("{}"),
			},
			NOW,
		);
		const res = localLimitAnswerResponse(
			cooldownAnswer(NOW + 60_000),
			"req-2",
			NOW,
		);
		expect(res.headers.get(`${H}-representative-claim`)).toBeNull();
		expect(res.headers.get(`${H}-reset`)).toBeNull();
		expect(res.headers.get("retry-after")).toBe("60");
	});
});
