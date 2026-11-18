import {
	getModelFamily,
	isAccountAvailable,
	probeBackoffRank,
} from "@better-ccflare/core";
import type {
	ForecastAdvisor,
	MoveAdvice,
	PlacementAdvice,
} from "@better-ccflare/forecast";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	AccountLimit,
	LimitBlockedAccount,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
	StrategyUsageWindow,
} from "@better-ccflare/types";
import { isPeekAvailable, wouldAutoUnpause } from "./peek-availability";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Two new sessions that start this close together alternate between
 * near-tied accounts. Same window as SessionAffinityStrategy's recent-pick
 * spread.
 */
export const SESSION_PACE_RECENT_PICK_WINDOW_MS = 500;

/**
 * After a session is placed on an account with no running 5-hour window, or
 * the account serves a response, the open-session rule leaves that account
 * alone this long. The strategy cannot see when usage data was fetched. With
 * the default poll (90 s ±20%, at most 108 s plus the fetch itself) the data
 * has usually been refreshed by then; a longer configured interval, a slow
 * fetch or a failure backoff can leave it older, and the rule then applies
 * again on data that predates the window.
 */
export const SESSION_PACE_OPEN_SESSION_HOLD_MS = 120_000;

const MAX_SESSIONS = 10_000;

export interface SessionPaceOptions {
	/** New sessions skip an account whose five_hour utilization is at or above this. */
	fiveHourGuardPct: number;
	/** A request skips an account whose weekly window for the request's model family is at or above this. */
	familyGuardPct: number;
	/** Deficits this close (in points) count as a near-tie. */
	tieBandPct: number;
	/** A session mapping expires after this long without a request. */
	idleMs: number;
	/** Local days with ISO weekday <= this count toward the weekly pace (5 = Monday to Friday, 7 = every day). */
	workDays: number;
}

export const SESSION_PACE_DEFAULTS: Readonly<SessionPaceOptions> = {
	fiveHourGuardPct: 90,
	familyGuardPct: 90,
	tieBandPct: 10,
	idleMs: 60 * 60 * 1000,
	workDays: 5,
};

/** What the weekly pace counts: local days with ISO weekday <= workDays, in timeZone. */
export interface PaceBasis {
	workDays: number;
	timeZone: string;
}

/** The IANA zone this process resolves as local (TZ, else the system zone). */
export function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string, t: number) {
	let fmt = zoneFormatters.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		zoneFormatters.set(timeZone, fmt);
	}
	const p: Record<string, number> = {};
	for (const part of fmt.formatToParts(t)) {
		if (part.type !== "literal") p[part.type] = Number(part.value);
	}
	return {
		year: p.year,
		month: p.month,
		day: p.day,
		hour: p.hour === 24 ? 0 : p.hour,
		minute: p.minute,
		second: p.second,
	};
}

/** Offset of timeZone from UTC at instant t, in ms (positive east of UTC). */
function zoneOffsetMs(timeZone: string, t: number): number {
	const w = wallClock(timeZone, t);
	const wallAsUtc = Date.UTC(
		w.year,
		w.month - 1,
		w.day,
		w.hour,
		w.minute,
		w.second,
	);
	return wallAsUtc - Math.floor(t / 1000) * 1000;
}

/** The local calendar day containing t, named by its UTC midnight. */
function localDay(timeZone: string, t: number): number {
	const w = wallClock(timeZone, t);
	return Date.UTC(w.year, w.month - 1, w.day);
}

/**
 * The first instant of the local calendar day dayUtc (a UTC midnight naming
 * that date): its local midnight, or, where a DST change skips midnight, the
 * first instant whose local date is that day.
 */
function localDayStart(timeZone: string, dayUtc: number): number {
	const a = dayUtc - zoneOffsetMs(timeZone, dayUtc - DAY_MS);
	const b = dayUtc - zoneOffsetMs(timeZone, dayUtc + DAY_MS);
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (const c of [lo, hi]) {
		const w = wallClock(timeZone, c);
		if (
			Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) ===
			dayUtc
		)
			return c;
	}
	// Midnight skipped: binary-search the second the local date turns over.
	let before = lo;
	let after = hi;
	while (after - before > 1000) {
		const mid = before + Math.floor((after - before) / 2000) * 1000;
		if (localDay(timeZone, mid) >= dayUtc) after = mid;
		else before = mid;
	}
	return after;
}

