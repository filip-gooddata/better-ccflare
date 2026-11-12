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
 * shape with `reason: "error"`.
 */
export function createForecastHandler(
	getSettings: () => Pick<ForecastSettings, "enabled">,
	getForecast: ForecastProvider | undefined,
	now: () => number = Date.now,
): () => Response {
	return () => {
		if (!getSettings().enabled || !getForecast)
			return noStore(disabledForecastResponse(now()));
		try {
			return noStore(getForecast());
		} catch (error) {
			log.warn(
				`Forecast provider failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return noStore({ ...disabledForecastResponse(now()), reason: "error" });
		}
	};
}
