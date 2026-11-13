# @better-ccflare/forecast

The interruption forecast: when each account's Claude quota is likely to run out.
It holds the shared types, demand units (weighted tokens per model) and local-time helpers.
Later code adds the simulation engine and planner, demand history, session routing advice, 5-hour window pre-warm, and the `/api/forecast` endpoint.
Each part lives in its own `src/` directory, and `src/index.ts` re-exports all of them.
The code is pure TypeScript with no IO outside the history and service parts; tests run with `bun test`.

## Dependency check

`simple-statistics` **8.0.0**, pinned exactly in `package.json`. Checked 2026-11-12.

- **Version and licence:** `npm view simple-statistics version license dependencies scripts dist.tarball dist.integrity --json` reported version 8.0.0 and licence ISC. The tarball's `package.json` also says ISC.
- **Install scripts:** the registry `scripts` are `build`, `build:docs`, `changeset:version`, `lint`, `lint-fix`, `prelint` and `test`. There is no `preinstall`, `install`, `postinstall` or `prepare`.
- **Runtime dependencies:** none. The registry has no `dependencies` field, and the tarball's `package.json` has none either.
- **Network calls:** downloaded `https://registry.npmjs.org/simple-statistics/-/simple-statistics-8.0.0.tgz` with `curl` into a new empty directory. Its sha512 matched the registry `dist.integrity` (`sha512-LiiSF7yR…rO09Uw==`). After `tar -xzf`, these searches over `dist/` and every `.js`/`.mjs`/`.cjs` file found nothing:
  - `grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|sendBeacon'`
  - `require(`/`import`/`from` of `http`, `https`, `net`, `dgram`, `tls` or `child_process`, with or without the `node:` prefix
  - any `require`/`from` of a bare (non-relative) module

  The only URLs in the package are Wikipedia and paper links in doc comments under `src/`.
- **Lockfile:** `bun install` added only the `packages/forecast` workspace entry and `simple-statistics@8.0.0` with that same integrity hash.

## Service

`src/service/` joins the parts at run time. `createForecastService(deps)` keeps the last computation and serves it; nothing is computed on a request.

- **When it computes.** `notifyUsagePoll()` is called from every successful usage snapshot. It waits `FORECAST_POLL_SETTLE_MS` (5 s) for the burst of snapshots to settle, and two computations start at least `FORECAST_MIN_SPACING_MS` (30 s) apart. Only one runs at a time, and queued work is one timer whose deadline is the later of the last snapshot's settle wait and the spacing; snapshots during a run queue exactly one follow-up. `runOnce()` computes now (it covers every snapshot seen so far), or joins the run in progress. `idle()` waits for queued and running work.
- **One cycle.** Sync the proxy's demand buckets (a failure is logged and the cycle goes on). After a successful sync, when `transcriptsDir` is set, start the transcript backfill (once per process) in the background; its failure is logged by error name only. Then load pooled and per-account history, limit readings, current limits (`loadLimits`) and live sessions; run the engine (a throw becomes the `"error"` shape); keep the result; tick the pre-warm scheduler. Failures are logged once per cycle and never reach the caller.
- **Fresh or stale.** A kept result is fresh for `FORECAST_STALE_POLLS` (3) usage poll intervals. A stale or missing result is served as the `"error"` shape and gives no advice.
- **Advisor.** `advisor` is the `ForecastAdvisor` for session-pace. Placement and moves come from a fresh plan while `enabled` and `routing` are on (read live per call); a move that was applied is not offered again until the next plan. `cacheTtlMs` reads the session tracker. No method throws.
- **Provider.** `provider` is the `/api/forecast` provider and never throws. It always adds `prewarm` from the scheduler's status, or empty lists when there is no scheduler.
- **Pre-warm scheduler.** The service ticks, reads and stops it. The scheduler's `forecast()` and `limits()` read the service (`forecastView()`, `limits()`), so build the scheduler first with lazy getters over a variable the service is assigned to:

  ```ts
  let service: ForecastService | null = null;
  const scheduler = createPrewarmScheduler({
  	...,
  	forecast: () => service?.forecastView() ?? null,
  	limits: () => service?.limits() ?? [],
  });
  service = createForecastService({ ..., scheduler });
  ```
- **Stop.** `stop()` clears the service's timer, stops the scheduler, and awaits the running computation and any pre-warm run in flight (bounded by the runner's timeout), so records are written before the database closes; later notifications do nothing. Pass unref'd timers so none keeps the process alive.
