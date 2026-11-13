# Pre-warm

Opens an account's 5-hour window ahead of demand with one tiny request through the real `claude`
CLI, pinned to that account. OFF by default (`forecast.prewarm = false`). Nothing here runs unless
WIRING constructs it.

- `runner.ts`: `createClaudeCliRunner(options)` spawns the CLI once and keeps only the exit code
  and duration. `nodeClaudeCliIo()` supplies the real process, file system and clock.
- `scheduler.ts`: `createPrewarmScheduler(deps)` fires on `tick(now)` (every usage poll) and on its
  own timer, under the guards of design.md section 7. It keeps records in `forecast_meta`
  (`prewarm.records`, last 20, for display; `prewarm.history`, firing times per account for the
  5-hour and daily guards, 48 h; `prewarm.tests`, every used one-shot pair). After a restart a run
  that was in flight is judged only from a reading taken after its longest possible run (65 s).

## The command

```
<claude> --print ok --bare --model <prewarmModel> --no-session-persistence --output-format text --tools ""
```

Run in a fresh empty temporary directory, stdin/stdout/stderr all ignored (no output is read or
logged), killed with SIGTERM after 60 s and SIGKILL 5 s later.

| Part | Why |
|---|---|
| `--print ok` | non-interactive, one word, exits after the answer |
| `--bare` | no hooks, no CLAUDE.md, no plugins/MCP, no prefetches; auth only from `ANTHROPIC_API_KEY`, **never reads OAuth or the keychain** (CLI help, 2.1.322) |
| `--model <prewarmModel>` | the setting, Haiku by default: the cheapest request that opens the window |
| `--no-session-persistence` | nothing written to `~/.claude/projects` |
| `--output-format text` | the plain default; output is discarded anyway |
| `--tools ""` | no tools; kept last because the option is variadic and would swallow a following prompt |
| empty working directory | no project files, settings or CLAUDE.md in reach |

Environment (nothing else inherited from the proxy except HOME, PATH, USER, LOGNAME, TMPDIR, LANG):

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<proxy port>` | through the local proxy only |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-better-ccflare-account-id: <account id>` | pins the account, bypassing the strategy (`packages/proxy/src/handlers/account-selector.ts`) |
| `ANTHROPIC_API_KEY` | `better-ccflare-prewarm`, or the proxy's API key when one is configured | `--bare` needs a key; the Anthropic provider drops the incoming `x-api-key`/`Authorization` and sets the pinned account's own credential (`packages/providers/src/providers/anthropic/provider.ts` ~397-423) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY` | `1` | no traffic besides the one request (documented Claude Code variables; not listed in `--help`) |

The executable: `forecast.claudePath` if set (must be executable, no fallback), else the first
executable `claude` on PATH, then `~/.local/bin/claude`, `~/.claude/local/claude`,
`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`. A LaunchAgent's PATH usually lacks
`~/.local/bin`, where the CLI is installed on this Mac; the fallback list covers it.

## Authentication and the keychain

Settled from source and help (no request sent): with `--bare` the CLI does not read the keychain
or `~/.claude/.credentials.json`, so a process started by the per-user LaunchAgent
`net.kalny.better-ccflare` should not meet a keychain dialog. Without `--bare` the CLI would use the
logged-in OAuth login from the keychain, and its item's access list names a versioned binary path
(`~/.local/share/claude/versions/<v>`) that changes on every update, which is how a "claude wants to
use your confidential information" dialog would appear. Nothing here needs sudo or a macOS
permission.

Not known until the test morning:
1. That `--bare` with a placeholder key really sends the request (and does not refuse the
   key before sending).
2. That the proxy, receiving an `x-api-key` request for an OAuth account, sends it upstream with
   the account's OAuth token and the request succeeds (exit 0).
3. Whether the proxy has local API keys configured. The wiring passes no local key: the server
   sets `proxyApiKey` to return null, so the runner sends the placeholder key. If the installed
   proxy has active local API keys, it answers the pre-warm request with 401, which shows as a
   non-zero exit. Open point for the test morning.
4. That a Haiku `claude -p` request opens the 5-hour window (research 13 says any counted request
   does; not observed for Haiku through this proxy).
5. Whether a timer due while the lid is closed fires in a dark wake or only after the Mac wakes.

## What the proxy records

The request appears in `GET /api/requests?limit=N` with the pinned account, its start time, status
and the model the upstream reports (a Haiku model). There is no user-agent column; account, time and
model identify it. The window itself shows in the next usage poll: `five_hour.resets_at` of that
account (`GET /api/usage-history?account=<id>&range=24h`, field `resetsAt`). The scheduler takes the
first reading made after the run finished: an open 5-hour window whose reset lies after the firing
gives `windowOpened=true` and that `resetsAt`; otherwise `windowOpened=false`, `resetsAt=none`.

## Test morning (run by the supervisor with Filip)

1. Pick an account whose 5-hour window is closed (`/api/usage-history` shows no future `resetsAt`)
   and a time `at` a few minutes ahead, or overnight for the lid-closed question. Leave
   `forecast.prewarm` off.
2. Set `forecast.prewarmTest = { "account": "<account id or name>", "at": <epoch ms> }`.
3. Afterwards, in the proxy log (INFO):
   - `forecast prewarm fire account=<name> kind=test scheduled=<iso> late=<seconds>`
   - `forecast prewarm done account=<name> exit=<code> ms=<n>` (exit 0 expected; `exit=none` plus a
     WARN `forecast prewarm failed ... error=<text>` means it did not run: not found, spawn error,
     timeout)
   - `forecast prewarm result account=<name> windowOpened=<true|false> resetsAt=<iso|none>` after
     the next usage poll
   - or `forecast prewarm skip account=<name> reason=window_open` if the window was already open
     (the pair is then used up; set a new `at` to try again).
4. `GET /api/forecast`, field `prewarm.last[0]`: `kind: "test"`, `scheduledAt`, `firedAt`,
   `exitCode`, `windowOpened`, `resetsAt`. `resetsAt` should be about `firedAt` + 5 h.
5. `GET /api/requests?limit=20`: one request on that account at `firedAt`, a Haiku model, status 200.
6. Lid closed: set `at` to a time while the Mac sleeps with the lid closed. The scheduler's timer
   waits at most 60 s at a time, so after a wake it fires within a minute. `late` tells the cases
   apart: `late` of a few seconds to a minute means it fired during the sleep (a dark wake), and
   `firedAt`/`resetsAt` lie before the lid was opened. `late` close to (lid-open time − `at`)
   means it only ran after the wake. Compare `firedAt` with the wake time in `pmset -g log`.