/** Milliseconds of [from, to) that fall on local work days. */
function workMs(from: number, to: number, basis: PaceBasis): number {
	if (to <= from) return 0;
	let day = localDay(basis.timeZone, from);
	let dayStart = localDayStart(basis.timeZone, day);
	let total = 0;
	for (let i = 0; i < 400; i++) {
		const nextDay = day + DAY_MS;
		const dayEnd = localDayStart(basis.timeZone, nextDay);
		const isoWeekday = new Date(day).getUTCDay() || 7;
		if (isoWeekday <= basis.workDays) {
			total += Math.max(0, Math.min(to, dayEnd) - Math.max(from, dayStart));
		}
		if (dayEnd >= to) break;
		day = nextDay;
		dayStart = dayEnd;
	}
	return total;
}

/**
 * How far an account is behind (positive) or ahead of (negative) an even
 * spend of its all-models weekly window: the share of the window's work time
 * that has elapsed minus the share that has been used. The window starts
 * `resetsAt` minus 7 days; work time is the part of it on local days whose
 * ISO weekday is at most `basis.workDays`. Seven work days, or a window
 * with no work time, use the calendar share.
 */
export function weeklyPaceDeficit(
	window: StrategyUsageWindow | null,
	now: number,
	basis: PaceBasis = {
		workDays: SESSION_PACE_DEFAULTS.workDays,
		timeZone: localTimeZone(),
	},
): number {
	if (!window || window.resetsAt === null) return 0;
	const windowStart = window.resetsAt - WEEK_MS;
	const total =
		basis.workDays >= 7 ? 0 : workMs(windowStart, window.resetsAt, basis);
	const share =
		total > 0
			? (workMs(windowStart, now, basis) * 100) / total
			: ((now - windowStart) / WEEK_MS) * 100;
	const elapsedPct = Math.min(100, Math.max(0, share));
	return elapsedPct - window.utilization;
}

/**
 * First 8 characters of the session id inside a `metadata.user_id` value.
 * Claude Code sends either a JSON object with `session_id` or a
 * `user_…_account_…_session_<id>` string; anything else is treated as a bare
 * session id. Never returns the account part.
 */
export function sessionLogTag(clientSessionId: string): string {
	let sessionPart = clientSessionId;
	const trimmed = clientSessionId.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { session_id?: unknown };
			sessionPart =
				typeof parsed.session_id === "string" ? parsed.session_id : "";
		} catch {
			sessionPart = "";
		}
	} else {
		const match = /_session_([^_]+)$/.exec(clientSessionId);
		if (match) sessionPart = match[1];
		else if (clientSessionId.includes("_account_")) sessionPart = "";
	}
	return sessionPart ? sessionPart.slice(0, 8) : "unknown";
}

interface Candidate {
	account: Account;
	probeRank: number;
	deficit: number;
	fiveHourUtil: number | null;
	fiveHourGuarded: boolean;
	/** unknown: no usage data, or data without a 5-hour window. */
	fiveHourState: "running" | "not-running" | "unknown";
	/** No running window and not held after a recent placement or response. */
	opensWindow: boolean;
	familyUtil: number | null;
	familyGuarded: boolean;
	hasUsage: boolean;
	/** 5-hour or weekly limit used up with its reset ahead (forecast hard filter). */
	out: boolean;
}

interface Mapping {
	accountId: string;
	accountName: string;
	lastSeenAt: number;
}

type Rule =
	| "only-candidate"
	| "probe-backoff"
	| "family-guard"
	| "family-guard-all-guarded"
	| "five-hour-guard"
	| "open-session"
	| "priority"
	| "pace-deficit"
	| "near-tie-alternation"
	| "cold-start"
	| "account-id";

type ForecastStep =
	| { kind: "place"; advice: PlacementAdvice }
	| { kind: "move"; advice: MoveAdvice; fromName: string; toName: string };

interface Plan {
	ordered: Account[];
	/** Set when this request places the session fresh (no live mapping used). */
	placement: { rule: Rule | PlacementAdvice["rule"]; reason: string } | null;
	/** Set when the family guard demoted the session's mapped account. */
	familyMove: { fromName: string; rule: Rule; reason: string } | null;
	/** Set when the forecast advisor placed (new or cold session) or moved the session. */
	forecast: ForecastStep | null;
	family: string | null;
	candidates: Candidate[];
}

