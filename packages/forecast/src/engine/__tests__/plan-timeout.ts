/**
 * Per-test limit for a test that runs compute() or planForecast without a deadline. Every plan
 * simulates the planner's mandatory singles: now and every local quarter hour to the 24 h fine
 * horizon, plus the 5-minute marks around each peak, for each closed account and over every
 * simulated day (about 130 plans of 400 days for one closed account, against 9 to 14 before the
 * grid). Under a loaded full suite one such compute takes from seconds to minutes.
 */
export const FULL_GRID_TIMEOUT_MS = 600_000;
