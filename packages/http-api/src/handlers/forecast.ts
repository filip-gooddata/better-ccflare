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
 * fallback carries `prewarm` (the spec promises it then): the diagnostics of
 * the last response the provider gave, or empty lists, with `enabled` set
 * from the current setting.
 */
export function createForecastHandler(
	getSettings: () => Pick<ForecastSettings, "enabled" | "prewarm">,
	getForecast: ForecastProvider | undefined,
	now: () => number = Date.now,
): () => Response {
	let lastPrewarm: ForecastResponse["prewarm"];
	return () => {
		const settings = getSettings();
		if (!settings.enabled) return noStore(disabledForecastResponse(now()));
		const fallback = (reason: "disabled" | "error"): Response =>
			noStore({
				...disabledForecastResponse(now()),
				reason,
				prewarm: {
					planned: [],
					last: [],
					...lastPrewarm,
					enabled: settings.prewarm,
				},
			});
		if (!getForecast) return fallback("disabled");
		try {
			const response = getForecast();
			if (response.prewarm) lastPrewarm = response.prewarm;
			return noStore(response);
		} catch (error) {
			log.warn(
				`Forecast provider failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return fallback("error");
		}
	};
}
