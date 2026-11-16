import { unavailableResponse } from "../engine/response";
import {
	runTranscriptBackfill,
	TRANSCRIPT_BACKFILL_META_KEY,
} from "../history/backfill";
import type { ForecastDb } from "../history/ports";
import {
	earliestProxyBucket,
	errorName,
	syncProxyDemand,
} from "../history/proxy-demand";
import {
	usageDetailCutoff,
	usageDetailMeta,
} from "../history/proxy-usage-detail";
import { loadReadings } from "../history/readings";
import { runUsageDetailBackfill } from "../history/usage-detail-backfill";
import {
	type PrewarmForecastView,
	type PrewarmScheduler,
	plannedOpenings,
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
	ServedDay,
	SessionTrackerLike,
} from "../types";
import {
	backfillLine,
	createAvailabilityLog,
	createInputsLog,
	usageDetailBackfillLine,
} from "./log-lines";

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
	/**
	 * Runs once per service, from creation. Before the `backfill` marker is set,
	 * creation passes `earliestProxyBucket`: the cut-over that backfill will
	 * take once the first sync has stored every Claude OAuth request. Defaults
	 * to runUsageDetailBackfill over `db`, with usageDetailMeta(db) as the meta
	 * store.
	 */
	usageDetailBackfill?(
		transcriptsDir: string,
		earliestProxyBucket?: () => Promise<EpochMs | null>,
	): Promise<unknown>;
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
	/** Clears timers, stops the scheduler, awaits the running computation, the usage-detail pass and pre-warm runs in flight; later notifies do nothing. */
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
	let heldDay: ServedDay | null = null;
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
	let usageDetailRun: Promise<void> | null = null;
	let quietWaiters: (() => void)[] = [];

	const backfill =
		deps.backfill ??
		((transcriptsDir: string) =>
			runTranscriptBackfill({
				store,
				transcriptsDir,
				earliestProxyBucket: () => earliestProxyBucket({ db }),
				now: () => clock.now(),
				timeZone: deps.pace().timeZone,
			}));
	const usageDetailBackfill =
		deps.usageDetailBackfill ??
		((
			transcriptsDir: string,
			earliest: () => Promise<EpochMs | null> = () =>
				earliestProxyBucket({ db }),
		) =>
			runUsageDetailBackfill({
				db,
				meta: usageDetailMeta(db),
				transcriptsDir,
				earliestProxyBucket: earliest,
				now: () => clock.now(),
				historyLookbackDays: deps.settings().historyLookbackDays,
			}));
	const availability = createAvailabilityLog((msg) => logger.info(msg));
	const inputsLog = createInputsLog((msg) => logger.info(msg));

	const startBackfill = () => {
		if (backfillStarted) return;
		const dir = deps.settings().transcriptsDir;
		if (!dir) return;
		backfillStarted = true;
		logger.info("forecast backfill started");
		const startedAt = clock.now();
		void Promise.resolve()
			.then(() => backfill(dir))
			.then(
				(result) => {
					logger.info(backfillLine(result, clock.now() - startedAt));
					return true;
				},
				(error: unknown) => {
					logger.warn(`forecast backfill failed error=${errorName(error)}`);
					return false;
				},
			)
			.then((succeeded) => {
				// Sequential: it reads the cut-over the demand backfill settled on.
				if (succeeded) return startUsageDetailBackfill(dir);
			});
	};

	/** At most once per service, from creation or from the first cycle; never after stop. */
	const startUsageDetailBackfill = (
		dir: string,
		earliest?: () => Promise<EpochMs | null>,
	): Promise<void> => {
		if (usageDetailRun) return usageDetailRun;
		if (stopped) return Promise.resolve();
		const startedAt = clock.now();
		usageDetailRun = Promise.resolve()
			.then(() =>
				earliest
					? usageDetailBackfill(dir, earliest)
					: usageDetailBackfill(dir),
			)
			.then(
				(result) => {
					logger.info(usageDetailBackfillLine(result, clock.now() - startedAt));
				},
				(error: unknown) => {
					logger.warn(
						`forecast usage detail backfill failed error=${errorName(error)}`,
					);
				},
			);
		return usageDetailRun;
	};

	/**
	 * The demand backfill's cut-over before its first run: the first sync starts
	 * at 0 and stores a proxy bucket for every Claude OAuth request, so the
	 * earliest of those and of the proxy buckets already stored.
	 */
	const earliestAfterFirstSync = async (): Promise<EpochMs | null> => {
		let earliest = await earliestProxyBucket({ db });
		for (const request of await db.getClaudeOAuthRequestUsage(
			0,
			clock.now() + 1,
		)) {
			if (earliest === null || request.timestamp < earliest) {
				earliest = request.timestamp;
			}
		}
		return earliest;
	};

	// The pass starts at creation, without waiting for a usage snapshot that may
	// never come. Before the demand backfill has run, it gets the cut-over that
	// backfill will take.
	const startupDir = deps.settings().transcriptsDir;
	const startupCheck: Promise<unknown> = startupDir
		? Promise.resolve()
				.then(() => store.getMeta(TRANSCRIPT_BACKFILL_META_KEY))
				.then(
					(marker) =>
						marker !== null
							? startUsageDetailBackfill(startupDir)
							: startUsageDetailBackfill(startupDir, earliestAfterFirstSync),
					(error: unknown) => {
						logger.warn(
							`forecast usage detail backfill check failed error=${errorName(error)}`,
						);
					},
				)
		: Promise.resolve();

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
			const synced = await syncProxyDemand({ db }, now);
			if (synced.detailError !== undefined) {
				logger.warn(
					`forecast usage detail sync failed error=${synced.detailError}`,
				);
			}
			startBackfill();
		} catch (error) {
			failures.push(`sync=${message(error)}`);
		}
		try {
			await db.pruneUsageDetail(
				usageDetailCutoff(now, deps.settings().historyLookbackDays),
			);
		} catch (error) {
			failures.push(`prune=${errorName(error)}`);
		}
		try {
			const settings = deps.settings();
			const pace = deps.pace();
			// Days before the first stored bucket were never recorded; inside
			// [historyFrom, now) the engine reads a missing bucket as zero demand.
			const earliest = await store.earliest();
			const historyFrom = Math.max(
				now - settings.historyLookbackDays * DAY_MS,
				earliest ?? now,
			);
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
					heldDay,
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
			if (result.available && result.servedDay) heldDay = result.servedDay;
			consumedMoves = new Set();
			availability.record(result, now);
			inputsLog.record(result, now);
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

	const forecastView = (): PrewarmForecastView | null => {
		try {
			if (!deps.settings().enabled) return null;
			const plan = freshPlan(clock.now());
			return plan ? { available: true, plan } : null;
		} catch {
			return null;
		}
	};

	const emptyPrewarm = (): PrewarmStatus => {
		let enabled = false;
		try {
			enabled = deps.settings().prewarm;
		} catch {
			// keep false
		}
		return { enabled, planned: plannedOpenings(forecastView()), last: [] };
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
		forecastView,
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
			await startupCheck;
			if (usageDetailRun) await usageDetailRun;
			settleQuiet();
			// pre-warm runs in flight finish and record before the database closes
			await deps.scheduler?.idle();
		},
	};
}
