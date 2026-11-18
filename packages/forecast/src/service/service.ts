import { presentDemand } from "../engine/learn";
import type {
	LearnedDemand,
	Partition,
	RowChoice,
} from "../engine/learn/types";
import { buildPaceSeries } from "../engine/pace";
import type {
	PaceFitState,
	PaceSeries,
	PaceSeriesInput,
} from "../engine/pace/types";
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
	SessionTrackerLike,
} from "../types";
import { formatF2DaytypesLine, formatF2LearnLine } from "./f2-learn-log";
import {
	backfillLine,
	createAvailabilityLog,
	createInputsLog,
	usageDetailBackfillLine,
} from "./log-lines";
import { PACE_REFIT_CADENCE_MIN, paceRefitLine } from "./pace-refit-log";
import {
	createPaceRefitRunner,
	PACE_REFIT_TIMEOUT_MS,
	type PaceRefitRunner,
	type RefitDemandSettings,
} from "./pace-refit-runner";

/** A kept result older than this many usage poll intervals is stale. */
export const FORECAST_STALE_POLLS = 3;
/** Wait after a usage snapshot before computing, so a burst of snapshots gives one computation. */
export const FORECAST_POLL_SETTLE_MS = 5_000;
/** Two computations start at least this far apart. */
export const FORECAST_MIN_SPACING_MS = 30_000;

const DAY_MS = 24 * 60 * 60_000;

/** The E4 refit runs at start-up and then this often, timed from each refit's start. */
export const PACE_REFIT_CADENCE_MS = PACE_REFIT_CADENCE_MIN * 60_000;
/** A seven_day reading holds until its reset, so one taken up to 7 days before the window still censors inside it. */
const READINGS_LEAD_MS = 7 * DAY_MS;

/** The demand settings a refit job's F2 learners start from. */
export function refitDemandOf(
	settings: ForecastSettings,
	workDays: number,
): RefitDemandSettings {
	return {
		workDays,
		historyLookbackDays: settings.historyLookbackDays,
		historyHalfLifeDays: settings.historyHalfLifeDays,
		workStartSharePct: settings.workStartSharePct,
		timeShiftMin: settings.timeShiftMin,
	};
}

const demandKey = (d: RefitDemandSettings): string =>
	[
		d.workDays,
		d.historyLookbackDays,
		d.historyHalfLifeDays,
		d.workStartSharePct,
		d.timeShiftMin,
	].join("/");

/** History and readings the refit loads: the lookback, clipped to the first stored bucket. */
export function paceRefitRange(
	now: EpochMs,
	lookbackDays: number,
	earliest: EpochMs | null,
): { historyFrom: EpochMs; readingsFrom: EpochMs } {
	const historyFrom = Math.max(now - lookbackDays * DAY_MS, earliest ?? now);
	return { historyFrom, readingsFrom: historyFrom - READINGS_LEAD_MS };
}

