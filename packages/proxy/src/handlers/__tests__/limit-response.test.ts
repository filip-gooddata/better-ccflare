import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import {
	buildLocalCooldownResponse,
	buildLocalLimitResponse,
	clearLimitRefusalCache,
	getCachedLimitRefusal,
	localLimitInputForAccount,
	localLimitResponseForAccount,
	rebaseLimitRefusalHeaders,
	rememberLimitRefusal,
} from "../limit-response";
import { blockFamily, clearFamilyBlocks } from "../model-capacity";

const HOUR = 3_600_000;
// A fixed instant on a whole second, so header arithmetic is exact.
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const NOW_S = NOW / 1000;
const R5 = NOW_S + 2 * 3600 + 17 * 60; // five-hour reset, epoch s
const R7 = NOW_S + 3 * 24 * 3600; // weekly reset, epoch s
const OVERAGE_RESET = Date.UTC(2026, 11, 1) / 1000;

/**
 * The real upstream 429 header set (COMMON-BRIEF fixture, five-hour binding,
 * weekly at allowed_warning), rebuilt with fake values. `request-id`,
 * `cf-ray` and `server` are on the real response but have no local
 * counterpart.
 */
function realHeaders(): Headers {
	return new Headers({
		"content-type": "application/json",
		"retry-after": String(R5 - NOW_S),
		"x-should-retry": "true",
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-reset": String(R5),
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-5h-status": "rejected",
		"anthropic-ratelimit-unified-5h-reset": String(R5),
		"anthropic-ratelimit-unified-5h-utilization": "1.0",
		"anthropic-ratelimit-unified-5h-surpassed-threshold": "1.0",
		"anthropic-ratelimit-unified-7d-status": "allowed_warning",
		"anthropic-ratelimit-unified-7d-reset": String(R7),
		"anthropic-ratelimit-unified-7d-utilization": "0.77",
		"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
		"anthropic-ratelimit-unified-fallback-percentage": "0.5",
		"anthropic-ratelimit-unified-overage-status": "rejected",
		"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		"anthropic-ratelimit-unified-overage-reset": String(OVERAGE_RESET),
		"anthropic-ratelimit-unified-overage-utilization": "2.06",
		"anthropic-ratelimit-unified-overage-surpassed-threshold": "1.0",
		"anthropic-ratelimit-unified-upgrade-paths": "overage",
		"request-id": "req_fake0000000000000000000",
		"cf-ray": "0000000000000000-FAKE",
		server: "cloudflare",
		date: new Date(NOW - 5 * 60_000).toUTCString(),
	});
}

const REAL_BODY = new TextEncoder().encode(
	JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: "upstream text, as received" },
	}),
);

const NOT_LOCAL = new Set(["request-id", "cf-ray", "server"]);

function names(h: Headers): string[] {
	return [...h.keys()].filter((k) => !NOT_LOCAL.has(k)).sort();
}

// Value grammar per header family, as observed on the real response.
const EPOCH_S = /^\d{10}$/;
const FRACTION = /^\d+\.\d+$/;
function expectGrammar(h: Headers): void {
	for (const [k, v] of h.entries()) {
		if (k.endsWith("-reset")) expect(v).toMatch(EPOCH_S);
		else if (k.endsWith("-utilization")) expect(v).toMatch(FRACTION);
		else if (k.endsWith("-surpassed-threshold")) expect(v).toMatch(FRACTION);
		else if (k === "anthropic-ratelimit-unified-fallback-percentage")
			expect(v).toMatch(FRACTION);
		else if (k === "retry-after") expect(v).toMatch(/^\d+$/);
		else if (k.endsWith("-status"))
			expect(["rejected", "allowed", "allowed_warning"]).toContain(v);
	}
}

