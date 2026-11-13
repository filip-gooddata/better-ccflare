import type {
	AccountLimits,
	EpochMs,
	ForecastSettings,
	Plan,
	PrewarmRunner,
	PrewarmRunResult,
} from "../../types";
import type {
	PrewarmForecastView,
	PrewarmSchedulerDeps,
	PrewarmTimer,
} from "../scheduler";

export const MIN = 60_000;
export const H = 60 * MIN;
export const z = (iso: string) => Date.parse(iso);
/** 07:00 in Prague on a Thursday. */
export const T0 = z("2026-11-12T06:00:00Z");

export function settings(
	over: Partial<ForecastSettings> = {},
): ForecastSettings {
	return {
		enabled: true,
		routing: false,
		prewarm: false,
		prewarmTest: null,
		claudePath: null,
		prewarmModel: "haiku",
		prewarmMaxPerDay: 2,
		simulatedDays: 200,
		timeShiftMin: 30,
		transcriptsDir: null,
		fanLevels: [],
		minStopPoints: 1,
		moveMinGainPoints: 2,
		openMinGainPoints: 2,
		historyHalfLifeDays: 14,
		historyLookbackDays: 56,
		recentTauMin: 60,
		sessionTurnoverMin: 90,
		workStartSharePct: 5,
		...over,
	};
}

export function limits(
	accountId: string,
	readAt: EpochMs,
	over: Partial<AccountLimits> = {},
): AccountLimits {
	return {
		accountId,
		name: `name-${accountId}`,
		counted: true,
		fiveHour: { usedPct: 0, resetsAt: null },
		weekly: { usedPct: 10, resetsAt: readAt + 3 * 24 * H },
		fable: null,
		blockedUntil: null,
		readAt,
		...over,
	};
}

export function plan(openAt: Plan["openAt"], computedAt = T0): Plan {
	return {
		computedAt,
		openAt,
		placement: null,
		moves: [],
		workStartMinute: null,
	};
}

export class FakeStore {
	meta = new Map<string, string>();
	async getMeta(key: string) {
		return this.meta.get(key) ?? null;
	}
	async setMeta(key: string, value: string) {
		this.meta.set(key, value);
	}
}

export class FakeTimer implements PrewarmTimer {
	pending: { callback: () => void; delayMs: number; id: number }[] = [];
	private next = 1;
	set(callback: () => void, delayMs: number) {
		const id = this.next++;
		this.pending.push({ callback, delayMs, id });
		return id;
	}
	clear(handle: unknown) {
		this.pending = this.pending.filter((p) => p.id !== handle);
	}
	fire() {
		const due = this.pending;
		this.pending = [];
		for (const p of due) p.callback();
	}
}

export class FakeRunner implements PrewarmRunner {
	calls: string[] = [];
	result: PrewarmRunResult = { exitCode: 0, durationMs: 1234, error: null };
	private waiting: (() => void)[] = [];
	hold = false;
	async run(accountId: string) {
		this.calls.push(accountId);
		if (this.hold) await new Promise<void>((r) => this.waiting.push(r));
		return this.result;
	}
	release() {
		for (const r of this.waiting.splice(0)) r();
	}
}

export interface World {
	runner: FakeRunner;
	store: FakeStore;
	timer: FakeTimer;
	lines: string[];
	warnings: string[];
	clock: { at: EpochMs };
	state: {
		settings: ForecastSettings;
		forecast: PrewarmForecastView | null;
		limits: AccountLimits[];
	};
	deps: PrewarmSchedulerDeps;
}

export function world(over: Partial<World["state"]> = {}): World {
	const runner = new FakeRunner();
	const store = new FakeStore();
	const timer = new FakeTimer();
	const lines: string[] = [];
	const warnings: string[] = [];
	const clock = { at: T0 };
	const state: World["state"] = {
		settings: settings(),
		forecast: null,
		limits: [],
		...over,
	};
	const deps: PrewarmSchedulerDeps = {
		runner,
		store,
		settings: () => state.settings,
		forecast: () => state.forecast,
		limits: () => state.limits,
		timeZone: () => "Europe/Prague",
		clock: { now: () => clock.at },
		timer,
		logger: {
			info: (m) => lines.push(m),
			warn: (m) => warnings.push(m),
		},
	};
	return { runner, store, timer, lines, warnings, clock, state, deps };
}
