# Forecast engine

Pure TypeScript: no IO, no clock, and no randomness except one seeded generator. `createForecastEngine()`
returns a `ForecastEngine`. Its `compute(input)` produces the `/api/forecast` response and the plan. It never
throws: any failure becomes `available: false, reason: "error"` with the spec's no-forecast shape, and the
error text stays out of the response. The kernel noise is the shrunk kernel by default (the only mode the
service uses). `createForecastEngine({ noiseMode: "unshrunk" })` gives the previous plain kernel and
`{ noiseMode: "off" }` (or `{ noise: false }`) plain resampling. They exist only to measure what the noise
does to the heavy line; `noiseMode` wins over `noise`, and `noise: true` or absent means shrunk.

## Stages (`engine.ts`)

1. **Day table** (`days.ts`). History is cut into local days, and each day is typed `monday`, `workday` or
   `weekend`. Each recorded day gets the recency weight 0.5^(age ÷ half-life), so the profile is a
   recency-weighted profile by day type.
2. **Availability** (`days.ts` `historyAvailable`, plus the checks in `engine.ts`). There is no forecast
   with fewer than 5 recorded days, with fewer than 3 days in today's pool, with no counted account, or
   when a counted account lacks a 5-hour or weekly k. The result then carries `detail`: the rule that
   answered and its numbers, which the service logs (`service/log-lines.ts`); the response never has it.
3. **Calibration** (`calibration.ts`). A ratio-of-sums estimator gives points per demand unit for each
   account and limit, over the window instances of the usage readings. A window instance is a run of
   consecutive readings whose reset time lies within `RESET_TIME_TOLERANCE_MS` (60 s) of the run's first
   reading and whose level never falls: the upstream sends one window's reset time with sub-second
   jitter, and a fall inside a window means its counter was reset. Both calibrations, and with them the
   weekly cap ratio r = k5 ÷ kW, are recomputed at every computation from the stored readings of the last
   56 days with a 14-day half-life (`historyLookbackDays`, `historyHalfLifeDays`). After a step change by
   the provider they have moved half-way in about 10 to 13 days and 90 % of the way in about 5 weeks, each
   limit on its own (`__tests__/calibration-step.test.ts`: r half-way 240–246 h, 90 % 822–828 h; kW 318–324 h
   and 924–942 h; k5 312 h and 906 h).