function anthropicUsage({
	five = 100,
	fiveReset = (R5 * 1000) as number | null,
	seven = 77,
	sevenReset = (R7 * 1000) as number | null,
	used = 206 as number | null,
	limit = 100 as number | null,
	fable = null as number | null,
} = {}) {
	const iso = (ms: number | null) =>
		ms === null ? null : new Date(ms).toISOString();
	return {
		five_hour: { utilization: five, resets_at: iso(fiveReset) },
		seven_day: { utilization: seven, resets_at: iso(sevenReset) },
		extra_usage: {
			is_enabled: true,
			monthly_limit: limit,
			used_credits: used,
			utilization: null,
		},
		limits:
			fable === null
				? []
				: [
						{
							kind: "weekly_scoped",
							percent: fable,
							resets_at: iso(R7 * 1000),
							scope: { model: { display_name: "Fable" } },
						},
					],
	};
}

beforeEach(() => {
	usageCache.clear();
	clearLimitRefusalCache();
	clearFamilyBlocks();
});
afterEach(() => {
	usageCache.clear();
	clearLimitRefusalCache();
	clearFamilyBlocks();
});

describe("buildLocalLimitResponse — compared with the real 429", () => {
	it("five-hour binding: same header names, grammar, statuses and retry-after", async () => {
		const res = buildLocalLimitResponse(
			{
				binding: { kind: "five_hour" },
				resetMs: R5 * 1000,
				fiveHour: { utilization: 100, resetMs: R5 * 1000 },
				sevenDay: { utilization: 77, resetMs: R7 * 1000 },
				overage: { usedCredits: 206, monthlyLimit: 100 },
			},
			NOW,
		);
		expect(res.status).toBe(429);
		const real = realHeaders();
		expect(names(res.headers)).toEqual(names(real));
		expectGrammar(res.headers);
		const h = res.headers;
		expect(h.get("content-type")).toBe("application/json");
		expect(h.get("retry-after")).toBe(real.get("retry-after"));
		expect(h.get("x-should-retry")).toBe("true");
		expect(h.get("anthropic-ratelimit-unified-status")).toBe("rejected");
		expect(h.get("anthropic-ratelimit-unified-reset")).toBe(String(R5));
		expect(h.get("anthropic-ratelimit-unified-representative-claim")).toBe(
			"five_hour",
		);
		expect(h.get("anthropic-ratelimit-unified-5h-status")).toBe("rejected");
		expect(h.get("anthropic-ratelimit-unified-5h-reset")).toBe(String(R5));
		expect(h.get("anthropic-ratelimit-unified-5h-utilization")).toBe("1.0");
		expect(h.get("anthropic-ratelimit-unified-5h-surpassed-threshold")).toBe(
			"1.0",
		);
		expect(h.get("anthropic-ratelimit-unified-7d-status")).toBe(
			"allowed_warning",
		);
		expect(h.get("anthropic-ratelimit-unified-7d-reset")).toBe(String(R7));
		expect(h.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.77");
		expect(h.get("anthropic-ratelimit-unified-7d-surpassed-threshold")).toBe(
			"0.75",
		);
		expect(h.get("anthropic-ratelimit-unified-fallback-percentage")).toBe(
			"0.5",
		);
		expect(h.get("anthropic-ratelimit-unified-overage-status")).toBe(
			"rejected",
		);
		expect(h.get("anthropic-ratelimit-unified-overage-disabled-reason")).toBe(
			"org_spend_cap_reached",
		);
		expect(h.get("anthropic-ratelimit-unified-overage-reset")).toBe(
			String(OVERAGE_RESET),
		);
		expect(h.get("anthropic-ratelimit-unified-overage-utilization")).toBe(
			"2.06",
		);
		expect(
			h.get("anthropic-ratelimit-unified-overage-surpassed-threshold"),
		).toBe("1.0");
		expect(h.get("anthropic-ratelimit-unified-upgrade-paths")).toBe("overage");
		expect(h.get("request-id")).toBeNull();
		expect(h.get("date")).toBe(new Date(NOW).toUTCString());
		expect(await res.json()).toEqual({
			type: "error",
			error: { type: "rate_limit_error", message: expect.any(String) },
		});
	});

	it("weekly binding: claim seven_day, unified reset = weekly reset, 7d rejected", () => {
		const res = buildLocalLimitResponse(
			{
				binding: { kind: "seven_day" },
				resetMs: R7 * 1000,
				fiveHour: { utilization: 40, resetMs: R5 * 1000 },
				sevenDay: { utilization: 100, resetMs: R7 * 1000 },
				overage: { usedCredits: 206, monthlyLimit: 100 },
			},
			NOW,
		);
		const h = res.headers;
		expectGrammar(h);
		expect(h.get("retry-after")).toBe(String(R7 - NOW_S));
		expect(h.get("anthropic-ratelimit-unified-reset")).toBe(String(R7));
		expect(h.get("anthropic-ratelimit-unified-representative-claim")).toBe(
			"seven_day",
		);
		expect(h.get("anthropic-ratelimit-unified-7d-status")).toBe("rejected");
		expect(h.get("anthropic-ratelimit-unified-5h-status")).toBe("allowed");
		expect(h.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.4");
		// The 5h window has room: no surpassed threshold, as upstream's one
		// 5h-allowed line had none.
		expect(
			h.get("anthropic-ratelimit-unified-5h-surpassed-threshold"),
		).toBeNull();
		// Every name the real response carries except the 5h threshold.
		const expected = names(realHeaders()).filter(
			(n) => n !== "anthropic-ratelimit-unified-5h-surpassed-threshold",
		);
		expect(names(h)).toEqual(expected);
	});

	it("family binding: approximate claim seven_day_<family>, family reset", async () => {
		const familyReset = R7 * 1000 + HOUR;
		const res = buildLocalLimitResponse(
			{
				binding: { kind: "family", family: "fable" },
				resetMs: familyReset,
				fiveHour: { utilization: 79, resetMs: R5 * 1000 },
				sevenDay: { utilization: 89, resetMs: R7 * 1000 },
				overage: { usedCredits: 206, monthlyLimit: 100 },
			},
			NOW,
		);
		const h = res.headers;
		expectGrammar(h);
		expect(res.status).toBe(429);
		expect(h.get("anthropic-ratelimit-unified-representative-claim")).toBe(
			"seven_day_fable",
		);
		expect(h.get("anthropic-ratelimit-unified-reset")).toBe(
			String(familyReset / 1000),
		);
		expect(h.get("retry-after")).toBe(String((familyReset - NOW) / 1000));
		const body = await res.json();
		expect(Object.keys(body.error).sort()).toEqual(["message", "type"]);
	});

	it("retry-after floors the remaining seconds and is at least 1", () => {
		const r = (resetMs: number) =>
			buildLocalLimitResponse(
				{ binding: { kind: "five_hour" }, resetMs },
				NOW,
			).headers.get("retry-after");
		expect(r(NOW + 90_999)).toBe("90");
		expect(r(NOW + 200)).toBe("1");
		expect(r(NOW - 5_000)).toBe("1");
	});

	it("omits the readings it does not have instead of inventing them", () => {
		const res = buildLocalLimitResponse(
			{ binding: { kind: "five_hour" }, resetMs: null },
			NOW,
		);
		const h = res.headers;
		expect(h.get("retry-after")).toBe("60");
		expect(h.get("anthropic-ratelimit-unified-reset")).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-5h-status")).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-7d-status")).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-overage-utilization")).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-status")).toBe("rejected");
		expect(h.get("anthropic-ratelimit-unified-overage-status")).toBe(
			"rejected",
		);
	});
});

