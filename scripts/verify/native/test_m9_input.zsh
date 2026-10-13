#!/bin/zsh
# Non-native checks that outside input ends a run (exit 4) wherever it happens: during a passive wait_log,
# just before a segment's quiet wait, and between scenarios of a batch (through QA_INPUT_STAMP). Also that
# the first quiet acquisition still waits for quiet, and that a wait with no outside input completes.
# Nothing here sends input or launches anything: lib.zsh runs with a stub ioreg whose HID idle time comes
# from a file of the last "hardware" event, a recording stub cliclick, and a temporary lock file. Each runner
# is under a watchdog; cleanup stops only processes this run recorded or that name its temporary directory.
#   zsh scripts/verify/native/test_m9_input.zsh                       one line per check; non-zero on a failure
#   LIB=/path/to/lib.zsh zsh scripts/verify/native/test_m9_input.zsh  the same checks against another lib.zsh
zmodload zsh/datetime
HERE=${0:A:h}
LIB=${LIB:-$HERE/lib.zsh}
ROOT=$(mktemp -d /tmp/lawsmith-m9-input-test.XXXXXX)
OWNED=$ROOT/owned
passed=0
failed=0
own() { print -r -- "$1 ${(j: :)${=$(ps -o lstart= -p $1)}}" >> $OWNED }
reap() {
  local pid start
  [[ -f $OWNED ]] || return 0
  while read -r pid start; do
    [[ -n $start && ${(j: :)${=$(ps -o lstart= -p $pid 2>/dev/null)}} == $start ]] && kill $pid 2>/dev/null
  done < $OWNED
  : > $OWNED
}
finish() {
  reap
  local pid; for pid in $(pgrep -f -- "$ROOT/"); do kill $pid 2>/dev/null; done
  rm -rf $ROOT
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check() {
  if eval "$2"; then (( passed++ )); print -r -- "ok   $1"
  else (( failed++ )); print -r -- "FAIL $1"; [[ -n $3 ]] && print -r -- "     $3"; fi
}

# The runner: the real lib.zsh, then stubs for the HID idle time and for synthetic input.
cat > $ROOT/runner.zsh <<'EOF'
zmodload zsh/datetime
D=$1; MODE=$2
export QA_STATE=$D/state QA_OUT=$D/out GUI_LOCK=$D/gui.lock QA_IDLE=1
source $LIB
# HID idle: seconds since the time in $D/hid, the last keyboard or mouse event, ours or the owner's.
ioreg() { print -r -- "    | |   \"HIDIdleTime\" = $(( (EPOCHREALTIME - $(<$D/hid)) * 1000000000 ))" }
# A synthetic event is a hardware event too, so it resets the idle time; it is recorded, never sent.
cliclick() { print -r -- "cliclick $*" >> $D/synthetic; print -r -- $EPOCHREALTIME > $D/hid }
APP_LOG=$D/app.log
: > $APP_LOG
case $MODE in
  wait-input)   # our last event, then a passive wait during which the owner moves the mouse
    cliclick m:1,1; touched
    wait_log never 1 8
    cliclick c:5,5 ;;
  wait-quiet-ok) # our last event, then a wait that ends when its event arrives, with nobody else active
    cliclick m:1,1; touched
    wait_log done 1 8 ;;
  segment-input) # our last event, owner input, then the next segment
    cliclick m:1,1; touched
    command sleep 0.6; print -r -- $EPOCHREALTIME > $D/hid
    segment next
    cliclick c:5,5 ;;
  first-acquire) # a fresh run: quiet acquisition as before, then a wait with no outside input
    segment first
    wait_log done 1 8 ;;
  stamped)       # a later scenario of a batch: the batch's last event is in the stamp, owner input after it
    segment next
    cliclick c:5,5 ;;
esac
exit 0
EOF

