#!/bin/bash
# Deploys a session-pace build of better-ccflare to the local LaunchAgent net.kalny.better-ccflare.
# Run it from a terminal, not from a model session whose tool timeout could kill it mid-run: the
# proxy is down during the reload.
#
# Usage: deploy.sh [--dry-run] [--sha256 HEX] NEW_BINARY
# Exit: 0 DEPLOYED, 1 NOT DEPLOYED (preflight refused, nothing changed),
#       2 NOT HEALTHY (a step or check failed after the first change; nothing is reverted), 64 usage.
#
# There is no automatic rollback. To go back to the release, run these by hand (a failed run prints
# them too, with its actual paths). The binary is replaced by rename rather than overwritten in
# place, because macOS can kill a signed executable whose file was rewritten in place. If bootstrap
# reports error 5, the old job is still unloading: wait a few seconds and run bootstrap again.
#   /bin/cp -p /Users/filip/.local/bin/better-ccflare.v3.6.7-release /Users/filip/.local/bin/better-ccflare.restore-tmp && /bin/mv -f /Users/filip/.local/bin/better-ccflare.restore-tmp /Users/filip/.local/bin/better-ccflare
#   /bin/cp -p /Users/filip/Library/LaunchAgents/net.kalny.better-ccflare.plist.pre-session-pace /Users/filip/.dotfiles/better-ccflare/Library/LaunchAgents/net.kalny.better-ccflare.plist
#   /bin/cp -p /Users/filip/.config/better-ccflare/better-ccflare.json.pre-session-pace /Users/filip/.config/better-ccflare/better-ccflare.json
#   /bin/launchctl bootout gui/$(id -u)/net.kalny.better-ccflare
#   /bin/launchctl bootstrap gui/$(id -u) /Users/filip/Library/LaunchAgents/net.kalny.better-ccflare.plist
#
# Secrets: the app config JSON holds OAuth tokens. Nothing here prints it or any part of it; it is
# only read through `jq -e` (exit status) and `cmp -s`, and edited by a Python snippet that prints
# nothing. Never enable xtrace in this script.
#
# Overrides, for local-ops/exercise.sh only: BCF_BIN, BCF_RELEASE_SHA, BCF_PLIST, BCF_CONFIG,
# BCF_PORT, BCF_LAUNCHCTL, BCF_CURL, BCF_LSOF, BCF_NETSTAT, BCF_CLAUDE, BCF_POLL,
# BCF_LISTEN_TIMEOUT, BCF_CHECK_TRIES, BCF_CHECK_SLEEP, BCF_BOOTOUT_WAIT, BCF_BOOTSTRAP_TRIES.

set -u
set +x
umask 077
ORIG_PATH=${PATH:-/usr/bin:/bin}
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

LABEL=net.kalny.better-ccflare
DOMAIN=gui/$(/usr/bin/id -u)
BIN=${BCF_BIN:-$HOME/.local/bin/better-ccflare}
RELEASE_KEEP=$BIN.v3.6.7-release
RELEASE_SHA=${BCF_RELEASE_SHA:-83a562d29a1785a10cbc0956377bd9f86e4ed25e936ea5fe333318966797e215}
PLIST=${BCF_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}
PLIST_BACKUP=$PLIST.pre-session-pace
CONFIG=${BCF_CONFIG:-$HOME/.config/better-ccflare/better-ccflare.json}
CONFIG_BACKUP=$CONFIG.pre-session-pace
PORT=${BCF_PORT:-8791}
API=http://127.0.0.1:$PORT
ACCOUNTS="gooddata gooddata-ai"

LAUNCHCTL=${BCF_LAUNCHCTL:-/bin/launchctl}
CURL=${BCF_CURL:-/usr/bin/curl}
LSOF=${BCF_LSOF:-/usr/sbin/lsof}
NETSTAT=${BCF_NETSTAT:-/usr/sbin/netstat}
CLAUDE=${BCF_CLAUDE:-$HOME/.local/bin/claude}
JQ=/usr/bin/jq
PYTHON=/usr/bin/python3
PLISTBUDDY=/usr/libexec/PlistBuddy
PLUTIL=/usr/bin/plutil
SHASUM=/usr/bin/shasum
PERL=/usr/bin/perl
CMP=/usr/bin/cmp

