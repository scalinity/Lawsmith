#!/bin/zsh
# Non-native checks of m9-batch.zsh: approval refusal, the lent lock (adopted by real lib.zsh runners and
# still the driver's afterwards, by an independent open), a stop at the first failure, outside input
# yielding with no resume, the watchdog's TERM and KILL, the driver itself terminated, and an adopter that
# wrongly releases the lent lock. Nothing here sends input, launches Lawsmith or touches the real display,
# preferences or GUI lock: the lock is a temporary file, the "app" is a stand-in executable under a
# temporary Lawsmith.app path, and a stub replaces the display and preference hooks. Every run is under a
# watchdog; cleanup stops only processes this run recorded or that name its temporary directory.
#   zsh scripts/verify/native/test_m9_batch.zsh       one line per check; exits non-zero on a failure
zmodload zsh/datetime
HERE=${0:A:h}
ROOT=$(mktemp -d /tmp/lawsmith-m9-batch-test.XXXXXX)
passed=0
failed=0
naming() { pgrep -f -- "$ROOT/" }
finish() {
  local pid; for pid in $(naming); do kill -KILL $pid 2>/dev/null; done
  rm -rf $ROOT
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check() {
  if eval "$2"; then (( passed++ )); print -r -- "ok   $1"
  else (( failed++ )); print -r -- "FAIL $1"; [[ -n $3 ]] && print -r -- "     $3"; fi
}
lock_state() { python3 -I -c 'import fcntl,sys
f=open(sys.argv[1],"a+")
try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); print("free")
except BlockingIOError: print("held")' $1 }
# field FILE PATH: a dotted path into batch.json (list indexes as numbers, -1 for the last).
field() { python3 -I -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(json.dumps(d) if isinstance(d, (dict, list)) else d)' $1 $2 2>/dev/null }
verdicts() { python3 -I -c 'import json,sys; print(",".join(s["verdict"] for s in json.load(open(sys.argv[1]))["scenarios"]))' $1 2>/dev/null }
until_file() { local i; for i in {1..100}; do [[ -e $1 ]] && return 0; command sleep 0.1; done; return 1 }

# The stand-in app: /bin/sleep running under the Lawsmith.app executable path as its argv[0] (so its command
# line reads as the app's), started in its own session by a scenario, as `open -n` starts the real app
# outside the scenario's process tree, with its PID logged the way lib.zsh's launch logs it.

# The stub: display and preferences as files in the case directory; no quiet wait; stub scenarios.
cat > $ROOT/stub.zsh <<'EOF'
SCENARIOS=$CASE/scenarios
display_get() { print -r -- "$(<$CASE/display)" }
display_apply() { print -r -- $1 > $CASE/display; print -r -- "set $1" }
wait_quiet() { : }
snapshot_preferences() {
  PREFS_SNAPSHOT=$CASE/prefs.snapshot
  if [[ -f $CASE/prefs ]]; then PREFS_ORIGINAL=present; cp $CASE/prefs $PREFS_SNAPSHOT; else PREFS_ORIGINAL=absent; : > $PREFS_SNAPSHOT; fi
}
prefs_match() { if [[ $PREFS_ORIGINAL == absent ]]; then [[ ! -e $CASE/prefs ]]; else cmp -s $CASE/prefs $PREFS_SNAPSHOT; fi }
prefs_put_back() { if [[ $PREFS_ORIGINAL == absent ]]; then rm -f $CASE/prefs; else cp $PREFS_SNAPSHOT $CASE/prefs; fi; prefs_match }
EOF

# scenario NAME BODY: a stub scenario that sources the real lib.zsh and adopts the lent lock first.
scenario() {
  mkdir -p $CASE/scenarios
  print -r -- "source $HERE/lib.zsh
wait_quiet() { : }
segment adopt
[[ \$LOCK_HOLDER == inherited:* ]] || exit 9
print -r -- \$(python3 -I -c 'import fcntl,sys
f=open(sys.argv[1],\"a+\")
try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); print(\"free\")
except BlockingIOError: print(\"held\")' \$GUI_LOCK) > $CASE/$1.lock
: > $CASE/$1.ran
$2" > $CASE/scenarios/$1.zsh
}
# Starts the stand-in app in its own session and logs its PID as lib.zsh's launch does.
cat > $ROOT/start_app.py <<'EOF'
import os, sys
if os.fork():
    sys.exit(0)
os.setsid()
open(sys.argv[2], "w").write(str(os.getpid()))
os.execv("/bin/sleep", [sys.argv[1], "60"])
EOF
START_APP="python3 -I $ROOT/start_app.py \$APP/Contents/MacOS/lawsmith \$CASE/app.pid; for i in {1..50}; do [[ -s \$CASE/app.pid ]] && break; command sleep 0.1; done; say \"launched pid \$(<\$CASE/app.pid), window at 0,0\""
# A scenario that changes the display and preferences, as a real one does before its own cleanup.
DIRTY='print -r -- 900x600@60 > $CASE/display; print -r -- changed > $CASE/prefs'

# new_case NAME: a fresh directory with the original display and preferences.
new_case() {
  CASE=$ROOT/$1
  mkdir -p $CASE/state $CASE/out
  print -r -- 1168x755@120 > $CASE/display
  print -r -- owner > $CASE/prefs
}
# run_batch [ENV…] -- SCENARIO…: the driver under a watchdog, approved for exactly those scenarios.
run_batch() {
  local envs=() specs=()
  while [[ $1 != -- ]]; do envs+=($1); shift; done
  shift
  specs=("$@")
  env CASE=$CASE GUI_LOCK=$CASE/gui.lock APP=$ROOT/Fake.app M9_BATCH_STUB=$ROOT/stub.zsh QA_STATE=$CASE/state QA_OUT=$CASE/out QA_IDLE=0 \
    QA_APPROVAL="test batch" QA_APPROVED_SCENARIOS=${(j:;:)specs} $envs \
    /usr/bin/timeout 60 zsh $HERE/m9-batch.zsh "${specs[@]}" > $CASE/log 2>&1
  STATUS=$?
}
app_gone() { [[ ! -s $CASE/app.pid ]] || ! kill -0 $(<$CASE/app.pid) 2>/dev/null }
restored() { [[ $(<$CASE/display) == 1168x755@120 && $(<$CASE/prefs) == owner ]] }
clean() { [[ -z $(naming | grep -v "^$$\$") ]] }

# --- approval ---------------------------------------------------------------------------------------
new_case refuse
env -u QA_APPROVAL CASE=$CASE GUI_LOCK=$CASE/gui.lock M9_BATCH_STUB=$ROOT/stub.zsh QA_STATE=$CASE/state QA_OUT=$CASE/out /usr/bin/timeout 20 zsh $HERE/m9-batch.zsh m9-smoke > $CASE/log 2>&1
STATUS=$?
check "no approval: refused before the lock (exit 2)" '[[ $STATUS == 2 && ! -e $CASE/out/batch.json && ! -e $CASE/gui.lock ]]' "status $STATUS; $(tail -2 $CASE/log)"
env CASE=$CASE GUI_LOCK=$CASE/gui.lock M9_BATCH_STUB=$ROOT/stub.zsh QA_STATE=$CASE/state QA_OUT=$CASE/out QA_APPROVAL=x QA_APPROVED_SCENARIOS='m9-smoke' /usr/bin/timeout 20 zsh $HERE/m9-batch.zsh m9-smoke m9-resources > $CASE/log 2>&1
STATUS=$?
check "approval for other scenarios: refused (exit 2)" '[[ $STATUS == 2 && ! -e $CASE/out/batch.json && ! -e $CASE/gui.lock ]]' "status $STATUS"
env -u M9_BATCH_STUB CASE=$CASE GUI_LOCK=$CASE/gui.lock QA_STATE=$CASE/state QA_OUT=$CASE/out QA_APPROVAL=x QA_APPROVED_SCENARIOS='m9-smoke' M9_CAP=2 /usr/bin/timeout 20 zsh $HERE/m9-batch.zsh m9-smoke > $CASE/log 2>&1
STATUS=$?
check "test-only knobs without a stub: refused (exit 2)" '[[ $STATUS == 2 && ! -e $CASE/out/batch.json && ! -e $CASE/gui.lock ]]' "status $STATUS"

# --- completion, with the lent lock --------------------------------------------------------------------
new_case complete
scenario m9-smoke 'exit 0'
scenario m9-resources 'exit 0'
run_batch -- m9-smoke m9-resources
check "two scenarios complete: exit 0, both ran under the lent lock" '[[ $STATUS == 0 && $(<$CASE/m9-smoke.lock) == held && $(<$CASE/m9-resources.lock) == held ]]' "status $STATUS; $(tail -3 $CASE/log)"
check "receipt: both completed, nothing unrun, not evidence (stubbed)" '[[ $(verdicts $CASE/out/batch.json) == completed,completed && -z $(field $CASE/out/batch.json final.unrun) && $(field $CASE/out/batch.json stubbed) == True ]]'
check "the lock is free after the batch, the state restored, nothing left" '[[ $(lock_state $CASE/gui.lock) == free ]] && restored && clean'

# --- stops --------------------------------------------------------------------------------------------
new_case failure
scenario m9-smoke 'exit 1'
scenario m9-resources 'exit 0'
run_batch -- m9-smoke m9-resources
check "a failure stops the batch: exit 1, the next scenario never ran and is listed unrun" '[[ $STATUS == 1 && ! -e $CASE/m9-resources.ran && $(field $CASE/out/batch.json final.unrun) == m9-resources ]]' "status $STATUS"

new_case outside
scenario m9-smoke 'exit 4'
scenario m9-resources 'exit 0'
run_batch -- m9-smoke m9-resources
check "outside input: exit 4, yielded and not resumed" '[[ $STATUS == 4 && ! -e $CASE/m9-resources.ran && $(field $CASE/out/batch.json scenarios.0.verdict) == "yielded to outside input; not resumed" ]]' "status $STATUS"
check "after outside input: lock free, nothing left" '[[ $(lock_state $CASE/gui.lock) == free ]] && clean'

# --- watchdog -----------------------------------------------------------------------------------------
new_case watchdog
scenario m9-smoke "$START_APP; $DIRTY; repeat 600 command sleep 0.1"
run_batch M9_CAP=1 M9_GRACE=1 M9_KILL_AFTER=5 -- m9-smoke
check "watchdog TERM: exit 124, recorded as expired" '[[ $STATUS == 124 && $(field $CASE/out/batch.json scenarios.0.verdict) == "watchdog expired" ]]' "status $STATUS; $(tail -3 $CASE/log)"
check "the driver stopped the scenario's app by its logged PID and restored display and preferences" '[[ $(field $CASE/out/batch.json scenarios.0.stoppedAfter) == app:* && $(field $CASE/out/batch.json scenarios.0.restoration) == "display:restored-by-driver preferences:restored-by-driver" ]] && app_gone && restored' "$(field $CASE/out/batch.json scenarios.0)"
check "after the watchdog: lock free, nothing left" '[[ $(lock_state $CASE/gui.lock) == free ]] && clean'

new_case killed
scenario m9-smoke "trap '' TERM; $START_APP; $DIRTY; repeat 600 command sleep 0.1"
run_batch M9_CAP=1 M9_GRACE=1 M9_KILL_AFTER=1 -- m9-smoke
# A runner that ignores TERM can end only by the watchdog's KILL; timeout reports that as 124 or 137.
check "a runner that ignores TERM is killed; the driver still stops its app and restores" '[[ $STATUS == 124 || $STATUS == 137 ]] && [[ $(field $CASE/out/batch.json scenarios.0.verdict) == "watchdog expired" ]] && app_gone && restored && [[ $(lock_state $CASE/gui.lock) == free ]] && clean' "status $STATUS; $(field $CASE/out/batch.json scenarios.0)"

# --- the driver itself terminated ---------------------------------------------------------------------
new_case driver-term
scenario m9-smoke "$START_APP; $DIRTY; : > $CASE/dirty; repeat 600 command sleep 0.1"
scenario m9-resources 'exit 0'
( run_batch -- m9-smoke m9-resources; print $STATUS > $CASE/status ) &
until_file $CASE/dirty
# The driver's own shell, not its test watchdog (whose arguments also name the script).
driver=$(pgrep -f -- "^zsh $HERE/m9-batch.zsh m9-smoke m9-resources" | head -1)
[[ -n $driver ]] && kill -TERM $driver
until_file $CASE/status
check "driver TERM: exit 143, the running scenario interrupted, the next unrun" '[[ -n $driver && $(<$CASE/status) == 143 && ! -e $CASE/m9-resources.ran && $(field $CASE/out/batch.json scenarios.-1.verdict) == "interrupted with the batch" ]]' "driver $driver, status $(<$CASE/status 2>/dev/null); $(tail -3 $CASE/log)"
check "after driver TERM: app stopped, state restored, lock free, nothing left" 'app_gone && restored && [[ $(lock_state $CASE/gui.lock) == free ]] && clean'

# --- an adopter that releases the lent lock -----------------------------------------------------------
new_case lost-lock
scenario m9-smoke "python3 -I -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_UN)' \$QA_LOCK_FD; exit 0"
scenario m9-resources 'exit 0'
run_batch -- m9-smoke m9-resources
check "negative control: a released lent lock is detected (exit 3); the next scenario never ran" '[[ $STATUS == 3 && ! -e $CASE/m9-resources.ran && $(field $CASE/out/batch.json scenarios.0.verdict) == "the lent lock was lost during it" ]]' "status $STATUS; $(tail -3 $CASE/log)"

print -r -- "$passed passed, $failed failed"
(( failed == 0 ))
