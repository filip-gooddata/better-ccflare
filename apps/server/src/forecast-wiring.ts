/**
 * Connects the interruption forecast to the running server: the session
 * tracker behind the proxy's served-usage sink, the forecast service driven by
 * usage snapshots, the pre-warm scheduler, the advisor for session-pace and
 * the `/api/forecast` provider.
 *
 * Every outside dependency is a port so the whole wiring runs in tests with a
 * sandbox database, a fake runner and fake timers. Only server.ts passes the
 * real `claude` CLI runner.
 */
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type AccountId,
	type AccountLimits,
	createDemandStore,
	createForecastEngine,
	createForecastService,
	createPrewarmScheduler,
	createSessionTracker,
	type EpochMs,
	type ForecastAdvisor,
	type ForecastInput,
	type ForecastResponse,
	type ForecastResult,
	type ForecastService,
	type ForecastSettings,
	type LimitState,
	type PaceContext,
	type PrewarmRunner,
	type ServedEvent,
	type SessionTrackerLike,
} from "@better-ccflare/forecast";
import { Logger } from "@better-ccflare/logger";
import {
	type AnyUsageData,
	extractFiveHourWindow,
	extractModelFamilyWindows,
	extractWeeklyWindow,
	type UsageData,
} from "@better-ccflare/providers";
import {
	type Account,
	isEligibleForReauthDeadline,
} from "@better-ccflare/types";

export interface ForecastTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface ForecastWiringLogger {
	info(msg: string): void;
	warn(msg: string): void;
}

/** What the runner factory gets; it is called once, on the first pre-warm. */
export interface ForecastRunnerContext {
	settings(): ForecastSettings;
	proxyPort: number;
	proxyApiKey: () => string | null;
}

export interface ForecastWiringPorts {
	config: {
		getForecastSettings(): ForecastSettings;
		getUsagePollIntervalMs(): number;
	};
	dbOps: DatabaseOperations;
	usage: { get(accountId: string): AnyUsageData | null };
	/** Session-pace values in effect (config values while another strategy runs). */
	pace(): PaceContext;
	/** The proxy's bound port; read when the first pre-warm runs, after the server listens. */
	proxyPort(): number;
	/** Key the pre-warm CLI sends to the proxy; null = none. */
	proxyApiKey?: () => string | null;
	createRunner(context: ForecastRunnerContext): PrewarmRunner;
	engine?: { compute(input: ForecastInput): Promise<ForecastResult> };
	tracker?: SessionTrackerLike;
	clock?: { now(): EpochMs };
	timer?: ForecastTimer;
	logger?: ForecastWiringLogger;
}

/** The part of a strategy the wiring talks to (SessionPaceStrategy has it). */
interface AdvisableStrategy {
	setForecastAdvisor(advisor: ForecastAdvisor | null): void;
}

export interface ForecastWiring {
	service: ForecastService | null;
	/** For `initProxy`; the proxy's served-usage event has this shape. */
	servedUsageSink: ((event: ServedEvent) => void) | undefined;
	provider: (() => ForecastResponse) | undefined;
	/** Give session-pace the advisor (routing on at start-up); other strategies get nothing. */
	attachToStrategy(strategy: unknown): void;
	/** Called after every recorded usage snapshot of a Claude account. */
	onUsageSnapshot(accountId: string): void;
	stop(): Promise<void>;
}

/** Longest shutdown waits for a pre-warm run in flight before the database closes. */
export const FORECAST_SHUTDOWN_PREWARM_WAIT_MS = 5_000;

