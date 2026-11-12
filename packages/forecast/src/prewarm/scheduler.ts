import { localDayKey } from "../time";
import type {
	AccountId,
	AccountLimits,
	DemandStore,
	EpochMs,
	ForecastSettings,
	Plan,
	PrewarmRecord,
	PrewarmRunner,
	PrewarmStatus,
} from "../types";

export const PREWARM_RECORDS_KEY = "prewarm.records";
export const PREWARM_TESTS_KEY = "prewarm.tests";
/** Firing times per account for the 5-hour and daily guards, kept apart from the display records. */
export const PREWARM_HISTORY_KEY = "prewarm.history";
/** Firing times older than this are dropped from the guard history; covers any local day. */
export const PREWARM_HISTORY_KEEP_MS = 48 * 60 * 60_000;
/** Longest a run can last (runner timeout plus kill grace); bounds a run interrupted by a restart. */
export const PREWARM_MAX_RUN_MS = 65_000;
export const PREWARM_KEEP_RECORDS = 20;
export const PREWARM_MAX_READING_AGE_MS = 10 * 60_000;
export const PREWARM_MIN_GAP_MS = 5 * 60 * 60_000;
/** Longest timer wait: a sleeping Mac stops the timer's clock, so short waits keep `late` close to the wake. */
export const PREWARM_MAX_TIMER_MS = 60_000;

export type PrewarmSkipReason =
	| "running"
	| "stale_reading"
	| "not_counted"
	| "out"
	| "window_open"
	| "recent"
	| "daily_cap"
	| "unknown_account";

export interface PrewarmForecastView {
	available: boolean;
	plan: Plan | null;
}

export interface PrewarmTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

export interface PrewarmLogger {
	info(message: string): void;
	warn(message: string): void;
}

export interface PrewarmSchedulerDeps {
	runner: PrewarmRunner;
	store: Pick<DemandStore, "getMeta" | "setMeta">;
	settings(): ForecastSettings;
	/** The latest forecast; null before the first computation. */
	forecast(): PrewarmForecastView | null;
	/** The latest limit reading per account. */
	limits(): AccountLimits[];
	timeZone(): string;
	/** Longest a run can last; default PREWARM_MAX_RUN_MS. */
	maxRunMs?: number;
	clock: { now(): EpochMs };
	timer: PrewarmTimer;
	logger: PrewarmLogger;
}

export interface PrewarmScheduler {
	/** Called every usage poll and by the scheduler's own timer. Never throws. */
	tick(now: EpochMs): Promise<void>;
	status(): PrewarmStatus;
	/** Resolves when every started run has finished and been recorded. */
	idle(): Promise<void>;
	stop(): void;
}

const iso = (at: EpochMs | null) =>
	at === null ? "none" : new Date(at).toISOString();

const windowOpen = (limits: AccountLimits, now: EpochMs) =>
	limits.fiveHour.resetsAt !== null && limits.fiveHour.resetsAt > now;

const isOut = (limits: AccountLimits, now: EpochMs) =>
	(limits.fiveHour.usedPct >= 100 && windowOpen(limits, now)) ||
	(limits.weekly.usedPct >= 100 &&
		limits.weekly.resetsAt !== null &&
		limits.weekly.resetsAt > now) ||
	(limits.blockedUntil !== null && limits.blockedUntil > now);

const testMarker = (test: { account: string; at: EpochMs }) =>
	`${test.account}|${test.at}`;

function parseArray<T>(raw: string | null, logger: PrewarmLogger, key: string) {
	if (raw === null) return [] as T[];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as T[];
	} catch {
		// fall through
	}
	logger.warn(`forecast prewarm meta unreadable key=${key}`);
	return [] as T[];
}

function parseHistory(
	raw: string | null,
	logger: PrewarmLogger,
): Record<AccountId, EpochMs[]> {
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<AccountId, EpochMs[]> = {};
			for (const [id, times] of Object.entries(parsed))
				if (Array.isArray(times))
					out[id] = times.filter((t): t is number => typeof t === "number");
			return out;
		}
	} catch {
		// fall through
	}
	logger.warn(`forecast prewarm meta unreadable key=${PREWARM_HISTORY_KEY}`);
	return {};
}

