/**
 * Two forecast computations start at least this far apart. The service schedules by it; the
 * engine derives the planner's compute budget and the plan job's timeout from it.
 */
export const FORECAST_MIN_SPACING_MS = 30_000;
