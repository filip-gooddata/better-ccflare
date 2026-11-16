/**
 * Shared types of the interruption forecast.
 *
 * Pure data and interfaces, no IO. Every forecast stream (engine, store,
 * routing, pre-warm, endpoint) compiles against this file; change it only
 * through the orchestrator.
 */

export type AccountId = string;
export type EpochMs = number;

/** Width of one demand bucket. */
export const BUCKET_MS = 5 * 60_000;
export const FIVE_HOUR_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;
/** Version of the HTTP contract in docs/forecast-endpoint.md. */
export const FORECAST_CONTRACT_VERSION = 1;
export const FORECAST_PATH = "/api/forecast";

export type ModelFamily = "opus" | "fable" | "sonnet" | "haiku" | "other";

// ── demand ──────────────────────────────────────────────────────────────

/** Token counts of one served request, as the proxy or a transcript reports them. */
export interface TokenUsage {
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** All cache-write tokens. The two fields below split it when the source reports the split. */
	cacheWriteTokens: number;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

/** Demand in one BUCKET_MS bucket, pooled over accounts. `units` are demand units (see units.ts). */
export interface DemandBucket {
	/** Bucket start, a multiple of BUCKET_MS. */
	start: EpochMs;
	units: number;
	/** The part of `units` that came from Fable-family requests. */
	fableUnits: number;
	requests: number;
}

export interface AccountDemandBucket extends DemandBucket {
	accountId: AccountId;
}

/** One stored row. `accountId` is "" for transcript rows (transcripts do not name the account). */
export interface StoredDemandRow extends DemandBucket {
	accountId: AccountId | "";
	source: "transcript" | "proxy";
}

/** Persistence for the demand history. Implemented on the database; faked in tests. */
export interface DemandStore {
	/** Insert or replace rows by (start, accountId, source). */
	upsert(rows: StoredDemandRow[]): Promise<void>;
	/** Buckets in [from, to), summed over accounts and sources, ascending, empty buckets omitted. */
	loadPooled(from: EpochMs, to: EpochMs): Promise<DemandBucket[]>;
	/** Proxy-sourced buckets per account in [from, to), ascending. */
	loadByAccount(from: EpochMs, to: EpochMs): Promise<AccountDemandBucket[]>;
	/** Start of the earliest stored bucket, or null when the store is empty. */
	earliest(): Promise<EpochMs | null>;
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
}

// ── limits ──────────────────────────────────────────────────────────────

export type LimitWindow = "five_hour" | "seven_day" | "seven_day_fable";

/** `resetsAt` null means: no open window (5-hour), or unknown. */
export interface LimitState {
	usedPct: number;
	resetsAt: EpochMs | null;
}

/** One account's limits as last read. */
export interface AccountLimits {
	accountId: AccountId;
	name: string;
	/** Can take work now: not paused, not logged out. Only counted accounts enter pooled figures. */
	counted: boolean;
	fiveHour: LimitState;
	weekly: LimitState;
	fable: LimitState | null;
	/** End of an upstream refusal cooldown, when one is running. */
	blockedUntil: EpochMs | null;
	readAt: EpochMs;
}

/** One recorded usage reading (a row of usage_snapshots). */
export interface LimitReading {
	accountId: AccountId;
	at: EpochMs;
	window: LimitWindow;
	usedPct: number;
	resetsAt: EpochMs | null;
}

/** Points of a limit per demand unit, per account. null = not calibrated. */
export interface Calibration {
	fiveHour: Record<AccountId, number>;
	weekly: Record<AccountId, number>;
	fable: Record<AccountId, number | null>;
}

// ── sessions ────────────────────────────────────────────────────────────

/** One served request with its token usage, as fed to the session tracker. */
export interface ServedEvent {
	sessionId: string;
	accountId: AccountId;
	at: EpochMs;
	usage: TokenUsage;
}

/** A session the tracker has seen recently. */
export interface LiveSession {
	sessionId: string;
	/** Account that served its last request. */
	accountId: AccountId;
	family: ModelFamily;
	lastRequestAt: EpochMs;
	/** Observed cache lifetime of this session; null until a cache write was observed. */
	cacheTtlMs: number | null;
	/** lastRequestAt + cacheTtlMs. null while the lifetime is unknown (callers then fall back to idleMs). */
	coldAt: EpochMs | null;
	/** Prompt size of its last request: input + cache read + cache write tokens. */
	contextTokens: number;
	/** Demand units it used in the trailing 60 minutes. */
	recentUnits: number;
}

export interface SessionTrackerLike {
	observe(event: ServedEvent): void;
	get(sessionId: string): LiveSession | null;
	/** Sessions with a request in the trailing `maxIdleMs`. */
	live(now: EpochMs, maxIdleMs: number): LiveSession[];
	forget(sessionId: string): void;
}

// ── settings ────────────────────────────────────────────────────────────

export interface ForecastSettings {
	/** Compute and serve the forecast. */
	enabled: boolean;
	/** Let the forecast place and move sessions under session-pace. */
	routing: boolean;
	/** Let the planner open 5-hour windows with a real `claude -p` request. OFF by default. */
	prewarm: boolean;
	/** One-shot test: fire one pre-warm for this account at or after this time, once. */
	prewarmTest: { account: string; at: EpochMs } | null;
	/** Path of the `claude` executable for pre-warm; null = look it up on PATH. */
	claudePath: string | null;
	/** Model alias the pre-warm request names (`claude -p --model <this>`). */
	prewarmModel: string;
	/** Most pre-warm requests per account per local day, test included. */
	prewarmMaxPerDay: number;
	/** Number of simulated days behind each percentile line. */
	simulatedDays: number;
	/** Smoothed bootstrap: largest time shift of a resampled day, either way, in minutes. */
	timeShiftMin: number;
	/** Root of the Claude Code transcripts for the one-time backfill; null = no backfill. */
	transcriptsDir: string | null;
	/** Extra percentile levels to return besides 10, 50 and 90. */
	fanLevels: number[];
	/** A projected stop is listed only when at least this much demand goes unserved in it. */
	minStopPoints: number;
	/** A live session moves only when the score's lowest point gains at least this much. */
	moveMinGainPoints: number;
	/** A window is opened ahead of demand only when that gains at least this much. */
	openMinGainPoints: number;
	/** Recency weighting of recorded days. */
	historyHalfLifeDays: number;
	historyLookbackDays: number;
	/** Time constant of the blend from the last hour's rate into the recorded day. */
	recentTauMin: number;
	/** Time constant with which demand detaches from the sessions that carry it now. */
	sessionTurnoverMin: number;
	/** Work start: the local minute by which this percent of a work day's demand has been used (median over recent work days). */
	workStartSharePct: number;
}

/** The session-pace values the forecast shares. */
export interface PaceContext {
	timeZone: string;
	workDays: number;
	fiveHourGuardPct: number;
	idleMs: number;
}

// ── engine ──────────────────────────────────────────────────────────────

export interface ForecastInput {
	now: EpochMs;
	settings: ForecastSettings;
	pace: PaceContext;
	accounts: AccountLimits[];
	/** Pooled demand, ascending, covering [historyFrom, now). A missing bucket inside the range is zero demand. */
	history: DemandBucket[];
	historyFrom: EpochMs;
	/** Proxy-sourced demand per account, for calibration. */
	accountHistory: AccountDemandBucket[];
	/** Recorded readings, ascending: at least since Monday 00:00 local, and as far back as calibration looks. */
	readings: LimitReading[];
	sessions: LiveSession[];
	/** The simulated day the previous poll served as the typical day line; absent or null picks afresh. */
	heldDay?: ServedDay | null;
}

/** A simulated day served as the typical day line: its index among the simulated days of a local date. */
export interface ServedDay {
	date: string;
	day: number;
}

export interface PlacementAdvice {
	/**
	 * Accounts in tiers, best tier first. Accounts in one tier are equal for the forecast; the router
	 * ranks them by its own rules. The router takes the first tier that holds one of its candidates.
	 */
	tiers: AccountId[][];
	/** "forecast-open": the plan opens a closed 5-hour window with this placement. */
	rule: "forecast-open" | "forecast-lookahead";
	/** Short reason for the log line: one token, no spaces (e.g. "low-point+12.4"). */
	reason: string;
}

export interface MoveAdvice {
	sessionId: string;
	from: AccountId;
	to: AccountId;
	rule: "forecast-move";
	/** Short reason for the log line: one token, no spaces. */
	reason: string;
	/** Gain of the lowest point after paying for the move, in points. */
	gainPoints: number;
	/** What the cold-cache re-read costs on the target account, in 5-hour points. */
	costPoints: number;
}

export interface Plan {
	computedAt: EpochMs;
	/**
	 * Planned opening time of the 5-hour window for each counted account that has no open window.
	 * null = open on demand (when work first reaches the account).
	 */
	openAt: Record<AccountId, EpochMs | null>;
	/** Where new and cold sessions go. null = no preference; the router uses its own rules. */
	placement: PlacementAdvice | null;
	/** Planned moves of live sessions. At most one per computation. */
	moves: MoveAdvice[];
	/** Median first use on recent workdays, as minutes after local midnight; null when unknown. */
	workStartMinute: number | null;
}

export type UnavailableReason = "insufficient_history" | "error" | "disabled";

/** One counted account's limit in the calibration rule, as the unavailable log line names it. */
export interface CalibrationLimitDetail {
	accountId: AccountId;
	limit: "five_hour" | "seven_day";
	instances: number;
	/** Summed rise against minPoints (MIN_CALIBRATION_POINTS). */
	points: number;
	minPoints: number;
	/** Recency-weighted unit sum; an own k needs it positive. */
	units: number;
	/** An own k, one borrowed from another counted account, or none. */
	k: "own" | "borrowed" | "none";
}

/**
 * Which availability rule (design 4.2, 4.3) answered insufficient_history, with its numbers.
 * For the service's log only: never part of the response.
 */
export type UnavailableDetail =
	| { rule: "no_counted_account" }
	| {
			rule: "history";
			recordedDays: number;
			minRecordedDays: number;
			/** Today's pool: its own day type, or "weekdays" when monday and workday pool together. */
			pool: "workday" | "monday" | "weekend" | "weekdays";
			poolDays: number;
			minPoolDays: number;
	  }
	| { rule: "calibration"; limits: CalibrationLimitDetail[] };

/** The day factor of design amendment 4 (D1) with its inputs. */
export interface DayFactorDetail {
	/** The factor the simulation uses: 1 + (clamped − 1) × weight. */
	a: number;
	/** (Y + c) ÷ (M + c). */
	raw: number;
	/** raw clamped to [DAY_FACTOR_MIN, DAY_FACTOR_MAX]. */
	clamped: number;
	/** Evidence weight min(1, M ÷ c). */
	weight: number;
	/** Today's units since local midnight. */
	y: number;
	/** The pool's weighted mean units over the same clock span. */
	m: number;
	/** DAY_FACTOR_PRIOR_SHARE × the pool's weighted mean daily total. */
	c: number;
}

/** One counted account's limit as the forecast-inputs log line names it. */
export interface InputsLimitDetail {
	accountId: AccountId;
	limit: LimitWindow;
	/** The k in use (own or borrowed); null without one. */
	k: number | null;
	source: "own" | "borrowed" | "none";
	instances: number;
	points: number;
	/**
	 * Hours before the computation of the first and of the last reading of the window
	 * instances the account's own k counted; null with none counted.
	 */
	oldestHoursAgo: number | null;
	newestHoursAgo: number | null;
}

/** The day line's weekly cap of one counted account at the computation (spec section 3). */
export interface InputsCapDetail {
	accountId: AccountId;
	/** Five-hour points per weekly point, k5 / kW; null when there is no cap. */
	ratio: number | null;
	/** Whether the cap lowers the account's share of the pooled 5-hour quota left now. */
	binds: boolean;
}

/**
 * What an available forecast was computed from (design amendment 4, D2).
 * For the service's log only: never part of the response.
 */
export interface ForecastInputsDetail {
	dayFactor: DayFactorDetail;
	/** Demand over the last hour, units per hour. */
	recentRatePerHour: number;
	/** Today's pool: its own day type, or "weekdays" when monday and workday pool together. */
	pool: {
		name: "workday" | "monday" | "weekend" | "weekdays";
		days: number;
		/** Recency-weighted median and p90 of the pool's daily units; null for an empty pool. */
		medianUnits: number | null;
		p90Units: number | null;
	};
	workStartMinute: number | null;
	limits: InputsLimitDetail[];
	caps: InputsCapDetail[];
}

export type ForecastResult =
	| {
			available: true;
			response: ForecastResponse;
			plan: Plan;
			/** What the forecast was computed from; the HTTP response never carries it. */
			inputs?: ForecastInputsDetail;
			/** The simulated day served as the typical day line; the HTTP response never carries it. */
			servedDay?: ServedDay;
	  }
	| {
			available: false;
			reason: UnavailableReason;
			response: ForecastResponse;
			plan: null;
			/** Set with insufficient_history; the HTTP response never carries it. */
			detail?: UnavailableDetail;
	  };

export interface ForecastEngine {
	/** Never throws: a failure is returned as available false, reason "error". */
	compute(input: ForecastInput): Promise<ForecastResult>;
}

/** What the router asks of the forecast. Every method is synchronous and cheap. */
export interface ForecastAdvisor {
	/** Advice for a new or cold session; null = no forecast applies, use the router's own rules. */
	placeNewSession(now: EpochMs): PlacementAdvice | null;
	/** A planned move for this live session; null = stay. */
	moveFor(sessionId: string, now: EpochMs): MoveAdvice | null;
	/**
	 * Observed cache lifetime of this session; null = unknown. The router calls a session cold when
	 * its own last-request time plus this lifetime has passed (unknown: its idle time setting).
	 */
	cacheTtlMs(sessionId: string): number | null;
	/** The router applied a placement or a move; the advisor replans soon. */
	applied(
		kind: "place" | "move",
		sessionId: string,
		accountId: AccountId,
		now: EpochMs,
	): void;
}

// ── pre-warm ────────────────────────────────────────────────────────────

export interface PrewarmRunResult {
	exitCode: number | null;
	durationMs: number;
	/** Short error text when the process could not be started or timed out. Never CLI output. */
	error: string | null;
}

/** Sends one tiny request through the real `claude` CLI, pinned to one account. Faked in tests. */
export interface PrewarmRunner {
	run(accountId: AccountId): Promise<PrewarmRunResult>;
}

export interface PrewarmRecord {
	accountId: AccountId;
	kind: "plan" | "test";
	scheduledAt: EpochMs;
	firedAt: EpochMs;
	exitCode: number | null;
	/** Whether a later reading showed the account's 5-hour window open; null = not known yet. */
	windowOpened: boolean | null;
	/** The window's reset time from that reading. */
	resetsAt: EpochMs | null;
}

export interface PrewarmStatus {
	enabled: boolean;
	planned: { accountId: AccountId; openAt: EpochMs }[];
	last: PrewarmRecord[];
}

// ── HTTP contract (docs/forecast-endpoint.md) ───────────────────────────

export interface Interval {
	start: EpochMs;
	end: EpochMs;
}

export interface Series {
	times: EpochMs[];
	values: number[];
}

export interface Shortfall {
	stop: Interval;
	points: number;
	lastAccount: AccountId;
	perAccount: Record<AccountId, number>;
}

export interface ForecastBlock {
	past: Series;
	times: EpochMs[];
	light: number[];
	typical: number[];
	heavy: number[];
	/** Keyed "pNN". */
	fan: Record<string, number[]>;
	stops: { light: Interval[]; typical: Interval[]; heavy: Interval[] };
	stopNow: Interval | null;
	pastStops: Interval[];
	shortfall: Shortfall | null;
}

export interface ForecastResponse {
	contractVersion: number;
	computedAt: EpochMs;
	available: boolean;
	reason: UnavailableReason | null;
	accounts: AccountId[];
	levels: { light: number; typical: number; heavy: number };
	day: ForecastBlock | null;
	week: ForecastBlock | null;
	fable: Record<AccountId, { outAt: EpochMs | null }>;
	/** Added by the service, not by the engine. */
	prewarm?: PrewarmStatus;
}
