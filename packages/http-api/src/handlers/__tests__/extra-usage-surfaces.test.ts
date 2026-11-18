/**
 * Every operator-facing surface reads a full window the way account selection
 * does: final. Extra usage never makes an account routable, never takes it out
 * of usage_exhausted, and is never shown as a label of its own.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { isUseExtraUsageEnabled, setUseExtraUsage } from "@better-ccflare/core";
import type { Account, SessionPaceSettings } from "@better-ccflare/types";
import { createConfigHandlers } from "../config";
import { computePoolStatus } from "../health";
import { computeRateLimitStatusDisplay } from "../rate-limit-status";

const paceSettings = (): SessionPaceSettings => ({
	workDays: 5,
	familyGuardPct: 90,
	fiveHourGuardPct: 85,
	tieBandPct: 3,
	idleMs: 600_000,
	timeZone: "UTC",
});

const NOW = Date.UTC(2030, 0, 1);
const RESET = NOW + 60 * 60000;

afterEach(() => {
	setUseExtraUsage(false);
});

describe("computeRateLimitStatusDisplay — extra usage", () => {
	const base = {
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limited_until: null,
		usageUtilization: 100,
		usageResetMs: RESET,
	};

	it("labels a spent window usage_exhausted even if a caller claims extra usage", () => {
		expect(
			computeRateLimitStatusDisplay(
				{ ...base, usageExtraUsageAvailable: true } as never,
				NOW,
			),
		).toBe("usage_exhausted (60m)");
	});

	it("labels a spent window usage_exhausted with its reset", () => {
		expect(computeRateLimitStatusDisplay(base, NOW)).toBe(
			"usage_exhausted (60m)",
		);
	});

	it("never shows extra usage for a window that still has headroom", () => {
		expect(
			computeRateLimitStatusDisplay(
				{
					...base,
					usageUtilization: 40,
					usageExtraUsageAvailable: true,
				} as never,
				NOW,
			),
		).toBe("OK");
	});
});

describe("computePoolStatus — extra usage", () => {
	it("counts a spent account as usage_exhausted even if a snapshot claims extra usage", () => {
		const accounts = [
			{ id: "on-credits", name: "on-credits", provider: "codex" },
			{ id: "spent", name: "spent", provider: "codex" },
		].map(
			(a) => ({ paused: false, rate_limited_until: null, ...a }) as Account,
		);

		const status = computePoolStatus(
			accounts,
			NOW,
			(account) =>
				({
					utilization: 100,
					resetMs: RESET,
					extraUsageAvailable: account.id === "on-credits" ? true : undefined,
				}) as never,
		);

		expect(status.routable).toBe(0);
		expect(status.usage_exhausted).toBe(2);
	});
});

describe("/api/config/use-extra-usage", () => {
	it("reports the switch and pushes a write into the runtime mirror", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-api-"));
		try {
			const handlers = createConfigHandlers(
				new Config(join(dir, "config.json")),
				paceSettings,
			);

			const before = await handlers.getUseExtraUsage().json();
			expect(before).toEqual({ enabled: false, source: "default" });

			const res = await handlers.setUseExtraUsage(
				new Request("http://localhost/api/config/use-extra-usage", {
					method: "POST",
					body: JSON.stringify({ enabled: true }),
				}),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				success: true,
				enabled: true,
				source: "file",
				effective: true,
			});
			expect(isUseExtraUsageEnabled()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a payload that is not a boolean and changes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-api-"));
		try {
			const handlers = createConfigHandlers(
				new Config(join(dir, "config.json")),
				paceSettings,
			);
			const res = await handlers.setUseExtraUsage(
				new Request("http://localhost/api/config/use-extra-usage", {
					method: "POST",
					body: JSON.stringify({ enabled: "yes" }),
				}),
			);
			expect(res.status).toBe(400);
			expect(isUseExtraUsageEnabled()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
