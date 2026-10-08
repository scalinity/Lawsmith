# M5 visual QA in the packaged app (MILESTONES M5 Visual QA; AC1–AC7): construct a compound law from
# primitives; open the Storm Bottle, move it into the stream, turn it and resize its support as one law;
# read each ingredient's part of a body's step; remove the drag and undo; adjust the drag's mask with its
# handle; give the swirl a triangle gain and read it at named ticks, held through a pause; save, quit,
# relaunch, open and compare every authored value; then the runtime's own fixtures on that scene.
# Every ingredient part the readout shows is recomputed from the app's `explanation` events by m5q.py,
# with its own evaluator of SPEC §6.3 and §7. Whole-window captures and recordings are supporting evidence.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m5-compose
source ${0:A:h}/lib.zsh
# Any exit, a script error included, stops a recording in progress, so its overlay never outlives the run.
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; gui_unlock' EXIT
RECOVERY=$QA_STATE/recovery-compose5-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/storm-bottle.lawsmith.json $QA_STATE/scenes/
rm -f $QA_STATE/scenes/storm-qa.lawsmith.json

m5q() { python3 -I $NATIVE/m5q.py $APP_LOG "$@" }
explanation() { local n=$(count explanation); keys kd:shift t:e ku:shift; wait_log explanation $(( n + 1 )) }
# check NAME DESCRIPTION ARGS…: a fresh explanation event (unless NAME is held), checked by m5q.py.
check() {
  local name=$1 description=$2; shift 2
  [[ $name == held ]] && layout || explanation
  local verdict=$(m5q $name "$@")
  say "$verdict  [m5q $name] $description"
  [[ $verdict == PASS* ]] || fail "expectation failed: $description"
}
pause() { [[ $(field sim-control action) == '"play"' ]] && press play; sleep 0.3 }
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
# box EXPR: the screen point at the center of a box the last layout reports, chosen by a Python
# expression over the layout event `e`; empty when it does not exist.
box() {
  logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
try:
    b = $1
except (StopIteration, KeyError, IndexError, TypeError):
    b = None
if b: print(round($WIN_X + b[0] + b[2] / 2), round($WIN_Y + b[1] + b[3] / 2), round(b[1]), round(b[3]))"
}
# reveal EXPR: scrolls the Scene panel with real wheel steps over it until that box lies inside its
# visible area, then clicks its center. Only the panel scrolls; the pointer stays over the panel.
reveal() {
  local i p panel
  for i in {1..30}; do
    layout
    p=(${=$(box "$1")})
    [[ -n $p[1] ]] || fail "the layout has no box for $1"
    panel=(${=$(logq field $APP_LOG layout controls.panel | tr -d '[],')})
    if (( p[3] >= panel[2] + 4 && p[3] + p[4] <= panel[2] + panel[4] - 4 )); then
      click $p[1] $p[2]
      return 0
    fi
    # Over the panel's left edge, clear of its controls' text, never over the canvas.
    local sx=$(( WIN_X + ${panel[1]%.*} + 8 )) sy=$(( WIN_Y + ${panel[2]%.*} + ${panel[4]%.*} / 2 ))
    if (( p[3] < panel[2] + 4 )); then scroll_at $sx $sy 120; else scroll_at $sx $sy -120; fi
  done
  fail "could not bring $1 into the panel's view"
}
row() { print -r -- "next(r['$2'] for r in e['ingredients']['rows'] if r['label']=='$1')" }
button() { print -r -- "next(b['box'] for b in e['ingredients']['buttons'] if b['action']=='$1'${2:+ and b['value']=='$2'})" }
lawhandle() { logq lawhandle $APP_LOG $WIN_X $WIN_Y $1 }
# drag_handle NAME DX DY DZ: drags the selected law's handle toward a world offset, at least 90 px (m3-demo).
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
selected_expression() { logq field $APP_LOG layout selectedField.expression }
same_json() { python3 -I -c "import json,sys; print('PASS' if json.loads(sys.argv[1]) == json.loads(sys.argv[2]) else 'FAIL')" "$1" "$2" }
steps() { keys t:${(l:$1::.:)} }