describe("limit refusal cache", () => {
	it("keeps only a 429 whose unified reset is ahead, and copies it", () => {
		const headers = realHeaders();
		const body = REAL_BODY.slice();
		rememberLimitRefusal(
			"acc-a",
			{ status: 429, statusText: "Too Many Requests", headers, body },
			NOW,
		);
		headers.set("anthropic-ratelimit-unified-reset", "1");
		body[0] = 0;
		const cached = getCachedLimitRefusal("acc-a", NOW + 1000);
		expect(cached).not.toBeNull();
		expect(cached?.resetMs).toBe(R5 * 1000);
		expect(cached?.capturedAt).toBe(NOW);
		expect(cached?.headers.get("anthropic-ratelimit-unified-reset")).toBe(
			String(R5),
		);
		expect(cached?.body).toEqual(REAL_BODY);

		rememberLimitRefusal(
			"acc-b",
			{ status: 529, statusText: "", headers: realHeaders(), body: REAL_BODY },
			NOW,
		);
		const noReset = realHeaders();
		noReset.delete("anthropic-ratelimit-unified-reset");
		rememberLimitRefusal(
			"acc-c",
			{ status: 429, statusText: "", headers: noReset, body: REAL_BODY },
			NOW,
		);
		rememberLimitRefusal(
			"acc-d",
			{ status: 429, statusText: "", headers: realHeaders(), body: REAL_BODY },
			R5 * 1000,
		);
		expect(getCachedLimitRefusal("acc-b", NOW)).toBeNull();
		expect(getCachedLimitRefusal("acc-c", NOW)).toBeNull();
		expect(getCachedLimitRefusal("acc-d", NOW)).toBeNull();
	});

	it("does not serve a refusal once its reset has passed", () => {
		rememberLimitRefusal(
			"acc-a",
			{ status: 429, statusText: "", headers: realHeaders(), body: REAL_BODY },
			NOW,
		);
		expect(getCachedLimitRefusal("acc-a", R5 * 1000 - 1)).not.toBeNull();
		expect(getCachedLimitRefusal("acc-a", R5 * 1000)).toBeNull();
		expect(getCachedLimitRefusal("acc-a", NOW)).toBeNull();
	});

	it("rebases only retry-after and date", () => {
		const later = NOW + 30 * 60_000 + 400;
		const rebased = rebaseLimitRefusalHeaders(realHeaders(), later);
		const original = realHeaders();
		expect(rebased.get("retry-after")).toBe(
			String(Math.floor(R5 - later / 1000)),
		);
		expect(rebased.get("date")).toBe(new Date(later).toUTCString());
		for (const [k, v] of original.entries()) {
			if (k === "retry-after" || k === "date") continue;
			expect(rebased.get(k)).toBe(v);
		}
		expect([...rebased.keys()].sort()).toEqual([...original.keys()].sort());
	});
});

