/**
 * A full limit is final: isUsageExhausted / isAccountAvailable know no
 * extra-usage exception, whatever a snapshot or the "use extra usage" setting
 * carries.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { setUseExtraUsage } from "./extra-usage";
import { isAccountAvailable, isUsageExhausted } from "./strategy";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const FUTURE = NOW + 3_600_000;

function account(): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		paused: false,
		requires_reauth: false,
		rate_limited_until: null,
	} as unknown as Account;
}

afterEach(() => {
	setUseExtraUsage(false);
});

describe("isUsageExhausted — no extra-usage exception", () => {
	it("is exhausted at 100 % with a future reset", () => {
		expect(isUsageExhausted(100, FUTURE, NOW)).toBe(true);
	});

	it("is exhausted at 100 % with an unknown reset", () => {
		expect(isUsageExhausted(100, null, NOW)).toBe(true);
	});

	it("is not exhausted once the reset has passed (stale snapshot)", () => {
		expect(isUsageExhausted(100, NOW - 1, NOW)).toBe(false);
	});

	it("ignores any extra argument a caller still passes", () => {
		const exhausted = (isUsageExhausted as (...args: unknown[]) => boolean)(
			100,
			FUTURE,
			NOW,
			true,
		);
		expect(exhausted).toBe(true);
	});
});

describe("isAccountAvailable — no extra-usage exception", () => {
	it("refuses a snapshot at 100 % even if it claims extra usage, setting on", () => {
		setUseExtraUsage(true);
		const snapshot = {
			utilization: 100,
			resetMs: FUTURE,
			extraUsageAvailable: true,
		} as unknown as Parameters<typeof isAccountAvailable>[2];
		expect(isAccountAvailable(account(), NOW, snapshot)).toBe(false);
	});

	it("still admits an account with headroom", () => {
		expect(
			isAccountAvailable(account(), NOW, { utilization: 99, resetMs: FUTURE }),
		).toBe(true);
	});
});
