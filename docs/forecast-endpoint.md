> This is a copy of spec revision 7 of the forecast endpoint contract, the source of truth for the
> `GET /api/forecast` response. The validator in `packages/forecast/src/contract/validate.ts` enforces it.
> The settings are described in [configuration.md](configuration.md#forecast-settings).
> How the proxy computes, serves and routes by the forecast: [routing-architecture.md](routing-architecture.md#interruption-forecast).

# Forecast endpoint of the proxy

Contract version 1 · spec revision 7 · 2026-11-16 · written by the proxy forecast session (its only writer).

Status: specification written before the implementation. It answers `forecast-ui-data-needs.md` Draft 4. Any field
change bumps the spec revision, is listed in the change log at the end, and is announced to the supervisor. A
change that breaks a reader bumps `contractVersion`.

## 1. Discovery

`GET /api/config/strategy` gains one field when this build serves the forecast and the forecast is switched on:

```json
"forecast": { "path": "/api/forecast", "contractVersion": 1 }
```

The field is absent when the forecast is switched off (setting `forecast.enabled` false). A client calls `path`
only when the field is present and it understands `contractVersion`. The same response also gains
`forecastSettings` (always present; the effective settings, like `sessionPace`); the UI does not need it.

Names of settings: this document writes a setting as `forecast.<name>`. The same setting is the field
`forecastSettings.<name>` of this response (so `forecast.enabled` is `forecastSettings.enabled`), the environment
variable `FORECAST_<NAME>` and the config key `forecast_<name>`. The set of settings may grow without a spec
revision; `docs/configuration.md` in the proxy repository lists them.

## 2. Request

`GET /api/forecast`, no parameters, same access rules as `GET /api/config/strategy`. The proxy recomputes the
forecast on every usage poll (about every 90 s), off the request path and in short slices so that it never delays
request handling, and serves the last result from memory. A call is cheap and never triggers a computation or an
upstream request. Response: `application/json`, `Cache-Control: no-store`.
Clients must ignore fields they do not know.

## 3. Units and rules

- **Times**: epoch milliseconds, integers.
- **Points**: percent of ONE account's limit, one decimal. A pooled value is the sum over the counted accounts, so
  0 to 200 with two accounts.
- **Counted accounts** (`accounts`): the Claude accounts that can take work now: not paused, not logged out (no
  re-authentication pending). Ids are the ids of `/api/accounts`.
- **Pooled 5-hour quota left** (the `day` quantity): per counted account, the LOWER of two amounts. The first is
  its 5-hour quota left: 100 minus its 5-hour utilisation; an account with no open 5-hour window counts 100. The
  second is its weekly quota left expressed in 5-hour points: 100 minus its weekly utilisation, times the
  account's 5-hour points per weekly point. The proxy calibrates that ratio per account from the account's own
  usage (about 6 on both accounts in November 2026, so the weekly limit lowers the value only when less than
  about a sixth of it is left). So 100 is one account's full 5-hour window, and each account counts only as much
  of it as its weekly limit still allows. An account whose WEEKLY limit is used up therefore counts 0 until its
  weekly reset. An account that is refused by upstream with a cooldown running also counts 0 until the cooldown
  ends, because its quota cannot be used. So this line at 0 means "no counted account can take work", whichever
  limit caused it. The pooled maximum stays 100 times the number of counted accounts. The rule holds at the
  current point, in `day.past` and at every projected point, a 5-hour reset included: after a reset the account
  rises to the lower of 100 and what its weekly limit allows, not to 100. The limit of the Fable model family
  does not enter this line; it is reported in `fable`.
  The ratio is not a constant. It is the quotient of two calibrations (5-hour points per demand unit and weekly
  points per demand unit) that the proxy recomputes at every computation from its stored readings of the last
  56 days, weighted by recency with a half-life of 14 days. It therefore follows a change of a limit by the
  provider, but slowly: after a step change it has moved half-way in about 10 to 13 days and 90 % of the way in
  about 5 weeks (measured by the test `calibration-step.test.ts`). The two calibrations follow separately: a
  change of one limit leaves the other calibration unchanged. Until the calibration has caught up, every value
  that depends on it (this line, the projections, `shortfall`) is off in proportion.
- **Pooled weekly quota left** (the `week` quantity): per counted account, 100 minus its weekly utilisation. The
  5-hour state does not enter.
- **Series shape**: one shared time axis per block (`times`) and one value array per level, all the same length.
  A jump (a reset) is two consecutive entries with the same time: the value before and the value after. A level
  that does not jump at that time carries the same value twice.

## 4. Levels and ordering

The proxy simulates 400 possible rests of the day and week ("simulated days"; setting `forecast.simulatedDays`).
Each one is a whole recorded day of the same day type (workday, Monday, weekend), resampled with more weight on
recent weeks, scaled by how today has gone so far, and joined to the last hour's actual rate, which fades into the
recorded day. Because only a few dozen recorded days exist, each simulated day also gets its own small random shift
in time (up to 30 minutes either way) and its own random scale around today's level, so the 400 days differ from
each other and levels two percentile points apart (8 simulated days apart) are not systematically identical. The
method is a smoothed bootstrap of whole recorded days. The width of the random scale comes from the recorded days
themselves (the normal-reference bandwidth rule on the logarithm of their daily totals), and the scale is applied
in the variance-preserving ("shrunk") form of Silverman and Young (1987), so the simulated days keep the mean and
the spread of the recorded days and are not made wider by the added noise. The
random draws are fixed per local day, so the lines do not flicker between two computations. Every simulated day
is run through the same routing plan the proxy is following (including the window openings it has planned).

A level `pNN` is "the NNth percentile of demand": at each time point, the value that the pooled quota left is at or
above in (100 − NN) % of the simulated days. `light` = p10, `typical` = p50 (the median, not a mean profile),
`heavy` = p90. `fan` holds the other levels, by default every 2 percentile points: `p12 p14 … p48` and
`p52 p54 … p88` (38 keys; 41 lines with `light`, `typical`, `heavy`). The list of fan levels is a setting
(`forecast.fanLevels`); adding a level adds a key and changes no existing key.

**Ordering is guaranteed for all 41 lines**: all levels are percentiles of the same simulated quantity at the same
time point, so at every index `light ≥ p12 ≥ p14 ≥ … ≥ p48 ≥ typical ≥ p52 ≥ … ≥ p88 ≥ heavy`. Equality is possible
wherever all simulated days agree, such as at 0 and at the full pool, and with little history the lines may nearly
coincide. At `computedAt` all levels are equal as a consequence (every simulated day starts from the same
reading); that is not a separate rule a reader has to check. The price of this: a level line is not one
single simulated day. Resets of windows that are open now happen at the same time in every simulated day and
show as exact jumps. So do openings the proxy has planned when it makes them itself by a pre-warm request
(setting `forecast.prewarm` on). With that setting off (the default) a planned opening is made by routing: from
the planned time the first new demand goes to that account and opens its window, so the opening happens at or
shortly after the planned time and its reset is close to one jump. A window that opens "whenever demand first
reaches that account" opens at different times in different simulated days, so its later reset shows as a rise
spread over a few steps, not as one jump.

The routing planner plans against `heavy` (p90). That is unchanged by the extra levels.

## 5. What a stop is

- **In one simulated day**, a hard stop is a time when the pooled 5-hour quota left (as defined in section 3) is 0.
  A weekly stop is a time when the pooled weekly quota left is 0.
- **A projected stop at a level** (`stops.light | typical | heavy`) is a maximal interval, after `computedAt`, in
  which that level's line is 0. In words: `heavy` = at least 10 % of the simulated days are stopped at that time
  ("possible"), `typical` = at least half ("probable"), `light` = at least 90 % ("certain"). Because the lines are
  ordered, every `light` stop lies inside a `typical` stop, which lies inside a `heavy` stop.
- **"While work is expected"**: an interval is reported only if the simulated days at that level leave at least
  1 point of demand unserved inside it (setting `forecast.minStopPoints`). Zero quota at night or on a weekend with
  no expected demand is therefore NOT a stop and is not listed, although the line is drawn at 0. If demand is
  expected in any part of the interval, the whole interval is reported.
- `start` is the first minute the line is at 0. `end` is the first minute it is above 0 again (the reset that
  brings quota back), or the end of the projection if none comes before it. Both are instants in their own
  right: they usually coincide with an entry of `times` (zero points and jumps are on the axis), but a reader
  must not rely on finding them there.
- **`stopNow`** is a fact, not a projection: every counted account is out right now according to the latest
  readings (5-hour utilisation at 100 with a reset still ahead, weekly at 100, or refused by upstream with a
  cooldown running). `start` = when the last account went out, `end` = the earliest moment a counted account comes
  back. For an account out on a limit, "went out" is the first reading that showed it at 100. For an account
  refused by upstream it is the start of its running cooldown: the first refusal of that cooldown that the proxy
  has seen since the proxy itself started. After a restart of the proxy that is the latest refusal on record,
  which can be later than the first. An account that has been out without a break counts from the start of
  that unbroken time out, even when the reason changed along the way: out on its 5-hour limit from 12:00,
  refused from 13:00, its 5-hour reset at 14:00 while the cooldown still runs, it counts from 12:00. When no
  start is known, the account's last reading is used. `stopNow` is reported whether or
  not work is expected. A stop that has begun is in `stopNow` only, never in the `stops` lists and never in
  `pastStops`.
- **`pastStops`** are the same fact for earlier today (`day`) or this week (`week`): intervals in the recorded
  readings in which every counted account was out. Their start is as exact as the readings (about 90 s).
  A refusal cooldown is not in the recorded readings. While a cooldown is running, its account counts as out
  from the cooldown's start, so an ended stop that the cooldown helped to complete is listed. Once the cooldown
  itself has ended, the proxy keeps no record of it, and a stop that only the cooldown made complete is no
  longer listed.

## 6. Fields

| Field | Meaning |
|---|---|
| `contractVersion` | 1. |
| `computedAt` | When this forecast was computed. |
| `available` | `false` = no forecast; then `reason` is set, `accounts` may be empty, `day` and `week` are `null`, `fable` is `{}`. |
| `reason` | `null` when available. Else `insufficient_history` (too few recorded days or too few usage readings to calibrate), `error` (the computation failed, or there is no current result: just after a start before the first computation, or when the last result is older than three usage polls), or `disabled` (switched off; a client that follows discovery never sees it, because the discovery field and the forecast are switched by the same setting). |
| `accounts` | Ids of the counted accounts. |
| `levels` | `{ "light": 10, "typical": 50, "heavy": 90 }`: the percentile behind each named level. |
| `day.past` | `{ times, values }`: pooled 5-hour quota left from local midnight to `computedAt`, one entry per change in the readings, jumps as two entries. Starts later than midnight when the proxy has no earlier readings. An account in a cooldown that is running at `computedAt` counts 0 from the cooldown's start (a jump on the axis), so a running stop shows from its start; a cooldown that has ended is not in the line. |
| `day.times` | Time axis of the projection: `computedAt`, then every 5 minutes on the clock, to the end of the local day, plus the exact time of every jump and of every point where a level reaches 0. |
| `day.light`, `day.typical`, `day.heavy` | Projected pooled 5-hour quota left per level, aligned with `day.times`. |
| `day.fan` | `{ "p12": [...], "p14": [...], ... }`: the other levels (38 keys by default), aligned with `day.times`. No stops for these. |
| `day.stops` | `{ light, typical, heavy }`, each a list of `{ start, end }` in time order (section 5). |
| `day.stopNow` | `{ start, end }` or `null` (section 5). |
| `day.pastStops` | List of `{ start, end }`, today's ended stops. |
| `day.shortfall` | `null`, or `{ stop, points, lastAccount, perAccount }` for one stop: `stopNow` if there is one, else the first `typical` stop. `stop` = that stop's `{ start, end }`. `points` = the demand expected inside it that cannot be served (median over the simulated days; for `stopNow`, counted from `computedAt`). `lastAccount` = the account that runs out last before the stop (for `stopNow`: the one that did). `perAccount` = `{ "<id>": points }`, the spill rule: `lastAccount` gets as much as fits its fill (its used share at `computedAt`: 100 minus the lower of its 5-hour quota left and its weekly quota left in 5-hour points, as in section 3; 0 when no 5-hour window is open and the weekly limit does not lower the value; a running cooldown does not enter the fill), the rest goes to the other accounts in reverse order of running out, each capped the same way; anything still left over is added to `lastAccount`, so the parts always sum to `points`. |
| `week.past` | As `day.past` for the pooled weekly quota left, from Monday 00:00 local, at most one entry per 30 minutes plus jumps. |
| `week.times` | `computedAt`, then every full hour, to the later of Friday 24:00 local and the last weekly reset of a counted account (at most 7 days ahead), plus exact jumps and zero points. |
| `week.light`, `week.typical`, `week.heavy`, `week.fan` | As for `day`, for the weekly quantity. |
| `week.stops`, `week.stopNow`, `week.pastStops`, `week.shortfall` | As for `day`, for the weekly limits, in points of a weekly limit. `end` = the first weekly reset that brings quota back. |
| `fable` | `{ "<id>": { "outAt": time or null } }` per counted account: when its weekly Fable sub-limit reaches 100 % on the typical projection (the median over the simulated days, rounded down to the hour), or `null` when at least half of the simulated days reach its reset first. Display only; routing keeps the 90 % Fable guard. |

| `prewarm` | Optional. Diagnostics of the window pre-warm, for the pre-warm test and for operators; the UI ignores it. `{ enabled, planned: [{ accountId, openAt }], last: [{ accountId, kind, scheduledAt, firedAt, exitCode, windowOpened, resetsAt }] }`. `enabled` = setting `forecast.prewarm`. `planned` = the window openings in the current plan, each with its planned time: made by a pre-warm request when `enabled` is true, and by routing the first new demand to that account from that time when `enabled` is false. `last` = the most recent pre-warm requests, newest first (at most 20): `kind` is `"plan"` or `"test"`, `windowOpened` is `true`/`false` once a later usage reading has shown whether the 5-hour window opened, `null` before that; `resetsAt` is that window's reset. Present whenever the forecast is switched on, also when `available` is false. |

Size: up to about 300 time points × 42 arrays for the day and 170 × 42 for the week, values at one decimal: at
most 150 to 250 kB uncompressed; about 80 to 90 kB measured on the test fixtures.

## 7. Full example

State: 2026-11-12 13:20 CET. Account `1d05…` is at 100 % of its 5-hour window (reset 16:00), `28f6…` at 6 %
(reset 18:10). The arrays are shortened to the points that matter; a real response has every 5-minute (day) or
hourly (week) point in between. `fan` is shortened to six of its 38 keys. The numbers are illustrative.

```json
{
  "contractVersion": 1,
  "computedAt": 1794486000000,
  "available": true,
  "reason": null,
  "accounts": ["1d05b422-cf9f-43a1-964b-706e55017200", "28f69dec-2e46-4b18-9557-dcdc132fc385"],
  "levels": { "light": 10, "typical": 50, "heavy": 90 },
  "day": {
    "past": {
      "times":  [1794438000000, 1794439800000, 1794439800000, 1794441000000, 1794441000000, 1794471000000, 1794477480000, 1794477600000, 1794477600000, 1794485280000, 1794485861000, 1794486000000],
      "values": [193, 193, 195, 195, 200, 200, 140, 140, 200, 104, 98, 94]
    },
    "times":   [1794486000000, 1794488400000, 1794490200000, 1794491880000, 1794493800000, 1794495600000, 1794495600000, 1794499200000, 1794502920000, 1794503400000, 1794503400000, 1794513600000, 1794513600000, 1794524400000],
    "light":   [94, 70, 52, 35, 16, 2, 102, 78, 65, 64, 164, 150, 196, 195],
    "typical": [94, 56, 27, 0, 0, 0, 100, 57, 32, 31, 131, 113, 188, 186],
    "heavy":   [94, 36, 0, 0, 0, 0, 100, 28, 0, 0, 100, 76, 176, 172],
    "fan": {
      "p20": [94, 66, 45, 25, 4, 0, 100, 72, 56, 55, 155, 140, 194, 193],
      "p30": [94, 62, 38, 16, 0, 0, 100, 67, 48, 47, 147, 131, 192, 191],
      "p40": [94, 59, 32, 7, 0, 0, 100, 62, 40, 39, 139, 122, 190, 189],
      "p60": [94, 52, 21, 0, 0, 0, 100, 51, 23, 22, 122, 103, 185, 183],
      "p70": [94, 48, 14, 0, 0, 0, 100, 45, 13, 12, 112, 92, 182, 180],
      "p80": [94, 43, 6, 0, 0, 0, 100, 38, 4, 3, 103, 82, 179, 176]
    },
    "stops": {
      "light": [],
      "typical": [{ "start": 1794491880000, "end": 1794495600000 }],
      "heavy": [
        { "start": 1794490200000, "end": 1794495600000 },
        { "start": 1794502920000, "end": 1794503400000 }
      ]
    },
    "stopNow": null,
    "pastStops": [],
    "shortfall": {
      "stop": { "start": 1794491880000, "end": 1794495600000 },
      "points": 58,
      "lastAccount": "28f69dec-2e46-4b18-9557-dcdc132fc385",
      "perAccount": {
        "28f69dec-2e46-4b18-9557-dcdc132fc385": 6,
        "1d05b422-cf9f-43a1-964b-706e55017200": 52
      }
    }
  },
  "week": {
    "past": {
      "times":  [1794409800000, 1794471000000, 1794486000000],
      "values": [147, 131, 106]
    },
    "times":   [1794486000000, 1794524400000, 1794582000000, 1794589200000, 1794610800000, 1794751200000, 1794751200000, 1794848400000, 1794880800000, 1794880800000],
    "light":   [106, 92, 64, 60, 58, 57, 140, 112, 110, 190],
    "typical": [106, 81, 36, 30, 28, 27, 117, 80, 78, 173],
    "heavy":   [106, 65, 0, 0, 0, 0, 100, 40, 38, 138],
    "fan": {
      "p20": [106, 89, 57, 52, 50, 49, 135, 104, 102, 186],
      "p30": [106, 86, 50, 44, 42, 41, 130, 96, 94, 182],
      "p40": [106, 84, 43, 37, 35, 34, 124, 88, 86, 178],
      "p60": [106, 78, 28, 22, 19, 18, 110, 71, 69, 168],
      "p70": [106, 75, 20, 14, 11, 10, 104, 62, 60, 162],
      "p80": [106, 71, 10, 5, 2, 1, 100, 52, 50, 155]
    },
    "stops": {
      "light": [],
      "typical": [],
      "heavy": [{ "start": 1794582000000, "end": 1794751200000 }]
    },
    "stopNow": null,
    "pastStops": [],
    "shortfall": null
  },
  "fable": {
    "1d05b422-cf9f-43a1-964b-706e55017200": { "outAt": null },
    "28f69dec-2e46-4b18-9557-dcdc132fc385": { "outAt": 1794574800000 }
  },
  "prewarm": { "enabled": false, "planned": [], "last": [] }
}
```

No forecast:

```json
{
  "contractVersion": 1,
  "computedAt": 1794486000000,
  "available": false,
  "reason": "insufficient_history",
  "accounts": [],
  "levels": { "light": 10, "typical": 50, "heavy": 90 },
  "day": null,
  "week": null,
  "fable": {}
}
```

## 8. Where this differed from `forecast-ui-data-needs.md` Draft 3

All seven points were accepted by the supervisor on 2026-11-12 and Draft 4 of the UI file takes them over. Kept
for the record.

1. **Layout.** Projections are `day.times` plus one array per level (`day.light`, `day.typical`, `day.heavy`,
   `day.fan.pNN`), not lists of `{time, value}` points. Same for `week`. `past` is `{ times, values }`.
2. **Weekly exhaustion enters the day line.** An account that is out on its weekly limit counts 0 in the pooled
   5-hour line (section 3). Without this the day line could show quota that cannot be used, and a real hard stop
   (one account out for the week, the other out for 5 hours) would not show as a day stop. Consequence: a weekly
   stop also appears as a day stop while it overlaps today. Since revision 5 the same holds for an account that
   is refused by upstream with a cooldown running.
3. **`shortfall` names its stop** (`shortfall.stop`) and refers to `stopNow` when a stop is running, because a
   running stop is not in `stops.typical`. Draft 3 says "the first typical stop".
4. **`perAccount` leftover.** When `points` exceeds what fits both accounts' fills, the leftover goes to
   `lastAccount` so the parts still sum to `points`. Draft 3 does not say.
5. **Stops outside work hours** are not listed (section 5), but `stopNow` and `pastStops` are facts and are
   listed whenever they happen.
6. **Extra fields**: `contractVersion`, `levels`, and the reason `disabled`.
7. **Level lines are not single days** (section 4): spread-out rises where a window's opening time depends on demand.

## Change log

- Revision 7, 2026-11-16 (ships in pace.9): values only; no field added, removed, renamed
  or retyped. Section 5: `stopNow.start` for a stop that a refusal cooldown made complete is the cooldown's start
  (it was the blocked account's last reading, about one poll before `computedAt`, so the stop appeared to begin
  at the present). `day.past` counts such an account 0 from that start (it stepped down only at `computedAt`).
  The start is as exact as the first refusal seen since the proxy started. A running stop is never also listed
  in `pastStops`. A cooldown that has ended is not recorded, so it is in neither `day.past` nor `pastStops`.
  `contractVersion` stays 1.

- Revision 6, 2026-11-13: values only; no field added, removed, renamed or retyped. Section 3: the `day`
  quantity counts each account at the lower of its 5-hour quota left and its weekly quota left in 5-hour points
  (weekly quota left times the account's calibrated 5-hour points per weekly point), at the current point, in
  `day.past` and at every projected point. Before, an account counted its full 5-hour quota until its weekly
  limit was completely used up, so the line rose by 100 at a 5-hour reset even when the weekly limit allowed far
  less. The `perAccount` fill of `shortfall` follows the same lower value. The Fable limit stays out of the
  line. Section 3 also states how the ratio is obtained and how fast it follows a change of a limit by the
  provider (half-way in about 10 to 13 days, 90 % in about 5 weeks). `contractVersion` stays 1.

- Revision 5, 2026-11-13: one rule widened; no field added, removed, renamed or retyped. Section 3: an account
  that is refused by upstream with a cooldown running counts 0 in the pooled 5-hour line until the cooldown ends,
  as an account out on its weekly limit already did. Before, the unused 5-hour quota of such an account held the
  line above 0 while no work could be served, so no stop and no shortfall were reported (seen live on 2026-11-13:
  the line stood at 100 for three hours of a stop). The rule applies to the projected `day` lines and to the
  current point. `day.past` is drawn from the readings and does not carry a cooldown before the current point;
  it always ends at the current point, so a running cooldown shows as a step down at `computedAt`. `stopNow`
  already counted such an account as out (section 5). `contractVersion` stays 1.

- Revision 4, 2026-11-13: wording only; no field added, removed, renamed or retyped. Section 4 and the `prewarm`
  row of section 6 say what a planned opening is when the pre-warm is off (the default): the proxy routes the
  first new demand to that account from the planned time. `prewarm.planned` lists the planned openings in both
  cases. `contractVersion` stays 1.

- Revision 3, 2026-11-13: wording only; no field added, removed, renamed or retyped. One clarification a client
  may act on: `reason` = `error` is also what the proxy serves when it has no current result (see section 6), so
  it can be transient just after a proxy start. Section 1: how setting names map to `forecastSettings`, environment and config keys. Section 4: the method is
  named (smoothed bootstrap, variance-preserving form of Silverman and Young 1987, bandwidth from the recorded
  days); equality of the levels at `computedAt` is stated as a consequence, not a rule. Section 5: a stop's
  `start` and `end` are instants and need not be entries of `times`. Section 6: `error` also covers "no current
  result" (just after a start, or a result older than three usage polls); why `disabled` is never seen after
  discovery; measured size. `contractVersion` stays 1.

- Revision 2, 2026-11-12: default `forecast.fanLevels` is now every 2 percentile points (`p12` … `p48`, `p52` …
  `p88`, 38 keys) for the smooth fan; same format, more keys. 400 simulated days, each with its own small random
  time shift and scale, so that adjacent levels differ (section 4). Ordering stated for all 41 lines. Size line
  updated. The computation runs off the request path (section 2). New optional field `prewarm` (diagnostics for
  the pre-warm test; the UI ignores it). `contractVersion` stays 1: nothing an existing reader uses has changed.
- Revision 1, 2026-11-12: first version, against Draft 3 of the UI data-needs file.
