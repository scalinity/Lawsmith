#!/bin/zsh
# Non-native checks of the shared GUI lock's process lifecycle in lib.zsh: acquisition and release,
# a contended deadline, the runner stopped or killed while its holder waits or holds (and before the
# holder has started), a lent lock, and a terminated runner's own cleanup. Nothing here sends input,
# launches the app or changes the display or preferences: each runner only takes a real flock on a
# temporary file, and runs under a watchdog. Cleanup stops only processes this run started (recorded
# with their start times) or that name its temporary directory.
#   zsh scripts/verify/native/test_lock_lifecycle.zsh            prints one line per check, exits non-zero on a failure
#   LIB=/path/to/lib.zsh zsh scripts/verify/native/test_lock_lifecycle.zsh   runs the same checks against another lib.zsh
zmodload zsh/datetime
HERE=${0:A:h}
LIB=${LIB:-$HERE/lib.zsh}
ROOT=$(mktemp -d)
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
# naming DIR: processes whose arguments name DIR (lock holders and competitors on its lock).
naming() { pgrep -f -- "$1/" }
finish() {
  reap
  local pid; for pid in $(naming $ROOT); do kill $pid 2>/dev/null; done
  rm -rf $ROOT
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check() {
  if eval "$2"; then (( passed++ )); print -r -- "ok   $1"
  else (( failed++ )); print -r -- "FAIL $1"; [[ -n $3 ]] && print -r -- "     $3"; fi
}
holders() { print $(pgrep -f -- "$1/.*lawsmith-m2" | wc -l) }
production_holders() { print $(pgrep -f -- "mac-gui-automation.lock lawsmith-m2" | wc -l) }
lock_state() { python3 -I -c 'import fcntl,sys
f=open(sys.argv[1],"a+")
try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: print("held"); sys.exit()
print("free")' $1/gui.lock }
until_file() { local i; for i in {1..60}; do [[ -e $1 ]] && return 0; command sleep 0.1; done; return 1 }
# settled DIR: the holder count once it reaches zero, or after 3 s.
settled() { local i; for i in {1..30}; do (( $(holders $1) == 0 )) && break; command sleep 0.1; done; holders $1 }

# The runner under test. MODE picks what it does after sourcing LIB.
cat > $ROOT/runner.zsh <<'EOF'
zmodload zsh/system
D=$1; MODE=$2
export QA_STATE=$D/state QA_OUT=$D/out GUI_LOCK=${GUI_LOCK:-$D/gui.lock} QA_IDLE=1
source $LIB
wait_quiet() { : }
print $sysparams[pid] > $D/runner.pid
hold() { : > $D/held; repeat 120 command sleep 0.25 }
tally() { print -n "$(pgrep -f -- "$GUI_LOCK lawsmith-m2" | wc -l | tr -d ' ') " >> $D/counts }
case $MODE in
  segments) segment a; tally; segment b; tally; segment c; tally; gui_unlock; tally; exit 0 ;;
  exit-held) gui_lock x; tally; exit 0 ;;
  deadline) QA_DEADLINE=$(( EPOCHREALTIME + 1.5 )); gui_lock x ;;
  holder-exits) trap 'print -r -- "holder=[$LOCK_HOLDER]" > $D/holder; gui_unlock' EXIT; gui_lock x ;;
  hold) gui_lock x; hold ;;
  wait) : > $D/waiting; gui_lock x; hold ;;
  race) python3() { command sleep 0.8; : > $D/exec; exec $commands[python3] "$@" }; : > $D/spawning; gui_lock x; hold ;;
  term-cleanup) trap ': > $D/cleanup; gui_unlock' EXIT; gui_lock x; hold ;;
  adopt) segment a; segment b; print -r -- $LOCK_HOLDER > $D/adopted; gui_unlock; exit 0 ;;
  adopt-hold) segment a; hold ;;
  lend)  # lends the lock on a descriptor to an adopting runner, then reports whether it still holds it
    exec {lfd}>>$GUI_LOCK
    python3 -I -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX)' $lfd
    QA_LOCK_FD=$lfd zsh $0 $D/adopter $3; print $? > $D/adopter-exit
    print -n "after-adopter=" > $D/lender; python3 -I -c 'import fcntl,sys
try: fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX|fcntl.LOCK_NB); print("held-by-lender")
except BlockingIOError: print("lost")' $lfd >> $D/lender
    exec {lfd}>&- ;;
esac
EOF

# scenario NAME MODE [WAIT_FOR_FILE]: a fresh directory, an optional competitor already holding the lock
# (COMPETE=1), and the runner under its watchdog. Sets D and RUNNER (the runner's PID).
scenario() {
  D=$ROOT/$1; mkdir -p $D/state $D/out $D/adopter/state $D/adopter/out
  if [[ -n $COMPETE ]]; then
    python3 -I -c 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.flock(f, fcntl.LOCK_EX); open(sys.argv[2],"w"); time.sleep(25)' $D/gui.lock $D/competitor &
    own $!; until_file $D/competitor
  fi
  LIB=$LIB /usr/bin/timeout 20 zsh $ROOT/runner.zsh $D $2 $3 > $D/log 2>&1 &
  WATCHDOG=$!; own $WATCHDOG
  until_file $D/runner.pid; RUNNER=$(<$D/runner.pid); own $RUNNER
  [[ -n $4 ]] && until_file $D/$4
}
finished() { wait $WATCHDOG 2>/dev/null; STATUS=$? }