const unrefTimer: ForecastTimer = {
	set(fn, ms) {
		const handle = setTimeout(fn, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

function hasAdvisorSetter(strategy: unknown): strategy is AdvisableStrategy {
	return (
		typeof strategy === "object" &&
		strategy !== null &&
		typeof (strategy as Partial<AdvisableStrategy>).setForecastAdvisor ===
			"function"
	);
}

/** A genuine Claude (Anthropic OAuth) account, the criterion the demand sync uses. */
export function isClaudeOAuthAccount(
	account: Pick<Account, "provider" | "refresh_token" | "access_token">,
): boolean {
	return isEligibleForReauthDeadline({
		provider: account.provider,
		refreshToken: account.refresh_token,
		accessToken: account.access_token,
	});
}

const CLOSED: LimitState = { usedPct: 0, resetsAt: null };

/** A window whose reset has passed counts as closed (nothing used, no reset). */
function limitState(
	window: { utilization: number; resetsAt: number | null } | null | undefined,
	now: EpochMs,
): LimitState {
	if (!window) return CLOSED;
	if (window.resetsAt !== null && window.resetsAt <= now) return CLOSED;
	return { usedPct: window.utilization, resetsAt: window.resetsAt };
}

function fableWindow(data: AnyUsageData, now: EpochMs): LimitState | null {
	const flat = (data as UsageData).seven_day_fable;
	if (flat && typeof flat.utilization === "number") {
		const resetMs = flat.resets_at ? new Date(flat.resets_at).getTime() : NaN;
		return limitState(
			{
				utilization: flat.utilization,
				resetsAt: Number.isFinite(resetMs) ? resetMs : null,
			},
			now,
		);
	}
	const scoped = extractModelFamilyWindows(data, "anthropic", "fable")[0];
	return scoped ? limitState(scoped, now) : null;
}

/**
 * Current limits of every Claude OAuth account from the accounts table and
 * the usage cache. Counted = not paused and no re-authentication pending; an
 * account without a cached reading has both windows closed.
 */
export async function loadClaudeLimits(
	dbOps: Pick<DatabaseOperations, "getAllAccounts">,
	usage: { get(accountId: string): AnyUsageData | null },
	now: EpochMs,
): Promise<AccountLimits[]> {
	const accounts = await dbOps.getAllAccounts();
	return accounts.filter(isClaudeOAuthAccount).map((account) => {
		const data = usage.get(account.id);
		const cooldown = account.rate_limited_until;
		return {
			accountId: account.id as AccountId,
			name: account.name,
			counted: !account.paused && !account.requires_reauth,
			fiveHour: data
				? limitState(extractFiveHourWindow(data, "anthropic"), now)
				: CLOSED,
			weekly: data
				? limitState(extractWeeklyWindow(data, "anthropic"), now)
				: CLOSED,
			fable: data ? fableWindow(data, now) : null,
			blockedUntil: cooldown != null && cooldown > now ? cooldown : null,
			readAt: now,
		};
	});
}

const DISABLED: ForecastWiring = {
	service: null,
	servedUsageSink: undefined,
	provider: undefined,
	attachToStrategy: () => {},
	onUsageSnapshot: () => {},
	stop: async () => {},
};

/**
 * Build the forecast from the settings at start-up. Disabled: nothing is
 * constructed (no tracker, service, scheduler or timer); changing `enabled`
 * needs a restart.
 */
export function createForecastWiring(
	ports: ForecastWiringPorts,
): ForecastWiring {
	const settings = () => ports.config.getForecastSettings();
	const startSettings = settings();
	if (!startSettings.enabled) return DISABLED;

	const logger = ports.logger ?? new Logger("Forecast");
	const clock = ports.clock ?? { now: () => Date.now() };
	const timer = ports.timer ?? unrefTimer;
	const proxyApiKey = ports.proxyApiKey ?? (() => null);
	const tracker = ports.tracker ?? createSessionTracker();
	const store = createDemandStore({ db: ports.dbOps });

	let realRunner: PrewarmRunner | null = null;
	const runner: PrewarmRunner = {
		run(accountId) {
			realRunner ??= ports.createRunner({
				settings,
				proxyPort: ports.proxyPort(),
				proxyApiKey,
			});
			return realRunner.run(accountId);
		},
	};

	let service: ForecastService | null = null;
	const scheduler = createPrewarmScheduler({
		runner,
		store,
		settings,
		forecast: () => service?.forecastView() ?? null,
		limits: () => service?.limits() ?? [],
		timeZone: () => ports.pace().timeZone,
		clock,
		timer,
		logger,
	});
	const created = createForecastService({
		settings,
		pace: () => ports.pace(),
		db: ports.dbOps,
		store,
		engine: ports.engine ?? createForecastEngine(),
		tracker,
		loadLimits: (now) => loadClaudeLimits(ports.dbOps, ports.usage, now),
		scheduler,
		clock,
		timer,
		pollIntervalMs: ports.config.getUsagePollIntervalMs(),
		logger,
	});
	service = created;

	const routingAtStart = startSettings.routing;
	return {
		service: created,
		servedUsageSink: (event) => tracker.observe(event),
		provider: created.provider,
		attachToStrategy(strategy) {
			if (!hasAdvisorSetter(strategy)) return;
			strategy.setForecastAdvisor(routingAtStart ? created.advisor : null);
		},
		onUsageSnapshot() {
			created.notifyUsagePoll();
		},
		async stop() {
			await created.stop();
			let handle: unknown;
			await Promise.race([
				scheduler.idle(),
				new Promise<void>((resolve) => {
					handle = unrefTimer.set(resolve, FORECAST_SHUTDOWN_PREWARM_WAIT_MS);
				}),
			]);
			unrefTimer.clear(handle);
		},
	};
}
