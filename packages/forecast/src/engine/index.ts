/**
 * The forecast engine: createForecastEngine() is the entry point; the rest are the building
 * blocks the tests and the service need. Generic names carry an engine prefix so that the
 * package index (which re-exports every forecast directory) cannot collide.
 */
export { calibrate as calibrateAccounts } from "./calibration";
export { buildDayTable, historyAvailable, workStartMinute } from "./days";
export {
	createForecastEngine,
	type ForecastEngineOptions,
	prepareEngineContext,
} from "./engine";
export { computeHorizon as computeEngineHorizon } from "./horizon";
export type {
	DayTable as EngineDayTable,
	EngineContext,
	Horizon as EngineHorizon,
	Scenarios as EngineScenarios,
	SimulationResult as EngineSimulationResult,
} from "./model";
export { type PlanScore as EnginePlanScore, planForecast } from "./planner";
export {
	buildResponse as buildForecastResponse,
	unavailableResponse as unavailableForecastResponse,
} from "./response";
export { buildScenarios, scaleBandwidth } from "./scenarios";
export {
	type DayRanking as EngineDayRanking,
	MEDIAN_DAY_WINDOW,
	rankDays as rankEngineDays,
	serveDay as serveEngineDay,
} from "./served-day";
export {
	onDemandPlan,
	type SimPlan as EngineSimPlan,
	simulate as simulatePlan,
} from "./simulate";
