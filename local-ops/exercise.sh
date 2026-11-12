#!/bin/bash
# Sandbox exercise for deploy.sh. Builds a mode-700 mktemp sandbox holding copies of the real
# release binary, LaunchAgent plist and app config JSON, points deploy.sh at the copies through
# BCF_* overrides, and replaces launchctl, curl (the HTTP endpoints), lsof, netstat and claude with
# stubs. Nothing here touches the real installation, calls launchctl, runs the real claude or sends
# a network request. The sandbox is deleted on exit.
#
# The upgrade scenarios start each sandbox from a finished first deploy of NEW_BINARY (first-deploy
# backups present, plist and config at session-pace) and upgrade it with --upgrade-from to a
# stand-in for the next build: a copy of NEW_BINARY with bytes appended, never executed.
#
# Usage: exercise.sh NEW_BINARY      (any executable that differs from the release binary)
# Exit: 0 when every scenario passes, 1 otherwise. EX_LOG_DIR keeps the script output.

set -u
set +x
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

HERE=$(cd -P "$(dirname "$0")" && pwd)
DEPLOY=$HERE/deploy.sh
LABEL=net.kalny.better-ccflare
REAL_BIN=$HOME/.local/bin/better-ccflare
REAL_KEEP=$REAL_BIN.v3.6.7-release
REAL_PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
REAL_CONFIG=$HOME/.config/better-ccflare/better-ccflare.json
PB=/usr/libexec/PlistBuddy

[ $# -eq 1 ] || { echo "usage: exercise.sh NEW_BINARY" >&2; exit 64; }
NEW_SRC=$1
[ -f "$NEW_SRC" ] || { echo "exercise: $NEW_SRC is not a file" >&2; exit 64; }

SBX=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/pace-exercise.XXXXXX") || exit 1
/bin/chmod 700 "$SBX"
SBX=$(cd -P "$SBX" && pwd) || exit 1
trap '/bin/chmod -R u+w "$SBX" 2>/dev/null; /bin/rm -rf "$SBX"' EXIT
trap 'exit 130' INT TERM HUP

sha() { /usr/bin/shasum -a 256 "$1" 2>/dev/null | /usr/bin/awk '{print $1}'; }
mtime() { /usr/bin/stat -f %m "$1" 2>/dev/null; }
inode() { /usr/bin/stat -f %i "$1" 2>/dev/null; }
fmode() { /usr/bin/stat -f %Lp "$1" 2>/dev/null; }
die() { echo "exercise: setup failed: $*" >&2; exit 1; }

# ---- pristine copies (normalised to the release state the deploy expects) ----
P=$SBX/pristine
/bin/mkdir -p "$P" && /bin/chmod 700 "$P"
if [ -f "$REAL_KEEP" ]; then src_bin=$REAL_KEEP; else src_bin=$REAL_BIN; fi
/bin/cp -p "$src_bin" "$P/bin" || die "copy binary"
real_plist_file=$(/usr/bin/perl -MCwd=abs_path -e 'my $p = abs_path(shift); defined $p or exit 1; print $p' "$REAL_PLIST") || die "resolve plist"
/bin/cp -p "$real_plist_file" "$P/plist" || die "copy plist"
/bin/cp -p "$REAL_CONFIG" "$P/config" || die "copy config"
/bin/cp "$NEW_SRC" "$P/new" && /bin/chmod 755 "$P/new" || die "copy new binary"
RELEASE_SHA=$(sha "$P/bin")
NEW_SHA=$(sha "$P/new")
[ "$RELEASE_SHA" != "$NEW_SHA" ] || die "the stand-in new binary must differ from the release binary"
$PB -c "Set :EnvironmentVariables:LB_STRATEGY session-affinity" "$P/plist" >/dev/null 2>&1 || die "plist LB_STRATEGY"
$PB -c "Delete :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING" "$P/plist" >/dev/null 2>&1
# Synthetic secret planted in the config copy, which is also set to the release lb_strategy; the
# leak checks at the end assert the secret never leaves the config files. Written via a mode-600
# temp file; nothing is printed.
SENTINEL=$(/usr/bin/od -An -N16 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')
[ ${#SENTINEL} = 32 ] || die "sentinel"
(umask 077; /usr/bin/jq --arg s "exercise-sentinel-$SENTINEL" '. + {exercise_sentinel_token: $s} | .lb_strategy = "session-affinity"' "$P/config" >"$P/config.tmp" 2>/dev/null) || die "plant sentinel"
/bin/chmod "$(fmode "$P/config")" "$P/config.tmp" && /bin/mv -f "$P/config.tmp" "$P/config" || die "plant sentinel"
/usr/bin/jq -e '.lb_strategy == "session-affinity" and (.exercise_sentinel_token | type) == "string"' "$P/config" >/dev/null 2>&1 || die "sentinel config shape"

# ---- stubs ----
ST=$SBX/stubs
/bin/mkdir -p "$ST"
cat >"$ST/common.sh" <<'EOF'
C=${EX_CTL:?}
# inj NAME [LB]: injection NAME is active. Modes: always; pace (the job, or LB if given, runs
# session-pace); once (fires one time).
inj() {
  local mode lb=${2:-}
  mode=$(/usr/bin/awk -v n="$1" '$1 == n { print $2; exit }' "$C/inject" 2>/dev/null)
  [ -n "$lb" ] || lb=$(/bin/cat "$C/env_lb" 2>/dev/null)
  case $mode in
    always) return 0 ;;
    pace) [ "$lb" = session-pace ] ;;
    once) /usr/bin/grep -v "^$1 " "$C/inject" >"$C/inject.n"; /bin/mv "$C/inject.n" "$C/inject"; return 0 ;;
    *) return 1 ;;
  esac
}
loaded() { [ -f "$C/loaded" ]; }
EOF
cat >"$ST/launchctl" <<'EOF'
#!/bin/bash
. "$(dirname "$0")/common.sh"
echo "launchctl $*" >>"$C/calls.log"
PB=/usr/libexec/PlistBuddy
case ${1:-} in
  print)
    loaded || { echo "Could not find service \"x\" in domain for user gui: 501" >&2; exit 113; }
    mscr=$(/bin/cat "$C/env_mscr")
    inj launchd_env && mscr=__absent__
    printf '%s = {\n\tactive count = 1\n\tpath = %s\n\ttype = LaunchAgent\n\tstate = running\n\n' "$2" "$(/bin/cat "$C/path")"
    printf '\tprogram = %s\n\tdefault environment = {\n\t\tLB_STRATEGY => bogus-default\n\t\tPATH => /usr/bin:/bin\n\t}\n\n' "$(/bin/cat "$C/program")"
    printf '\tenvironment = {\n\t\tBETTER_CCFLARE_HOST => 127.0.0.1\n\t\tLB_STRATEGY => %s\n' "$(/bin/cat "$C/env_lb")"
    [ "$mscr" = __absent__ ] || printf '\t\tMODEL_SCOPED_CAPACITY_ROUTING => %s\n' "$mscr"
    printf '\t\tSTORE_PAYLOADS => false\n\t}\n\n\tpid = %s\n\tlast exit code = (never exited)\n}\n' "$(/bin/cat "$C/pid")"
    ;;
  bootout)
    if loaded; then
      /bin/rm -f "$C/loaded"
      exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2
    exit 3
    ;;
  bootstrap)
    plist=$3
    lb=$($PB -c "Print :EnvironmentVariables:LB_STRATEGY" "$plist" 2>/dev/null)
    if loaded; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    if inj bootstrap_fail "$lb"; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    n=$(/bin/cat "$C/bootstrap_transient" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$C/bootstrap_transient"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo "$lb" >"$C/env_lb"
    $PB -c "Print :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING" "$plist" >"$C/env_mscr" 2>/dev/null || echo __absent__ >"$C/env_mscr"
    $PB -c "Print :ProgramArguments:0" "$plist" >"$C/program" 2>/dev/null
    echo "$plist" >"$C/path"
    echo $(($(/bin/cat "$C/pid") + 1)) >"$C/pid"
    touch "$C/loaded"
    if inj binary_corrupt "$lb"; then printf 'x' >>"$(/bin/cat "$C/program")"; fi
    ;;
  *)
    echo "UNEXPECTED launchctl $*" >>"$C/calls.log"
    exit 64
    ;;