# run NAME MODE [SETUP]: a fresh directory, SETUP evaluated in it, then the runner under its watchdog.
run() {
  D=$ROOT/$1
  mkdir -p $D/state $D/out
  print -r -- $EPOCHREALTIME > $D/hid
  [[ -n $3 ]] && eval "$3"
  local t0=$EPOCHREALTIME
  LIB=$LIB QA_INPUT_STAMP=$STAMP /usr/bin/timeout 30 zsh $ROOT/runner.zsh $D $2 > $D/log 2>&1
  STATUS=$?
  ELAPSED=$(( EPOCHREALTIME - t0 ))
}
synthetic() { [[ -f $D/synthetic ]] && grep -c . $D/synthetic || print 0 }
holders() { print $(pgrep -f -- "$ROOT/.*gui-lock" | wc -l) }

# --- mid-wait input -----------------------------------------------------------------------------------
STAMP=
D=$ROOT/wait-input; mkdir -p $D
# The owner's input two seconds into the run, well after its own last event (a recorded background writer
# with a finite life). The wait's own timeout is 8 s, so exit 4 well before that is the guard, not a timeout.
( command sleep 2; print -r -- $EPOCHREALTIME > $ROOT/wait-input/hid ) & own $!
run wait-input wait-input
check "outside input during a passive wait_log: exit 4 at once, no further synthetic input" '[[ $STATUS == 4 ]] && (( ELAPSED < 5 )) && [[ $(synthetic) == 1 ]]' "status $STATUS after ${ELAPSED}s; $(tail -2 $D/log)"

D=$ROOT/wait-quiet-ok; mkdir -p $D
( command sleep 0.8; print -r -- '[lawsmith] {"kind":"done"}' >> $ROOT/wait-quiet-ok/app.log ) & own $!
run wait-quiet-ok wait-quiet-ok
check "no outside input: the passive wait completes (exit 0)" '[[ $STATUS == 0 ]]' "status $STATUS; $(tail -2 $D/log)"

# --- input just before a segment ----------------------------------------------------------------------
run segment-input segment-input
check "outside input just before a segment: exit 4, never waited out, no further synthetic input" '[[ $STATUS == 4 ]] && (( ELAPSED < 5 )) && [[ $(synthetic) == 1 ]]' "status $STATUS after ${ELAPSED}s; $(tail -2 $D/log)"
check "after it: no lock holder left" '[[ $(holders) == 0 ]]'

# --- the first acquisition keeps its quiet wait --------------------------------------------------------
D=$ROOT/first-acquire; mkdir -p $D
( command sleep 3; print -r -- '[lawsmith] {"kind":"done"}' >> $ROOT/first-acquire/app.log ) & own $!
# The owner was active a moment ago; the quiet wait outlasts it (QA_IDLE=1, checked every 5 s), then proceeds.
run first-acquire first-acquire 'print -r -- $EPOCHREALTIME > $D/hid'
check "first acquisition: waits for quiet as before, then proceeds (exit 0)" '[[ $STATUS == 0 ]] && (( ELAPSED >= 4.5 ))' "status $STATUS after ${ELAPSED}s; $(tail -2 $D/log)"

# --- between scenarios ---------------------------------------------------------------------------------
STAMP=$ROOT/stamp
# The previous scenario's last synthetic event two seconds ago; the owner touched the mouse one second ago.
run stamped stamped 'print -r -- $(( EPOCHREALTIME - 2 )) > $STAMP; print -r -- $(( EPOCHREALTIME - 1 )) > $D/hid'
check "outside input between scenarios (via QA_INPUT_STAMP): the next scenario's first segment exits 4" '[[ $STATUS == 4 ]] && (( ELAPSED < 5 )) && [[ $(synthetic) == 0 ]]' "status $STATUS after ${ELAPSED}s; $(tail -2 $D/log)"
run stamped-quiet stamped 'print -r -- $(( EPOCHREALTIME - 2 )) > $STAMP; print -r -- $(( EPOCHREALTIME - 2 )) > $D/hid'
check "no input since the stamp: the next scenario proceeds" '[[ $STATUS == 0 ]] && [[ $(synthetic) == 1 ]]' "status $STATUS after ${ELAPSED}s; $(tail -2 $D/log)"
STAMP=

reap
check "no process of this run left" '[[ -z $(pgrep -f -- "$ROOT/") ]]'
print -r -- "$passed passed, $failed failed"
(( failed == 0 ))
