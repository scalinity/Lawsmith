#!/bin/zsh
# M8 R22: m8-perf.zsh's workload selection, extracted and run on its own (no lib.zsh, nothing native).
# The eleventh attempt stopped in 0.02 s with "unknown workload P0 P1 P2 P3": ${@:-P0 P1 P2 P3} gave the
# default as one word. With no arguments all four workloads must run, each its own word, in order;
# explicit selectors pass through unchanged and anything else is refused with exit 2.
HERE=${0:A:h}
pass=0 failed=0
check() { if eval "$2"; then (( pass++ )); else (( failed++ )); print -u2 "FAIL $1"; fi }
BLOCK="$(sed -n '/WORKLOADS=(/,/unknown workload/p' $HERE/m8-perf.zsh)"
select_workloads() { zsh -c "$BLOCK"'
print -r -- "count=${#WORKLOADS} words=${(j:|:)WORKLOADS}"' select "$@" 2>&1; print "exit=$?" }

out=$(select_workloads)
check "the default is four separate workloads, P0 to P3 in order" '[[ $out == *"count=4 words=P0|P1|P2|P3"* && $out == *"exit=0"* ]]'
out=$(select_workloads P2)
check "one explicit workload" '[[ $out == *"count=1 words=P2"* && $out == *"exit=0"* ]]'
out=$(select_workloads P3 P0)
check "explicit workloads keep their order" '[[ $out == *"count=2 words=P3|P0"* && $out == *"exit=0"* ]]'
out=$(select_workloads P4)
check "an unknown workload is refused" '[[ $out == *"unknown workload P4"* && $out == *"exit=2"* ]]'
out=$(select_workloads "P0 P1")
check "a selector holding two names is refused, not split" '[[ $out == *"unknown workload P0 P1"* && $out == *"exit=2"* ]]'
out=$(select_workloads P1 "")
check "an empty selector is refused" '[[ $out == *"unknown workload "* && $out == *"exit=2"* ]]'

print "$pass passed, $failed failed"
(( failed == 0 ))
