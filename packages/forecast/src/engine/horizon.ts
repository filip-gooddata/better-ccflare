import { addLocalDays, localDayStart, localWeekStart } from "../time";
import type { AccountLimits, EpochMs } from "../types";
import { WEEK_MS } from "../types";
import type { Horizon } from "./model";

const DAY_MS = 86_400_000;

/**
 * Time limits of the projection. The week block ends at the later of Friday 24:00 local and the
 * last weekly reset of a counted account, at most 7 days ahead. When neither lies ahead (a weekend
 * with no known weekly reset), it ends at the next Friday 24:00, still at most 7 days ahead.
 */
export function computeHorizon(
	now: EpochMs,
	counted: AccountLimits[],
	timeZone: string,
): Horizon {
	const dayEnd = addLocalDays(localDayStart(now, timeZone), 1, timeZone);
	const fridayEnd = addLocalDays(localWeekStart(now, timeZone), 5, timeZone);
	let lastReset = 0;
	for (const account of counted) {
		const resetsAt = account.weekly.resetsAt;
		if (resetsAt !== null && resetsAt > now && resetsAt > lastReset)
			lastReset = resetsAt;
	}
	const latest = Math.max(fridayEnd, lastReset);
	const weekEnd = Math.min(
		now + WEEK_MS,
		latest > now ? latest : addLocalDays(fridayEnd, 7, timeZone),
	);
	const fineEnd = now + DAY_MS;
	return { now, dayEnd, fineEnd, weekEnd, simEnd: Math.max(fineEnd, weekEnd) };
}
