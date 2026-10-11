#!/bin/zsh
# M8 R21: m8lib.zsh drag_window and window_round_trip, extracted and run with the native layer stubbed.
# The eighth attempt dragged the window (80, 50) from the band, saw it move (0, 0), and then sent an
# assumed reverse drag whose end fell under the menu bar. Here a drag that moves nothing must fail before
# any second drag; a reverse uses the displacement actually made, from a fresh origin. Nothing runs natively.
HERE=${0:A:h}
pass=0 failed=0
check() { if eval "$2"; then (( pass++ )); else (( failed++ )); print -u2 "FAIL $1"; fi }

run() {  # run MOVES...: each MOVES entry is the window displacement the next drag produces, "dx dy"
  (
    eval "$(sed -n '/^drag_window() {/,/^}/p;/^window_round_trip() {/,/^}/p' $HERE/m8lib.zsh)"
    QA_OUT=$(mktemp -d); APP_LOG=/dev/null; WIN_X=40; WIN_Y=45
    MOVES=("$@"); DRAGS=()
    layout() { :; }
    logq() { print '[0, 0, 600, 40]' }
    field() { print 1 }
    say() { print -r -- "say: $*" }
    fail() { print -r -- "fail: $1"; print -r -- "drags: ${(j:;:)DRAGS}"; exit 1 }
    drag() { DRAGS+=("$1,$2>$3,$4"); local m=(${=MOVES[1]}); MOVES=("${(@)MOVES[2,-1]}"); PENDING=($m) }
    window_origin() { WIN_X=$(( WIN_X + PENDING[1] )); WIN_Y=$(( WIN_Y + PENDING[2] )); PENDING=(0 0) }
    sleep() { :; }
    window_round_trip 80 50
    print -r -- "drags: ${(j:;:)DRAGS}"
    cat $QA_OUT/m8-checks.jsonl
  )
}

out=$(run "0 0" "0 0")
check "zero displacement fails" '[[ $out == *"fail: the window did not move for a (80,50) drag"* ]]'
check "zero displacement sends no reverse drag" '[[ $out == *"drags: 240,65>320,115"* && $out != *";"* ]]'

out=$(run "80 50" "-80 -50")
check "exact move then reverse from the fresh origin" '[[ $out == *"drags: 240,65>320,115;320,115>240,65"* ]]'
check "both drags recorded as passing" '[[ $(print -r -- $out | grep -c "\"pass\":true") == 2 ]]'

out=$(run "60 50" "-60 -50")
check "a mismatched move is a recorded watch, not a pass" '[[ $out == *"WATCH: the window moved (60,50)"* && $out == *"\"pass\":false"* ]]'
check "the reverse is the actual displacement, not the asked one" '[[ $out == *";300,115>240,65"* ]]'

print "$pass passed, $failed failed"
(( failed == 0 ))
