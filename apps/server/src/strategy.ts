import {
	LeastUsedStrategy,
	SessionAffinityStrategy,
	SessionDrainSoonestStrategy,
	type SessionPaceOptions,
	SessionPaceStrategy,
	SessionStrategy,
} from "@better-ccflare/load-balancer";
import {
	type LoadBalancingStrategy,
	type SessionPaceSettings,
	StrategyName,
} from "@better-ccflare/types";

/**
 * Build a load-balancing strategy from its enum name. Add new strategies here
 * as additional cases. Falls back to SessionStrategy on unknown values.
 */
export function buildStrategy(
	name: StrategyName,
	sessionDurationMs: number,
	paceOptions?: Partial<SessionPaceOptions>,
): LoadBalancingStrategy {
	switch (name) {
		case StrategyName.LeastUsed:
			return new LeastUsedStrategy();
		case StrategyName.SessionAffinity:
			return new SessionAffinityStrategy(sessionDurationMs);
		case StrategyName.SessionDrainSoonest:
			return new SessionDrainSoonestStrategy(sessionDurationMs);
		case StrategyName.SessionDrainSoonestStrict:
			return new SessionDrainSoonestStrategy(sessionDurationMs, "strict");
		case StrategyName.SessionPace:
			return new SessionPaceStrategy(paceOptions);
		default:
			return new SessionStrategy(sessionDurationMs);
	}
}

export interface SessionPaceConfig {
	getSessionPaceFiveHourGuardPct(): number;
	getSessionPaceFamilyGuardPct(): number;
	getSessionPaceTieBandPct(): number;
	getSessionPaceIdleMs(): number;
	getSessionPaceWorkDays(): number;
}

export function sessionPaceOptionsFrom(
	config: SessionPaceConfig,
): SessionPaceOptions {
	return {
		fiveHourGuardPct: config.getSessionPaceFiveHourGuardPct(),
		familyGuardPct: config.getSessionPaceFamilyGuardPct(),
		tieBandPct: config.getSessionPaceTieBandPct(),
		idleMs: config.getSessionPaceIdleMs(),
		workDays: config.getSessionPaceWorkDays(),
	};
}

/**
 * The session-pace settings in effect: the running instance's own values
 * while session-pace runs, so a setting it has not picked up is not reported;
 * otherwise what buildStrategy would give it now, in the zone the process
 * read at start.
 */
export function sessionPaceSettings(
	current: LoadBalancingStrategy | null,
	config: SessionPaceConfig,
	startTimeZone: string,
): SessionPaceSettings {
	const running = current instanceof SessionPaceStrategy ? current : null;
	const options = running?.options ?? sessionPaceOptionsFrom(config);
	return {
		workDays: running?.paceBasis.workDays ?? options.workDays,
		familyGuardPct: options.familyGuardPct,
		fiveHourGuardPct: options.fiveHourGuardPct,
		tieBandPct: options.tieBandPct,
		idleMs: options.idleMs,
		timeZone: running?.paceBasis.timeZone ?? startTimeZone,
	};
}
