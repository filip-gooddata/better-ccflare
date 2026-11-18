/**
 * The one snapshot helper every caller shares — account selection, the
 * auto-refresh probe skip, the /health usage_exhausted counter and the
 * pool-exhausted response body. What all of them need from it is that a null
 * snapshot never reads as "exhausted" and that the reset always belongs to the
 * same window the utilization came from.
 */
import { describe, expect, it } from "bun:test";
import { isUsageExhausted } from "@better-ccflare/core";
import type { ZaiUsageData, ZaiUsageWindow } from "@better-ccflare/types";
import type { UsageData } from "../usage-fetcher";
import { getRepresentativeUsageSnapshotForProvider } from "../usage-fetcher";

function zaiWindow(
	type: string,
	percentage: number,
	resetAt: number | null,
): ZaiUsageWindow {
	return {
		used: percentage,
		remaining: 100 - percentage,
		percentage,
		resetAt,
		type,
	};
}

describe("getRepresentativeUsageSnapshotForProvider", () => {
	it("has no opinion when nothing was ever polled", () => {
		expect(getRepresentativeUsageSnapshotForProvider(null, "codex")).toBeNull();
		expect(
			getRepresentativeUsageSnapshotForProvider(undefined, "codex"),
		).toBeNull();
		expect(getRepresentativeUsageSnapshotForProvider(null, "zai")).toBeNull();
	});

	it("has no opinion when the payload exposes no utilization surface", () => {
		// An empty payload names no window, so there is no percentage to gate
		// on — distinct from a real 0%, which would be a routable account.
		const empty = {} as unknown as UsageData;
		expect(
			getRepresentativeUsageSnapshotForProvider(empty, "codex"),
		).toBeNull();
	});

	it("takes the exhausted window's utilization and that window's reset", () => {
		// The incident shape: a spent weekly window four days out while the
		// five-hour window is nearly empty and resets within the hour. Pairing
		// 100% with the five-hour reset is what let the staleness guard clear
		// the account an hour later and re-probe it.
		const weeklyExhausted = {
			five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00.000Z" },
			seven_day: { utilization: 100, resets_at: "2030-01-05T00:00:00.000Z" },
		} as unknown as UsageData;

		const snapshot = getRepresentativeUsageSnapshotForProvider(
			weeklyExhausted,
			"codex",
		);

		expect(snapshot).toEqual({
			utilization: 100,
			resetMs: new Date("2030-01-05T00:00:00.000Z").getTime(),
		});
		expect(
			isUsageExhausted(
				snapshot?.utilization ?? null,
				snapshot?.resetMs,
				Date.parse("2030-01-02T00:00:00.000Z"),
			),
		).toBe(true);
	});

	it("pairs a zai time_limit win with its OWN reset, not a token window's", () => {
		// Greptile P1 on PR #468: the plain pairing took zai's utilization from
		// max(time_limit, tokens_limit, tokens_limit_weekly) but its reset from
		// the winning TOKEN window only. A stale 100% time_limit whose reset has
		// already passed then paired with a future token reset, and the
		// staleness guard — which exists precisely to clear that reading —
		// could not fire. Valid probes stayed suppressed until an unrelated
		// window reset.
		const now = Date.parse("2030-06-01T12:00:00.000Z");
		const pastReset = now - 60 * 60 * 1000;
		const futureReset = now + 2 * 60 * 60 * 1000;
		const zaiUsage: ZaiUsageData = {
			time_limit: zaiWindow("time_limit", 100, pastReset),
			tokens_limit: zaiWindow("tokens_limit", 40, futureReset),
			tokens_limit_weekly: null,
		};

		const snapshot = getRepresentativeUsageSnapshotForProvider(zaiUsage, "zai");

		expect(snapshot).toEqual({ utilization: 100, resetMs: pastReset });
		expect(
			isUsageExhausted(snapshot?.utilization ?? null, snapshot?.resetMs, now),
		).toBe(false);
	});

	it("on a 100%/100% zai tie, keeps the LATER reset", () => {
		// The account is not available again until every exhausted window
		// clears, so the earlier reset would promise recovery too soon.
		const now = Date.parse("2030-06-01T12:00:00.000Z");
		const earlier = now + 120_000;
		const later = now + 3_600_000;
		const zaiUsage: ZaiUsageData = {
			time_limit: zaiWindow("time_limit", 100, earlier),
			tokens_limit: zaiWindow("tokens_limit", 100, later),
			tokens_limit_weekly: null,
		};

		const snapshot = getRepresentativeUsageSnapshotForProvider(zaiUsage, "zai");

		expect(snapshot).toEqual({ utilization: 100, resetMs: later });
		expect(
			isUsageExhausted(snapshot?.utilization ?? null, snapshot?.resetMs, now),
		).toBe(true);
	});
});