export interface PaceRefitDeps {
	/** Runs the fit off the main thread. */
	runner: PaceRefitRunner;
	/** Builds the pooled series on the main thread. */
	buildSeries(input: PaceSeriesInput): PaceSeries;
	timeoutMs?: number;
}

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
	/** The E4 refit. Defaults to the forecast worker over buildPaceSeries; null runs no refit. */
	paceRefit?: PaceRefitDeps | null;
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
	const refitDeps: PaceRefitDeps | null =
		deps.paceRefit === undefined
			? { runner: createPaceRefitRunner(), buildSeries: buildPaceSeries }
			: deps.paceRefit;
	/** The last successful fit, swapped in whole; null until the first. */
	let paceState: PaceFitState | null = null;
	/** F2: the last successful job's learned demand and the demand settings it was learned under; swapped with paceState. */
	let learnedState: { learned: LearnedDemand; key: string } | null = null;
	/**
	 * The demand the engine serves: the last learned one while the demand
	 * settings are those it was learned under, else every row at its present
	 * value for the current settings (before the first successful refit, and
	 * after a demand setting changes until the next successful refit).
	 */
	const servedDemand = (
		settings: ForecastSettings,
		workDays: number,
	): LearnedDemand => {
		const demand = refitDemandOf(settings, workDays);
		// pace off: no refit runs, so a stored learned demand would freeze (R3-5)
		if (!settings.paceConditioning) return presentDemand(demand);
		if (learnedState && learnedState.key === demandKey(demand))
			return learnedState.learned;
		return presentDemand(demand);
	};
	/**
	 * F2 row 1: the last successful row-1 job's choice, the demand settings it
	 * was learned under and the instant it was fitted at. The main refit job
	 * fits E4 with its served partition while the settings match, else with
	 * the present partition (none stored, or a demand setting changed since).
	 */
	let daytypesState: {
		choice: RowChoice<Partition>;
		/** A switch waiting for the next row-1 job's nested confirmation (R3-2); same settings rule as the choice. */
		pending: Partition | null;
		key: string;
		at: EpochMs;
	} | null = null;
	const storedDaytypes = (demand: RefitDemandSettings) =>
		daytypesState && daytypesState.key === demandKey(demand)
			? daytypesState
			: null;
	let refitRunning: Promise<void> | null = null;
	let refitAbort: AbortController | null = null;
	let refitHandle: unknown = null;
	let refitsStarted = false;

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
					demandModel: paceState,
					learnedDemand: servedDemand(settings, pace.workDays),
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

	const refit = async (refitWith: PaceRefitDeps, signal: AbortSignal) => {
		const now = clock.now();
		const started = performance.now();
		let series: PaceSeries;
		let demand: RefitDemandSettings;
		try {
			const settings = deps.settings();
			demand = refitDemandOf(settings, deps.pace().workDays);
			const { historyFrom, readingsFrom } = paceRefitRange(
				now,
				settings.historyLookbackDays,
				await store.earliest(),
			);
			const [history, readings, limits] = await Promise.all([
				store.loadPooled(historyFrom, now),
				loadReadings({ db }, readingsFrom, now),
				deps.loadLimits(now),
			]);
			series = refitWith.buildSeries({
				history,
				historyFrom,
				now,
				readings,
				accounts: countedIds(limits),
				timeZone: deps.pace().timeZone,
			});
		} catch {
			if (!stopped)
				logger.info(
					paceRefitLine(
						{
							status: "error",
							reason: "input-error",
							ms: performance.now() - started,
						},
						paceState,
						clock.now(),
					),
				);
			return;
		}
		if (stopped) return;
		// The row-1 job gets its own copy: the main job transfers these buffers.
		const daytypesSeries: PaceSeries = {
			...series,
			units: series.units.slice(),
			censored: series.censored.slice(),
		};
		const timeoutMs = refitWith.timeoutMs ?? PACE_REFIT_TIMEOUT_MS;
		const outcome = await refitWith.runner.run(series, now, demand, {
			timeoutMs,
			signal,
			daytypes: storedDaytypes(demand)?.choice ?? null,
		});
		if (stopped) return;
		// One synchronous swap: a forecast sees the old fit and learned demand or the new pair, never a mix.
		if (outcome.status === "ok") {
			paceState = outcome.state;
			learnedState = { learned: outcome.learned, key: demandKey(demand) };
		}
		logger.info(paceRefitLine(outcome, paceState, clock.now()));
		// F2 line only for a job that returned learned demand; a failure keeps the last one silently.
		if (outcome.status === "ok")
			logger.info(
				formatF2LearnLine(outcome.learned, outcome.ms, { mainJob: true }),
			);

		// Row 1 in its own job, after the main job whatever its outcome, inside
		// the same refit cycle: it never overlaps the main job or itself. A
		// success is used by the next main refit; a failure keeps the last choice.
		const stored = storedDaytypes(demand);
		const daytypes = await refitWith.runner.runDaytypes(
			daytypesSeries,
			now,
			demand,
			{
				timeoutMs,
				signal,
				daytypes: stored?.choice ?? null,
				pending: stored?.pending ?? null,
			},
		);
		if (stopped) return;
		if (daytypes.status === "ok") {
			daytypesState = {
				choice: daytypes.choice,
				pending: daytypes.pending,
				key: demandKey(demand),
				at: now,
			};
			logger.info(formatF2DaytypesLine(daytypes, now, clock.now()));
		} else
			logger.warn(
				formatF2DaytypesLine(daytypes, daytypesState?.at ?? null, clock.now()),
			);
	};

	/** Arms the next refit one cadence from now, then refits unless one runs or the setting is off. */
	const triggerRefit = () => {
		if (stopped || !refitDeps) return;
		if (refitHandle !== null) timer.clear(refitHandle);
		refitHandle = timer.set(() => {
			refitHandle = null;
			triggerRefit();
		}, PACE_REFIT_CADENCE_MS);
		if (refitRunning) return;
		try {
			if (!deps.settings().paceConditioning) return;
		} catch {
			return;
		}
		const abort = new AbortController();
		refitAbort = abort;
		refitRunning = refit(refitDeps, abort.signal)
			.catch((error: unknown) => {
				const name = error instanceof Error ? error.name : typeof error;
				logger.warn(`forecast e4 refit failed error=${name}`);
			})
			.finally(() => {
				refitRunning = null;
				refitAbort = null;
			});
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
		if (!refitsStarted) {
			refitsStarted = true;
			triggerRefit();
		}
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
			if (refitHandle !== null) timer.clear(refitHandle);
			refitHandle = null;
			refitAbort?.abort();
			deps.scheduler?.stop();
			if (running) await running;
			if (refitRunning) await refitRunning;
			await startupCheck;
			if (usageDetailRun) await usageDetailRun;
			settleQuiet();
			// pre-warm runs in flight finish and record before the database closes
			await deps.scheduler?.idle();
		},
	};
}
