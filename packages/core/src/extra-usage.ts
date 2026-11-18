/**
 * Retired "use extra usage" flag. Nothing in the server sets it any more and
 * routing must not read it: an account at 100% of its five-hour, weekly or
 * model-family limit is out until that limit resets, whatever extra usage or
 * spend says. The config still stores the value (see Config.getUseExtraUsage)
 * and warns at start when it is on. The exports stay until every reader is
 * gone; the flag stays false in a running server.
 */
let useExtraUsage = false;

/** Test seam only; the server never calls it. */
export function setUseExtraUsage(value: boolean): void {
	useExtraUsage = value;
}

/** Always false in a running server. Gates nothing. */
export function isUseExtraUsageEnabled(): boolean {
	return useExtraUsage;
}