// A stale full window must not hide a hard window that is still full: the
// gates read this snapshot, and a full five-hour or weekly window is final.
describe("getRepresentativeUsageSnapshotForProvider: a hard window still full", () => {
	const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
	const iso = (ms: number) => new Date(ms).toISOString();
	const expired = NOW - 60 * 60 * 1000;
	const weekly = NOW + 3 * 24 * 60 * 60 * 1000;
	const later = NOW + 5 * 24 * 60 * 60 * 1000;

	for (const provider of ["anthropic", "codex"]) {
		it(`${provider}: an expired full five-hour window does not hide a full weekly window`, () => {
			const data = {
				five_hour: { utilization: 100, resets_at: iso(expired) },
				seven_day: { utilization: 100, resets_at: iso(weekly) },
			} as unknown as UsageData;
			const snapshot = getRepresentativeUsageSnapshotForProvider(
				data,
				provider,
				NOW,
			);
			expect(snapshot).toEqual({ utilization: 100, resetMs: weekly });
			expect(
				isUsageExhausted(snapshot?.utilization ?? 0, snapshot?.resetMs, NOW),
			).toBe(true);
		});
	}

	it("reads limits[]-only payloads the same way", () => {
		const data = {
			limits: [
				{ kind: "session", percent: 100, resets_at: iso(expired) },
				{ kind: "weekly_all", percent: 100, resets_at: iso(weekly) },
			],
		} as unknown as UsageData;
		expect(
			getRepresentativeUsageSnapshotForProvider(data, "anthropic", NOW),
		).toEqual({ utilization: 100, resetMs: weekly });
	});

	it("reports the full window with the latest reset when several are full", () => {
		const data = {
			five_hour: { utilization: 130, resets_at: iso(weekly) },
			seven_day: { utilization: 100, resets_at: iso(later) },
		} as unknown as UsageData;
		expect(
			getRepresentativeUsageSnapshotForProvider(data, "anthropic", NOW),
		).toEqual({ utilization: 100, resetMs: later });
	});

	it("reports an unknown reset when a full window has none", () => {
		const data = {
			five_hour: { utilization: 100, resets_at: null },
			seven_day: { utilization: 100, resets_at: iso(later) },
		} as unknown as UsageData;
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			data,
			"anthropic",
			NOW,
		);
		expect(snapshot).toEqual({ utilization: 100, resetMs: null });
		expect(isUsageExhausted(100, snapshot?.resetMs, NOW)).toBe(true);
	});

	it("keeps the usual pick when no hard window is still full", () => {
		const data = {
			five_hour: { utilization: 100, resets_at: iso(expired) },
			seven_day: { utilization: 40, resets_at: iso(weekly) },
		} as unknown as UsageData;
		expect(
			getRepresentativeUsageSnapshotForProvider(data, "anthropic", NOW),
		).toEqual({ utilization: 100, resetMs: expired });
	});

	it("does not treat a spent extra_usage pool as a hard window", () => {
		const data = {
			seven_day: { utilization: 40, resets_at: iso(weekly) },
			extra_usage: { is_enabled: true, utilization: 100 },
		} as unknown as UsageData;
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			data,
			"anthropic",
			NOW,
		);
		expect(snapshot).toEqual({ utilization: 40, resetMs: weekly });
	});
});