seed_folder $QA_STATE/scenes
segment "construct a compound law from primitives"
launch compose5 $RECOVERY
activate
record_start m5-construct 60
press add-softRadial
expect control "the shelf made a Pull law at the view's focus point" "e.get('create')=='softRadial' and e['id']=='pull'"
reveal "$(print -r -- "e['ingredients']['shelf']['vortexY']")"
expect control "Swirl joined the Pull: one law, a sum of two" "e.get('ingredient')=='Add swirl' and e['field']['expression']['kind']=='sum' and [t['kind'] for t in e['field']['expression']['terms']]==['softRadial','vortexY']"
reveal "$(print -r -- "e['ingredients']['shelf']['linearDrag']")"
expect control "Drag joined as the third ingredient, after the others" "e.get('ingredient')=='Add drag' and [t['kind'] for t in e['field']['expression']['terms']]==['softRadial','vortexY','linearDrag'] and e['field']['id']=='pull'"
layout
expect layout "the law list still holds two laws, and the new one reads pull + swirl + drag" "len(e['laws'])==2 and [r['label'] for r in e['ingredients']['rows']]==['Pull','Swirl','Drag']"
shot construct-01-ingredients
press play
sleep 2.5
pause
keys t:f
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
steps 3
check ingredients "a body inside it: Pull, Swirl and Drag parts, recomputed here, add up to the law's share" Pull,Swirl,Drag
shot construct-02-parts
record_stop

