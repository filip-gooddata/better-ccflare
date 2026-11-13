# Local operations

Scripts for deploying a session-pace build of this fork to the local LaunchAgent
`net.kalny.better-ccflare` (port 8791). Run them from a terminal, not from a model session: the
proxy is down during the reload, and the real deploy ends with one genuine `claude -p` request.

- `deploy.sh`: installs a new binary, reloads the LaunchAgent and checks the result. Its header
  documents both starting states, the exit codes and the manual restore commands. There is no
  automatic rollback.
- `exercise.sh`: a sandbox test of `deploy.sh` (below). Run it on every new binary before deploying.

## Build, exercise and deploy pace.4 (`v3.6.7+pace.4`)

pace.4 is an upgrade of the installed pace.3 build, whose sha256 is
`2eea8308411ed7a53c7a8f307267f2948caaf127229ac675da39c0842875966e`.

1. Build from the repository root at the commit to ship, the same way pace.3 was built
   (Bun 1.4.4 from the local toolchain; the build checks the embedded Bun against `.bun-version`):

   ```bash
   cd /Users/filip/Developer/better-ccflare
   source .toolchain/env-base.sh
   export CCFLARE_BUILD_SUFFIX=pace.4
   export CCFLARE_SKIP_PLATFORMS=bun-linux-amd64,bun-linux-arm64,bun-darwin-x64,bun-windows-x64
   bun run build:dashboard
   (cd apps/cli && bun run build-multi-arch.ts)
   apps/cli/dist/better-ccflare-macos-arm64 --version   # better-ccflare v3.6.7+pace.4
   shasum -a 256 apps/cli/dist/better-ccflare-macos-arm64
   ```

   `CCFLARE_BUILD_SUFFIX` gives the version its `+pace.4` (`apps/cli/version-define.ts`,
   `buildVersionString`). `CCFLARE_BUILD_SUFFIX=pace.4 bun run build:macos-arm64` in `apps/cli`
   names the binary the same way and writes the same path, but it is not the route pace.3 took.

2. Exercise the deploy script against the new binary (sandboxed, see below):

   ```bash
   bash local-ops/exercise.sh apps/cli/dist/better-ccflare-macos-arm64
   ```

3. Check that the installed binary is pace.3, then dry-run and deploy. `<NEW_SHA256>` is the
   `shasum` output from step 1.

   ```bash
   shasum -a 256 ~/.local/bin/better-ccflare   # must print 2eea8308…966e
   local-ops/deploy.sh --dry-run --sha256 <NEW_SHA256> --upgrade-from 2eea8308411ed7a53c7a8f307267f2948caaf127229ac675da39c0842875966e apps/cli/dist/better-ccflare-macos-arm64
   local-ops/deploy.sh --sha256 <NEW_SHA256> --upgrade-from 2eea8308411ed7a53c7a8f307267f2948caaf127229ac675da39c0842875966e apps/cli/dist/better-ccflare-macos-arm64
   ```

   The upgrade keeps the pace.3 binary as `~/.local/bin/better-ccflare.pre-upgrade-2eea8308411e`
   and leaves the plist, the config and the first-deploy backups byte for byte. A failed run prints
   the commands that return to pace.3.

4. After the deploy, `GET /api/config/strategy` carries `forecastSettings` and, with the forecast
   enabled, `forecast: { path: "/api/forecast", contractVersion: 1 }`; `GET /api/forecast` serves
   the projection a few seconds after the first usage poll. Pre-warm stays off unless
   `prewarm` is turned on (`FORECAST_PREWARM` or `forecast_prewarm`). See
   [Interruption Forecast](../docs/routing-architecture.md#interruption-forecast).

## What `--dry-run` does

It runs the same preflight as a real deploy and prints what it would do. It writes no file or
directory, calls `launchctl` only as `launchctl print`, and runs no `claude` (`deploy.sh`:499; the temporary directory is made only
outside a dry run, :502-505; `reload_job` and `run_checks` only print, :250 and :397; the run ends at
:626-648 with `DRY RUN: no changes made`). It does read the live installation:

- the new binary and the installed `~/.local/bin/better-ccflare` (sha256), and for an upgrade any
  existing `.pre-upgrade-*` copy and the first-deploy backups (sha256, `plutil -lint`, PlistBuddy);
- the LaunchAgent plist (`plutil -lint`, PlistBuddy: `Label`, `ProgramArguments:0`, and the
  `LB_STRATEGY` and `MODEL_SCOPED_CAPACITY_ROUTING` variables);
- the app config `~/.config/better-ccflare/better-ccflare.json`: file mode, and `jq -e` on its
  shape and `lb_strategy`, exit status only, nothing printed;
- `launchctl print gui/<uid>/net.kalny.better-ccflare` (loaded, pid, plist path; :592).

It makes no HTTP request: the post-deploy checks (`/api/accounts`, `/api/config/strategy`, the
listener, the `claude -p` reply) are only printed as "would check".

## What `exercise.sh` does

`exercise.sh NEW_BINARY` builds a mode-700 `mktemp` sandbox with copies of the release binary and
the real plist plus a synthetic config it writes itself (the real config is never read), points
`deploy.sh` at them through the `BCF_*` overrides, and replaces `launchctl`, `curl`, `lsof`,
`netstat` and `claude` with stubs. The `curl` stub answers canned `/api/accounts` and
`/api/config/strategy` bodies; the listener stubs report port 18791. It starts no server, never runs
NEW_BINARY (it is only copied and hashed), sends no network request and deletes the sandbox on exit.
It covers first deploys, re-runs, refusals, failure paths and upgrades, and checks that no config
content leaks into any output.

It has no forecast check, by design: it tests `deploy.sh`, and `deploy.sh` does not look at the
forecast. A check of `GET /api/forecast` here would only check the stub's canned answer. The
forecast's server wiring is covered by the server's own tests with a sandbox database and stand-in
upstreams.