describe("localLimitResponseForAccount", () => {
	it("replays a fresh cached 429: body bytes kept, every header but retry-after and date kept", async () => {
		rememberLimitRefusal(
			"acc-a",
			{
				status: 429,
				statusText: "Too Many Requests",
				headers: realHeaders(),
				body: REAL_BODY,
			},
			NOW,
		);
		const later = NOW + 10 * 60_000;
		const res = localLimitResponseForAccount(
			{ id: "acc-a", name: "a" },
			{ requestId: "req-local-1", now: later },
		);
		expect(res.status).toBe(429);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(REAL_BODY);
		const h = res.headers;
		expect(h.get("retry-after")).toBe(String(R5 - later / 1000));
		expect(h.get("date")).toBe(new Date(later).toUTCString());
		expect(h.get("x-better-ccflare-request-id")).toBe("req-local-1");
		const real = realHeaders();
		for (const name of names(real)) {
			if (name === "retry-after" || name === "date") continue;
			expect(h.get(name)).toBe(real.get(name));
		}
		// Replay keeps upstream's own request-id; it is a real one.
		expect(h.get("request-id")).toBe(real.get("request-id"));
	});

	it("builds from usage when the cached 429 is stale", () => {
		rememberLimitRefusal(
			"acc-a",
			{ status: 429, statusText: "", headers: realHeaders(), body: REAL_BODY },
			NOW,
		);
		const later = R5 * 1000 + 1000;
		usageCache.set(
			"acc-a",
			anthropicUsage({
				five: 30,
				seven: 100,
				fiveReset: later + 5 * HOUR,
			}) as never,
		);
		const res = localLimitResponseForAccount({ id: "acc-a" }, { now: later });
		expect(
			res.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("seven_day");
		expect(res.headers.get("retry-after")).toBe(
			String(Math.floor(R7 - later / 1000)),
		);
		// The real value seen last for this account outlives its stale refusal.
		expect(
			res.headers.get("anthropic-ratelimit-unified-overage-disabled-reason"),
		).toBe("out_of_credits");
	});

	it("falls back to a built 429 with only the binding reset when nothing is cached", () => {
		const res = localLimitResponseForAccount(
			{ id: "acc-none" },
			{ family: "fable", familyResetMs: R7 * 1000, now: NOW },
		);
		expect(res.status).toBe(429);
		expect(
			res.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("seven_day_fable");
		expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBe(
			String(R7),
		);
		expect(res.headers.get("anthropic-ratelimit-unified-5h-status")).toBeNull();
	});
});

describe("localLimitInputForAccount", () => {
	it("returns null without cached usage", () => {
		expect(localLimitInputForAccount("acc-none", { now: NOW })).toBeNull();
	});

	it("binds the full five-hour window and carries the readings", () => {
		usageCache.set("acc-a", anthropicUsage() as never);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input).toEqual({
			binding: { kind: "five_hour" },
			resetMs: R5 * 1000,
			fiveHour: { utilization: 100, resetMs: R5 * 1000 },
			sevenDay: { utilization: 77, resetMs: R7 * 1000 },
			overage: { usedCredits: 206, monthlyLimit: 100, disabledReason: null },
		});
	});

	it("binds the weekly window when only it is full", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 20, seven: 100 }) as never);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "seven_day" });
		expect(input?.resetMs).toBe(R7 * 1000);
	});

	it("binds the later reset when both windows are full", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 100, seven: 100 }) as never);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "seven_day" });
		expect(input?.resetMs).toBe(R7 * 1000);
	});

	it("binds the family when its usage window is full", () => {
		usageCache.set(
			"acc-a",
			anthropicUsage({ five: 79, seven: 89, fable: 100 }) as never,
		);
		const input = localLimitInputForAccount("acc-a", {
			family: "fable",
			now: NOW,
		});
		expect(input?.binding).toEqual({ kind: "family", family: "fable" });
		expect(input?.resetMs).toBe(R7 * 1000);
	});

	it("binds the family when it is blocked, at the block's reset", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 79, seven: 89 }) as never);
		blockFamily("acc-a", "fable", R7 * 1000 + HOUR, "header", NOW);
		const input = localLimitInputForAccount("acc-a", {
			family: "fable",
			now: NOW,
		});
		expect(input?.binding).toEqual({ kind: "family", family: "fable" });
		expect(input?.resetMs).toBe(R7 * 1000 + HOUR);
	});

	it("binds a full account-wide window that resets after a full family", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 100, seven: 100 }) as never);
		const familyReset = NOW + 1000;
		const input = localLimitInputForAccount("acc-a", {
			family: "fable",
			familyResetMs: familyReset,
			now: NOW,
		});
		expect(input?.binding).toEqual({ kind: "seven_day" });
		expect(input?.resetMs).toBe(R7 * 1000);
		const res = localLimitResponseForAccount(
			{ id: "acc-a" },
			{ family: "fable", familyResetMs: familyReset, now: NOW },
		);
		expect(res.headers.get("retry-after")).toBe(
			String(Math.floor(R7 - NOW / 1000)),
		);
		expect(
			res.headers.get("anthropic-ratelimit-unified-representative-claim"),
		).toBe("seven_day");
	});

	it("keeps the family binding when it resets after every full window", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 100, seven: 89 }) as never);
		const familyReset = R7 * 1000 + HOUR;
		const input = localLimitInputForAccount("acc-a", {
			family: "fable",
			familyResetMs: familyReset,
			now: NOW,
		});
		expect(input?.binding).toEqual({ kind: "family", family: "fable" });
		expect(input?.resetMs).toBe(familyReset);
	});

	it("leaves five_hour as the binding when nothing is full", () => {
		usageCache.set("acc-a", anthropicUsage({ five: 50, seven: 60 }) as never);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "five_hour" });
		expect(input?.resetMs).toBe(R5 * 1000);
	});

	it("reads windows from limits[] when the flat windows are absent", () => {
		usageCache.set("acc-a", {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: new Date(R5 * 1000).toISOString(),
				},
				{
					kind: "weekly_all",
					percent: 30,
					resets_at: new Date(R7 * 1000).toISOString(),
				},
			],
		} as never);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "five_hour" });
		expect(input?.fiveHour).toEqual({ utilization: 100, resetMs: R5 * 1000 });
		expect(input?.sevenDay).toEqual({ utilization: 30, resetMs: R7 * 1000 });
		expect(input?.overage).toBeNull();
	});
});