print -r -- "lock holders before: $(holders $ROOT) on this run's temporary locks; $(production_holders) on the shared GUI lock (not started by this run, never touched)"

# --- 1: normal acquisition and release, repeated segments ------------------------------------------
scenario segments segments; finished
check "segments: one holder per segment, none after release" '[[ $STATUS == 0 && $(<$D/counts) == "1 1 1 0 " && $(holders $D) == 0 && $(lock_state $D) == free ]]' "exit $STATUS, counts '$(<$D/counts)'"
scenario exit-held exit-held; finished
check "exit while holding: the EXIT trap releases" '[[ $STATUS == 0 && $(settled $D) == 0 && $(lock_state $D) == free ]]'
reap

# --- 2: contended deadline and holder failure ----------------------------------------------------------
COMPETE=1 scenario deadline deadline; finished
check "contended deadline: exit 5, no holder left, the other holder keeps the lock" '[[ $STATUS == 5 && $(settled $D) == 0 && $(lock_state $D) == held ]]' "exit $STATUS"
reap
GUI_LOCK=$ROOT/holder-exits scenario holder-exits holder-exits; finished
check "a holder that exits early fails the run and is forgotten, not killed later" '[[ $STATUS == 1 && $(<$D/holder) == "holder=[]" ]]' "exit $STATUS, $(<$D/holder 2>/dev/null)"
reap

# --- 3: the runner stopped or killed while its holder holds, waits, or has not started -------------
for sig in TERM KILL; do
  scenario held-$sig hold "" held; command sleep 0.4; kill -$sig $RUNNER; finished
  check "held, runner $sig: holder gone, lock free" '[[ $(settled $D) == 0 && $(lock_state $D) == free ]]'
  reap
  COMPETE=1 scenario waiting-$sig wait "" waiting; command sleep 0.6; kill -$sig $RUNNER; finished
  check "waiting, runner $sig: holder gone while the other holder keeps the lock" '[[ $(settled $D) == 0 && $(lock_state $D) == held ]]' "$(holders $D) holder(s) left"
  reap
done
scenario race race "" spawning; command sleep 0.3; kill -KILL $RUNNER; finished; until_file $D/exec; command sleep 0.5
check "runner killed before its holder started: the holder never takes the lock" '[[ $(settled $D) == 0 && $(lock_state $D) == free ]]' "$(holders $D) holder(s) left, lock $(lock_state $D)"
reap
scenario term-cleanup term-cleanup "" held; command sleep 0.4; kill -TERM $RUNNER; finished
check "runner TERM: its own EXIT cleanup runs" '[[ $STATUS == 143 && -e $D/cleanup && $(settled $D) == 0 ]]' "exit $STATUS"
reap

# --- 4: a lent lock stays the lender's; wrong descriptors are refused --------------------------------
scenario lend-adopt lend adopt; finished
check "lent lock: the adopter uses it and the lender still holds it after" '[[ $(<$D/adopter-exit) == 0 && $(<$D/adopter/adopted) == inherited:* && $(<$D/lender) == after-adopter=held-by-lender && $(holders $D) == 0 ]]' "adopter exit $(<$D/adopter-exit 2>/dev/null), $(<$D/lender 2>/dev/null)"
scenario lend-term lend adopt-hold; until_file $D/adopter/held; kill -TERM $(<$D/adopter/runner.pid); finished
check "lent lock: a terminated adopter leaves it with the lender" '[[ $(<$D/adopter-exit) == 143 && $(<$D/lender) == after-adopter=held-by-lender && $(holders $D) == 0 ]]' "adopter exit $(<$D/adopter-exit 2>/dev/null), $(<$D/lender 2>/dev/null)"
reap
D=$ROOT/closed-fd; mkdir -p $D/state $D/out
QA_LOCK_FD=57 LIB=$LIB /usr/bin/timeout 20 zsh $ROOT/runner.zsh $D hold > $D/log 2>&1; STATUS=$?
check "a closed descriptor is refused (exit 3) and no holder starts" '[[ $STATUS == 3 && $(holders $D) == 0 ]] && grep -q "descriptor 57 is not open" $D/log'
D=$ROOT/other-file; mkdir -p $D/state $D/out; : >> $D/gui.lock
exec {ofd}>>$D/other.lock
QA_LOCK_FD=$ofd LIB=$LIB /usr/bin/timeout 20 zsh $ROOT/runner.zsh $D hold > $D/log 2>&1; STATUS=$?
check "a descriptor on another file is refused (exit 3) and no holder starts" '[[ $STATUS == 3 && $(holders $D) == 0 ]] && grep -q "is not the GUI lock" $D/log'
exec {ofd}>&-

reap
command sleep 0.5
left=$(naming $ROOT | wc -l | tr -d ' ')
print -r -- "lock holders after: $(holders $ROOT) on this run's temporary locks; $(production_holders) on the shared GUI lock; $left processes still naming this run's directory"
print -r -- "$passed passed, $failed failed"
(( failed == 0 && left == 0 ))
