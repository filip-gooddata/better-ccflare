import { unavailableResponse } from "../engine/response";
import { runTranscriptBackfill } from "../history/backfill";
import type { ForecastDb } from "../history/ports";
import { earliestProxyBucket, syncProxyDemand } from "../history/proxy-demand";
import { loadReadings } from "../history/readings";
import type {
	PrewarmForecastView,
	PrewarmScheduler,
} from "../prewarm/scheduler";
import type {
	AccountId,
	AccountLimits,
	DemandStore,
	EpochMs,
	ForecastAdvisor,
	ForecastInput,
	ForecastResponse,
	ForecastResult,
	ForecastSettings,
	PaceContext,
	PrewarmStatus,
	SessionTrackerLike,
} from "../types";

/** A kept result older than this many usage poll intervals is stale. */
export const FORECAST_STALE_POLLS = 3;
/** Wait after a usage snapshot before computing, so a burst of snapshots gives one computation. */
export const FORECAST_POLL_SETTLE_MS = 5_000;
/** Two computations start at least this far apart. */
export const FORECAST_MIN_SPACING_MS = 30_000;

const DAY_MS = 24 * 60 * 60_000;

export interface ForecastServiceTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface ForecastServiceDeps {
	/** Live settings (Config.getForecastSettings). */
	settings(): ForecastSettings;
	/** Live pace context: session-pace values, or the configured ones while another strategy runs. */
	pace(): PaceContext;
	db: ForecastDb;
	store: DemandStore;
	engine: { compute(input: ForecastInput): Promise<ForecastResult> };
	tracker: SessionTrackerLike;
	/** Current limits of the Claude OAuth accounts. */
	loadLimits(now: EpochMs): Promise<AccountLimits[]>;
	/**
	 * The pre-warm scheduler, or null. The service ticks it after each
	 * computation, reads its status and stops it. The scheduler's own
	 * `forecast()` and `limits()` read this service: build the scheduler with
	 * lazy getters over a variable the service is assigned to afterwards.
	 */
	scheduler: PrewarmScheduler | null;
	/** Defaults to runTranscriptBackfill over `store` and `db`. */
	backfill?(transcriptsDir: string): Promise<unknown>;
	clock: { now(): EpochMs };
	/** The server passes unref'd timers so none keeps the process alive. */
	timer: ForecastServiceTimer;
	/** The usage poll interval from the config. */
	pollIntervalMs: number;
	logger: { info(msg: string): void; warn(msg: string): void };
}

export interface ForecastService {
	/** Call from every successful usage snapshot. Debounced and coalesced; never throws. */
	notifyUsagePoll(): void;
	/** Computes now; joins a computation already running. Never rejects. */
	runOnce(): Promise<void>;
	readonly advisor: ForecastAdvisor;
	/** The endpoint's ForecastProvider. Never throws. */
	readonly provider: () => ForecastResponse;
	/** Limits from the last computation (the scheduler's `limits()`). */
	limits(): AccountLimits[];
	/** The scheduler's `forecast()`: the kept plan while fresh, else null. */
	forecastView(): PrewarmForecastView | null;
	/** Resolves when no computation is running or queued and the scheduler is idle. */
	idle(): Promise<void>;
	/** Clears timers, stops the scheduler, awaits the running computation and pre-warm runs in flight; later notifies do nothing. */
	stop(): Promise<void>;
}

const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 200);

const countedIds = (limits: AccountLimits[]): AccountId[] =>
	limits.filter((l) => l.counted).map((l) => l.accountId);