// ── fix1 part C: cooldown answers, unknown resets, family replay ───────────

const CLAIM = "anthropic-ratelimit-unified-representative-claim";

function refusalWith(claim: string, resetS: number): Headers {
	const h = realHeaders();
	h.set(CLAIM, claim);
	h.set("anthropic-ratelimit-unified-reset", String(resetS));
	return h;
}

describe("buildLocalCooldownResponse", () => {
	it("stays a 429 but claims no limit and invents no reset", async () => {
		const cooldownEnd = NOW + 7 * 60_000;
		const res = buildLocalCooldownResponse(
			{
				fiveHour: { utilization: 42, resetMs: R5 * 1000 },
				sevenDay: { utilization: 77, resetMs: R7 * 1000 },
				overage: null,
			},
			cooldownEnd,
			NOW,
		);
		expect(res.status).toBe(429);
		const h = res.headers;
		expect(h.get("content-type")).toBe("application/json");
		expect(h.get("x-should-retry")).toBe("true");
		expect(h.get("retry-after")).toBe(String(7 * 60));
		expect(h.get("anthropic-ratelimit-unified-status")).toBeNull();
		expect(h.get(CLAIM)).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-reset")).toBeNull();
		// Window statuses come from the readings only.
		expect(h.get("anthropic-ratelimit-unified-5h-status")).toBe("allowed");
		expect(h.get("anthropic-ratelimit-unified-5h-reset")).toBe(String(R5));
		expect(h.get("anthropic-ratelimit-unified-7d-status")).toBe(
			"allowed_warning",
		);
		expectGrammar(h);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("rate_limit_error");
	});

	it("sends the default retry-after and no window headers without readings", () => {
		const res = buildLocalCooldownResponse(null, null, NOW);
		const h = res.headers;
		expect(h.get("retry-after")).toBe("60");
		expect(h.get("anthropic-ratelimit-unified-status")).toBeNull();
		expect(h.get(CLAIM)).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-5h-status")).toBeNull();
		expect(h.get("anthropic-ratelimit-unified-7d-status")).toBeNull();
	});
});