interface RoutedRequest {
	clientId: string | null;
	family: string | null;
	familyMove: boolean;
	candidates: Candidate[];
	/** The forecast placement or move this request carries, and its advised account. */
	forecast: { kind: "place" | "move"; accountId: string } | null;
}

const ADVISOR_ERROR_LOG_INTERVAL_MS = 60_000;

function points(n: number): string {
	return Number.isFinite(n) ? n.toFixed(1) : String(n);
}

/**
 * Session-pace strategy ("weekly pace with a 5-hour guard").
 *
 * Each client session (`metadata.user_id`) sticks to one account. A new
 * session goes to the available account that is furthest behind an even
 * spend of its all-models weekly window. Placement order, highest first:
 * availability; probe-backoff rank; the model-family guard, then the 5-hour
 * guard; an account with no running 5-hour window (open-session rule);
 * configured priority; weekly pace deficit; near-tie alternation.
 *
 * When another account serves a request this strategy routed (failover or a
 * family-guard move), the session rebinds to it and stays there. A mapping
 * expires after `idleMs` without a request.
 */
/** Latest reset among an account's limits; null when any reset is unknown. */
function usableAgainAt(limits: AccountLimit[]): number | null {
	let latest = Number.NEGATIVE_INFINITY;
	for (const limit of limits) {
		if (limit.resetAt === null) return null;
		latest = Math.max(latest, limit.resetAt);
	}
	return Number.isFinite(latest) ? latest : null;
}

function limitLabel(limit: AccountLimit): string {
	if (limit.kind === "five_hour") return "5h";
	if (limit.kind === "family") return limit.family ?? "family";
	return limit.kind;
}

function isoOrUnknown(ms: number | null): string {
	return ms === null ? "unknown" : new Date(ms).toISOString();
}

export class SessionPaceStrategy implements LoadBalancingStrategy {
	readonly options: SessionPaceOptions;
	/** Work days from options; the zone is read once, here, unless injected. */
	readonly paceBasis: PaceBasis;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionPaceStrategy");
	private sessions = new Map<string, Mapping>();
	private lastPickedAt = new Map<string, number>();
	private lastPickSeq = new Map<string, number>();
	private pickSeq = 0;
	/** Per account: until when the open-session rule leaves it alone. */
	private openSessionHeldUntil = new Map<string, number>();
	private routed = new WeakMap<RequestMeta, RoutedRequest>();
	private advisor: ForecastAdvisor | null = null;
	private advisorErrorLoggedAt = Number.NEGATIVE_INFINITY;
	/** Set by ask() when an advisor call threw during the current plan. */
	private advisorFailed = false;

