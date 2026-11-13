import {
	disabledForecastResponse,
	type ForecastResponse,
	type ForecastSettings,
} from "@better-ccflare/forecast";
import { Logger } from "@better-ccflare/logger";
import type { ForecastProvider } from "../types";

const log = new Logger("ForecastHandler");

function noStore(body: ForecastResponse): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

/**
 * GET /api/forecast: serves what the provider returns (the forecast kept
 * from the last computation) and never computes anything itself. Without a
 * provider, or with the forecast switched off, it serves the "no forecast"
 * shape with `reason: "disabled"`. A provider that throws gives the same
 * shape with `reason: "error"`. While the forecast is switched on, every
 * fallback carries `prewarm` (the spec promises it then) with empty lists and
 * `enabled` from the current setting. The handler holds no state: the
 * provider owns the pre-warm diagnostics.
 */
export function createForecastHandler(
	getSettings: () => Pick<ForecastSettings, "enabled" | "prewarm">,
	getForecast: ForecastProvider | undefined,
	now: () => number = Date.now,
): () => Response {
	return () => {
		const settings = getSettings();
		if (!settings.enabled) return noStore(disabledForecastResponse(now()));
		const fallback = (reason: "disabled" | "error"): Response =>
			noStore({
				...disabledForecastResponse(now()),
				reason,
				prewarm: { enabled: settings.prewarm, planned: [], last: [] },
			});
		if (!getForecast) return fallback("disabled");
		try {
			return noStore(getForecast());
		} catch (error) {
			log.warn(
				`Forecast provider failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return fallback("error");
		}
	};
}