POLL=${BCF_POLL:-1}
LISTEN_TIMEOUT=${BCF_LISTEN_TIMEOUT:-180}
CHECK_TRIES=${BCF_CHECK_TRIES:-10}
CHECK_SLEEP=${BCF_CHECK_SLEEP:-2}
BOOTOUT_WAIT=${BCF_BOOTOUT_WAIT:-20}
BOOTSTRAP_TRIES=${BCF_BOOTSTRAP_TRIES:-10}
CLAUDE_TIMEOUT=180
CMD_TIMEOUT=${BCF_CMD_TIMEOUT:-15}
CLAUDE_MODEL=claude-haiku-5-5

NEW_STRATEGY=session-pace
OLD_STRATEGY=session-affinity
MSCR_NAME=MODEL_SCOPED_CAPACITY_ROUTING
MSCR_VALUE=exhausted
ABSENT=__absent__

DRY_RUN=0
CHANGED=0
PLIST_REAL=""
WORK=""
TMP_FILES=""
CHECK_FAILED=""

usage() {
  echo "usage: deploy.sh [--dry-run] [--sha256 HEX] NEW_BINARY" >&2
  exit 64
}

say() { printf 'deploy: %s\n' "$*"; }
nap() { /bin/sleep "$1"; }
now() { /bin/date +%s; }
sha256() { "$SHASUM" -a 256 "$1" 2>/dev/null | /usr/bin/awk '{print $1}'; }
fmode() { /usr/bin/stat -f %Lp "$1" 2>/dev/null; }
fowner() { /usr/bin/stat -f %u:%g "$1" 2>/dev/null; }
lower() { printf '%s' "$1" | /usr/bin/tr '[:upper:]' '[:lower:]'; }
same_bytes() { "$CMP" -s "$1" "$2"; }

