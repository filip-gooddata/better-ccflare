# Forecast engine

Pure TypeScript: no IO, no clock, and no randomness except one seeded generator. `createForecastEngine()`
returns a `ForecastEngine`. Its `compute(input)` produces the `/api/forecast` response and the plan. It never
throws: any failure becomes `available: false, reason: "error"` with the spec's no-forecast shape, and the
error text stays out of the response. `createForecastEngine({ noise: false })` turns the kernel noise off.
It exists only to measure what the noise does to the heavy line.

## Stages (`engine.ts`)

1. **Day table** (`days.ts`). History is cut into local days, and each day is typed `monday`, `workday` or
   `weekend`. Each recorded day gets the recency weight 0.5^(age ÷ half-life), so the profile is a
   recency-weighted profile by day type.
2. **Availability** (`days.ts` `historyAvailable`, plus the checks in `engine.ts`). There is no forecast
   with fewer than 5 recorded days, with fewer than 3 days in today's pool, with no counted account, or
   when a counted account lacks a 5-hour or weekly k.
3. **Calibration** (`calibration.ts`). A ratio-of-sums estimator gives points per demand unit for each
   account and limit, over the window instances of the usage readings.
4. **Scenarios** (`scenarios.ts`). A smoothed bootstrap resamples whole recorded days, weighted by recency.
   It adds kernel noise on scale: exp(ε) with ε ~ N(0, h²), where h comes from the normal-reference
   (Silverman) bandwidth rule on the log daily totals. It adds kernel noise on time: a uniform whole-bucket
   shift within ±`timeShiftMin`. Today is scaled by the call-centre intraday day-factor update
   a = (Y + c) ÷ (M + c). The last hour's rate is blended in with an exponentially decaying weight
   e^(−h/τ). The generator is seeded from the local day key.
5. **Planner** (`planner.ts`, `simulate.ts`, `move-cost.ts`). This is a scenario-based receding-horizon
   search over openings, order and at most one move. Each candidate is a simulated depletion of every
   account, with refill jumps at resets. Candidates get a leximin score on the lowest point of the heavy
   (p90-of-demand) lines.
6. **Response** (`response.ts`, `stops.ts`, `past.ts`). Pointwise percentile lines (`percentile.ts`),
   stops, `stopNow`, shortfall, Fable `outAt`, and the past series.

`compute` yields to the event loop between stages, and the stages yield inside: between blocks of simulated
days and between candidate plans.

## Empty pool

When a date's pool is empty after the `monday`/`workday` merge, the scenarios draw from all recorded days.
That leans toward more demand. The planner plans against the heavy day, so erring that way is the safe
side.

## Named constants

| Constant | Value | File |
|---|---|---|
| `MIN_RECORDED_DAYS`, `MIN_POOL_DAYS` | 5, 3 | `days.ts` |
| `RECENT_WINDOW_MS`, `WORK_START_RECENT_DAYS`, `DEFAULT_WORK_START_SHARE_PCT` | 60 min, 10 days, 5 % | `days.ts` |
| `MIN_CALIBRATION_POINTS`, `MIN_CALIBRATION_UNITS` | 5, 0 | `calibration.ts` |
| `SILVERMAN_FACTOR`, `NORMAL_IQR_SD` | 1.06, 1.34 | `scenarios.ts` |
| `DAY_FACTOR_PRIOR_SHARE`, `DAY_FACTOR_MIN`, `DAY_FACTOR_MAX` | 0.25, 0.25, 4 | `scenarios.ts` |
| `SIMULATED_DAYS_PER_YIELD` | 25 | `scenarios.ts` |
| `FINE_STEP_MS`, `COARSE_STEP_MS`, `DAYS_PER_SLICE`, `FULL_POINTS` | 5 min, 1 h, 20, 100 − 1e-9 | `simulate.ts` |
| `ONE_HOUR_LIFETIME_FROM_MS` | 30 min | `move-cost.ts` |
| `HEAVY_LEVEL`, `TYPICAL_LEVEL`, `ZERO_LINE_POINTS`, `SCORE_EPS` | 90, 50, 0.05, 1e-9 | `planner.ts` |
| `OPEN_AHEAD_MIN`, `OPEN_BEFORE_WORK_START_MIN` | 0–240 min ahead; 300–60 min before work start | `planner.ts` |
| `OPENING_BEAM`, `MAX_OPENING_COMBOS`, `MAX_MOVE_SESSIONS` | 3, 64, 3 | `planner.ts` |
| `TIER_TOLERANCE_POINTS`, `TIER_TOLERANCE_STOP_MIN`, `REASON_MIN_GAIN_POINTS` | 0.5, 5 min, 0.05 | `planner.ts` |
| `OPEN_MIN_STOP_GAIN_MIN` | 5 min (one simulation step) | `planner.ts` |
| `ZERO_POINTS` | 0.05 | `stops.ts` |
| `WEEK_PAST_SPACING_MS` | 30 min | `past.ts` |

The user-facing knobs (`simulatedDays`, `timeShiftMin`, `recentTauMin`, `sessionTurnoverMin`,
`openMinGainPoints`, `moveMinGainPoints`, `minStopPoints`, `fanLevels`, history half-life and lookback)
are `ForecastSettings`, not constants.

Opening ahead of need (`openingEarns`, amendment A2): a window opens early when that raises score item 1
by `openMinGainPoints`, or when items 1 and 2 tie within `TIER_TOLERANCE_POINTS` and the heavy stop
minutes fall by at least `OPEN_MIN_STOP_GAIN_MIN`. The placement reason is then `open-ahead+<points>` or
`open-ahead-stop-<minutes>min`.

Learned work start (`workStartMinute`, amendment A3): the median, over the last `WORK_START_RECENT_DAYS`
work days with demand, of the local minute at which the day's cumulative demand first reaches
`workStartSharePct` percent (setting, default 5) of its total, taken as the start of that 5-minute bucket.
A stray overnight request no longer sets the work start.

## Index

`index.ts` exports the entry point and the building blocks. Generic names carry an engine prefix
(`simulatePlan`, `calibrateAccounts`, `EngineScenarios`, ...) because the package index re-exports every
forecast directory.