segment "the Storm Bottle moves, turns and resizes as one law"
activate
open_example storm-bottle
layout
expect layout "the Storm Bottle opens with its one law selected, three ingredients" "e['selected']=='storm-bottle' and [r['label'] for r in e['ingredients']['rows']]==['Pull','Swirl','Drag']"
original=$(selected_expression)
record_start m5-storm 100
press play
sleep 1.5
drag_law_to 3.2 1.6 0 0 1.6 0
expect gesture "one drag moved the whole bottle into the stream" "e['phase']=='commit' and e['transformMode']=='translate' and abs(e['field']['position'][0]) < 0.5 and e['field']['expression']==$original"
sleep 7
check held "in the stream the bottle holds a storm" 25 64
shot storm-01-held
keys t:r
layout
center=$(logq field $APP_LOG layout selectedField.pose.position | tr -d '[] ')
rotate_from=(${=$(handle Z 0)})
camera=$(logq field $APP_LOG layout camera | tr -d '[] ')
direction=(${=$(python3 -I -c "
c = [$camera]; p = [$center]
e = [c[i] - p[i] for i in range(3)]; n = sum(v * v for v in e) ** 0.5; e = [v / n for v in e]
d = [-e[1], e[0], 0]; m = (d[0] ** 2 + d[1] ** 2) ** 0.5
print(*(round(p[i] + 0.5 * d[i] / m, 6) for i in range(3)))")})
p0=(${=$(world ${=${center//,/ }})}); p1=(${=$(world $direction)})
rotate_to=(${=$(python3 -I -c "
dx, dy = $p1[1] - $p0[1], $p1[2] - $p0[2]; n = (dx * dx + dy * dy) ** 0.5
print(round($rotate_from[1] + 42 * dx / n), round($rotate_from[2] + 42 * dy / n))")})
drag $rotate_from[1] $rotate_from[2] $rotate_to[1] $rotate_to[2]
expect gesture "one rotate gesture tilted the bottle; its ingredients turned with it, unchanged" "e['phase']=='commit' and e['transformMode']=='rotate' and abs(e['field']['rotation'][3]) < 0.995 and e['field']['expression']==$original"
keys t:s
before=$(selected_expression)
drag_handle radius -0.8 0 0
expect gesture "the support's radius handle widened the outer support only: no strength, core or mask changed" "e['phase']=='commit' and e['handle']=='radius' and e['field']['region']['radius'] > 1.6 and e['field']['expression']==$before"
keys t:t
sleep 2
shot storm-02-moved-turned-resized
pause
keys t:f
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
steps 2
check ingredients "a body in the bottle: each ingredient's part, recomputed independently, adds to the bottle's share" Pull,Swirl,Drag
shot storm-03-parts
record_stop

segment "remove the drag, see the difference, undo"
activate
record_start m5-remove 70
keep=$(selected_expression)
reveal "$(row Drag remove)"
expect control "Drag came out of the bottle: one law put, two ingredients left" "e.get('ingredient')=='Remove ingredient' and [t['kind'] for t in e['field']['expression']['terms']]==['softRadial','vortexY']"
press play
sleep 5
check held "without its drag the bottle lets the stream fall through" 0 18
shot remove-01-without-drag
n=$(count history)
keys kd:cmd t:z ku:cmd
wait_log history $(( n + 1 ))
expect history "Undo put the drag back" "e['action']=='undo' and e['ok'] is True and e['label']=='Remove ingredient'"
layout
[[ $(same_json "$(selected_expression)" "$keep") == PASS ]] || fail "undo did not restore the exact expression"
say "PASS  [layout] undo restored the bottle's expression exactly, mask included"
sleep 7
check held "with the drag back the bottle holds a storm again" 25 64
shot remove-02-undone
record_stop

segment "adjust the drag's mask with its handle"
activate
record_start m5-mask 45
pause
reveal "$(row Drag select)"
expect ingredient-focus "Drag is the ingredient being edited" "e['law']=='storm-bottle' and e['focus']==[2]"
keys t:s
layout
expect layout "Adjust shows the bottle's own handles and the drag mask's" "any(h['name']=='expression.terms[2].region.halfExtents.1' for h in e['lawHandles']) and any(h['name']=='radius' for h in e['lawHandles'])"
drag_handle 'expression.terms[2].region.halfExtents.1' 0 -0.6 0
expect gesture "one drag of the mask's handle lowered its top: only that mask changed" "e['phase']=='commit' and e['handle']=='expression.terms[2].region.halfExtents.1' and e['field']['expression']['terms'][2]['region']['halfExtents'][1] < 1.25 and e['field']['expression']['terms'][0]==(${original})['terms'][0] and e['field']['expression']['terms'][1]==(${original})['terms'][1]"
keys t:t
press play
sleep 3
pause
keys t:b
steps 2
check ingredients "the drag's part now carries the smaller mask's weight, recomputed here" Pull,Swirl,Drag
shot mask-01-adjusted
record_stop

segment "give the swirl a triangle gain and read it at named ticks"
activate
record_start m5-triangle 90
pause
reveal "$(row Swirl select)"
reveal "$(button add-gain)"
expect control "Swirl has a gain of 1, which changes nothing yet" "e.get('ingredient')=='Add gain' and e['field']['expression']['terms'][1]['kind']=='gain' and e['field']['expression']['terms'][1]['gain']=={'kind':'constant','value':1}"
reveal "$(button gain-kind triangle)"
expect control "the swirl's gain is a triangle: 0 → 2 → 0 over 240 ticks from phase 0" "e.get('ingredient')=='Change gain' and e['field']['expression']['terms'][1]['gain']=={'kind':'triangle','min':0,'max':2,'periodTicks':240,'phaseTicks':0}"
n=$(count sim-control)
keys kd:shift t:r ku:shift
wait_log sim-control $(( n + 1 ))
expect sim-control "Reset rebuilt the bottle's scene at tick 0, paused" "e['action']=='reset' and e['tick']==0"
steps 1
keys t:b
steps 119
check triangle "the step from tick 119: g = 2·(1 − |2·119/240 − 1|), from the tick alone" Swirl any
steps 1
check triangle "the step from tick 120, the peak: g = 2" Swirl 2
shot triangle-01-peak
explanation
sleep 2
check same-retained "paused at tick 121 for 2 s: the same step and the same preview"
steps 120
check triangle "the step from tick 240, a trough: g = 0, the swirl's part is zero" Swirl 0
shot triangle-02-trough
press play
sleep 4
pause
keys t:b
steps 1
check ingredients "with the triangle running every part still adds to the law's share" Pull,Swirl,Drag
check triangle "and the swirl's gain is the formula's at that step's tick" Swirl any
record_stop

segment "save, quit, relaunch, open: every authored value survives"
activate
saved=$(selected_expression)
n=$(count document)
d=$(count digest)
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes storm-qa.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "Save As wrote storm-qa and bound it" "e['action']=='save-as' and e['outcome']=='saved'"
wait_log digest $(( d + 1 )) 10
expect digest "the saved scene's semantic digest is recorded" "e['reason']=='saveAs'"
saved_digest=$(field digest semanticSha256)
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
launch compose5b $RECOVERY
activate
wait_log digest 1 10
sleep 0.5
d=$(count digest)
open_example storm-qa
expect sim-control "it opened paused at tick 0" "e['action']=='load' and e['tick']==0 and e['playing'] is False"
layout
[[ $(same_json "$(selected_expression)" "$saved") == PASS ]] || fail "the reopened bottle's expression differs from the saved one"
say "PASS  [layout] the reopened bottle has the saved expression exactly: ingredients, mask, triangle"
wait_log digest $(( d + 1 )) 10
expect digest "the reopened scene's semantic digest is the saved one" "e['reason']=='load' and e['semanticSha256']==$saved_digest"
shot reopen-01

segment "the runtime's own fixtures on the reopened compound scene"
activate
keys kd:shift t:d ku:shift
wait_log fixtures 1 300
expect fixtures "reset, cadence, invariance and observed reset agree exactly; every step's parts reconcile" "e['allEqual'] is True and e['t08'] is True and e['contributions']['pass'] is True and e['contributions']['ingredientChecks'] > 0 and e['contributions']['unreconciled']==0"
press play
sleep 11.5
pause
wait_log run-digest 2 10
say "run digests at ticks 600 and 1200: $(logq all $APP_LOG run-digest | python3 -I -c "import json,sys; print(*[(e['tick'], e['stateSha256'], e['engineSha256']) for e in map(json.loads, sys.stdin)][-2:])")"
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
say "m5-compose complete"