4. **Scenarios** (`scenarios.ts`). A smoothed bootstrap resamples whole recorded days, weighted by recency.
   It adds kernel noise on scale by the shrunk (variance-preserving) smoothed bootstrap of Silverman and
   Young (1987), "The bootstrap: to smooth or not to smooth?", Biometrika 74(3), 469–479 (also Silverman
   1986, Density Estimation for Statistics and Data Analysis, section 6.4.1): a drawn day with log total
   L_I is multiplied by exp(L* − L_I), L* = m + (L_I − m + h·ε) ÷ √(1 + h²/s²), ε ~ N(0, 1). h comes from
   the normal-reference (Silverman) bandwidth rule on the log daily totals; m and s² are the mean and
   variance of the log totals under the draw's own recency weights (s² = Σw·(L − m)² ÷ Σw), so the
   simulated log totals keep the resampled m and s² instead of widening to s² + h². Zero-total days have
   no logarithm: they are left out of h, m and s², and a drawn zero-total day stays 0 with no scale noise.
   A pool with h = 0 or s² = 0 gets no scale noise. The unshrunk mode multiplies by exp(h·ε) instead.
   In both kernel modes it adds kernel noise on time: a uniform whole-bucket
   shift within ±`timeShiftMin`. Today is scaled by the call-centre intraday day-factor update with an
   evidence weight (design amendment 4): Y is today's units since local midnight, M the pool's weighted
   mean units over the same clock span, c = `DAY_FACTOR_PRIOR_SHARE` × the pool's weighted mean daily
   total (the pool is today's, so a weekend day uses the weekend pool); a_cl = (Y + c) ÷ (M + c) clamped
   to [`DAY_FACTOR_MIN`, `DAY_FACTOR_MAX`], w = min(1, M ÷ c), and a = 1 + (a_cl − 1) × w. The ratio
   assumes that demand so far is proportional to the day's demand; in a span where the pool has almost
   no demand (a night) usage says nothing about the rest of the day, yet the ratio is at its most
   extreme, so its effect grows with the pool's own evidence. The clamp comes first, so the span moves
   the day by at most 1 + 3w up and 1 − 0.75w down whatever Y is. w reaches 1 once the pool's mean day
   has accumulated a quarter of its total (late morning for the work-day pool); from then on a is the
   clamped ratio. Known cost: an unusually early heavy morning gets its lift only as the pool's own day
   gets under way; until then the load reaches the forecast through the current levels and the
   last-hour blend. An empty pool, M + c not above 0, or c = 0 gives a = 1.
   The last hour's rate is blended in with an exponentially decaying weight
   e^(−h/τ). The generator is seeded from the local day key.
5. **Planner** (`planner.ts`, `simulate.ts`, `move-cost.ts`). This is a scenario-based receding-horizon
   search over openings, order and at most one move. Each candidate is a simulated depletion of every
   account, with refill jumps at resets. Candidates are compared by the score S and its tie-breaks
   (design amendment 5, E2; see Score below).
   A planned opening (`openAt`) with pre-warm off is a routing-opening: from its time the first new
   (unattached) demand goes to that closed account and opens its window, then the base order applies
   again (design 4.5). An `openAt` later than on demand would open the account is a hold: until its
   time the account counts as held and takes no new work (amendment 5, E3). The placement advice
   carries the simulated order: a due routing-opening or the idle accounts the plan does not hold come
   first with `forecast-open`; an account the plan holds goes behind every other.

## Routing order in the simulation (`DayRun.pick`, amendment 5 E1)

New (unattached) demand, and an attached session whose account is full (failover), go to the first of:

1. a closed account whose planned opening time has come (routing-opening);
2. an idle account: usable, window not open, not held. Among several, the larger weekly pace deficit
   first (elapsed share of the weekly window's local work time minus weekly use, as the live router's
   session-pace), then the lower account index;
3. the plan's preferred account, when usable and not held;
4. an open usable account, the earliest 5-hour reset first;
5. last resort: any usable account, a held one included (it opens then).

Not modelled: account priority. The live router orders idle accounts by priority first; the engine
has no priority input and treats all priorities as equal (both live priorities are 0 today), so among
idle accounts it orders by weekly pace deficit, then index. Also not modelled: the live probe backoff, the router's 120-second hold,
the Fable-family guard, cold-start rotation, and the live order among open accounts (the simulation
always takes the earliest reset). A hold executed live can leak, because a request without a session
key or stale advice places by the plain rules.

## Score (amendment 5, E2)

S is the lowest usage point of the heavy day with unserved demand counted below zero. For each limit
(5-hour and weekly) and each simulated day, the day's own low is the minimum over the day of
(line − k × cumulative unserved units), k the mean calibration of the counted accounts; unserved demand
is lost and stays counted for the rest of the day. The limit's low is the 10th percentile of those
per-day lows (`levelOf` at `HEAVY_LEVEL`), and S = min(5-hour low, weekly low), the limit closer to
zero. Higher is better. Served lines, the response and its floor at 0 are unchanged; only the planner
scores this way. Fable is not part of S.

Order (`compareScores`): S higher by its fixed `TIER_TOLERANCE_POINTS`-wide bin (floor of S ÷ 0.5);
in one bin the other limit's low, then the typical day's unfloored low (min over both limits of the
median per-day low), both also by bin; then fewer departures from on demand (`departuresOf`: openings,
a preferred account, a move); then the exact values. Fixed bins keep the order transitive; a pairwise
"within 0.5 points" test can rank three plans in a cycle.
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
| `HEAVY_LEVEL`, `TYPICAL_LEVEL`, `SCORE_EPS` | 90, 50, 1e-9 | `planner.ts` |
| `OPEN_AHEAD_MIN`, `OPEN_BEFORE_WORK_START_MIN` | 0–240 min ahead; 300–60 min before work start | `planner.ts` |
| `OPENING_BEAM`, `MAX_OPENING_COMBOS`, `MAX_MOVE_SESSIONS` | 3, 64, 3 | `planner.ts` |
| `TIER_TOLERANCE_POINTS`, `REASON_MIN_GAIN_POINTS` | 0.5, 0.05 | `planner.ts` |
| `ZERO_POINTS` | 0.05 | `stops.ts` |
| `WEEK_PAST_SPACING_MS` | 30 min | `past.ts` |

The user-facing knobs (`simulatedDays`, `timeShiftMin`, `recentTauMin`, `sessionTurnoverMin`,
`openMinGainPoints`, `moveMinGainPoints`, `minStopPoints`, `fanLevels`, history half-life and lookback)
are `ForecastSettings`, not constants.

Openings and holds (`openingEarns`, amendment 5 E3): the candidates include earlier and later opening
times than on demand (`OPEN_AHEAD_MIN` from now, and before the work start with pre-warm on); a plan
that departs from on demand by an opening or a hold is chosen only when it raises S by at least
`openMinGainPoints`, a move only by `moveMinGainPoints`. The other low, the typical low and departures
never earn one. The engine adds the chosen plan's S and on demand's S to the `forecast inputs` log
line (`lowPoint`, `lowPointOnDemand`); the HTTP response does not carry them.

Placement reason (amendment 2 B4), one token: `open-ahead+<points>` for an opening ahead of need; else
`low-point+<points>` for a gain of S over the on-demand plan; else `reset-soon`; else the first score
item on which the first tier beats the second, with its gain (`decidingReason`): `low-point+<points>`,
`weekly-low+<points>` or `five-hour-low+<points>`, `typical-low+<points>`.

Learned work start (`workStartMinute`, amendment A3): the median, over the last `WORK_START_RECENT_DAYS`
work days with demand, of the local minute at which the day's cumulative demand first reaches
`workStartSharePct` percent (setting, default 5) of its total, taken as the start of that 5-minute bucket.
A stray overnight request no longer sets the work start.

## Index

`index.ts` exports the entry point and the building blocks. Generic names carry an engine prefix
(`simulatePlan`, `calibrateAccounts`, `EngineScenarios`, ...) because the package index re-exports every
forecast directory.
