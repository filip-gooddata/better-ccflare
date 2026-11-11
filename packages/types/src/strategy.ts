import type { Account } from "./account";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
	SessionAffinity = "session-affinity",
	SessionDrainSoonest = "session-drain-soonest",
	// Same strategy class in "strict" mode: one canonical comparator ranks
	// every available account (earliest weekly reset first; an active 5h
	// session only breaks ties instead of gating position 0).
	SessionDrainSoonestStrict = "session-drain-soonest-strict",
	// Sticky per client session; new sessions go to the account furthest
	// behind its weekly pace, with 5-hour and per-model-family guards.
	SessionPace = "session-pace",
}

/**
 * One usage window as a strategy sees it: utilization in percent (0–100) and
 * the epoch-ms reset time, or null when the payload carries none. Unlike
 * {@link StrategyStore.getAccountWeeklyReset}, a reset that has already
 * passed is returned as-is so the caller can decide what stale means.
 */
export interface StrategyUsageWindow {
	utilization: number;
	resetsAt: number | null;
}

/**
 * Interface for strategy-specific database operations
 * Allows strategies to interact with the database without direct SQL access
 */
export interface StrategyStore {
	/**
	 * Reset session for an account
	 * Updates session_start and session_request_count
	 */
	resetAccountSession(accountId: string, timestamp: number): void;

	/**
	 * Get all accounts (optional method for strategies that need full account list)
	 */
	getAllAccounts?(): Account[] | Promise<Account[]>;

	/**
	 * Update account request count
	 */
	updateAccountRequestCount?(accountId: string, count: number): void;

	/**
	 * Get account by ID
	 */
	getAccount?(accountId: string): Account | null | Promise<Account | null>;

	/**
	 * Pause an account
	 */
	pauseAccount?(accountId: string): void;

	/**
	 * Resume a paused account
	 */
	resumeAccount?(accountId: string): void;

	/**
	 * Get the representative utilization (0–100) for an account based on its
	 * most-constrained usage window. Returns null when no usage data is available.
	 */
	getAccountUtilization?(accountId: string, provider: string): number | null;

	/**
	 * Get the epoch-ms reset time of the account's weekly_all (all-models
	 * weekly) usage window — the point at which unused capacity is lost and
	 * fresh capacity becomes available. Returns null when unknown or when the
	 * reset has already passed (stale telemetry that hasn't caught up yet).
	 */
	getAccountWeeklyReset?(accountId: string, provider: string): number | null;

	/**
	 * The account's all-models weekly window (`seven_day`, else the
	 * `weekly_all` entry of `limits[]`). Null when no usage data is cached.
	 */
	getAccountWeeklyWindow?(
		accountId: string,
		provider: string,
	): StrategyUsageWindow | null;

	/** The account's `five_hour` window. Null when no usage data is cached. */
	getAccountFiveHourWindow?(
		accountId: string,
		provider: string,
	): StrategyUsageWindow | null;

	/**
	 * The account's model-scoped weekly windows (`limits[]` entries of kind
	 * `weekly_scoped`) whose model belongs to `family` (as resolved by
	 * `getModelFamily`). Empty when there are none.
	 */
	getAccountModelFamilyWindows?(
		accountId: string,
		provider: string,
		family: string,
	): StrategyUsageWindow[];
}