resolve_path() {
  local p=$1 l d n=0
  while [ -L "$p" ]; do
    n=$((n + 1)); [ "$n" -le 20 ] || return 1
    l=$(/usr/bin/readlink "$p") || return 1
    case $l in /*) p=$l ;; *) p=$(/usr/bin/dirname "$p")/$l ;; esac
  done
  [ -e "$p" ] || return 1
  d=$(cd -P "$(/usr/bin/dirname "$p")" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "$d" "$(/usr/bin/basename "$p")"
}

require_exec() {
  local t
  for t in "$@"; do
    [ -x "$t" ] || { say "required tool missing or not executable: $t"; return 1; }
  done
}

cleanup() {
  local f
  for f in $TMP_FILES; do /bin/rm -f "$f"; done
  [ -n "$WORK" ] && /bin/rm -rf "$WORK"
}

# atomic_copy SRC TARGET [MODE] [OWNER]: copy SRC beside TARGET, then rename over TARGET.
# Without MODE/OWNER the copy keeps SRC's mode and owner (cp -p).
atomic_copy() {
  local src=$1 target=$2 mode=${3:-} owner=${4:-} tmp
  tmp="$target.pace-tmp.$$"
  TMP_FILES="$TMP_FILES $tmp"
  /bin/rm -f "$tmp"
  /bin/cp -p "$src" "$tmp" 2>/dev/null || { /bin/rm -f "$tmp"; return 1; }
  if [ -n "$mode" ]; then /bin/chmod "$mode" "$tmp" || { /bin/rm -f "$tmp"; return 1; }; fi
  if [ -n "$owner" ] && [ "$(fowner "$tmp")" != "$owner" ]; then
    /usr/sbin/chown "$owner" "$tmp" 2>/dev/null || { /bin/rm -f "$tmp"; return 1; }
  fi
  /bin/mv -f "$tmp" "$target" 2>/dev/null || { /bin/rm -f "$tmp"; return 1; }
}

# plist_env FILE NAME: prints the value of EnvironmentVariables:NAME, or __absent__.
plist_env() {
  local v
  if v=$("$PLISTBUDDY" -c "Print :EnvironmentVariables:$2" "$1" 2>/dev/null); then
    printf '%s\n' "$v"
  else
    printf '%s\n' "$ABSENT"
  fi
}
plist_key() { "$PLISTBUDDY" -c "Print :$2" "$1" 2>/dev/null; }

# Config JSON probes: exit status only, nothing printed.
config_is() { "$JQ" -e --arg v "$2" '.lb_strategy == $v' "$1" >/dev/null 2>&1; }
config_shape_ok() { "$JQ" -e 'type == "object" and (.lb_strategy | type) == "string"' "$1" >/dev/null 2>&1; }
# True when the file's mode grants no group or other access (600, 400, 700, ...).
mode_private() {
  local m
  m=$(fmode "$1")
  case $m in '' | *[!0-7]*) return 1 ;; esac
  [ $((8#$m & 8#077)) -eq 0 ]
}

# Sets one top-level string key in a JSON file in place, changing only that value's bytes.
# Prints nothing. Exit: 0 ok, 3 key missing or not a string, 4 key not found exactly once
# in the text, 5 re-parse mismatch, 9 any other error.
read -r -d '' CONFIG_EDIT_PY <<'PY'
import json, re, sys
def main(argv):
    path, key, val = argv[1], argv[2], argv[3]
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get(key), str):
        return 3
    if data[key] == val:
        return 0
    pat = re.compile(r'("' + re.escape(key) + r'"\s*:\s*)"(?:[^"\\]|\\.)*"')
    if len(pat.findall(raw)) != 1:
        return 4
    new = pat.sub(lambda m: m.group(1) + json.dumps(val), raw, count=1)
    expect = dict(data)
    expect[key] = val
    if json.loads(new) != expect:
        return 5
    with open(path, "r+", encoding="utf-8") as f:
        f.seek(0)
        f.write(new)
        f.truncate()
    return 0
try:
    sys.exit(main(sys.argv))
except SystemExit:
    raise
except BaseException:
    sys.exit(9)
PY

config_set_strategy() { "$PYTHON" -I -c "$CONFIG_EDIT_PY" "$1" lb_strategy "$2" >/dev/null 2>&1; }

# ---- launchd views (read-only) ----
# Runs one external command under a SIGALRM deadline so a hung launchctl, lsof or netstat cannot stall a check.
bounded() { "$PERL" -e 'alarm shift; exec @ARGV' "$CMD_TIMEOUT" "$@"; }
job_loaded() { bounded "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
job_pid() { bounded "$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }'; }
job_path() { bounded "$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "path" && $2 == "=" { print $3; exit }'; }

# Prints only LB_STRATEGY=<v> and MODEL_SCOPED_CAPACITY_ROUTING=<v> from the job's own
# "environment = {" block; every other variable is skipped unread.
job_env() {
  bounded "$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk -v a=LB_STRATEGY -v b="$MSCR_NAME" '
    !done && /^[[:space:]]*environment = \{[[:space:]]*$/ { inside = 1; next }
    inside && /^[[:space:]]*\}[[:space:]]*$/ { inside = 0; done = 1; next }
    inside {
      line = $0; sub(/^[[:space:]]+/, "", line)
      n = index(line, " => ")
      if (n > 0) { k = substr(line, 1, n - 1); if (k == a || k == b) print k "=" substr(line, n + 4) }
    }'
}

# ---- reload: bootout, wait until unloaded, bootstrap (retried) ----
# bootout can return before the job is gone, and bootstrap then fails with error 5 for a few
# seconds; hence the wait and the bounded retry.
reload_job() {
  local rc deadline i
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: launchctl bootout $DOMAIN/$LABEL (a job that is not loaded is fine)"
    say "would wait up to ${BOOTOUT_WAIT}s until launchctl print reports the job unloaded"
    say "would run: launchctl bootstrap $DOMAIN $PLIST (up to $BOOTSTRAP_TRIES tries)"
    return 0
  fi
  say "reload: launchctl bootout $DOMAIN/$LABEL"
  bounded "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || say "reload: bootout exit $rc (job was not loaded or is already going away)"
  deadline=$(($(now) + BOOTOUT_WAIT))
  while job_loaded; do
    if [ "$(now)" -ge "$deadline" ]; then
      say "reload: job still loaded ${BOOTOUT_WAIT}s after bootout"
      return 1
    fi
    nap "$POLL"
  done
  i=1
  while :; do
    say "reload: launchctl bootstrap $DOMAIN $PLIST (try $i)"
    bounded "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    if job_loaded; then
      say "reload: bootstrap exit $rc but the job is loaded; continuing"
      return 0
    fi
    say "reload: bootstrap exit $rc, job not loaded"
    [ "$i" -lt "$BOOTSTRAP_TRIES" ] || return 1
    i=$((i + 1))
    nap "$POLL"
  done
}

# ---- checks ----
pass_check() { say "check $1: ok ($2)"; }
fail_check() { CHECK_FAILED=$1; say "check $1: FAIL ($2)"; return 1; }

check_launchd_env() {
  local envs lb mscr i=1
  while :; do
    envs=$(job_env)
    lb=$(printf '%s\n' "$envs" | /usr/bin/sed -n 's/^LB_STRATEGY=//p' | /usr/bin/head -n 1)
    mscr=$(printf '%s\n' "$envs" | /usr/bin/sed -n "s/^$MSCR_NAME=//p" | /usr/bin/head -n 1)
    [ -n "$lb" ] || lb=$ABSENT
    [ -n "$mscr" ] || mscr=$ABSENT
    if [ "$lb" = "$NEW_STRATEGY" ] && [ "$mscr" = "$MSCR_VALUE" ]; then
      pass_check launchd-env "loaded job has LB_STRATEGY=$lb $MSCR_NAME=$mscr"
      return 0
    fi
    [ "$i" -lt "$CHECK_TRIES" ] || break
    i=$((i + 1)); nap "$CHECK_SLEEP"
  done
  fail_check launchd-env "loaded job has LB_STRATEGY=$lb $MSCR_NAME=$mscr, expected $NEW_STRATEGY / $MSCR_VALUE"
}

join_sorted() { /usr/bin/sort -u | /usr/bin/tr '\n' ' ' | /usr/bin/sed 's/ *$//'; }

listener_snapshot() {
  local out
  L_PID=$(job_pid)
  out=$(bounded "$LSOF" -nP -iTCP:"$PORT" -sTCP:LISTEN -Fpn 2>/dev/null)
  L_PIDS=$(printf '%s\n' "$out" | /usr/bin/sed -n 's/^p//p' | join_sorted)
  L_ADDRS=$(printf '%s\n' "$out" | /usr/bin/sed -n 's/^n//p' | join_sorted)
  L_NS=$(bounded "$NETSTAT" -an -p tcp 2>/dev/null | /usr/bin/awk -v sfx=".$PORT" '
    $NF == "LISTEN" { a = $4; if (length(a) > length(sfx) && substr(a, length(a) - length(sfx) + 1) == sfx) print a }' | join_sorted)
}

check_listener() {
  local deadline
  deadline=$(($(now) + LISTEN_TIMEOUT))
  while :; do
    listener_snapshot
    if [ -n "$L_PID" ] && case " $L_PIDS " in *" $L_PID "*) true ;; *) false ;; esac; then break; fi
    if [ "$(now)" -ge "$deadline" ]; then
      fail_check listener "no listener from job pid ${L_PID:-none} on port $PORT within ${LISTEN_TIMEOUT}s (listener pids: ${L_PIDS:-none})"
      return 1
    fi
    nap "$POLL"
  done
  if [ "$L_PIDS" = "$L_PID" ] && [ "$L_ADDRS" = "127.0.0.1:$PORT" ] && [ "$L_NS" = "127.0.0.1.$PORT" ]; then
    pass_check listener "only 127.0.0.1:$PORT, pid $L_PID"
    return 0
  fi
  fail_check listener "port $PORT listeners: pids=[$L_PIDS] lsof=[$L_ADDRS] netstat=[$L_NS], job pid $L_PID"
}

check_binary() {
  local got
  got=$(sha256 "$BIN")
  if [ "$got" = "$NEW_SHA" ]; then pass_check binary "$BIN sha256 $got"; return 0; fi
  fail_check binary "$BIN sha256 ${got:-unreadable}, expected $NEW_SHA"
}

http_get() {
  local code
  code=$("$CURL" -sS --max-time 5 -o "$2" -w '%{http_code}' "$API$1" 2>/dev/null) || return 1
  [ "$code" = 200 ]
}

check_accounts() {
  local body="$WORK/accounts.json" i=1 a st detail ok
  while :; do
    ok=1; detail=""
    if http_get /api/accounts "$body" && "$JQ" -e 'type == "array"' "$body" >/dev/null 2>&1; then
      for a in $ACCOUNTS; do
        st=$("$JQ" -r --arg n "$a" '[.[] | select(.name == $n)] | if length == 0 then "missing" elif length > 1 then "duplicate" elif .[0].paused == false then "unpaused" else "paused" end' "$body" 2>/dev/null)
        detail="$detail $a=${st:-unreadable}"
        [ "$st" = unpaused ] || ok=0
      done
    else
      ok=0; detail=" GET /api/accounts failed"
    fi
    if [ "$ok" = 1 ]; then pass_check accounts "${detail# }"; return 0; fi
    [ "$i" -lt "$CHECK_TRIES" ] || break
    i=$((i + 1)); nap "$CHECK_SLEEP"
  done
  fail_check accounts "${detail# }"
}

check_strategy() {
  local body="$WORK/strategy.json" i=1 got
  while :; do
    got=""
    if http_get /api/config/strategy "$body"; then
      got=$("$JQ" -r '.strategy // "none"' "$body" 2>/dev/null)
      if [ "$got" = "$NEW_STRATEGY" ]; then pass_check strategy "GET /api/config/strategy -> $got"; return 0; fi
    fi
    [ "$i" -lt "$CHECK_TRIES" ] || break
    i=$((i + 1)); nap "$CHECK_SLEEP"
  done
  fail_check strategy "GET /api/config/strategy -> ${got:-no answer}, expected $NEW_STRATEGY"
}

check_claude() {
  local out rc norm
  out=$(cd "$WORK" && PATH=$ORIG_PATH /usr/bin/env -u CLAUDECODE "$PERL" -e 'alarm shift; exec @ARGV' "$CLAUDE_TIMEOUT" \
    "$CLAUDE" -p "Reply with the single word ok" --model "$CLAUDE_MODEL" </dev/null 2>/dev/null)
  rc=$?
  norm=$(printf '%s' "$out" | /usr/bin/tr -d '[:space:][:punct:]' | /usr/bin/tr '[:upper:]' '[:lower:]')
  if [ "$rc" -eq 0 ] && [ "$norm" = ok ]; then pass_check claude "claude -p --model $CLAUDE_MODEL replied ok"; return 0; fi
  fail_check claude "claude -p exit $rc, reply '$(printf '%s' "$norm" | /usr/bin/cut -c1-40)'"
}

run_checks() {
  CHECK_FAILED=""
  if [ "$DRY_RUN" = 1 ]; then
    say "would check launchd-env: launchctl print shows LB_STRATEGY=$NEW_STRATEGY and $MSCR_NAME=$MSCR_VALUE (only these two values read)"
    say "would check listener: wait up to ${LISTEN_TIMEOUT}s for the job's pid to listen on $PORT, then require 127.0.0.1:$PORT only (lsof and netstat)"
    say "would check binary: sha256 of $BIN is $NEW_SHA"
    say "would check accounts: GET $API/api/accounts lists $ACCOUNTS, each once and unpaused ($CHECK_TRIES tries)"
    say "would check strategy: GET $API/api/config/strategy reports $NEW_STRATEGY ($CHECK_TRIES tries)"
    say "would check claude: one claude -p \"Reply with the single word ok\" --model $CLAUDE_MODEL (timeout ${CLAUDE_TIMEOUT}s)"
    return 0
  fi
  check_launchd_env || return 1
  check_listener || return 1
  check_binary || return 1
  check_accounts || return 1
  check_strategy || return 1
  check_claude || return 1
}

print_restore() {
  say "restore by hand, in this order (nothing was reverted):"
  say "restore: /bin/cp -p '$RELEASE_KEEP' '$BIN.restore-tmp' && /bin/mv -f '$BIN.restore-tmp' '$BIN'"
  say "restore: /bin/cp -p '$PLIST_BACKUP' '$PLIST_REAL'"
  say "restore: /bin/cp -p '$CONFIG_BACKUP' '$CONFIG'"
  say "restore: $LAUNCHCTL bootout $DOMAIN/$LABEL"
  say "restore: $LAUNCHCTL bootstrap $DOMAIN '$PLIST'"
  say "if bootstrap reports error 5, wait a few seconds and run it again; logs are in $HOME/Library/Logs/better-ccflare"
}

refuse() {
  echo "NOT DEPLOYED (preflight: $1): nothing was changed"
  exit 1
}

failed() {
  trap '' INT TERM HUP
  say "failed: $1; stopping, no further changes"
  print_restore
  echo "NOT HEALTHY (failed check: $1)"
  exit 2
}

on_signal() {
  [ "$CHANGED" = 1 ] && failed interrupted
  echo "NOT DEPLOYED (interrupted before any change): nothing was changed"
  exit 1
}

# backup SRC DST WHAT: copy SRC to DST (same directory as the original, same mode) unless DST
# already exists, which keeps the pre-deploy copy from an earlier run.
backup() {
  if [ -e "$2" ]; then
    say "backup $3: keeping existing $2"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "would back up $3: copy $1 to $2 (cp -p, via rename)"
    return 0
  fi
  atomic_copy "$1" "$2" || refuse "cannot write $2"
  same_bytes "$1" "$2" || refuse "$2 does not match $1 after copying"
  say "backup $3: $1 -> $2"
}

# ---- arguments ----
NEW=""
EXPECT_SHA=""
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY_RUN=1; shift ;;
    --sha256) [ $# -ge 2 ] || usage; EXPECT_SHA=$(lower "$2"); shift 2 ;;
    -*) usage ;;
    *) [ -z "$NEW" ] || usage; NEW=$1; shift ;;
  esac
done
[ -n "$NEW" ] || usage

trap cleanup EXIT
trap on_signal INT TERM HUP

[ "$DRY_RUN" = 1 ] && say "dry run: read-only probes only; no file or directory written, no launchctl call other than print, no claude run"

# ---- preflight (read-only) ----
if [ "$DRY_RUN" != 1 ]; then
  WORK=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/pace-deploy.XXXXXX" 2>/dev/null) || { WORK=""; refuse "cannot create a temporary directory"; }
  /bin/chmod 700 "$WORK" || refuse "cannot make $WORK private"
fi

require_exec "$LAUNCHCTL" "$PLISTBUDDY" "$PLUTIL" "$SHASUM" "$JQ" "$PYTHON" "$CURL" "$LSOF" "$NETSTAT" "$PERL" "$CMP" "$CLAUDE" || refuse "tools"
"$PYTHON" -I -c 'import json, re' >/dev/null 2>&1 || refuse "$PYTHON cannot import json and re"
say "preflight: tools present ($JQ, $PYTHON, $PLISTBUDDY, $PLUTIL, $CLAUDE)"

[ -f "$NEW" ] && [ -x "$NEW" ] || refuse "new binary $NEW is not an executable file"
NEW_SHA=$(sha256 "$NEW")
[ -n "$NEW_SHA" ] || refuse "cannot hash $NEW"
if [ -n "$EXPECT_SHA" ] && [ "$NEW_SHA" != "$EXPECT_SHA" ]; then
  refuse "new binary sha256 $NEW_SHA is not the expected $EXPECT_SHA"
fi
[ "$NEW_SHA" != "$RELEASE_SHA" ] || refuse "new binary is the release binary itself"
say "preflight: new binary $NEW sha256 $NEW_SHA${EXPECT_SHA:+ (matches --sha256)}"

PLIST_REAL=$(resolve_path "$PLIST") || refuse "plist $PLIST does not resolve to a file"
"$PLUTIL" -lint -s "$PLIST_REAL" >/dev/null 2>&1 || refuse "plist $PLIST_REAL fails plutil -lint"
[ "$(plist_key "$PLIST_REAL" Label)" = "$LABEL" ] || refuse "plist Label is not $LABEL"
[ "$(plist_key "$PLIST_REAL" ProgramArguments:0)" = "$BIN" ] || refuse "plist ProgramArguments:0 is not $BIN"
say "preflight: plist $PLIST -> $PLIST_REAL (lint ok, Label and program match)"

[ -f "$BIN" ] || refuse "installed binary $BIN is missing"
[ -f "$CONFIG" ] || refuse "config $CONFIG is missing"
mode_private "$CONFIG" || refuse "config $CONFIG has mode $(fmode "$CONFIG"), which grants group or other access; chmod 600 it first"
config_shape_ok "$CONFIG" || refuse "config $CONFIG is not a JSON object with a string lb_strategy"
say "preflight: config $CONFIG is a JSON object with a string lb_strategy (mode $(fmode "$CONFIG"), private)"

CUR_SHA=$(sha256 "$BIN")
PLIST_LB=$(plist_env "$PLIST_REAL" LB_STRATEGY)
PLIST_MSCR=$(plist_env "$PLIST_REAL" "$MSCR_NAME")
if config_is "$CONFIG" "$OLD_STRATEGY"; then CONFIG_LB=$OLD_STRATEGY
elif config_is "$CONFIG" "$NEW_STRATEGY"; then CONFIG_LB=$NEW_STRATEGY
else CONFIG_LB=other; fi

if [ "$CUR_SHA" = "$RELEASE_SHA" ] && [ "$PLIST_LB" = "$OLD_STRATEGY" ] && [ "$CONFIG_LB" = "$OLD_STRATEGY" ]; then
  # Release state. A backup left from an earlier run is kept, so it must still be the current file.
  if [ -e "$RELEASE_KEEP" ] && [ "$(sha256 "$RELEASE_KEEP")" != "$RELEASE_SHA" ]; then refuse "$RELEASE_KEEP exists but is not the release binary"; fi
  if [ -e "$PLIST_BACKUP" ] || [ -L "$PLIST_BACKUP" ]; then
    [ -f "$PLIST_BACKUP" ] && [ ! -L "$PLIST_BACKUP" ] && same_bytes "$PLIST_BACKUP" "$PLIST_REAL" || refuse "$PLIST_BACKUP exists but is not a regular copy of $PLIST_REAL; move it aside"
  fi
  if [ -e "$CONFIG_BACKUP" ]; then
    mode_private "$CONFIG_BACKUP" && same_bytes "$CONFIG_BACKUP" "$CONFIG" || refuse "$CONFIG_BACKUP exists but is not a private copy of $CONFIG; move it aside"
  fi
  say "preflight: current state is the release ($OLD_STRATEGY, $MSCR_NAME=$PLIST_MSCR)"
else
  # Deployed or half-deployed by an earlier run: every backup was taken before the first change.
  [ -f "$RELEASE_KEEP" ] && [ -f "$PLIST_BACKUP" ] && [ -f "$CONFIG_BACKUP" ] ||
    refuse "state is not the release (binary sha256 $CUR_SHA, plist LB_STRATEGY=$PLIST_LB, config lb_strategy $CONFIG_LB) and the backups of an earlier run are not all present"
  [ "$(sha256 "$RELEASE_KEEP")" = "$RELEASE_SHA" ] || refuse "$RELEASE_KEEP is not the release binary"
  [ ! -L "$PLIST_BACKUP" ] && "$PLUTIL" -lint -s "$PLIST_BACKUP" >/dev/null 2>&1 &&
    [ "$(plist_key "$PLIST_BACKUP" Label)" = "$LABEL" ] && [ "$(plist_key "$PLIST_BACKUP" ProgramArguments:0)" = "$BIN" ] &&
    [ "$(plist_env "$PLIST_BACKUP" LB_STRATEGY)" = "$OLD_STRATEGY" ] ||
    refuse "$PLIST_BACKUP is not a release plist (regular file, lint, Label, ProgramArguments:0, LB_STRATEGY=$OLD_STRATEGY)"
  mode_private "$CONFIG_BACKUP" && config_is "$CONFIG_BACKUP" "$OLD_STRATEGY" ||
    refuse "$CONFIG_BACKUP is not a private release config (lb_strategy $OLD_STRATEGY)"
  case $CUR_SHA in "$RELEASE_SHA" | "$NEW_SHA") ;; *) refuse "installed binary sha256 $CUR_SHA is neither the release nor the new binary" ;; esac
  case $PLIST_LB in "$OLD_STRATEGY" | "$NEW_STRATEGY") ;; *) refuse "plist LB_STRATEGY=$PLIST_LB is neither $OLD_STRATEGY nor $NEW_STRATEGY" ;; esac
  [ "$CONFIG_LB" != other ] || refuse "config lb_strategy is neither $OLD_STRATEGY nor $NEW_STRATEGY"
  say "preflight: current state is an earlier deploy (binary sha256 $CUR_SHA, plist LB_STRATEGY=$PLIST_LB, config $CONFIG_LB); its backups are kept"
fi

if job_loaded; then
  say "preflight: job $DOMAIN/$LABEL loaded, pid $(job_pid), plist path $(job_path)"
else
  say "preflight: job $DOMAIN/$LABEL is not loaded; deploy will bootstrap it"
fi

# ---- backups ----
if [ -e "$RELEASE_KEEP" ]; then
  say "backup binary: keeping existing $RELEASE_KEEP"
elif [ "$DRY_RUN" = 1 ]; then
  say "would back up binary: copy $BIN to $RELEASE_KEEP (cp -p, via rename)"
else
  atomic_copy "$BIN" "$RELEASE_KEEP" || refuse "cannot write $RELEASE_KEEP"
  [ "$(sha256 "$RELEASE_KEEP")" = "$RELEASE_SHA" ] || refuse "$RELEASE_KEEP does not hash to the release sha256"
  say "backup binary: $BIN -> $RELEASE_KEEP"
fi
backup "$PLIST_REAL" "$PLIST_BACKUP" plist
backup "$CONFIG" "$CONFIG_BACKUP" config

if [ "$DRY_RUN" = 1 ]; then
  if [ "$CUR_SHA" = "$NEW_SHA" ]; then
    say "would leave $BIN alone (already the new binary)"
  else
    say "would install $NEW as $BIN: copy beside it with mode $(fmode "$BIN") owner $(fowner "$BIN"), then rename"
  fi
  if [ "$PLIST_MSCR" = "$ABSENT" ]; then mscr_op=add; else mscr_op="set (now $PLIST_MSCR)"; fi
  say "would edit a copy of $PLIST_REAL: set LB_STRATEGY=$NEW_STRATEGY, $mscr_op $MSCR_NAME=$MSCR_VALUE, then rename"
  say "would edit a copy of $CONFIG: set lb_strategy to $NEW_STRATEGY in place (nothing printed), then rename"
  say "would validate binary sha256, plist lint and values, and config lb_strategy before the reload"
  reload_job
  run_checks
  say "on a failed step or check would stop, change nothing further, print the restore commands and exit 2"
  echo "DRY RUN: no changes made"
  exit 0
fi

# ---- changes ----
CHANGED=1

if [ "$CUR_SHA" = "$NEW_SHA" ]; then
  say "install: $BIN is already the new binary"
else
  say "install: $NEW -> $BIN (mode $(fmode "$BIN"), owner $(fowner "$BIN"))"
  atomic_copy "$NEW" "$BIN" "$(fmode "$BIN")" "$(fowner "$BIN")" || failed install
fi
[ "$(sha256 "$BIN")" = "$NEW_SHA" ] || failed install

if [ "$PLIST_LB" = "$NEW_STRATEGY" ] && [ "$PLIST_MSCR" = "$MSCR_VALUE" ]; then
  say "plist: already LB_STRATEGY=$NEW_STRATEGY $MSCR_NAME=$MSCR_VALUE"
else
  ptmp="$PLIST_REAL.pace-tmp.$$"
  TMP_FILES="$TMP_FILES $ptmp"
  /bin/cp -p "$PLIST_REAL" "$ptmp" || failed plist-edit
  "$PLISTBUDDY" -c "Set :EnvironmentVariables:LB_STRATEGY $NEW_STRATEGY" "$ptmp" >/dev/null 2>&1 || failed plist-edit
  if [ "$(plist_env "$ptmp" "$MSCR_NAME")" = "$ABSENT" ]; then
    "$PLISTBUDDY" -c "Add :EnvironmentVariables:$MSCR_NAME string $MSCR_VALUE" "$ptmp" >/dev/null 2>&1 || failed plist-edit
  else
    "$PLISTBUDDY" -c "Set :EnvironmentVariables:$MSCR_NAME $MSCR_VALUE" "$ptmp" >/dev/null 2>&1 || failed plist-edit
  fi
  /bin/chmod "$(fmode "$PLIST_REAL")" "$ptmp" || failed plist-edit
  /bin/mv -f "$ptmp" "$PLIST_REAL" || failed plist-edit
  say "plist: set LB_STRATEGY=$NEW_STRATEGY and $MSCR_NAME=$MSCR_VALUE in $PLIST_REAL (was $PLIST_LB / $PLIST_MSCR)"
fi

if [ "$CONFIG_LB" = "$NEW_STRATEGY" ]; then
  say "config: lb_strategy already $NEW_STRATEGY"
else
  ctmp="$CONFIG.pace-tmp.$$"
  TMP_FILES="$TMP_FILES $ctmp"
  /bin/cp -p "$CONFIG" "$ctmp" || failed config-edit
  config_set_strategy "$ctmp" "$NEW_STRATEGY" || failed config-edit
  config_is "$ctmp" "$NEW_STRATEGY" || failed config-edit
  /bin/mv -f "$ctmp" "$CONFIG" || failed config-edit
  say "config: set lb_strategy=$NEW_STRATEGY in place in $CONFIG (contents not printed)"
fi

"$PLUTIL" -lint -s "$PLIST_REAL" >/dev/null 2>&1 || failed pre-reload-validation
[ "$(plist_env "$PLIST_REAL" LB_STRATEGY)" = "$NEW_STRATEGY" ] || failed pre-reload-validation
[ "$(plist_env "$PLIST_REAL" "$MSCR_NAME")" = "$MSCR_VALUE" ] || failed pre-reload-validation
config_is "$CONFIG" "$NEW_STRATEGY" || failed pre-reload-validation
[ "$(sha256 "$BIN")" = "$NEW_SHA" ] || failed pre-reload-validation
[ "$(resolve_path "$PLIST")" = "$PLIST_REAL" ] || failed pre-reload-validation
say "validate: binary sha256, plist (lint, LB_STRATEGY, $MSCR_NAME) and config lb_strategy are as intended"

reload_job || failed reload
run_checks || failed "$CHECK_FAILED"

say "session-pace running from $BIN (sha256 $NEW_SHA), $MSCR_NAME=$MSCR_VALUE; backups: $RELEASE_KEEP, $PLIST_BACKUP, $CONFIG_BACKUP"
echo "DEPLOYED"
exit 0