esac
EOF
cat >"$ST/curl" <<'EOF'
#!/bin/bash
. "$(dirname "$0")/common.sh"
echo "curl $*" >>"$C/calls.log"
out=/dev/stdout url="" code=200
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -w | --max-time | -m) shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
loaded || { echo "curl: (7) Failed to connect" >&2; exit 7; }
case $url in
  */api/accounts)
    p=false; inj accounts_paused && p=true
    body='[{"name":"gooddata","paused":false,"id":"1"},{"name":"gooddata-ai","paused":'$p',"id":"2"},{"name":"spare","paused":true,"id":"3"}]' ;;
  */api/config/strategy)
    s=$(/bin/cat "$C/env_lb"); inj strategy_wrong && s=session-affinity
    body='{"strategy":"'$s'","strategySource":"env"}' ;;
  *) body='{"error":"not found"}'; code=404 ;;
esac
printf '%s' "$body" >"$out"
printf '%s' "$code"
EOF
cat >"$ST/lsof" <<'EOF'
#!/bin/bash
. "$(dirname "$0")/common.sh"
echo "lsof $*" >>"$C/calls.log"
loaded || exit 1
printf 'p%s\nf12\nn127.0.0.1:%s\n' "$(/bin/cat "$C/pid")" "$EX_PORT"
inj listener_wide && printf 'f13\nn*:%s\n' "$EX_PORT"
exit 0
EOF
cat >"$ST/netstat" <<'EOF'
#!/bin/bash
. "$(dirname "$0")/common.sh"
echo "netstat $*" >>"$C/calls.log"
echo "Active Internet connections (including servers)"
echo "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)"
echo "tcp4       0      0  127.0.0.1.9999         *.*                    LISTEN"
if loaded; then
  echo "tcp4       0      0  127.0.0.1.$EX_PORT         *.*                    LISTEN"
  inj listener_wide && echo "tcp46      0      0  *.$EX_PORT                 *.*                    LISTEN"
