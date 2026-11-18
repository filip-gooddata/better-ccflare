import { afterEach, describe, expect, it } from "bun:test";
import { isUseExtraUsageEnabled, setUseExtraUsage } from "./extra-usage";
import { isAccountAvailable, isUsageExhausted } from "./strategy";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;

afterEach(() => {
	setUseExtraUsage(false);
});

describe("use extra usage switch", () => {
	it("is off by default: extra usage is billed, so spending it must be chosen", () => {
		expect(isUseExtraUsageEnabled()).toBe(false);
	});

	it("mirrors whatever the config pushes in", () => {
		setUseExtraUsage(true);
		expect(isUseExtraUsageEnabled()).toBe(true);
		setUseExtraUsage(false);
		expect(isUseExtraUsageEnabled()).toBe(false);
	});
});

describe("isUsageExhausted ignores the retired switch", () => {
	it("reports a spent window as exhausted with the switch on", () => {
		setUseExtraUsage(true);
		expect(isUsageExhausted(100, FUTURE, NOW)).toBe(true);
		expect(isUsageExhausted(130, null, NOW)).toBe(true);
	});

	it("leaves a window with headroom alone with the switch on", () => {
		setUseExtraUsage(true);
		expect(isUsageExhausted(42, FUTURE, NOW)).toBe(false);
	});
});

describe("isAccountAvailable ignores the retired switch", () => {
	const account = {
		requires_reauth: false,
		paused: false,
		rate_limited_until: null,
	} as unknown as Parameters<typeof isAccountAvailable>[0];

	it("excludes an account whose window is spent with the switch on", () => {
		setUseExtraUsage(true);
		expect(
			isAccountAvailable(account, NOW, { utilization: 100, resetMs: FUTURE }),
		).toBe(false);
	});

	it("still excludes the same account with the switch off", () => {
		expect(
			isAccountAvailable(account, NOW, { utilization: 100, resetMs: FUTURE }),
		).toBe(false);
	});

	it("never lets the switch override a pause or a cooldown", () => {
		setUseExtraUsage(true);
		const usage = { utilization: 40, resetMs: FUTURE };
		expect(
			isAccountAvailable(
				{ ...account, paused: true } as typeof account,
				NOW,
				usage,
			),
		).toBe(false);
		expect(
			isAccountAvailable(
				{ ...account, rate_limited_until: FUTURE } as typeof account,
				NOW,
				usage,
			),
		).toBe(false);
	});
});