	/** `internal.timeZone` replaces the process's local zone (tests). */
	constructor(
		options: Partial<SessionPaceOptions> = {},
		internal: { timeZone?: string } = {},
	) {
		this.options = { ...SESSION_PACE_DEFAULTS, ...options };
		this.paceBasis = {
			workDays: this.options.workDays,
			timeZone: internal.timeZone ?? localTimeZone(),
		};
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	/**
	 * Route by the interruption forecast. Without an advisor, or when it
	 * gives no advice or throws, the strategy behaves exactly as before.
	 */
	setForecastAdvisor(advisor: ForecastAdvisor | null): void {
		this.advisor = advisor;
	}

	peek(accounts: Account[], meta?: RequestMeta): string | null {
		const now = Date.now();
		const available = accounts.filter(
			(a) =>
				isAccountAvailable(a, now) ||
				(isPeekAvailable(a, now) &&
					isAccountAvailable({ ...a, paused: false }, now)),
		);
		if (available.length === 0) return null;
		const plan = this.plan(available, meta ?? null, now);
		return plan.ordered[0]?.id ?? null;
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();
		this.autoUnpauseElapsedAccounts(accounts, now);
		const available = accounts.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		const plan = this.plan(available, meta, now);
		const clientId = meta.clientSessionId || null;
		const first = plan.ordered[0];

		if (plan.placement || plan.familyMove || plan.forecast?.kind === "move") {
			const placed = plan.candidates.find((c) => c.account.id === first.id);
			if (placed?.fiveHourState === "not-running")
				this.holdOpenSession(first.id, now);
		}

		if (plan.placement) {
			this.lastPickedAt.set(first.id, now);
			this.lastPickSeq.set(first.id, ++this.pickSeq);
			if (clientId === null && plan.placement.rule === "open-session") {
				// Without a client session every request is placed afresh, so
				// only the open-session rule is logged (held after one line).
				this.log.info(
					`session-pace place session=none account=${first.name} rule=${plan.placement.rule} reason=${plan.placement.reason} ${this.describe(plan.candidates, plan.family)}`,
				);
			}
			if (clientId !== null) {
				const previous = this.sessions.get(clientId);
				const live = previous && !this.isExpired(previous, now);
				// A forecast placement of a mapped session re-places a cold one.
				if (!live || plan.forecast?.kind === "place") {
					this.sessions.delete(clientId);
					this.evictOldestIfFull();
					this.sessions.set(clientId, {
						accountId: first.id,
						accountName: first.name,
						lastSeenAt: now,
					});
					this.log.info(
						`session-pace place session=${sessionLogTag(clientId)} account=${first.name} rule=${plan.placement.rule} reason=${plan.placement.reason} ${this.describe(plan.candidates, plan.family)}`,
					);
				} else {
					// Mapped account unavailable: order a failover, keep the
					// mapping until another account serves (onRequestServed).
					this.touch(clientId, previous, now);
					this.log.info(
						`session-pace failover-order session=${sessionLogTag(clientId)} mapped=${previous.accountName} unavailable next=${first.name} rule=${plan.placement.rule} reason=${plan.placement.reason} ${this.describe(plan.candidates, plan.family)}`,
					);
				}
			}
		} else if (clientId !== null) {
			const mapping = this.sessions.get(clientId);
			if (mapping) this.touch(clientId, mapping, now);
			if (plan.familyMove) {
				this.log.info(
					`session-pace family-guard demotes session=${sessionLogTag(clientId)} from=${plan.familyMove.fromName} next=${first.name} rule=${plan.familyMove.rule} reason=${plan.familyMove.reason} family=${plan.family} ${this.describe(plan.candidates, plan.family)}`,
				);
			}
			if (plan.forecast?.kind === "move") {
				const { advice, fromName, toName } = plan.forecast;
				this.log.info(
					`session-pace move session=${sessionLogTag(clientId)} from=${fromName} to=${toName} rule=${advice.rule} reason=${advice.reason} gain=${points(advice.gainPoints)} cost=${points(advice.costPoints)}`,
				);
			}
		}

		this.routed.set(meta, {
			clientId,
			family: plan.family,
			familyMove: plan.familyMove !== null,
			candidates: plan.candidates,
			forecast:
				plan.forecast && clientId !== null
					? { kind: plan.forecast.kind, accountId: first.id }
					: null,
		});
		return plan.ordered;
	}

	onRequestServed(meta: RequestMeta, account: Account, status: number): void {
		const routed = this.routed.get(meta);
		if (!routed) return;
		this.routed.delete(meta);
		if (status < 200 || status >= 400) return;

		const now = Date.now();
		this.holdOpenSession(account.id, now);
		if (routed.clientId === null) return;
		const clientId = routed.clientId;
		const advised =
			routed.forecast && routed.forecast.accountId === account.id
				? routed.forecast
				: null;
		const mapping = this.sessions.get(clientId);
		if (mapping && mapping.accountId === account.id) {
			this.touch(clientId, mapping, now);
			if (advised) this.notifyApplied(advised.kind, clientId, account.id, now);
			return;
		}
		const fromName = mapping?.accountName ?? "none";
		this.sessions.delete(clientId);
		this.evictOldestIfFull();
		this.sessions.set(clientId, {
			accountId: account.id,
			accountName: account.name,
			lastSeenAt: now,
		});
		if (advised) {
			// The move line was logged when the request was routed.
			this.notifyApplied(advised.kind, clientId, account.id, now);
			return;
		}
		const rule = routed.familyMove ? "family-guard" : "failover";
		this.log.info(
			`session-pace rebind session=${sessionLogTag(routed.clientId)} from=${fromName} to=${account.name} rule=${rule} ${this.describe(routed.candidates, routed.family)}`,
		);
	}

	/**
	 * Pure ordering for one request: no state is written. select() and peek()
	 * both use it, so they agree by construction.
	 */
	private plan(
		available: Account[],
		meta: RequestMeta | null,
		now: number,
	): Plan {
		if (this.advisor === null)
			return this.planWith(available, meta, now, false);
		this.advisorFailed = false;
		const advised = this.planWith(available, meta, now, true);
		// Any advisor failure while planning: today's rules for the whole request.
		return this.advisorFailed
			? this.planWith(available, meta, now, false)
			: advised;
	}

	private planWith(
		available: Account[],
		meta: RequestMeta | null,
		now: number,
		useAdvisor: boolean,
	): Plan {
		const model = meta?.routingModel ?? null;
		const family = model ? getModelFamily(model) : null;
		const candidates = available.map((a) =>
			this.describeCandidate(a, family, now),
		);
		const byId = new Map(candidates.map((c) => [c.account.id, c]));
		const sorted = [...candidates].sort((x, y) => this.compareNew(x, y));

		const clientId = meta?.clientSessionId || null;
		const mapping = clientId !== null ? this.sessions.get(clientId) : undefined;

		// Forecast routing applies to client sessions only. Under advice the
		// session's cache lifetime (unknown: idleMs), not idleMs, tells a live
		// session from a cold one; a new or cold session is placed by the advice.
		const advising = useAdvisor && this.advisor !== null && clientId !== null;
		const cold =
			advising &&
			clientId !== null &&
			mapping !== undefined &&
			this.isCold(clientId, mapping, now);
		const liveMapping =
			mapping && (advising && !cold ? true : !this.isExpired(mapping, now))
				? mapping
				: undefined;
		const mapped = liveMapping ? byId.get(liveMapping.accountId) : undefined;

		if (advising && (!mapping || cold)) {
			const advised = this.forecastPlacement(sorted, candidates, now);
			if (advised) {
				const landsElsewhere =
					mapping !== undefined &&
					advised.order[0].account.id !== mapping.accountId;
				return {
					ordered: advised.order.map((c) => c.account),
					placement: {
						rule: advised.advice.rule,
						reason: landsElsewhere
							? `cold:${advised.advice.reason}`
							: advised.advice.reason,
					},
					familyMove: null,
					forecast: { kind: "place", advice: advised.advice },
					family,
					candidates,
				};
			}
		}

		if (mapped) {
			if (family !== null && mapped.familyGuarded) {
				const movers = sorted.filter(
					(c) => !c.familyGuarded && c.probeRank <= mapped.probeRank,
				);
				if (movers.length > 0) {
					const moverIds = new Set(movers.map((c) => c.account.id));
					const rest = sorted.filter((c) => !moverIds.has(c.account.id));
					return {
						ordered: [...movers, ...rest].map((c) => c.account),
						placement: null,
						familyMove: {
							fromName: mapped.account.name,
							...(movers.length > 1
								? this.decidingRule(movers[0], movers[1])
								: { rule: "only-candidate" as const, reason: "single" }),
						},
						forecast: null,
						family,
						candidates,
					};
				}
			}
			const target =
				advising && !cold && clientId !== null
					? this.forecastMoveTarget(clientId, mapped, byId, now)
					: null;
			if (target) {
				return {
					ordered: [
						target.candidate,
						mapped,
						...sorted.filter((c) => c !== mapped && c !== target.candidate),
					].map((c) => c.account),
					placement: null,
					familyMove: null,
					forecast: {
						kind: "move",
						advice: target.advice,
						fromName: mapped.account.name,
						toName: target.candidate.account.name,
					},
					family,
					candidates,
				};
			}
			return {
				ordered: [mapped, ...sorted.filter((c) => c !== mapped)].map(
					(c) => c.account,
				),
				placement: null,
				familyMove: null,
				forecast: null,
				family,
				candidates,
			};
		}

		const { order, rule, reason } = this.placeNew(sorted, candidates, now);
		return {
			ordered: order.map((c) => c.account),
			placement: { rule, reason },
			familyMove: null,
			forecast: null,
			family,
			candidates,
		};
	}

	/** Advisor call that never throws: a failure counts as no advice. */
	private ask<T>(call: (advisor: ForecastAdvisor) => T): T | null {
		const advisor = this.advisor;
		if (advisor === null || this.advisorFailed) return null;
		try {
			return call(advisor) ?? null;
		} catch (error) {
			this.advisorFailed = true;
			const now = Date.now();
			if (now - this.advisorErrorLoggedAt >= ADVISOR_ERROR_LOG_INTERVAL_MS) {
				this.advisorErrorLoggedAt = now;
				this.log.warn(
					`session-pace forecast advisor failed, using session-pace rules: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return null;
		}
	}

	/** Mapped, and its cache lifetime (unknown: idleMs) has passed since its last request. */
	private isCold(clientId: string, mapping: Mapping, now: number): boolean {
		const ttl = this.ask((a) => a.cacheTtlMs(clientId));
		const lifetime =
			ttl !== null && Number.isFinite(ttl) && ttl >= 0
				? ttl
				: this.options.idleMs;
		return now - mapping.lastSeenAt >= lifetime;
	}

	/**
	 * New or cold session under forecast advice. Hard filters first: the best
	 * probe-backoff rank, the family guard, never an account that is out. The
	 * first tier holding a filtered candidate wins; inside it today's ranking
	 * decides. The 5-hour guard is no filter here, only a tie-break in a tier.
	 */
	private forecastPlacement(
		sorted: Candidate[],
		all: Candidate[],
		now: number,
	): { order: Candidate[]; advice: PlacementAdvice } | null {
		const advice = this.ask((a) => a.placeNewSession(now));
		if (advice === null || !Array.isArray(advice.tiers)) return null;
		const bestRank = Math.min(...sorted.map((c) => c.probeRank));
		const eligible = sorted.filter(
			(c) => c.probeRank === bestRank && !c.familyGuarded && !c.out,
		);
		for (const tier of advice.tiers) {
			const ids = new Set(tier);
			const inTier = eligible.filter((c) => ids.has(c.account.id));
			if (inTier.length === 0) continue;
			const { order } = this.placeNew(inTier, all, now);
			return {
				order: [...order, ...sorted.filter((c) => !order.includes(c))],
				advice,
			};
		}
		return null;
	}

	/** A planned move of a live session, if its target may take it. */
	private forecastMoveTarget(
		clientId: string,
		mapped: Candidate,
		byId: Map<string, Candidate>,
		now: number,
	): { candidate: Candidate; advice: MoveAdvice } | null {
		const advice = this.ask((a) => a.moveFor(clientId, now));
		if (advice === null) return null;
		if (advice.from !== mapped.account.id || advice.to === advice.from)
			return null;
		const candidate = byId.get(advice.to);
		if (!candidate || candidate.out || candidate.familyGuarded) return null;
		return { candidate, advice };
	}

	private notifyApplied(
		kind: "place" | "move",
		clientId: string,
		accountId: string,
		now: number,
	): void {
		this.advisorFailed = false;
		this.ask((a) => a.applied(kind, clientId, accountId, now));
	}

	private placeNew(
		sorted: Candidate[],
		all: Candidate[],
		now: number,
	): { order: Candidate[]; rule: Rule; reason: string } {
		const leader = sorted[0];
		if (sorted.length === 1) {
			return { order: sorted, rule: "only-candidate", reason: "single" };
		}
		const sameTier = (c: Candidate) =>
			c.probeRank === leader.probeRank &&
			c.familyGuarded === leader.familyGuarded &&
			c.fiveHourGuarded === leader.fiveHourGuarded &&
			c.opensWindow === leader.opensWindow &&
			c.account.priority === leader.account.priority &&
			(!leader.familyGuarded || c.familyUtil === leader.familyUtil);

		if (!all.some((c) => c.hasUsage)) {
			// Rule 9: no usage data anywhere — rotate through the leading tier,
			// least recently picked first, whatever the spacing.
			const tier = sorted.filter(sameTier);
			let pick = tier[0];
			for (const c of tier) {
				if (this.pickOrder(c) < this.pickOrder(pick)) pick = c;
			}
			return {
				order: [pick, ...sorted.filter((c) => c !== pick)],
				rule: "cold-start",
				reason: "no-usage-data",
			};
		}

		const runnerUp = sorted[1];
		if (
			!leader.familyGuarded &&
			sameTier(runnerUp) &&
			Math.abs(leader.deficit - runnerUp.deficit) <= this.options.tieBandPct &&
			now - this.pickedAt(leader) < SESSION_PACE_RECENT_PICK_WINDOW_MS &&
			this.pickOrder(runnerUp) < this.pickOrder(leader)
		) {
			return {
				order: [runnerUp, leader, ...sorted.slice(2)],
				rule: "near-tie-alternation",
				reason: `leader-${leader.account.name}-picked-${now - this.pickedAt(leader)}ms-ago`,
			};
		}

		const { rule, reason } = this.decidingRule(leader, runnerUp);
		return { order: sorted, rule, reason };
	}

	/** Which ordering key separated the leader from the runner-up. */
	private decidingRule(
		leader: Candidate,
		runnerUp: Candidate,
	): { rule: Rule; reason: string } {
		if (leader.probeRank !== runnerUp.probeRank)
			return {
				rule: "probe-backoff",
				reason: `${runnerUp.account.name}-backed-off`,
			};
		if (leader.familyGuarded !== runnerUp.familyGuarded)
			return {
				rule: "family-guard",
				reason: `${runnerUp.account.name}-guarded`,
			};
		if (leader.familyGuarded && leader.familyUtil !== runnerUp.familyUtil)
			return {
				rule: "family-guard-all-guarded",
				reason: "lowest-family-utilization",
			};
		if (leader.fiveHourGuarded !== runnerUp.fiveHourGuarded)
			return {
				rule: "five-hour-guard",
				reason: `${runnerUp.account.name}-guarded`,
			};
		if (leader.opensWindow !== runnerUp.opensWindow)
			return { rule: "open-session", reason: "no-five-hour-window" };
		if (leader.account.priority !== runnerUp.account.priority)
			return { rule: "priority", reason: "higher-priority" };
		if (leader.deficit !== runnerUp.deficit)
			return { rule: "pace-deficit", reason: "largest-deficit" };
		return { rule: "account-id", reason: "full-tie" };
	}

	/** Placement order for a new session (rules 2, 3 and 8 under the ordering ruling). */
	private compareNew(x: Candidate, y: Candidate): number {
		if (x.probeRank !== y.probeRank) return x.probeRank - y.probeRank;
		if (x.familyGuarded !== y.familyGuarded) return x.familyGuarded ? 1 : -1;
		if (x.familyGuarded && y.familyGuarded) {
			const fx = x.familyUtil ?? 0;
			const fy = y.familyUtil ?? 0;
			if (fx !== fy) return fx - fy;
		}
		if (x.fiveHourGuarded !== y.fiveHourGuarded)
			return x.fiveHourGuarded ? 1 : -1;
		if (x.opensWindow !== y.opensWindow) return x.opensWindow ? -1 : 1;
		if (x.account.priority !== y.account.priority)
			return x.account.priority - y.account.priority;
		if (x.deficit !== y.deficit) return y.deficit - x.deficit;
		return x.account.id < y.account.id
			? -1
			: x.account.id > y.account.id
				? 1
				: 0;
	}

	private describeCandidate(
		account: Account,
		family: string | null,
		now: number,
	): Candidate {
		const store = this.store;
		const weekly =
			store?.getAccountWeeklyWindow?.(account.id, account.provider) ?? null;
		const fiveHour =
			store?.getAccountFiveHourWindow?.(account.id, account.provider) ?? null;
		const fiveHourLive =
			fiveHour !== null && fiveHour.resetsAt !== null && fiveHour.resetsAt > now
				? fiveHour.utilization
				: null;
		const fiveHourState =
			fiveHour === null
				? "unknown"
				: fiveHourLive === null
					? "not-running"
					: "running";

		let familyUtil: number | null = null;
		if (family !== null) {
			const rows =
				store?.getAccountModelFamilyWindows?.(
					account.id,
					account.provider,
					family,
				) ?? [];
			for (const row of rows) {
				if (row.resetsAt === null || row.resetsAt <= now) continue;
				familyUtil =
					familyUtil === null
						? row.utilization
						: Math.max(familyUtil, row.utilization);
			}
		}

		return {
			account,
			probeRank: probeBackoffRank(account.id, now),
			deficit: weeklyPaceDeficit(weekly, now, this.paceBasis),
			fiveHourUtil: fiveHourLive,
			fiveHourGuarded:
				fiveHourLive !== null && fiveHourLive >= this.options.fiveHourGuardPct,
			fiveHourState,
			opensWindow:
				fiveHourState === "not-running" &&
				now >= (this.openSessionHeldUntil.get(account.id) ?? 0),
			familyUtil,
			familyGuarded:
				familyUtil !== null && familyUtil >= this.options.familyGuardPct,
			hasUsage: weekly !== null || fiveHour !== null,
			out:
				(fiveHourLive !== null && fiveHourLive >= 100) ||
				(weekly !== null &&
					weekly.resetsAt !== null &&
					weekly.resetsAt > now &&
					weekly.utilization >= 100),
		};
	}

	/**
	 * Every account that could serve the request is out on limits: pick the
	 * one usable again first. Nothing is forwarded to it (upstream would serve
	 * a full account from extra usage); the proxy answers locally with that
	 * account's limit 429, so its retry-after is the soonest any account frees
	 * up. An account is usable again at the latest reset among its limits; an
	 * unknown reset sorts after every known one. Ties go to the lower priority
	 * number, then the account name. Session mappings are left alone. The log
	 * line keeps its `place ... rule=all-exhausted` shape for log readers; it
	 * names the account the answer describes.
	 */
	selectWhenAllLimited(
		blocked: LimitBlockedAccount[],
		meta: RequestMeta,
	): Account | null {
		if (blocked.length === 0) return null;
		// An earlier select() for this request may have recorded it; the rule
		// must not let the served response rebind the session.
		this.routed.delete(meta);
		const ranked = blocked
			.map((b) => ({ ...b, usableAt: usableAgainAt(b.limits) }))
			.sort(
				(x, y) =>
					(x.usableAt ?? Number.POSITIVE_INFINITY) -
						(y.usableAt ?? Number.POSITIVE_INFINITY) ||
					(x.account.priority ?? 0) - (y.account.priority ?? 0) ||
					x.account.name.localeCompare(y.account.name),
			);
		const first = ranked[0].account;
		const session = meta.clientSessionId
			? sessionLogTag(meta.clientSessionId)
			: "none";
		const parts = ranked.map(
			(r) =>
				`${r.account.name}(usable=${isoOrUnknown(r.usableAt)} limits=${r.limits
					.map((l) => `${limitLabel(l)}@${isoOrUnknown(l.resetAt)}`)
					.join(",")})`,
		);
		this.log.info(
			`session-pace place session=${session} account=${first.name} rule=all-exhausted reason=earliest-reset candidates=[${parts.join("; ")}]`,
		);
		return first;
	}

	private describe(candidates: Candidate[], family: string | null): string {
		const parts = candidates.map((c) => {
			const deficit = `${c.deficit >= 0 ? "+" : ""}${c.deficit.toFixed(1)}`;
			const fiveHour =
				c.fiveHourState === "running" ? `${c.fiveHourUtil}%` : c.fiveHourState;
			const fam =
				family === null
					? ""
					: ` ${family}=${c.familyUtil === null ? "n/a" : `${c.familyUtil}%`}`;
			const flags = [
				c.probeRank > 0 ? "backoff" : null,
				c.familyGuarded ? "family-guarded" : null,
				c.fiveHourGuarded ? "5h-guarded" : null,
				c.fiveHourState === "not-running" && !c.opensWindow
					? "open-held"
					: null,
			]
				.filter(Boolean)
				.join(",");
			return `${c.account.name}(deficit=${deficit} 5h=${fiveHour}${fam}${flags ? ` ${flags}` : ""})`;
		});
		return `work_days=${this.paceBasis.workDays} tz=${this.paceBasis.timeZone} family=${family ?? "-"} candidates=[${parts.join("; ")}]`;
	}

	private holdOpenSession(accountId: string, now: number): void {
		this.openSessionHeldUntil.set(
			accountId,
			now + SESSION_PACE_OPEN_SESSION_HOLD_MS,
		);
	}

	private pickedAt(c: Candidate): number {
		return this.lastPickedAt.get(c.account.id) ?? Number.NEGATIVE_INFINITY;
	}

	private pickOrder(c: Candidate): number {
		return this.lastPickSeq.get(c.account.id) ?? 0;
	}

	private isExpired(mapping: Mapping, now: number): boolean {
		return now - mapping.lastSeenAt >= this.options.idleMs;
	}

	private touch(clientId: string, mapping: Mapping, now: number): void {
		mapping.lastSeenAt = now;
		this.sessions.delete(clientId);
		this.sessions.set(clientId, mapping);
	}

	private evictOldestIfFull(): void {
		while (this.sessions.size >= MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) return;
			this.sessions.delete(oldest);
		}
	}

	/** Mirrors SessionAffinityStrategy.autoUnpauseElapsedAccounts. */
	private autoUnpauseElapsedAccounts(accounts: Account[], now: number): void {
		if (!this.store?.resumeAccount) return;
		for (const account of accounts) {
			if (!wouldAutoUnpause(account, now)) continue;
			this.log.info(
				`Auto-unpausing ${account.name} (pause_reason=${account.pause_reason ?? "null"}) — usage window has reset`,
			);
			this.store.resumeAccount(account.id);
			account.paused = false;
		}
	}
}