fi
exit 0
EOF
cat >"$ST/claude" <<'EOF'
#!/bin/bash
. "$(dirname "$0")/common.sh"
echo "claude $*" >>"$C/calls.log"
if inj claude_fail; then echo "API Error: 502" ; exit 1; fi
echo "Ok."
EOF
/bin/chmod 700 "$ST"/*

# ---- per-scenario sandbox ----
PASS=0
FAIL=0
S=""
OUT=""
RC=0
N=0
WHY=""
TRIES=4

setup() { # NAME MSCR(__absent__|value) [loaded|unloaded]
  N=$((N + 1))
  S=$SBX/s$N
  /bin/mkdir -p "$S/bin" "$S/dotfiles/LaunchAgents" "$S/LaunchAgents" "$S/config" "$S/ctl" "$S/tmp"
  /bin/chmod 700 "$S/config"
  /bin/cp -c -p "$P/bin" "$S/bin/better-ccflare" 2>/dev/null || /bin/cp -p "$P/bin" "$S/bin/better-ccflare"
  /bin/cp -p "$P/plist" "$S/dotfiles/LaunchAgents/$LABEL.plist"
  RP=$S/dotfiles/LaunchAgents/$LABEL.plist
  $PB -c "Set :ProgramArguments:0 $S/bin/better-ccflare" "$RP" >/dev/null
  if [ "$2" != __absent__ ]; then $PB -c "Add :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING string $2" "$RP" >/dev/null; fi
  /bin/ln -s ../dotfiles/LaunchAgents/$LABEL.plist "$S/LaunchAgents/$LABEL.plist"
  /bin/cp -p "$P/config" "$S/config/better-ccflare.json"
  C=$S/ctl
  : >"$C/inject"; : >"$C/calls.log"
  echo session-affinity >"$C/env_lb"; echo "$2" >"$C/env_mscr"; echo 1000 >"$C/pid"
  echo "$RP" >"$C/path"; echo "$S/bin/better-ccflare" >"$C/program"
  [ "${3:-loaded}" = loaded ] && touch "$C/loaded"
  export EX_CTL=$C EX_PORT=18791
  export BCF_BIN=$S/bin/better-ccflare BCF_RELEASE_SHA=$RELEASE_SHA BCF_PLIST=$S/LaunchAgents/$LABEL.plist
  export BCF_CONFIG=$S/config/better-ccflare.json BCF_PORT=18791
  export BCF_LAUNCHCTL=$ST/launchctl BCF_CURL=$ST/curl BCF_LSOF=$ST/lsof BCF_NETSTAT=$ST/netstat BCF_CLAUDE=$ST/claude
  export TMPDIR=$S/tmp HOME=$S/home
  export BCF_POLL=0.05 BCF_LISTEN_TIMEOUT=2 BCF_CHECK_TRIES=3 BCF_CHECK_SLEEP=0.05 BCF_BOOTOUT_WAIT=2 BCF_BOOTSTRAP_TRIES=$TRIES
  KEEP=$BCF_BIN.v3.6.7-release PBAK=$BCF_PLIST.pre-session-pace CBAK=$BCF_CONFIG.pre-session-pace
  H_BIN=$(sha "$BCF_BIN"); H_PLIST=$(sha "$RP"); H_CFG=$(sha "$BCF_CONFIG")
  M_BIN=$(mtime "$BCF_BIN"); M_PLIST=$(mtime "$RP"); M_CFG=$(mtime "$BCF_CONFIG")
  WHY=""
  T0=$SECONDS
  echo "== s$N $1" >"$S/output.log"
}

inject() { echo "$1 $2" >>"$EX_CTL/inject"; }
run() { OUT=$("$@" 2>&1); RC=$?; printf '%s\n' "$OUT" >>"$S/output.log"; }
note() { WHY="${WHY:+$WHY; }$*"; }
expect_rc() { [ "$RC" = "$1" ] || note "exit $RC, expected $1"; }
expect_last() { printf '%s\n' "$OUT" | /usr/bin/tail -n 1 | /usr/bin/grep -q -- "$1" || note "last line lacks '$1'"; }
expect_out() { printf '%s\n' "$OUT" | /usr/bin/grep -q -- "$1" || note "output lacks '$1'"; }
calls() { /usr/bin/grep -c "^$1" "$EX_CTL/calls.log"; }
expect_pristine() {
  [ "$(sha "$BCF_BIN")" = "$H_BIN" ] || note "binary differs from original"
  [ "$(sha "$RP")" = "$H_PLIST" ] || note "plist differs from original"
  [ "$(sha "$BCF_CONFIG")" = "$H_CFG" ] || note "config differs from original"
  [ -L "$BCF_PLIST" ] || note "plist symlink replaced"
  [ "$(fmode "$BCF_CONFIG")" = "$(fmode "$P/config")" ] || note "config mode changed"
}
expect_untouched() {
  expect_pristine
  [ "$(mtime "$BCF_BIN")" = "$M_BIN" ] && [ "$(mtime "$RP")" = "$M_PLIST" ] && [ "$(mtime "$BCF_CONFIG")" = "$M_CFG" ] || note "a modification time changed"
  [ ! -e "$KEEP" ] && [ ! -e "$PBAK" ] && [ ! -e "$CBAK" ] || note "a backup was created"
  [ "$(/bin/ls -A "$S/LaunchAgents")" = "$LABEL.plist" ] || note "LaunchAgents holds more than the plist symlink"
  [ -z "$(/bin/ls -A "$S/tmp")" ] || note "temporary directory left behind"
}
expect_readonly_calls() {
  if /usr/bin/grep -v '^launchctl print ' "$EX_CTL/calls.log" | /usr/bin/grep -q .; then note "non-read-only stub calls: $(/usr/bin/grep -v '^launchctl print ' "$EX_CTL/calls.log" | /usr/bin/head -n 3 | /usr/bin/tr '\n' '|')"; fi
}
expect_backups() { # byte-identical to the originals, same mode, regular files
  [ "$(sha "$KEEP")" = "$H_BIN" ] || note "release keep file missing or not the original binary"
  [ -f "$PBAK" ] && [ ! -L "$PBAK" ] && [ "$(sha "$PBAK")" = "$H_PLIST" ] || note "plist backup missing or not the original plist"
  [ "$(sha "$CBAK")" = "$H_CFG" ] || note "config backup missing or not the original config"
  [ "$(fmode "$CBAK")" = "$(fmode "$P/config")" ] || note "config backup mode differs"
  [ "$(fmode "$PBAK")" = "$(fmode "$RP")" ] || note "plist backup mode differs"
}
expect_installed() { # [skip-bin]: new binary, edited plist and config, symlink intact
  if [ "${1:-}" != skip-bin ]; then [ "$(sha "$BCF_BIN")" = "$NEW_SHA" ] || note "binary is not the new one"; fi
  [ "$($PB -c 'Print :EnvironmentVariables:LB_STRATEGY' "$RP" 2>/dev/null)" = session-pace ] || note "plist LB_STRATEGY not session-pace"
  [ "$($PB -c 'Print :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING' "$RP" 2>/dev/null)" = exhausted ] || note "plist MSCR not exhausted"
  /usr/bin/jq -e '.lb_strategy == "session-pace"' "$BCF_CONFIG" >/dev/null 2>&1 || note "config lb_strategy not session-pace"
  [ "$(fmode "$BCF_BIN")" = "$(fmode "$P/bin")" ] || note "binary mode differs"
  [ "$(fmode "$BCF_CONFIG")" = "$(fmode "$P/config")" ] || note "config mode changed"
  [ -L "$BCF_PLIST" ] || note "plist symlink replaced"
}
expect_deployed_state() {
  expect_installed; expect_backups
  [ "$(/bin/cat "$EX_CTL/env_lb")" = session-pace ] || note "loaded job LB_STRATEGY not session-pace"
  [ "$(/bin/cat "$EX_CTL/env_mscr")" = exhausted ] || note "loaded job MSCR not exhausted"
  [ -z "$(/bin/ls -A "$S/tmp")" ] || note "temporary directory left behind"
}
finish() {
  if [ -z "$WHY" ]; then
    PASS=$((PASS + 1)); echo "PASS  s$N $1 ($((SECONDS - T0))s)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  s$N $1 ($((SECONDS - T0))s): $WHY"
    printf '%s\n' "$OUT" | /usr/bin/tail -n 12 | /usr/bin/sed 's/^/        | /'
  fi
  WHY=""
}

# ---- scenarios ----
setup dry-run __absent__
/bin/chmod 500 "$S/tmp"  # any mktemp attempt would fail the dry run
run "$DEPLOY" --dry-run "$P/new"
expect_rc 0; expect_last "DRY RUN: no changes made"; expect_out "would run: launchctl bootout"
expect_out "would run: launchctl bootstrap"; expect_out "would check launchd-env"; expect_out "would check claude"
expect_out "add MODEL_SCOPED_CAPACITY_ROUTING=exhausted"; expect_out "would back up config"
expect_untouched; expect_readonly_calls
finish "dry run (key absent): prints every step, changes nothing, only launchctl print"

setup dry-run-keyset off
/bin/chmod 500 "$S/tmp"
run "$DEPLOY" --dry-run "$P/new"
expect_rc 0; expect_last "DRY RUN: no changes made"; expect_out "set (now off) MODEL_SCOPED_CAPACITY_ROUTING=exhausted"
expect_untouched; expect_readonly_calls
finish "dry run (key present): changes nothing, only launchctl print"

setup bad-sha __absent__
run "$DEPLOY" --sha256 0000000000000000000000000000000000000000000000000000000000000000 "$P/new"
expect_rc 1; expect_last "NOT DEPLOYED (preflight: new binary sha256"
expect_untouched; expect_readonly_calls
finish "wrong --sha256: refused before any change"

setup config-group-readable __absent__
/bin/chmod 644 "$BCF_CONFIG"
run "$DEPLOY" "$P/new"
expect_rc 1; expect_last "NOT DEPLOYED (preflight: config"; expect_out "grants group or other access"
[ "$(sha "$BCF_BIN")" = "$H_BIN" ] && [ "$(sha "$RP")" = "$H_PLIST" ] && [ "$(sha "$BCF_CONFIG")" = "$H_CFG" ] || note "a file changed"
[ "$(mtime "$BCF_BIN")" = "$M_BIN" ] && [ "$(mtime "$RP")" = "$M_PLIST" ] && [ "$(mtime "$BCF_CONFIG")" = "$M_CFG" ] || note "a modification time changed"
[ ! -e "$KEEP" ] && [ ! -e "$PBAK" ] && [ ! -e "$CBAK" ] || note "a backup was created"
[ "$(fmode "$BCF_CONFIG")" = 644 ] || note "config mode changed"
expect_readonly_calls
finish "group-readable config: refused before any change"

setup deploy-key-absent __absent__
run "$DEPLOY" --sha256 "$NEW_SHA" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"; expect_deployed_state
expect_out "check claude: ok"; expect_out "check launchd-env: ok"; expect_out "check listener: ok"
expect_out "check accounts: ok"; expect_out "check strategy: ok"; expect_out "check binary: ok"
[ "$(calls 'claude')" = 1 ] || note "claude stub ran $(calls claude) times"
[ "$(calls 'launchctl bootout')" = 1 ] && [ "$(calls 'launchctl bootstrap')" = 1 ] || note "expected one bootout and one bootstrap"
finish "deploy succeeds (key absent -> added)"

setup deploy-key-present off
run "$DEPLOY" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"; expect_deployed_state; expect_out "(was session-affinity / off)"
finish "deploy succeeds (key present as off -> set to exhausted)"

setup second-deploy __absent__
run "$DEPLOY" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"
run "$DEPLOY" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"; expect_out "current state is an earlier deploy"
expect_out "backup binary: keeping existing"; expect_out "backup plist: keeping existing"; expect_out "backup config: keeping existing"
expect_deployed_state
finish "second deploy on top of the first: succeeds, original backups kept byte for byte"

setup not-loaded __absent__ unloaded
run "$DEPLOY" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"; expect_out "is not loaded"; expect_out "bootout exit 3"; expect_deployed_state
finish "job not loaded at start (bootout reports no such process)"

setup transient-bootstrap __absent__
echo 2 >"$EX_CTL/bootstrap_transient"
run "$DEPLOY" "$P/new"
expect_rc 0; expect_last "^DEPLOYED$"; expect_out "bootstrap exit 5, job not loaded"; expect_deployed_state
[ "$(calls 'launchctl bootstrap')" = 3 ] || note "expected 3 bootstrap tries, saw $(calls 'launchctl bootstrap')"
finish "bootstrap fails twice after bootout, retry succeeds"

for spec in launchd_env:launchd-env:__absent__ launchd_env:launchd-env:off listener_wide:listener:__absent__ \
  binary_corrupt:binary:__absent__ accounts_paused:accounts:__absent__ strategy_wrong:strategy:__absent__ \
  claude_fail:claude:__absent__ bootstrap_fail:reload:__absent__ bootstrap_fail:reload:off; do
  inj_name=${spec%%:*}; rest=${spec#*:}; check=${rest%%:*}; mscr=${rest#*:}
  setup "fail-$check" "$mscr"
  inject "$inj_name" pace
  run "$DEPLOY" "$P/new"
  expect_rc 2; expect_last "^NOT HEALTHY (failed check: $check)$"; expect_out "failed check: $check"
  expect_out "restore: /bin/cp -p '$KEEP' '$BCF_BIN.restore-tmp' && /bin/mv -f '$BCF_BIN.restore-tmp' '$BCF_BIN'"
  expect_out "restore: /bin/cp -p '$PBAK' '$RP'"; expect_out "restore: /bin/cp -p '$CBAK' '$BCF_CONFIG'"
  expect_out "restore: $ST/launchctl bootout gui/"; expect_out "restore: $ST/launchctl bootstrap gui/"
  if [ "$check" = binary ]; then expect_installed skip-bin; else expect_installed; fi
  expect_backups
  if [ "$check" = reload ]; then want_bs=$TRIES; else want_bs=1; fi
  [ "$(calls 'launchctl bootout')" = 1 ] || note "expected one bootout, saw $(calls 'launchctl bootout')"
  [ "$(calls 'launchctl bootstrap')" = "$want_bs" ] || note "expected $want_bs bootstrap calls, saw $(calls 'launchctl bootstrap')"
  if [ "$check" = claude ]; then want_cl=1; else want_cl=0; fi
  [ "$(calls 'claude')" = "$want_cl" ] || note "claude stub ran $(calls claude) times"
  finish "failing $check (key $mscr): exit 2, restore commands printed, nothing reverted, backups intact, no launchctl call after the failure"
  if [ "$check" = claude ]; then
    printf '%s\n' "$OUT" | /usr/bin/sed -n 's/^deploy: restore: //p' >"$S/restore.sh"
    [ "$(/usr/bin/wc -l <"$S/restore.sh" | /usr/bin/tr -d ' ')" = 5 ] || note "expected 5 restore commands"
    : >"$EX_CTL/calls.log"
    run /bin/bash "$S/restore.sh"
    expect_rc 0; expect_pristine
    [ ! -e "$BCF_BIN.restore-tmp" ] || note "restore left $BCF_BIN.restore-tmp"
    [ -f "$EX_CTL/loaded" ] || note "job not loaded after the restore commands"
    [ "$(/bin/cat "$EX_CTL/env_lb")" = session-affinity ] || note "restored job LB_STRATEGY not session-affinity"
    [ "$(/bin/cat "$EX_CTL/env_mscr")" = "$mscr" ] || note "restored job MSCR not $mscr"
    finish "the printed restore commands, run as printed, bring back binary, plist and config byte for byte and reload"
  fi
done

setup hung-lsof __absent__
printf '#!/bin/bash\nexec /bin/sleep 60\n' >"$S/hang" && /bin/chmod 755 "$S/hang"
T_HANG=$SECONDS
BCF_LSOF=$S/hang BCF_CMD_TIMEOUT=1 run "$DEPLOY" "$P/new"
expect_rc 2; expect_last "NOT HEALTHY (failed check: listener)"; expect_out "restore: "
[ $((SECONDS - T_HANG)) -lt 30 ] || note "deploy took $((SECONDS - T_HANG))s with a hung lsof"
finish "a hung lsof is cut off by the per-command timeout: listener check fails in bounded time"

# ---- upgrade scenarios: each sandbox starts as a finished first deploy of $P/new ----
/bin/cp "$P/new" "$P/new2" && printf 'upgrade-stand-in' >>"$P/new2" && /bin/chmod 755 "$P/new2" || die "copy upgrade binary"
NEW2_SHA=$(sha "$P/new2")
FROM_SHA=$NEW_SHA
PREV_NAME=better-ccflare.pre-upgrade-$(printf '%s' "$FROM_SHA" | /usr/bin/cut -c1-12)

set_config_lb() { # FILE VALUE: rewrites lb_strategy through a same-mode temp file; prints nothing
  (umask 077; /usr/bin/jq --arg v "$2" '.lb_strategy = $v' "$1" >"$1.tmp" 2>/dev/null) &&
    /bin/chmod "$(fmode "$1")" "$1.tmp" && /bin/mv -f "$1.tmp" "$1"
}
snapshot() {
  H_BIN=$(sha "$BCF_BIN"); H_PLIST=$(sha "$RP"); H_CFG=$(sha "$BCF_CONFIG")
  M_BIN=$(mtime "$BCF_BIN"); M_PLIST=$(mtime "$RP"); M_CFG=$(mtime "$BCF_CONFIG")
  I_BIN=$(inode "$BCF_BIN"); I_PLIST=$(inode "$RP"); I_CFG=$(inode "$BCF_CONFIG")
  H_KEEP=$(sha "$KEEP"); H_PBAK=$(sha "$PBAK"); H_CBAK=$(sha "$CBAK")
  M_BAKS="$(mtime "$KEEP") $(mtime "$PBAK") $(mtime "$CBAK")"; I_BAKS="$(inode "$KEEP") $(inode "$PBAK") $(inode "$CBAK")"
}
setup_upgrade() { # NAME
  setup "$1" __absent__
  /bin/cp -p "$BCF_BIN" "$KEEP" && /bin/cp -p "$RP" "$PBAK" && /bin/cp -p "$BCF_CONFIG" "$CBAK" || die "first-deploy backups"
  /bin/cp "$P/new" "$BCF_BIN.n" && /bin/chmod "$(fmode "$P/bin")" "$BCF_BIN.n" && /bin/mv -f "$BCF_BIN.n" "$BCF_BIN" || die "install first build"
  $PB -c "Set :EnvironmentVariables:LB_STRATEGY session-pace" "$RP" >/dev/null 2>&1 || die "plist LB_STRATEGY"
  $PB -c "Add :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING string exhausted" "$RP" >/dev/null 2>&1 || die "plist MSCR"
  set_config_lb "$BCF_CONFIG" session-pace || die "config lb_strategy"
  echo session-pace >"$C/env_lb"; echo exhausted >"$C/env_mscr"
  PREV=$S/bin/$PREV_NAME
  snapshot
}
expect_aux_untouched() { # first-deploy backups, plist and config: same bytes, same file, same mtime
  [ "$(sha "$KEEP")" = "$H_KEEP" ] && [ "$(sha "$PBAK")" = "$H_PBAK" ] && [ "$(sha "$CBAK")" = "$H_CBAK" ] || note "a first-deploy backup changed"
  [ "$(mtime "$KEEP") $(mtime "$PBAK") $(mtime "$CBAK")" = "$M_BAKS" ] && [ "$(inode "$KEEP") $(inode "$PBAK") $(inode "$CBAK")" = "$I_BAKS" ] || note "a first-deploy backup was rewritten"
  [ "$(sha "$RP")" = "$H_PLIST" ] || note "plist bytes changed"
  [ "$(sha "$BCF_CONFIG")" = "$H_CFG" ] || note "config bytes changed"
  [ "$(mtime "$RP")" = "$M_PLIST" ] && [ "$(inode "$RP")" = "$I_PLIST" ] || note "plist was rewritten"
  [ "$(mtime "$BCF_CONFIG")" = "$M_CFG" ] && [ "$(inode "$BCF_CONFIG")" = "$I_CFG" ] || note "config was rewritten"
  [ -L "$BCF_PLIST" ] || note "plist symlink replaced"
  [ "$(fmode "$BCF_CONFIG")" = "$(fmode "$P/config")" ] || note "config mode changed"
  [ -z "$(/bin/ls -A "$S/tmp")" ] || note "temporary directory left behind"
  if for d in "$S/bin" "$S/dotfiles/LaunchAgents" "$S/LaunchAgents" "$S/config"; do /bin/ls -A "$d"; done | /usr/bin/grep -q 'tmp'; then note "a temporary file was left beside the installed files"; fi
}
expect_upgrade_refused() { # WHY_TEXT
  expect_rc 1; expect_last "NOT DEPLOYED (preflight: "; expect_out "$1"
  [ "$(sha "$BCF_BIN")" = "$H_BIN" ] && [ "$(inode "$BCF_BIN")" = "$I_BIN" ] && [ "$(mtime "$BCF_BIN")" = "$M_BIN" ] || note "installed binary changed"
  expect_aux_untouched; expect_readonly_calls
}
expect_upgraded_files() { # new binary installed, previous build kept, nothing else touched
  [ "$(sha "$BCF_BIN")" = "$NEW2_SHA" ] || note "binary is not the upgrade binary"
  [ "$(fmode "$BCF_BIN")" = "$(fmode "$P/bin")" ] || note "binary mode differs"
  [ -f "$PREV" ] && [ ! -L "$PREV" ] && [ "$(sha "$PREV")" = "$FROM_SHA" ] || note "previous build $PREV_NAME missing or not the previous binary"
  expect_aux_untouched
}

setup_upgrade upgrade
run "$DEPLOY" --sha256 "$NEW2_SHA" --upgrade-from "$FROM_SHA" "$P/new2"
expect_rc 0; expect_last "^DEPLOYED$"; expect_upgraded_files
expect_out "current state is a session-pace deploy to upgrade"; expect_out "first-deploy backup left untouched: $KEEP"
expect_out "first-deploy backups are the release; a failed check will also print"
expect_out "plist: already LB_STRATEGY=session-pace"; expect_out "config: lb_strategy already session-pace"
for c in launchd-env listener binary accounts strategy claude; do expect_out "check $c: ok"; done
[ "$(/bin/cat "$EX_CTL/env_lb")" = session-pace ] && [ "$(/bin/cat "$EX_CTL/env_mscr")" = exhausted ] || note "loaded job not session-pace / exhausted"
[ "$(calls 'launchctl bootout')" = 1 ] && [ "$(calls 'launchctl bootstrap')" = 1 ] || note "expected one bootout and one bootstrap"
[ "$(calls 'claude')" = 1 ] || note "claude stub ran $(calls claude) times"
finish "upgrade succeeds: new binary installed, previous build kept, first-deploy backups, plist and config untouched"

setup_upgrade upgrade-dry-run
/bin/chmod 500 "$S/tmp"
run "$DEPLOY" --dry-run --upgrade-from "$FROM_SHA" "$P/new2"
expect_rc 0; expect_last "DRY RUN: no changes made"; expect_out "would keep the previous build: copy $BCF_BIN to $PREV"
expect_out "would leave $RP alone"; expect_out "would leave $BCF_CONFIG alone"; expect_out "would run: launchctl bootstrap"
/bin/chmod 700 "$S/tmp"
[ "$(sha "$BCF_BIN")" = "$H_BIN" ] && [ "$(inode "$BCF_BIN")" = "$I_BIN" ] || note "installed binary changed"
[ ! -e "$PREV" ] || note "dry run created $PREV_NAME"
expect_aux_untouched; expect_readonly_calls
finish "upgrade dry run: prints the plan, changes nothing, only launchctl print"

setup_upgrade upgrade-wrong-hash
run "$DEPLOY" --upgrade-from 0000000000000000000000000000000000000000000000000000000000000000 "$P/new2"
expect_upgrade_refused "is not the --upgrade-from"; [ ! -e "$PREV" ] || note "refused run created $PREV_NAME"
finish "upgrade refused: installed binary is not the one --upgrade-from names"

setup_upgrade upgrade-plist-lb
$PB -c "Set :EnvironmentVariables:LB_STRATEGY session-affinity" "$RP" >/dev/null 2>&1; snapshot
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_upgrade_refused "plist has LB_STRATEGY=session-affinity"; [ ! -e "$PREV" ] || note "refused run created $PREV_NAME"
finish "upgrade refused: plist LB_STRATEGY is not session-pace"

setup_upgrade upgrade-plist-mscr
$PB -c "Delete :EnvironmentVariables:MODEL_SCOPED_CAPACITY_ROUTING" "$RP" >/dev/null 2>&1; snapshot
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_upgrade_refused "MODEL_SCOPED_CAPACITY_ROUTING=__absent__"; [ ! -e "$PREV" ] || note "refused run created $PREV_NAME"
finish "upgrade refused: plist lacks MODEL_SCOPED_CAPACITY_ROUTING"

setup_upgrade upgrade-config
set_config_lb "$BCF_CONFIG" session-affinity || die "config lb_strategy"; snapshot
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_upgrade_refused "config lb_strategy is session-affinity"; [ ! -e "$PREV" ] || note "refused run created $PREV_NAME"
finish "upgrade refused: config lb_strategy is not session-pace"

setup_upgrade upgrade-without-option
run "$DEPLOY" "$P/new2"
expect_upgrade_refused "is neither the release nor the new binary"; [ ! -e "$PREV" ] || note "refused run created $PREV_NAME"
finish "without --upgrade-from the session-pace state is refused as before"

setup_upgrade upgrade-same-binary
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new"
expect_upgrade_refused "nothing to upgrade"
finish "upgrade refused: the new binary is the installed one"

setup_upgrade upgrade-from-release
run "$DEPLOY" --upgrade-from "$RELEASE_SHA" "$P/new2"
expect_upgrade_refused "names the release binary"
finish "upgrade refused: --upgrade-from names the release binary"

setup_upgrade upgrade-bad-option
run "$DEPLOY" --upgrade-from 1234 "$P/new2"
expect_rc 64; expect_out "usage: deploy.sh"
[ ! -s "$EX_CTL/calls.log" ] || note "stub calls on a usage error"
expect_aux_untouched
finish "malformed --upgrade-from: usage error, nothing run"

setup_upgrade upgrade-prev-differs
printf 'not the previous build' >"$PREV"; H_PREV=$(sha "$PREV")
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_upgrade_refused "exists but is not an executable copy of the installed binary"
[ "$(sha "$PREV")" = "$H_PREV" ] || note "existing $PREV_NAME was overwritten"
finish "upgrade refused: an existing $PREV_NAME with other content is left as it is"

setup_upgrade upgrade-prev-same
/bin/cp -p "$BCF_BIN" "$PREV"; I_PREV=$(inode "$PREV")
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_rc 0; expect_last "^DEPLOYED$"; expect_out "previous build: keeping existing $PREV"; expect_upgraded_files
[ "$(inode "$PREV")" = "$I_PREV" ] || note "existing $PREV_NAME was replaced"
finish "upgrade with an existing identical $PREV_NAME: kept, upgrade succeeds"

setup_upgrade upgrade-prev-not-executable
/bin/cp -p "$BCF_BIN" "$PREV" && /bin/chmod 600 "$PREV"; H_PREV=$(sha "$PREV")
run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
expect_upgrade_refused "exists but is not an executable copy of the installed binary"
[ "$(sha "$PREV")" = "$H_PREV" ] && [ "$(fmode "$PREV")" = 600 ] || note "existing $PREV_NAME was changed"
finish "upgrade refused: an existing $PREV_NAME with the right bytes but not executable is left as it is"

for name in keep-absent plist-backup-not-release; do
  setup_upgrade "upgrade-fail-$name"
  case $name in
    keep-absent) /bin/rm -f "$KEEP" ;;
    *) $PB -c "Set :EnvironmentVariables:LB_STRATEGY session-pace" "$PBAK" >/dev/null 2>&1 ;;
  esac
  snapshot
  inject claude_fail pace
  run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
  expect_rc 2; expect_last "^NOT HEALTHY (failed check: claude)$"
  expect_out "backups are missing or not the release; a failed check will print only"; expect_out "no release restore commands"
  expect_out "restore: /bin/cp -p '$PREV' '$BCF_BIN.restore-tmp'"
  if printf '%s\n' "$OUT" | /usr/bin/grep -q '^deploy: release-restore: '; then note "release restore commands printed"; fi
  [ "$(sha "$BCF_BIN")" = "$NEW2_SHA" ] && [ "$(sha "$PREV")" = "$FROM_SHA" ] || note "binary or previous build wrong"
  expect_aux_untouched
  if [ "$name" = keep-absent ] && [ -e "$KEEP" ]; then note "absent release keep file was created"; fi
  finish "failing claude on an upgrade with first-deploy backups $name: only the previous-build restore commands are printed, backups left as they were"
done

for spec in claude_fail:claude bootstrap_fail:reload; do
  inj_name=${spec%%:*}; check=${spec#*:}
  setup_upgrade "upgrade-fail-$check"
  inject "$inj_name" pace
  run "$DEPLOY" --upgrade-from "$FROM_SHA" "$P/new2"
  expect_rc 2; expect_last "^NOT HEALTHY (failed check: $check)$"; expect_upgraded_files
  expect_out "restore: /bin/cp -p '$PREV' '$BCF_BIN.restore-tmp' && /bin/mv -f '$BCF_BIN.restore-tmp' '$BCF_BIN'"
  expect_out "release-restore: /bin/cp -p '$KEEP' '$BCF_BIN.restore-tmp' && /bin/mv -f '$BCF_BIN.restore-tmp' '$BCF_BIN'"
  expect_out "release-restore: /bin/cp -p '$PBAK' '$RP'"; expect_out "release-restore: /bin/cp -p '$CBAK' '$BCF_CONFIG'"
  printf '%s\n' "$OUT" | /usr/bin/sed -n 's/^deploy: restore: //p' >"$S/restore.sh"
  printf '%s\n' "$OUT" | /usr/bin/sed -n 's/^deploy: release-restore: //p' >"$S/release-restore.sh"
  [ "$(/usr/bin/wc -l <"$S/restore.sh" | /usr/bin/tr -d ' ')" = 3 ] || note "expected 3 previous-build restore commands"
  [ "$(/usr/bin/wc -l <"$S/release-restore.sh" | /usr/bin/tr -d ' ')" = 5 ] || note "expected 5 release restore commands"
  if [ "$check" = reload ]; then want_bs=$TRIES; else want_bs=1; fi
  [ "$(calls 'launchctl bootout')" = 1 ] && [ "$(calls 'launchctl bootstrap')" = "$want_bs" ] || note "unexpected launchctl calls after the failure"
  finish "failing $check on an upgrade: exit 2, previous-build and release restore commands printed, nothing reverted"
  if [ "$check" = claude ]; then
    : >"$EX_CTL/inject"; : >"$EX_CTL/calls.log"
    run /bin/bash "$S/restore.sh"
    expect_rc 0
    [ "$(sha "$BCF_BIN")" = "$FROM_SHA" ] || note "binary is not the previous build after the restore commands"
    [ "$(fmode "$BCF_BIN")" = "$(fmode "$P/bin")" ] || note "binary mode differs"
    [ ! -e "$BCF_BIN.restore-tmp" ] || note "restore left $BCF_BIN.restore-tmp"
    [ -f "$EX_CTL/loaded" ] && [ "$(/bin/cat "$EX_CTL/env_lb")" = session-pace ] || note "job not reloaded as session-pace"
    expect_aux_untouched
    finish "the printed previous-build restore commands, run as printed, bring back the previous binary and reload"
    run /bin/bash "$S/release-restore.sh"
    expect_rc 0
    [ "$(sha "$BCF_BIN")" = "$H_KEEP" ] || note "binary is not the release after the release restore commands"
    [ "$(sha "$RP")" = "$H_PBAK" ] || note "plist is not the first-deploy backup"
    [ "$(sha "$BCF_CONFIG")" = "$H_CBAK" ] || note "config is not the first-deploy backup"
    [ "$(fmode "$BCF_CONFIG")" = "$(fmode "$P/config")" ] || note "config mode changed"
    [ -L "$BCF_PLIST" ] || note "plist symlink replaced"
    [ "$(/bin/cat "$EX_CTL/env_lb")" = session-affinity ] || note "job not reloaded as session-affinity"
    [ "$(sha "$KEEP")" = "$H_KEEP" ] && [ "$(sha "$PBAK")" = "$H_PBAK" ] && [ "$(sha "$CBAK")" = "$H_CBAK" ] || note "a first-deploy backup changed"
    finish "the printed release restore commands, run as printed after an upgrade, bring back the release byte for byte"
  fi
done

# Secret leak check: no line of the config copy longer than 12 characters may appear in any
# script output. grep -q prints nothing either way.
/usr/bin/awk 'length($0) > 12' "$P/config" >"$SBX/config-lines"; rc_lines=$?
/bin/cat "$SBX"/s*/output.log >"$SBX/all-output" 2>/dev/null; rc_cat=$?
/usr/bin/grep -qF -f "$SBX/config-lines" "$SBX/all-output" 2>/dev/null; rc_grep=$?
if [ "$rc_lines" != 0 ] || [ "$rc_cat" != 0 ] || [ ! -s "$SBX/config-lines" ] || [ ! -s "$SBX/all-output" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL  config leak check could not collect its patterns or the script output"
elif [ "$rc_grep" = 1 ]; then
  PASS=$((PASS + 1)); echo "PASS  no line of the config JSON appears in any script output"
elif [ "$rc_grep" = 0 ]; then
  FAIL=$((FAIL + 1)); echo "FAIL  a line of the config JSON appears in script output"
else
  FAIL=$((FAIL + 1)); echo "FAIL  config leak scan failed (grep exit $rc_grep)"
fi
# Sentinel check: the planted value may live only in config files and their backups. grep -l
# prints file names only.
/usr/bin/grep -rlF "exercise-sentinel-$SENTINEL" "$SBX" --exclude=config --exclude=config-lines \
  --exclude=better-ccflare.json --exclude=better-ccflare.json.pre-session-pace >"$SBX/sentinel-hits" 2>/dev/null
rc_sent=$?
if [ "$rc_sent" -gt 1 ]; then
  FAIL=$((FAIL + 1)); echo "FAIL  sentinel scan failed (grep exit $rc_sent)"
elif [ -s "$SBX/sentinel-hits" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL  the planted secret appears outside config files: $(/usr/bin/sed "s|^$SBX/||" "$SBX/sentinel-hits" | /usr/bin/tr '\n' ' ')"
else
  PASS=$((PASS + 1)); echo "PASS  the planted secret appears in no output, log, stub call log or other sandbox file"
fi

if [ -n "${EX_LOG_DIR:-}" ] && /bin/mkdir -p "$EX_LOG_DIR" && /bin/chmod 700 "$EX_LOG_DIR"; then
  /bin/cp "$SBX/all-output" "$EX_LOG_DIR/script-output.log" && echo "exercise: script output kept in $EX_LOG_DIR/script-output.log"
fi
echo "exercise: $PASS passed, $FAIL failed (new binary sha256 $NEW_SHA)"
[ "$FAIL" -eq 0 ]