export function createForecastService(
	deps: ForecastServiceDeps,
): ForecastService {
	const { clock, timer, logger, store, db } = deps;
	let kept: { result: ForecastResult; computedAt: EpochMs } | null = null;
	let lastLimits: AccountLimits[] = [];
	let consumedMoves = new Set<string>();
	let running: Promise<void> | null = null;
	/** A usage snapshot arrived that no started computation has covered yet. */
	let wanted = false;
	let lastNotifyAt: EpochMs | null = null;
	let lastStart: EpochMs | null = null;
	/** The one timer for queued work; its deadline covers both the settle wait and the spacing. */
	let pendingHandle: unknown = null;
	let stopped = false;
	let backfillStarted = false;
	let quietWaiters: (() => void)[] = [];

	const backfill =
		deps.backfill ??
		((transcriptsDir: string) =>
			runTranscriptBackfill({
				store,
				transcriptsDir,
				earliestProxyBucket: () => earliestProxyBucket({ db }),
				now: () => clock.now(),
			}));

	const startBackfill = () => {
		if (backfillStarted) return;
		const dir = deps.settings().transcriptsDir;
		if (!dir) return;
		backfillStarted = true;
		logger.info("forecast backfill started");
		void Promise.resolve()
			.then(() => backfill(dir))
			.then(
				(result) => {
					const status =
						result && typeof result === "object" && "status" in result
							? String((result as { status: unknown }).status)
							: "done";
					logger.info(`forecast backfill finished status=${status}`);
				},
				(error: unknown) => {
					// The error's name only: a message could carry a transcript path.
					const name = error instanceof Error ? error.name : typeof error;
					logger.warn(`forecast backfill failed error=${name}`);
				},
			);
	};

	const fresh = (now: EpochMs) =>
		kept !== null &&
		now - kept.computedAt <= FORECAST_STALE_POLLS * deps.pollIntervalMs;

	const freshPlan = (now: EpochMs) => {
		if (!kept || !fresh(now) || !kept.result.available) return null;
		return kept.result.plan;
	};

	const cycle = async () => {
		const now = clock.now();
		const failures: string[] = [];
		try {
			await syncProxyDemand({ db }, now);
			startBackfill();
		} catch (error) {
			failures.push(`sync=${message(error)}`);
		}
		try {
			const settings = deps.settings();
			const pace = deps.pace();
			const historyFrom = now - settings.historyLookbackDays * DAY_MS;
			const [history, accountHistory, readings] = await Promise.all([
				store.loadPooled(historyFrom, now),
				store.loadByAccount(historyFrom, now),
				loadReadings({ db }, historyFrom, now),
			]);
			const accounts = await deps.loadLimits(now);
			lastLimits = accounts;
			const sessions = deps.tracker.live(now, pace.idleMs);
			let result: ForecastResult;
			try {
				result = await deps.engine.compute({
					now,
					settings,
					pace,
					accounts,
					history,
					historyFrom,
					accountHistory,
					readings,
					sessions,
				});
			} catch (error) {
				failures.push(`engine=${message(error)}`);
				result = {
					available: false,
					reason: "error",
					response: unavailableResponse(now, "error", countedIds(accounts)),
					plan: null,
				};
			}
			kept = { result, computedAt: now };
			consumedMoves = new Set();
		} catch (error) {
			failures.push(`compute=${message(error)}`);
		}
		try {
			await deps.scheduler?.tick(now);
		} catch (error) {
			failures.push(`prewarm=${message(error)}`);
		}
		if (failures.length > 0)
			logger.warn(`forecast cycle failed ${failures.join(" ")}`);
	};

	const clearPending = () => {
		if (pendingHandle !== null) timer.clear(pendingHandle);
		pendingHandle = null;
	};

	const settleQuiet = () => {
		if (running || pendingHandle !== null) return;
		const waiters = quietWaiters;
		quietWaiters = [];
		for (const resolve of waiters) resolve();
	};

	/** Arms the one pending timer for the latest snapshot, no earlier than the spacing allows. */
	const schedule = () => {
		clearPending();
		if (stopped || !wanted || running) return;
		const now = clock.now();
		const at = Math.max(
			(lastNotifyAt ?? now) + FORECAST_POLL_SETTLE_MS,
			lastStart === null ? now : lastStart + FORECAST_MIN_SPACING_MS,
		);
		pendingHandle = timer.set(
			() => {
				pendingHandle = null;
				if (!stopped && wanted && !running) void start();
				settleQuiet();
			},
			Math.max(0, at - now),
		);
	};

	/** Starts a computation now; it covers every snapshot seen so far. */
	const start = (): Promise<void> => {
		if (running) return running;
		clearPending();
		wanted = false;
		lastStart = clock.now();
		const current = cycle()
			.catch((error: unknown) => {
				logger.warn(`forecast cycle failed ${message(error)}`);
			})
			.finally(() => {
				running = null;
				schedule();
				settleQuiet();
			});
		running = current;
		return current;
	};

	const advisor: ForecastAdvisor = {
		placeNewSession(now) {
			try {
				const settings = deps.settings();
				if (!settings.enabled || !settings.routing) return null;
				return freshPlan(now)?.placement ?? null;
			} catch {
				return null;
			}
		},
		moveFor(sessionId, now) {
			try {
				const settings = deps.settings();
				if (!settings.enabled || !settings.routing) return null;
				if (consumedMoves.has(sessionId)) return null;
				return (
					freshPlan(now)?.moves.find((m) => m.sessionId === sessionId) ?? null
				);
			} catch {
				return null;
			}
		},
		cacheTtlMs(sessionId) {
			try {
				return deps.tracker.get(sessionId)?.cacheTtlMs ?? null;
			} catch {
				return null;
			}
		},
		applied(kind, sessionId) {
			try {
				if (kind === "move") consumedMoves.add(sessionId);
			} catch {
				// never throws
			}
		},
	};

	const emptyPrewarm = (): PrewarmStatus => {
		let enabled = false;
		try {
			enabled = deps.settings().prewarm;
		} catch {
			// keep false
		}
		return { enabled, planned: [], last: [] };
	};

	const provider = (): ForecastResponse => {
		let now = Date.now();
		try {
			now = clock.now();
			const base =
				kept && fresh(now)
					? kept.result.response
					: unavailableResponse(now, "error", countedIds(lastLimits));
			const prewarm = deps.scheduler ? deps.scheduler.status() : emptyPrewarm();
			return { ...base, prewarm };
		} catch (error) {
			try {
				logger.warn(`forecast provider failed ${message(error)}`);
			} catch {
				// never throws
			}
			return {
				...unavailableResponse(now, "error", []),
				prewarm: emptyPrewarm(),
			};
		}
	};

	return {
		notifyUsagePoll() {
			try {
				if (stopped) return;
				wanted = true;
				lastNotifyAt = clock.now();
				// while a computation runs, its end schedules the follow-up
				if (!running) schedule();
			} catch {
				// never throws
			}
		},
		runOnce() {
			if (stopped) return Promise.resolve();
			return start();
		},
		advisor,
		provider,
		limits: () => lastLimits,
		forecastView() {
			try {
				if (!deps.settings().enabled) return null;
				const plan = freshPlan(clock.now());
				return plan ? { available: true, plan } : null;
			} catch {
				return null;
			}
		},
		async idle() {
			for (;;) {
				if (running || pendingHandle !== null) {
					await new Promise<void>((resolve) => quietWaiters.push(resolve));
					continue;
				}
				await deps.scheduler?.idle();
				if (!running && pendingHandle === null) return;
			}
		},
		async stop() {
			stopped = true;
			wanted = false;
			clearPending();
			deps.scheduler?.stop();
			if (running) await running;
			settleQuiet();
			// pre-warm runs in flight finish and record before the database closes
			await deps.scheduler?.idle();
		},
	};
}
