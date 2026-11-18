import { describe, expect, it } from "bun:test";
import { SessionPaceStrategy } from "@better-ccflare/load-balancer";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../../proxy";
import type { LocalLimitAnswer } from "../limit-blocked";
import { type GatedAttempt, rankFullLimitAnswers } from "../proxy-operations";

/**
 * An account the gate skipped on several models (a model and its fallbacks)
 * is usable again as soon as ANY of those routes is: per account the routes
 * combine as the earliest usable one (each route: the latest of its blocking
 * limits), while account-wide limits (five-hour, weekly, cooldown) bind every
 * route. The answer describes the route that binds.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");

function account(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: `rt-${id}`,
		access_token: `token-${id}`,
		expires_at: NOW + 24 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

/** A skip of `acc` on `model`, sent verbatim, whose family resets at `resetMs`. */
function skip(
	acc: Account,
	model: string,
	family: string,
	resetMs: number | null,
): GatedAttempt {
	return {
		account: acc,
		model,
		upstream: true,
		answer: {
			account: acc,
			family,
			familyResetMs: resetMs,
			cooldownResetMs: null,
		},
	};
}

function ctx(): ProxyContext {
	const strategy = new SessionPaceStrategy({}, { timeZone: "Europe/Prague" });
	(strategy as unknown as { log: { info: () => void } }).log.info = () => {};
	return { strategy } as unknown as ProxyContext;
}

const meta = (): RequestMeta =>
	({
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers: new Headers(),
	}) as unknown as RequestMeta;

const pick = (answer: LocalLimitAnswer | null) => ({
	account: answer?.account.id,
	family: answer?.family,
	familyResetMs: answer?.familyResetMs,
});

describe("rankFullLimitAnswers across alternative model routes", () => {
	it("ranks an account by its earliest usable route, and answers with that route", async () => {
		const a = account("a");
		const b = account("b");
		const answer = await rankFullLimitAnswers(
			[
				skip(a, "model-x", "sonnet", NOW + HOUR),
				skip(a, "model-y", "opus", NOW + 5 * HOUR),
				skip(b, "model-y", "opus", NOW + 3 * HOUR),
			],
			ctx(),
			meta(),
			NOW,
		);
		expect(pick(answer)).toEqual({
			account: "a",
			family: "sonnet",
			familyResetMs: NOW + HOUR,
		});
	});

	it("answers with the binding route even when it was skipped last", async () => {
		const a = account("a");
		const b = account("b");
		const answer = await rankFullLimitAnswers(
			[
				skip(a, "model-y", "opus", NOW + 5 * HOUR),
				skip(a, "model-x", "sonnet", NOW + HOUR),
				skip(b, "model-y", "opus", NOW + 3 * HOUR),
			],
			ctx(),
			meta(),
			NOW,
		);
		expect(pick(answer)).toEqual({
			account: "a",
			family: "sonnet",
			familyResetMs: NOW + HOUR,
		});
	});

	it("a route with an unknown reset does not hide an alternative with a known one", async () => {
		const a = account("a");
		const b = account("b");
		const answer = await rankFullLimitAnswers(
			[
				skip(a, "model-x", "sonnet", null),
				skip(a, "model-y", "opus", NOW + HOUR),
				skip(b, "model-y", "opus", NOW + 3 * HOUR),
			],
			ctx(),
			meta(),
			NOW,
		);
		expect(pick(answer)).toEqual({
			account: "a",
			family: "opus",
			familyResetMs: NOW + HOUR,
		});
	});

	it("an account-wide limit binds every route", async () => {
		// a's cooldown runs 4 h: its 1 h route is not usable before then.
		const a = account("a", { rate_limited_until: NOW + 4 * HOUR });
		const b = account("b");
		const answer = await rankFullLimitAnswers(
			[
				skip(a, "model-x", "sonnet", NOW + HOUR),
				skip(a, "model-y", "opus", NOW + 5 * HOUR),
				skip(b, "model-y", "opus", NOW + 3 * HOUR),
			],
			ctx(),
			meta(),
			NOW,
		);
		expect(pick(answer)).toEqual({
			account: "b",
			family: "opus",
			familyResetMs: NOW + 3 * HOUR,
		});
	});
});
