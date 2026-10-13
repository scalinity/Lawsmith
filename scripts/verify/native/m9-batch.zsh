# M9's reproducible benchmark path: one owner-approved completion batch of native scenarios, run in order
# under one shared GUI lock, each with a finite watchdog, stopped at the first failure. It wraps scenarios
# that keep every guard of their own (hit tests, frontmost keys, the outside-input abort, their own cleanup);
# it adds no workflow of its own.
#
#   QA_APPROVAL='<what the owner approved, and when>' QA_APPROVED_SCENARIOS='m9-smoke;m9-resources;m9-perf P1 P2 P3 P0' \
#   QA_STATE=<private dir> QA_OUT=<private dir> zsh scripts/verify/native/m9-batch.zsh m9-smoke m9-resources 'm9-perf P1 P2 P3 P0'
#
# - Approval: QA_APPROVAL must be set, and QA_APPROVED_SCENARIOS must name exactly the scenarios given, in
#   order, separated by ';'. Anything else stops before the lock is taken (exit 2).
# - The lock: the driver holds the shared GUI lock on a descriptor for the whole batch and lends it to each
#   scenario as QA_LOCK_FD; lib.zsh adopts it and never releases it. The driver releases it last, after its
#   own checks and restoration.
# - Watchdogs: each scenario runs under /usr/bin/timeout with its own cap and QA_DEADLINE (a finite safety
#   deadline inside the batch, never a renewal point): TERM first, KILL 20 s later.
# - Stops: any nonzero exit ends the batch. Exit 4 means a person used the Mac: the batch yields and never
#   resumes by itself. Unrun scenarios are listed as unrun.
# - Ownership: a scenario's shell by PID and start time; each app it logged as launched by that PID, its
#   executable path and a start after the scenario began; anything else only by the batch's own unique
#   temporary paths. Nothing is stopped by name or broad pattern.
# - Restoration is checked, not assumed: after every scenario and at the end, the display mode and the
#   Lawsmith preferences are compared with the driver's own snapshot and restored if they differ, so a
#   killed scenario that could not clean up is still restored. A lock holder's exit proves neither.
# Receipts: QA_OUT/batch.json and QA_OUT/cleanup.jsonl.
zmodload zsh/datetime zsh/system
: ${QA_STATE:?set QA_STATE to a private disposable directory} ${QA_OUT:?set QA_OUT to a private output directory}
if (( $# == 0 )) || [[ -z $QA_APPROVAL || ${QA_APPROVED_SCENARIOS-} != ${(j:;:)@} ]]; then
  print -u2 "m9-batch: refusing to start: QA_APPROVAL must be set and QA_APPROVED_SCENARIOS must be exactly '${(j:;:)@}'"
  exit 2
fi
# The batch's last synthetic event or quiet acquisition, inherited by each scenario's lib.zsh, so outside input
# between scenarios is seen by the next one instead of being waited out.
export QA_INPUT_STAMP=$QA_STATE/last-input
rm -f $QA_INPUT_STAMP
source ${0:A:h}/lib.zsh
BATCH_STATE=$QA_STATE
BATCH_OUT=$QA_OUT
SCENARIOS=$NATIVE
STUBBED=false
# Caps in seconds: each scenario's planned reserve plus margin (docs/evidence/M9.md, native batch).
typeset -A CAPS
CAPS=(m9-smoke 300 m9-resources 900 m9-perf 1500 m9-limits 360)
LFD=
DRIVER_LOCKED=
RESULTS=()
UNRUN=("$@")
CURRENT=
CURRENT_PID=
CURRENT_START=
DISPLAY_SNAPSHOT=
BATCH_EXIT=0

json() { python3 -I -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1" }
start_of() {
  local s=${(j: :)${=$(LC_ALL=C ps -o lstart= -p $1 2>/dev/null)}}
  [[ -n $s ]] && LC_ALL=C date -j -f '%a %b %d %T %Y' "$s" +%s 2>/dev/null
}
# alive PID START: the process is still the one recorded (the same PID and start second).
alive() { [[ -n $1 && -n $2 && $(start_of $1) == $2 ]] }
display_apply() { osascript -l JavaScript $NATIVE/display.js set ${${1%@*}%x*} ${${1%@*}#*x} ${1#*@} 2>&1 }

# lock_probe: an independent open of the lock file, so the answer never depends on the driver's descriptor.
lock_probe() { python3 -I -c 'import fcntl,sys
f=open(sys.argv[1],"a+")
try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); print("free")
except BlockingIOError: print("held")' $GUI_LOCK }
take_lock() {
  : >> $GUI_LOCK
  exec {LFD}>>$GUI_LOCK
  python3 -I -c '
import fcntl, json, os, sys, time
fd, deadline = int(sys.argv[1]), float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.time() > deadline:
            sys.exit(5)
        time.sleep(0.25)
os.ftruncate(fd, 0)
os.write(fd, json.dumps({"pid": int(sys.argv[3]), "label": "lawsmith-m9-batch", "sinceMs": int(time.time() * 1000)}).encode())
' $LFD $(( EPOCHSECONDS + ${M9_LOCK_WAIT:-900} )) $sysparams[pid] || fail "the shared GUI lock did not become free" 5
  DRIVER_LOCKED=1
  # lib.zsh's lock-requiring guards (display, preferences) see the driver's lock; gui_unlock leaves it alone.
  LOCK_HOLDER=inherited:$LFD
  [[ $(lock_probe) == held ]] || fail "the lock is not held after taking it" 3
}
# lock_still_ours: an independent open must be refused (someone holds it), and the driver's own descriptor
# must still hold it (re-locking it succeeds only for the holder). An adopter that released it fails this.
lock_still_ours() {
  [[ $(lock_probe) == held ]] || return 1
  python3 -I -c 'import fcntl,sys
try: fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(1)' $LFD
}
release_lock() {
  [[ -n $DRIVER_LOCKED ]] || return 0
  exec {LFD}>&-
  DRIVER_LOCKED=
  LOCK_HOLDER=
}

# Preferences, against the driver's snapshot from lib.zsh's snapshot_preferences.
prefs_match() {
  prefs_state
  if [[ $PREFS_ORIGINAL == absent ]]; then [[ $PREFS_STATE == absent ]]; return; fi
  [[ $PREFS_STATE == present ]] || return 1
  local now=$BATCH_STATE/preferences-now.plist
  rm -f $now
  defaults export $PREFS_DOMAIN $now >/dev/null 2>&1 && cmp -s <(plutil -convert xml1 -o - $PREFS_SNAPSHOT) <(plutil -convert xml1 -o - $now)
}
prefs_put_back() {
  defaults delete $PREFS_DOMAIN >/dev/null 2>&1
  [[ $PREFS_ORIGINAL == absent ]] || defaults import $PREFS_DOMAIN $PREFS_SNAPSHOT >/dev/null 2>&1
  prefs_match
}

# app_owned PID DIR: whether a Lawsmith instance is proven to be this run's, never inferred from its name or
# start time. lib.zsh's launch passes `lawsmith-qa-owner=<recovery dir>` in the app's argv (open --args), and
# the recovery directory lies inside the scenario's unique DIR; the process must be this APP's executable
# with that token. Another instance of the same executable, from any other session, carries no such token.
# (The environment cannot be relied on: `ps -E` shows none for these processes here.)
app_owned() {
  local cmd=$(ps -o command= -p $1 2>/dev/null)
  [[ $cmd == "$APP/Contents/MacOS/lawsmith "* && $cmd == *" lawsmith-qa-owner=$2/"* ]]
}
# stop_app PID DIR: TERM, then KILL only if the same process (PID and start) is still there and still owned.
stop_app() {
  local pid=$1 start i
  start=$(start_of $pid)
  [[ -n $start ]] || return 1
  kill $pid 2>/dev/null
  for i in {1..50}; do alive $pid $start || return 0; command sleep 0.1; done
  alive $pid $start && app_owned $pid $2 && kill -KILL $pid 2>/dev/null
  return 0
}

# stop_owned DIR SINCE: this run's apps, receipted or not yet (found by their owner token inside DIR), then
# processes naming DIR, the scenario's own unique directory. Prints what it stopped.
stop_owned() {
  local dir=$1 pid stopped=()
  for pid in $(pgrep -f -- "lawsmith-qa-owner=$dir/"); do
    app_owned $pid $dir || continue
    stop_app $pid $dir && stopped+=("app:$pid")
  done
  for pid in $(pgrep -f -- "$dir/"); do
    [[ $pid == $sysparams[pid] ]] && continue
    kill $pid 2>/dev/null && stopped+=("path:$pid")
  done
  print -r -- ${(j:,:)stopped}
}

# check_restored LABEL: the display and preferences against the driver's snapshot, restored if they differ.
check_restored() {
  local display=same prefs=same
  if [[ $(display_get) != $DISPLAY_SNAPSHOT ]]; then
    display_apply $DISPLAY_SNAPSHOT >/dev/null
    command sleep 2
    [[ $(display_get) == $DISPLAY_SNAPSHOT ]] && display=restored-by-driver || display=FAILED
  fi
  if [[ -n $PREFS_SNAPSHOT ]] && ! prefs_match; then
    prefs_put_back && prefs=restored-by-driver || prefs=FAILED
  fi
  receipt "{\"batch\":$(json $1),\"display\":\"$display\",\"preferences\":\"$prefs\"}"
  print -r -- "display:$display preferences:$prefs"
}

run_scenario() {
  local spec=$1 name=${1%% *} args=() cap dir code verdict leftovers restored since
  [[ $spec == *' '* ]] && args=(${=${spec#* }})
  cap=${CAPS[$name]}
  [[ $STUBBED == true && -n $M9_CAP ]] && cap=$M9_CAP
  dir=$BATCH_STATE/run-$name
  rm -rf $dir
  mkdir -p $dir/state $dir/out
  CURRENT=$name
  since=$EPOCHSECONDS
  say "batch: $spec (cap $cap s)"
  QA_LOCK_FD=$LFD QA_STATE=$dir/state QA_OUT=$dir/out QA_DEADLINE=$(( EPOCHSECONDS + cap )) GUI_LOCK=$GUI_LOCK APP=$APP \
    /usr/bin/timeout -s TERM -k $KILL_AFTER $(( cap + GRACE )) zsh -c 'print -r -- $$ > "$1"; shift; exec zsh "$@"' _ $dir/shell.pid $SCENARIOS/$name.zsh $args &
  CURRENT_PID=$!
  CURRENT_START=$(start_of $CURRENT_PID)
  wait $CURRENT_PID
  code=$?
  CURRENT_PID=
  if ! lock_still_ours; then
    RESULTS+=("{\"scenario\":$(json $spec),\"exit\":$code,\"verdict\":\"the lent lock was lost during it\"}")
    BATCH_EXIT=3
    stop_owned $dir $since >/dev/null
    return 3
  fi
  case $code in
    0) verdict=completed ;;
    4) verdict='yielded to outside input; not resumed' ;;
    5) verdict='stopped at its deadline' ;;
    124|137) verdict='watchdog expired' ;;
    *) verdict=failed ;;
  esac
  leftovers=$(stop_owned $dir $since)
  restored=$(check_restored $name)
  RESULTS+=("{\"scenario\":$(json $spec),\"capSeconds\":$cap,\"start\":$since,\"end\":$EPOCHSECONDS,\"exit\":$code,\"verdict\":$(json $verdict),\"stoppedAfter\":$(json "$leftovers"),\"restoration\":$(json "$restored")}")
  CURRENT=
  if [[ $restored == *FAILED* ]]; then BATCH_EXIT=6; return 6; fi
  return $code
}

batch_cleanup() {
  local exit_status=$? code shell pid i leftovers=() restored lock results
  code=$(( BATCH_EXIT ? BATCH_EXIT : exit_status ))
  # A scenario still running because the driver itself was stopped: its watchdog and shell, by identity.
  if [[ -n $CURRENT_PID ]] && alive $CURRENT_PID $CURRENT_START; then
    shell=$(<$BATCH_STATE/run-$CURRENT/shell.pid) 2>/dev/null
    kill -TERM $CURRENT_PID 2>/dev/null
    for i in {1..50}; do alive $CURRENT_PID $CURRENT_START || break; command sleep 0.1; done
    alive $CURRENT_PID $CURRENT_START && kill -KILL $CURRENT_PID 2>/dev/null
    [[ -n $shell && $(ps -o command= -p $shell 2>/dev/null) == *"$SCENARIOS/$CURRENT.zsh"* ]] && kill -KILL $shell 2>/dev/null
    wait $CURRENT_PID 2>/dev/null
    leftovers+=(${(s:,:)$(stop_owned $BATCH_STATE/run-$CURRENT 0)})
    RESULTS+=("{\"scenario\":$(json $CURRENT),\"exit\":null,\"verdict\":\"interrupted with the batch\"}")
  fi
  # Any app carrying this batch's owner token, from any scenario, before the restoration check.
  for pid in $(pgrep -f -- "lawsmith-qa-owner=$BATCH_STATE/"); do
    app_owned $pid $BATCH_STATE && stop_app $pid $BATCH_STATE && leftovers+=("app:$pid")
  done
  if [[ -n $DISPLAY_SNAPSHOT ]]; then restored=$(check_restored final); else restored=not-snapshotted; fi
  release_lock
  lock=$(lock_probe)
  for pid in $(pgrep -f -- "$BATCH_STATE/"); do kill $pid 2>/dev/null && leftovers+=("path:$pid"); done
  results=$(python3 -I -c 'import json,sys; print(json.dumps([json.loads(r) for r in sys.argv[1:]]))' "${RESULTS[@]}")
  python3 -I -c '
import json, sys
approval, approved, stubbed, results, final = sys.argv[1:6]
print(json.dumps({"approval": approval, "approvedScenarios": approved.split(";"), "stubbed": stubbed == "true",
                  "scenarios": json.loads(results), "final": json.loads(final)}, indent=1))' \
    "$QA_APPROVAL" "$QA_APPROVED_SCENARIOS" $STUBBED "$results" \
    "{\"exit\":$code,\"restoration\":$(json "$restored"),\"lockAfterRelease\":$(json $lock),\"stoppedAtEnd\":$(json "${(j:,:)leftovers}"),\"unrun\":$(json "${(j:;:)UNRUN}")}" \
    > $BATCH_OUT/batch.json
  say "batch ended (exit $code): $restored; lock $lock after release; stopped at end [${(j:,:)leftovers}]; unrun [${(j:; :)UNRUN}]"
  [[ $restored == *FAILED* ]] && (( code == 0 )) && code=6
  exit $code
}

# Test-only: a stub may replace the display, preference, quiet-wait and scenario-directory hooks above. A
# stubbed batch says so in batch.json and is never evidence; M9_CAP is honoured only with a stub.
# The watchdog runs a scenario for its cap plus GRACE seconds, then sends TERM, and KILL after KILL_AFTER more.
GRACE=30
KILL_AFTER=20
if [[ -n $M9_BATCH_STUB ]]; then
  source $M9_BATCH_STUB
  STUBBED=true
  [[ -n $M9_GRACE ]] && GRACE=$M9_GRACE
  [[ -n $M9_KILL_AFTER ]] && KILL_AFTER=$M9_KILL_AFTER
elif [[ -n $M9_CAP$M9_GRACE$M9_KILL_AFTER ]]; then
  print -u2 "m9-batch: M9_CAP, M9_GRACE and M9_KILL_AFTER are for stubbed tests only"; exit 2
fi
for spec in "$@"; do
  [[ -n ${CAPS[${spec%% *}]} && -f $SCENARIOS/${spec%% *}.zsh ]] || { print -u2 "m9-batch: unknown scenario ${spec%% *}"; exit 2 }
done

trap batch_cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
take_lock
wait_quiet
DISPLAY_SNAPSHOT=$(display_get)
[[ $DISPLAY_SNAPSHOT == <->x<->@<-> ]] || { DISPLAY_SNAPSHOT=; fail "the display mode reads unexpectedly; nothing was run" 3 }
receipt "{\"batch\":\"start\",\"display\":\"$DISPLAY_SNAPSHOT\",\"stubbed\":$STUBBED}"
snapshot_preferences
say "batch: native input starts now: ${(j:; :)@}"
for spec in "$@"; do
  shift UNRUN
  run_scenario "$spec" || { BATCH_EXIT=$?; say "batch stopped at: $spec"; exit $BATCH_EXIT }
done
say "batch: native input is over"
exit 0