describe("exhausted limits with an unknown reset", () => {
	it("binds an exhausted family whose usage row has no reset", () => {
		usageCache.set("acc-a", {
			five_hour: {
				utilization: 40,
				resets_at: new Date(R5 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 50,
				resets_at: new Date(R7 * 1000).toISOString(),
			},
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: null,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never);
		const res = localLimitResponseForAccount(
			{ id: "acc-a" },
			{ family: "fable", familyResetMs: null, now: NOW },
		);
		const h = res.headers;
		expect(h.get(CLAIM)).toBe("seven_day_fable");
		expect(h.get("anthropic-ratelimit-unified-status")).toBe("rejected");
		expect(h.get("anthropic-ratelimit-unified-reset")).toBeNull();
		expect(h.get("retry-after")).toBe("60");
	});

	it("binds a family that admission holds out with no reset and no usage row", () => {
		usageCache.set(
			"acc-a",
			anthropicUsage({ five: 40, seven: 50, fable: null }) as never,
		);
		const res = localLimitResponseForAccount(
			{ id: "acc-a" },
			{ family: "fable", familyResetMs: null, now: NOW },
		);
		expect(res.headers.get(CLAIM)).toBe("seven_day_fable");
		expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBeNull();
	});

	it("counts a five-hour window at 100 % with no reset as full, as admission does", () => {
		usageCache.set(
			"acc-a",
			anthropicUsage({ five: 100, fiveReset: null, seven: 50 }) as never,
		);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "five_hour" });
		expect(input?.resetMs).toBeNull();
		if (!input) throw new Error("no readings");
		const res = buildLocalLimitResponse(input, NOW);
		expect(res.headers.get("anthropic-ratelimit-unified-5h-status")).toBe(
			"rejected",
		);
	});

	it("keeps a full window's known reset over a full window with no reset", () => {
		usageCache.set(
			"acc-a",
			anthropicUsage({ five: 100, fiveReset: null, seven: 100 }) as never,
		);
		const input = localLimitInputForAccount("acc-a", { now: NOW });
		expect(input?.binding).toEqual({ kind: "seven_day" });
		expect(input?.resetMs).toBe(R7 * 1000);
		if (!input) throw new Error("no readings");
		const res = buildLocalLimitResponse(input, NOW);
		expect(res.headers.get("anthropic-ratelimit-unified-5h-status")).toBe(
			"rejected",
		);
		expect(res.headers.get("anthropic-ratelimit-unified-7d-status")).toBe(
			"rejected",
		);
	});
});