export function createPrewarmScheduler(
	deps: PrewarmSchedulerDeps,
): PrewarmScheduler {
	const { runner, store, clock, timer, logger } = deps;
	let records: PrewarmRecord[] = [];
	let testsDone: string[] = [];
	let history: Record<AccountId, EpochMs[]> = {};
	let loaded = false;
	const maxRunMs = deps.maxRunMs ?? PREWARM_MAX_RUN_MS;
	let chain: Promise<void> = Promise.resolve();
	let timerHandle: unknown = null;
	let stopped = false;
	const running = new Map<AccountId, Promise<void>>();
	const doneAt = new Map<PrewarmRecord, EpochMs>();
	const skipsLogged = new Set<string>();

	const serialize = (work: () => Promise<void>) => {
		const next = chain.then(work).catch((error: unknown) => {
			logger.warn(
				`forecast prewarm error ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		chain = next;
		return next;
	};

	const persistRecords = () =>
		store.setMeta(PREWARM_RECORDS_KEY, JSON.stringify(records));

	const load = async () => {
		if (loaded) return;
		records = parseArray<PrewarmRecord>(
			await store.getMeta(PREWARM_RECORDS_KEY),
			logger,
			PREWARM_RECORDS_KEY,
		);
		testsDone = parseArray<string>(
			await store.getMeta(PREWARM_TESTS_KEY),
			logger,
			PREWARM_TESTS_KEY,
		);
		history = parseHistory(await store.getMeta(PREWARM_HISTORY_KEY), logger);
		for (const r of records) {
			const times = history[r.accountId] ?? [];
			if (!times.includes(r.firedAt))
				history[r.accountId] = [...times, r.firedAt];
		}
		loaded = true;
	};

	const nameOf = (accountId: AccountId) =>
		deps.limits().find((l) => l.accountId === accountId)?.name ?? accountId;

	const skip = (
		accountId: AccountId,
		key: string,
		reason: PrewarmSkipReason,
	) => {
		const token = `${accountId}|${key}|${reason}`;
		if (skipsLogged.has(token)) return;
		if (skipsLogged.size >= 500) skipsLogged.clear();
		skipsLogged.add(token);
		logger.info(
			`forecast prewarm skip account=${nameOf(accountId)} reason=${reason}`,
		);
	};

	const fire = async (
		limits: AccountLimits,
		kind: "plan" | "test",
		scheduledAt: EpochMs,
		now: EpochMs,
	) => {
		const record: PrewarmRecord = {
			accountId: limits.accountId,
			kind,
			scheduledAt,
			firedAt: now,
			exitCode: null,
			windowOpened: null,
			resetsAt: null,
		};
		records = [record, ...records].slice(0, PREWARM_KEEP_RECORDS);
		history[record.accountId] = [
			...(history[record.accountId] ?? []),
			now,
		].filter((at) => at > now - PREWARM_HISTORY_KEEP_MS);
		await store.setMeta(PREWARM_HISTORY_KEY, JSON.stringify(history));
		await persistRecords();
		const late = Math.max(0, Math.round((now - scheduledAt) / 1000));
		logger.info(
			`forecast prewarm fire account=${limits.name} kind=${kind} scheduled=${iso(scheduledAt)} late=${late}`,
		);
		const run = runner
			.run(limits.accountId)
			.catch((error: unknown) => ({
				exitCode: null,
				durationMs: 0,
				error: error instanceof Error ? error.message : String(error),
			}))
			.then((result) =>
				serialize(async () => {
					record.exitCode = result.exitCode;
					doneAt.set(record, clock.now());
					await persistRecords();
					logger.info(
						`forecast prewarm done account=${limits.name} exit=${result.exitCode ?? "none"} ms=${Math.round(result.durationMs)}`,
					);
					if (result.error)
						logger.warn(
							`forecast prewarm failed account=${limits.name} error=${result.error}`,
						);
				}),
			)
			.finally(() => running.delete(limits.accountId));
		running.set(limits.accountId, run);
	};

	const settleResults = async (byId: Map<AccountId, AccountLimits>) => {
		let changed = false;
		for (const record of records) {
			if (record.windowOpened !== null) continue;
			if (running.has(record.accountId)) continue;
			const limits = byId.get(record.accountId);
			if (!limits) continue;
			// After a restart the finish time is unknown: wait out the longest possible run.
			const finished = doneAt.get(record) ?? record.firedAt + maxRunMs;
			if (limits.readAt <= finished) continue;
			const resetsAt = limits.fiveHour.resetsAt;
			record.windowOpened = resetsAt !== null && resetsAt > record.firedAt;
			record.resetsAt = record.windowOpened ? resetsAt : null;
			changed = true;
			logger.info(
				`forecast prewarm result account=${limits.name} windowOpened=${record.windowOpened} resetsAt=${iso(record.resetsAt)}`,
			);
		}
		if (changed) await persistRecords();
	};

	const runTest = async (
		settings: ForecastSettings,
		all: AccountLimits[],
		now: EpochMs,
	) => {
		const test = settings.prewarmTest;
		if (!test || now < test.at) return;
		const marker = testMarker(test);
		if (testsDone.includes(marker)) return;
		const limits = all.find(
			(l) => l.accountId === test.account || l.name === test.account,
		);
		if (!limits) {
			skip(test.account, `test|${marker}`, "unknown_account");
			return;
		}
		if (running.has(limits.accountId)) return;
		testsDone = [...testsDone, marker];
		await store.setMeta(PREWARM_TESTS_KEY, JSON.stringify(testsDone));
		if (windowOpen(limits, now)) {
			skip(limits.accountId, `test|${marker}`, "window_open");
			return;
		}
		await fire(limits, "test", test.at, now);
	};

	const planGuard = (
		settings: ForecastSettings,
		limits: AccountLimits | undefined,
		accountId: AccountId,
		now: EpochMs,
	): PrewarmSkipReason | null => {
		if (running.has(accountId)) return "running";
		if (!limits || now - limits.readAt > PREWARM_MAX_READING_AGE_MS)
			return "stale_reading";
		if (!limits.counted) return "not_counted";
		if (isOut(limits, now)) return "out";
		if (windowOpen(limits, now)) return "window_open";
		const mine = history[accountId] ?? [];
		if (mine.some((at) => at > now - PREWARM_MIN_GAP_MS)) return "recent";
		const zone = deps.timeZone();
		const today = localDayKey(now, zone);
		if (
			mine.filter((at) => localDayKey(at, zone) === today).length >=
			settings.prewarmMaxPerDay
		)
			return "daily_cap";
		return null;
	};

	const runPlan = async (
		settings: ForecastSettings,
		byId: Map<AccountId, AccountLimits>,
		now: EpochMs,
	) => {
		if (!settings.prewarm) return;
		const forecast = deps.forecast();
		if (!forecast?.available || !forecast.plan) return;
		const due = Object.entries(forecast.plan.openAt)
			.filter((e): e is [AccountId, EpochMs] => e[1] !== null && e[1] <= now)
			.sort((a, b) => a[1] - b[1]);
		for (const [accountId, openAt] of due) {
			const limits = byId.get(accountId);
			const reason = planGuard(settings, limits, accountId, now);
			if (reason || !limits) {
				skip(accountId, `plan|${openAt}`, reason ?? "stale_reading");
				continue;
			}
			await fire(limits, "plan", openAt, now);
		}
	};

	const arm = (settings: ForecastSettings, now: EpochMs) => {
		if (timerHandle !== null) timer.clear(timerHandle);
		timerHandle = null;
		if (stopped) return;
		const upcoming: EpochMs[] = [];
		const test = settings.prewarmTest;
		if (test && test.at > now && !testsDone.includes(testMarker(test)))
			upcoming.push(test.at);
		const plan = settings.prewarm ? deps.forecast()?.plan : null;
		if (plan)
			for (const at of Object.values(plan.openAt))
				if (at !== null && at > now) upcoming.push(at);
		if (upcoming.length === 0) return;
		const delay = Math.min(Math.min(...upcoming) - now, PREWARM_MAX_TIMER_MS);
		timerHandle = timer.set(() => {
			timerHandle = null;
			void scheduler.tick(clock.now());
		}, delay);
	};

	const scheduler: PrewarmScheduler = {
		tick(now) {
			return serialize(async () => {
				if (stopped) return;
				await load();
				const settings = deps.settings();
				const all = deps.limits();
				const byId = new Map(all.map((l) => [l.accountId, l]));
				await settleResults(byId);
				await runTest(settings, all, now);
				await runPlan(settings, byId, now);
				arm(settings, now);
			});
		},
		status() {
			const settings = deps.settings();
			const forecast = deps.forecast();
			const planned =
				settings.prewarm && forecast?.available && forecast.plan
					? Object.entries(forecast.plan.openAt)
							.filter((e): e is [AccountId, EpochMs] => e[1] !== null)
							.map(([accountId, openAt]) => ({ accountId, openAt }))
							.sort((a, b) => a.openAt - b.openAt)
					: [];
			return {
				enabled: settings.prewarm,
				planned,
				last: records.map((r) => ({ ...r })),
			};
		},
		async idle() {
			for (;;) {
				const current = chain;
				await current;
				if (running.size > 0) {
					await Promise.all([...running.values()]);
					continue;
				}
				if (current === chain) return;
			}
		},
		stop() {
			stopped = true;
			if (timerHandle !== null) timer.clear(timerHandle);
			timerHandle = null;
		},
	};
	return scheduler;
}
