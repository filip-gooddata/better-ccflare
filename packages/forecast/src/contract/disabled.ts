import {
	type EpochMs,
	FORECAST_CONTRACT_VERSION,
	type ForecastResponse,
} from "../types";
import { NAMED_LEVELS } from "./levels";

/**
 * The spec's "no forecast" shape with `reason: "disabled"`: served when the
 * forecast is switched off or nothing provides one. Carries no `prewarm`,
 * which the spec only promises while the forecast is switched on.
 */
export function disabledForecastResponse(
	computedAt: EpochMs,
): ForecastResponse {
	return {
		contractVersion: FORECAST_CONTRACT_VERSION,
		computedAt: Math.floor(computedAt),
		available: false,
		reason: "disabled",
		accounts: [],
		levels: { ...NAMED_LEVELS },
		day: null,
		week: null,
		fable: {},
	};
}
