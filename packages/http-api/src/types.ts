// Re-export all types from the centralized types package
export type {
	AccountDeleteRequest,
	AccountResponse,
	AnalyticsResponse,
	CacheInsightsResponse,
	CacheInsightsRow,
	CleanupResponse,
	ConfigResponse,
	HealthResponse,
	IntegrityStatus,
	ModelPerformance,
	PoolStatus,
	RequestResponse,
	RetentionGetResponse,
	RetentionSetRequest,
	RetentionStatus,
	StatsResponse,
	StrategyUpdateRequest,
	TimePoint,
	TokenBreakdown,
	VacuumStatus,
} from "@better-ccflare/types";

import type { ForecastResponse } from "@better-ccflare/forecast";
import type { APIContext as BaseAPIContext } from "@better-ccflare/types";

/** Returns the forecast kept from the last computation; never computes. */
export type ForecastProvider = () => ForecastResponse;

/**
 * The router context: the shared APIContext plus the optional forecast
 * provider, which the server registers once the forecast service runs.
 */
export interface APIContext extends BaseAPIContext {
	getForecast?: ForecastProvider;
}
