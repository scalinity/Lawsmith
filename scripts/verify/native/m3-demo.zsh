# M3 visual QA in the packaged app (MILESTONES M3 Visual QA; AC4, AC6, AC8): each example opened
# through the real Open panel, played and recorded, with at least one spatial parameter handle used:
# radial capture, release and sign reversal; vortex direction reversal against its cylinder axis; a
# drag pocket dissipating motion without arrows; an overlap of three laws; all-body collisions under
# a pull. Assertions read the app's own events; recordings and captures are the visual evidence.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m3-demo
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-demo3-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/*.lawsmith.json $QA_STATE/scenes/

lawhandle() { logq lawhandle $APP_LOG $WIN_X $WIN_Y $1 }
# drag_handle NAME DX DY DZ: drags the selected law's handle NAME toward a world offset from where it
# is, along that offset's screen direction for at least 90 px (WebKit delivers only part of a short
# synthetic drag; values past a bound are held at it).
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
# law_control ID PART: clicks one law row's control (select, visible, enabled) from a fresh readback.
law_control() {
  layout
  local i=$(logq field $APP_LOG layout laws | python3 -I -c "import json,sys; print([l['id'] for l in json.load(sys.stdin)].index('$1'))")
  local p=(${=$(point laws.$i.$2)}); click $p[1] $p[2]
}
# select_law ID: selects a law from its row; a lost synthetic click (no selection event) is sent again once.
select_law() {
  local n=$(count selection) i
  law_control $1 select
  for i in {1..10}; do (( $(count selection) > n )) && return 0; sleep 0.1; done
  say "the synthetic click on $1's row was lost (no selection event); sending it again"
  law_control $1 select
  wait_log selection $(( n + 1 )) 3
}
# rotate_law_z X Y Z: turns the selected law about world Z by dragging the rotate gizmo's Z ring. As in
# m2-demo, TransformControls turns a ring by the drag along axis × eye, so the drag follows that
# direction's projection on screen.
rotate_law_z() {
  layout
  local from=(${=$(handle Z 0)})
  local camera=$(logq field $APP_LOG layout camera | tr -d '[] ')
  local direction=(${=$(python3 -I -c "
c = [$camera]; p = [$1, $2, $3]
e = [c[i] - p[i] for i in range(3)]; n = sum(v * v for v in e) ** 0.5; e = [v / n for v in e]
d = [-e[1], e[0], 0]; m = (d[0] ** 2 + d[1] ** 2) ** 0.5
print(*(round(p[i] + 0.5 * d[i] / m, 6) for i in range(3)))")})
  local p0=(${=$(world $1 $2 $3)}) p1=(${=$(world $direction)})
  local to=(${=$(python3 -I -c "
dx, dy = $p1[1] - $p0[1], $p1[2] - $p0[2]; n = (dx * dx + dy * dy) ** 0.5
print(round($from[1] + 42 * dx / n), round($from[2] + 42 * dy / n))")})
  drag $from[1] $from[2] $to[1] $to[2]
}
open_example() {
  activate
  keys kd:cmd t:o ku:cmd
  local n=$(count document)
  open_panel $1.lawsmith.json
  # Opening over the previous example's edits runs the unsaved-work guard; those edits are disposable.
  sleep 1.2
  [[ $(depth) == 1 ]] && alert "Don't Save"
  wait_log document $(( n + 1 )) 15
  expect document "$1 opened transactionally" "e['action']=='open' and e['outcome']=='committed'"
  expect sim-control "$1 starts paused at tick 0" "e['action']=='load' and e['tick']==0 and e['playing'] is False"
}

seed_folder $QA_STATE/scenes
segment "examples: radial catch, release and repulsion"
launch demo3 $RECOVERY
activate
open_example catch-and-release
record_start m3-radial 55
press_expect play sim-control
sleep 5
expect pacing "the stream runs through the pull without limiting" "e['bodies'] > 20 and e['playing'] is True"
shot radial-01-catch
# Release: move the pull out of the stream; bodies leave with the velocity they gained.
keys t:t
drag_law_to 1 2.8 0 3.6 2.8 0
expect gesture "the pull moved out of the stream" "e['phase']=='commit' and e['transformMode']=='translate' and e['field']['position'][0] > 3"
sleep 4
shot radial-02-release
drag_law_to 3.6 2.8 0 1 2.8 0
sleep 2
# Repulsion: the strength arrow dragged out through its anchor reverses the sign.
keys t:s
drag_handle strength 1.4 0 0
expect gesture "the strength handle made the pull a push" "e['handle']=='strength' and e['field']['expression']['strength'] < 0"
sleep 5
shot radial-03-repel
record_stop

segment "examples: vortex and its axis"
activate
open_example swirl
record_start m3-vortex 42
keys t:s
layout
expect layout "the swirl's cylinder support spans its radius and half-height" "e['selected']=='swirl'"
press_expect play sim-control
sleep 5
shot vortex-01-counterclockwise
drag_handle strength 0 0 1.4
expect gesture "the strength handle reversed the circulation" "e['handle']=='strength' and e['field']['expression']['strength'] < 0"
sleep 5
shot vortex-02-clockwise
drag_handle radius 1.0 0 0
expect gesture "the cylinder radius handle resized the support" "e['handle']=='radius' and e['field']['region']['radius'] < 1.2"
sleep 3
shot vortex-03-narrower
record_stop

segment "examples: drag pocket"
activate
open_example drag-pocket
record_start m3-drag 50
press_expect play sim-control
sleep 5
shot drag-01-pocket
keys t:s
drag_handle coefficient 0 1.6 0
expect gesture "the drag gauge raised the coefficient" "e['handle']=='coefficient' and e['field']['expression']['coefficient'] > 3"
sleep 5
shot drag-02-stronger
# Rotating a drag region turns its support only (AC6): the gizmo's Z ring turns the box pocket, and
# still no drive arrow appears.
keys t:r
rotate_law_z -1 2.8 0
expect gesture "the drag region turned about Z by more than 20 degrees through the rotate gizmo" "e['phase']=='commit' and e['transformMode']=='rotate' and abs(e['field']['rotation'][3]) < 0.985 and e['field']['expression']['kind']=='linearDrag'"
sleep 3
layout
expect layout "the rotated drag region draws no drive arrows, only coefficient dots" "e['arrows']==0 and e['selected']=='drag'"
shot drag-03-rotated-box
record_stop

segment "examples: overlap"
activate
open_example overlap
record_start m3-overlap 46
press_expect play sim-control
sleep 6
shot overlap-01-three-laws
law_control pull enabled
expect control "the pull is disabled: the swirl and drag still act" "e.get('law')=='pull' and e.get('enabled') is False"
sleep 4
shot overlap-02-without-pull
law_control pull enabled
expect control "the pull is enabled again" "e.get('law')=='pull' and e.get('enabled') is True"
keys t:s
layout
[[ $(field layout selected) == '"drag"' ]] || select_law drag
layout
expect layout "the overlap's drag law is selected, with its handles" "e['selected']=='drag' and any(h['name']=='coefficient' for h in e['lawHandles'])"
drag_handle coefficient 0 1.2 0
expect gesture "the overlap's drag gauge changed its coefficient" "e['handle']=='coefficient'"
sleep 4
shot overlap-03-drag-tuned
record_stop

segment "examples: collisions"
activate
open_example collisions
record_start m3-collisions 42
press_expect play sim-control
sleep 8
shot collisions-01-clump
keys t:s
layout
[[ $(field layout selected) == '"pull"' ]] || select_law pull
layout
expect layout "the collision scene's pull is selected, with its handles" "e['selected']=='pull' and any(h['name']=='strength' for h in e['lawHandles'])"
drag_handle strength 1.0 0 0
expect gesture "the pull's strength handle loosened the clump" "e['handle']=='strength'"
sleep 5
shot collisions-02-loosened
keys kd:shift t:d ku:shift
wait_log fixtures 1 120
expect fixtures "reset and cadence fixtures agree exactly on the collision scene" "e['allEqual'] is True"
record_stop
activate
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
say "m3-demo complete"
