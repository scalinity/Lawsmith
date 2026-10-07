# M4 visual QA in the packaged app (MILESTONES M4 Visual QA; AC2–AC6): a body entering and leaving a
# drag pocket, a body under overlapping laws, a body in a collision heap, the limiter against a capped
# arrow, probes, trails and the selected-law arrow filter, then the runtime's own T08 and invariance
# fixtures. A body is chosen by position while paused and clicked, so picking is exercised for real.
# Every claim the readout makes is rechecked from the app's `explanation` events by m4q.py.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m4-explain
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-explain4-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/*.lawsmith.json ${NATIVE:h}/scenes/m4-limiter.lawsmith.json $QA_STATE/scenes/

open_example() {
  activate
  keys kd:cmd t:o ku:cmd
  local n=$(count document)
  open_panel $1.lawsmith.json
  sleep 1.2
  [[ $(depth) == 1 ]] && alert "Don't Save"
  wait_log document $(( n + 1 )) 15
  expect document "$1 opened transactionally" "e['action']=='open' and e['outcome']=='committed'"
}
# explain_body PREDICATE: clicks the first body (paused) whose world point w satisfies the predicate.
explain_body() {
  layout
  local p=(${=$(logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
# Only a body over the bare canvas can be clicked: never one under a panel, the tools or the transport.
covers = [r for r in (e['controls'].get(k) for k in ('panel', 'explain', 'tools', 'transport', 'overlays')) if r]
inside = lambda p, r: r[0] - 6 <= p[0] <= r[0] + r[2] + 6 and r[1] - 6 <= p[1] <= r[1] + r[3] + 6
for b in e['bodies']:
    w = b['world']
    if ($1) and not any(inside(b['point'], r) for r in covers):
        print(b['id'], round($WIN_X + b['point'][0]), round($WIN_Y + b['point'][1])); break")})
  [[ -n $p[1] ]] || fail "no body satisfies $1"
  local n=$(count explain-select)
  click $p[2] $p[3]
  wait_log explain-select $(( n + 1 ))
  expect explain-select "a click explains $p[1]" "e['body']=='$p[1]' and e['reason']=='click'"
}
explanation() { local n=$(count explanation); keys kd:shift t:e ku:shift; wait_log explanation $(( n + 1 )) }
# check NAME DESCRIPTION [SINCE]: a fresh explanation event, checked by m4q.py.
check() {
  [[ $1 == any-* ]] || explanation
  local verdict=$(python3 -I $NATIVE/m4q.py $APP_LOG $1 $3)
  say "$verdict  [explanation] $2"
  [[ $verdict == PASS* ]] || fail "expectation failed: $2"
}
# step_until NAME MAX STRIDE: steps STRIDE ticks at a time until the check passes.
step_until() {
  local i
  for i in {1..$2}; do
    keys t:${(l:$3::.:)}
    explanation
    [[ $(python3 -I $NATIVE/m4q.py $APP_LOG $1) == PASS* ]] && return 0
  done
  fail "no step satisfied $1 within $(( $2 * $3 )) ticks"
}
pause() { [[ $(field sim-control action) == '"play"' ]] && press play; sleep 0.3 }
lawhandle() { logq lawhandle $APP_LOG $WIN_X $WIN_Y $1 }
# drag_handle NAME DX DY DZ: as m3-demo: drags the selected law's handle toward a world offset, at least 90 px.
drag_handle() {
  layout
  local from=(${=$(lawhandle $1)}) to=(${=$(world ${=$(logq lawhandleworld $APP_LOG $1 $2 $3 $4)})})
  to=(${=$(python3 -I -c "
import math
dx, dy = $to[1] - $from[1], $to[2] - $from[2]
n = math.hypot(dx, dy) or 1
k = max(1, 90 / n)
print(round($from[1] + dx * k), round($from[2] + dy * k))")})
  drag $from[1] $from[2] $to[1] $to[2]
}

seed_folder $QA_STATE/scenes
segment "a body entering and leaving a drag pocket"
launch explain4 $RECOVERY
activate
open_example drag-pocket
keys t:s
record_start m4-drag 75
press play
sleep 2.5
pause
explain_body "-3.3 < w[0] < -2.5"
shot drag-00-chosen
step_until in-drag 20 3
check in-drag "inside the pocket the drag share is −λβK·v at the sampled velocity, and the shares sum to force/mass"
shot drag-01-inside
# A paused edit changes the next-step preview, never the step that already happened (AC2).
press explain-preview
check consistent "the readout shows a next-step preview"
drag_handle coefficient 0 1.6 0
expect gesture "a paused drag of the coefficient gauge raised the drag" "e['phase']=='commit' and e['handle']=='coefficient' and e['field']['expression']['coefficient'] > 3"
check preview-edit "after the paused edit the next-step preview changed and the last step did not"
shot drag-02-preview-after-edit
press explain-applied
press play
sleep 1.8
pause
check out-of-drag "the body left the pocket with less sideways velocity, its trail behind it"
shot drag-03-left
record_stop

segment "a body under three overlapping laws"
activate
open_example overlap
keys t:s
record_start m4-overlap 40
press play
sleep 3
pause
keys t:f
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
expect explain-select "B explains the body nearest the laws' center" "e['reason']=='nearest'"
keys t:.
check overlap "the pull, swirl and drag act together; every share uses the step's one β and λ"
shot overlap-01-shares
press play
sleep 4
pause
shot overlap-02-later
record_stop

segment "a collision: law shares and contacts kept apart"
activate
open_example why-it-moves
keys t:s
press play
sleep 7
pause
explain_body "w[0] < -3.4 and w[1] > 3.6"
record_start m4-collision 70
step_until overlap 70 3
check overlap "on the way the pull and the drag pocket act in one step: two shares under one β and λ"
shot collision-00-overlap
step_until contact 60 6
check contact "the landed body names its contact, and the law acceleration alone misses its velocity after the step"
shot collision-01-contact
press play
sleep 3
pause
shot collision-02-heap
record_stop

segment "the limiter against a capped arrow"
activate
open_example m4-limiter
keys t:s
record_start m4-limiter 70
press play
sleep 0.75
pause
explain_body "4.1 < w[1] < 5.6 and abs(w[0]) < 0.6"
step_until capped-idle 25 2
check capped-idle "in the push the drawn arrow is capped (∥) while the limiter is idle (λ = 1)"
shot limiter-01-capped
step_until limited 40 2
check limited "in the thick drag the limiter is active (λ < 1) and every share is scaled by it"
shot limiter-02-limited
record_stop

segment "probes, trails and the selected-law arrow filter"
activate
open_example overlap
keys t:s
record_start m4-probes 45
press play
layout
before=$(field layout visualization.totalBytes)
press probes-toggle
expect visualization "2,000 probes are on, as visualization state: no revision, nothing dirty" "e['change']=='probes' and e['probes']['enabled'] is True and e['probes']['count']==2000 and e['revision']==0 and e['dirty'] is False"
sleep 4
shot probes-01-on
press trails-all
expect visualization "32 trails are on" "e['change']=='trails' and e['trails']['mode']=='all'"
sleep 5
shot trails-01-all
press arrows-selected
expect visualization "only the selected law draws arrows" "e['change']=='arrows' and e['arrowScope']=='selected' and e['revision']==0"
layout
expect layout "the filter draws only the selected law's samples, and every law is still enabled" "e['arrows'] <= 125 and e['visualization']['arrowScope']=='selected'"
shot filter-01-selected-law
press arrows-every
press probes-toggle
press trails-off
expect visualization "probes and trails are off again without touching a law" "e['trails']['mode']=='off' and e['probes']['enabled'] is False and e['revision']==0 and e['dirty'] is False"
record_stop

segment "bounded buffers through toggles, resets and loads (T11)"
activate
for cycle in {1..10}; do
  press probes-toggle
  press trails-all
  sleep 0.6
  keys kd:shift t:r ku:shift
  press trails-selected
  press probes-toggle
done
open_example why-it-moves
press play
press probes-toggle
press trails-all
sleep 2
keys kd:shift t:v ku:shift
wait_log visual-resources 1
expect visual-resources "after 10 toggle-and-reset cycles and two loads the buffers are the ones allocated at start" "e['totalBytes']==$before and e['probes']['live'] <= 2000 and e['trails']['count'] <= 32"
press probes-toggle
press trails-selected

segment "the runtime's own fixtures: invariance (AC6), reset (T04), trails and shares (T08)"
activate
open_example overlap
keys kd:shift t:d ku:shift
wait_log fixtures 1 240
expect fixtures "quiet and busy views, and a reset across a view change, agree exactly; trails and shares check out" "e['allEqual'] is True and e['t08'] is True and e['trails']['mismatches']==0 and e['contributions']['pass'] is True"
activate
keys kd:cmd t:q ku:cmd
# Opening the overlap scene left nothing unsaved, so Quit asks only if an earlier edit remains.
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
say "m4-explain complete"