describe("replay against the current binding", () => {
	it("does not replay one family's refusal for another family", async () => {
		rememberLimitRefusal(
			"acc-a",
			{
				status: 429,
				statusText: "Too Many Requests",
				headers: refusalWith("seven_day_opus", R7),
				body: REAL_BODY,
			},
			NOW,
		);
		expect(getCachedLimitRefusal("acc-a", NOW)?.claim).toBe("seven_day_opus");
		const res = localLimitResponseForAccount(
			{ id: "acc-a" },
			{ family: "fable", familyResetMs: R7 * 1000, now: NOW },
		);
		expect(res.headers.get(CLAIM)).toBe("seven_day_fable");
		expect(res.headers.get("request-id")).toBeNull();
		expect(new Uint8Array(await res.arrayBuffer())).not.toEqual(REAL_BODY);
	});

	it("replays a family refusal for the same family", async () => {
		rememberLimitRefusal(
			"acc-a",
			{
				status: 429,
				statusText: "Too Many Requests",
				headers: refusalWith("seven_day_fable", R7),
				body: REAL_BODY,
			},
			NOW,
		);
		const res = localLimitResponseForAccount(
			{ id: "acc-a" },
			{ family: "Fable", familyResetMs: R7 * 1000, now: NOW },
		);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(REAL_BODY);
		expect(res.headers.get(CLAIM)).toBe("seven_day_fable");
	});

	it("does not replay a family refusal for a request with no family", () => {
		rememberLimitRefusal(
			"acc-a",
			{
				status: 429,
				statusText: "",
				headers: refusalWith("seven_day_opus", R7),
				body: REAL_BODY,
			},
			NOW,
		);
		usageCache.set("acc-a", anthropicUsage({ five: 100, seven: 50 }) as never);
		const res = localLimitResponseForAccount({ id: "acc-a" }, { now: NOW });
		expect(res.headers.get(CLAIM)).toBe("five_hour");
		expect(res.headers.get("request-id")).toBeNull();
	});

	it("does not replay a five-hour refusal once the weekly limit binds", () => {
		rememberLimitRefusal(
			"acc-a",
			{ status: 429, statusText: "", headers: realHeaders(), body: REAL_BODY },
			NOW,
		);
		usageCache.set("acc-a", anthropicUsage({ five: 100, seven: 100 }) as never);
		const res = localLimitResponseForAccount({ id: "acc-a" }, { now: NOW });
		expect(res.headers.get(CLAIM)).toBe("seven_day");
		expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBe(
			String(R7),
		);
	});

	it("replays a seven_day_overage_included refusal when the weekly limit binds", async () => {
		rememberLimitRefusal(
			"acc-a",
			{
				status: 429,
				statusText: "",
				headers: refusalWith("seven_day_overage_included", R7),
				body: REAL_BODY,
			},
			NOW,
		);
		usageCache.set("acc-a", anthropicUsage({ five: 30, seven: 100 }) as never);
		const res = localLimitResponseForAccount({ id: "acc-a" }, { now: NOW });
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(REAL_BODY);
	});
});
