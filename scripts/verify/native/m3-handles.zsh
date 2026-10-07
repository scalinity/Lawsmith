# M3 spatial handles in the packaged app (T05, T06; AC5, AC7): laws created from the tool shelf;
# strength, fade, core radius, sphere radius, cylinder radius and half-height, a box face, the
# directional arrow tip and the drag gauge dragged by their viewport handles, each drag one undo
# entry that undo and redo restore exactly; a drag cancelled with Escape restores its start; the
# edited laws survive Save As → quit → relaunch → Open bit for bit, undo works after load, and the
# in-app reset and cadence fixtures agree exactly on the reopened multi-law scene.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m3-handles
#
# Synthetic drags reach WebKit only in part (M0 finding 1: the stale-buttons reconciliation commits
# the value reached), so drags overshoot and assertions check the direction of each change and that
# every other parameter is untouched; undo and redo are compared with the committed value exactly.
source ${0:A:h}/lib.zsh
SCENE=m3-handles.lawsmith.json
RECOVERY=$QA_STATE/recovery-handles-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes

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
# A law's summary in the last history event, as a Python expression.
law() { print -r -- "[l for l in e['laws'] if l['id']=='$1'][0]" }
undo() { keys kd:cmd t:z ku:cmd }
redo() { keys kd:cmd,shift t:z ku:cmd,shift }
# undo_redo LAW LABEL BEFORE-EXPR AFTER-EXPR: one undo restores BEFORE under LABEL; redo restores AFTER.
undo_redo() {
  undo
  expect history "one undo of '$2' restores $1's start" "e['action']=='undo' and e['label']=='$2' and $3"
  redo
  expect history "redo of '$2' restores $1's dragged value exactly" "e['action']=='redo' and e['label']=='$2' and $4"
}
select_law() {
  layout
  [[ $(field layout selected) == "\"$1\"" ]] && return 0
  local i=$(logq field $APP_LOG layout laws | python3 -I -c "import json,sys; print([l['id'] for l in json.load(sys.stdin)].index('$1'))")
  local p=(${=$(point laws.$i.select)}); click $p[1] $p[2]
  expect selection "$1 is selected" "e['field']=='$1'"
}

seed_folder $QA_STATE/scenes
segment "handles: soft radial in a sphere"
launch handles-a $RECOVERY
activate
press add-softRadial
expect control "Pull is created at the view's focus point" "e.get('create')=='softRadial' and e['id']=='pull'"
keys t:s
expect control "handle mode" "e.get('transformMode')=='scale'"
layout
expect layout "the selected Pull shows its extent, fade, strength and core handles" "sorted(h['name'] for h in e['lawHandles'])==['coreRadius', 'edgeFade', 'radius', 'strength']"
shot handles-01-pull

# Strength: the inward arrow tip, dragged out through its anchor, turns the pull into a push.
drag_handle strength 1.4 0 0
expect gesture "the strength handle reversed the pull (signed strength)" "e['phase']=='commit' and e['handle']=='strength' and e['field']['expression']['strength'] < 0 and e['field']['region']=={'kind': 'sphere', 'radius': 2}"
v=$(logq field $APP_LOG gesture field.expression.strength)
undo_redo pull "Change strength" "$(law pull)['expression']['strength']==8" "$(law pull)['expression']['strength']==$v"
shot handles-02-pull-reversed

# Core radius: separate from the support radius.
drag_handle coreRadius 0 0 0.75
expect gesture "the core handle changed only ε" "e['handle']=='coreRadius' and e['field']['expression']['coreRadius'] > 0.3 and e['field']['expression']['strength']==$(logq field $APP_LOG history laws | python3 -I -c "import json,sys; print([l for l in json.load(sys.stdin) if l['id']=='pull'][0]['expression']['strength'])") and e['field']['region']['radius']==2"
v=$(logq field $APP_LOG gesture field.expression.coreRadius)
undo_redo pull "Change core radius" "$(law pull)['expression']['coreRadius']==0.25" "$(law pull)['expression']['coreRadius']==$v"

# Fade: the inner surface moves; the outer sphere does not.
drag_handle edgeFade -0.566 -0.566 -0.566
expect gesture "the fade handle changed only f" "e['handle']=='edgeFade' and e['field']['edgeFade'] > 0.3 and e['field']['region']['radius']==2"
v=$(logq field $APP_LOG gesture field.edgeFade)
undo_redo pull "Change fade" "$(law pull)['edgeFade']==0.25" "$(law pull)['edgeFade']==$v"
shot handles-03-pull-fade

# Sphere radius: one radius, so it stays a sphere; strength and core are untouched.
drag_handle radius 0 1.2 0
expect gesture "the sphere radius handle changed only the radius" "e['handle']=='radius' and e['field']['region']['radius'] > 2.1 and set(e['field']['region'])=={'kind', 'radius'} and e['field']['expression']['coreRadius']==$(logq field $APP_LOG history laws | python3 -I -c "import json,sys; print([l for l in json.load(sys.stdin) if l['id']=='pull'][0]['expression']['coreRadius'])")"
v=$(logq field $APP_LOG gesture field.region.radius)
undo_redo pull "Resize law" "$(law pull)['region']['radius']==2" "$(law pull)['region']['radius']==$v"

segment "handles: vortex in a Y-cylinder"
activate
press add-vortexY
expect control "Swirl is created" "e.get('create')=='vortexY' and e['id']=='swirl'"
layout
shot handles-04-swirl
drag_handle radius -1.2 0 0
expect gesture "the cylinder radius handle changed one radius (no ellipse)" "e['handle']=='radius' and e['field']['region']['radius'] > 2.1 and e['field']['region']['halfHeight']==2"
v=$(logq field $APP_LOG gesture field.region.radius)
undo_redo swirl "Resize law" "$(law swirl)['region']['radius']==2" "$(law swirl)['region']['radius']==$v"
drag_handle halfHeight 0 1.2 0
expect gesture "the half-height handle changed only the half-height" "e['handle']=='halfHeight' and e['field']['region']['halfHeight'] > 2.1 and e['field']['region']['radius']==$v"
h=$(logq field $APP_LOG gesture field.region.halfHeight)
undo_redo swirl "Resize law" "$(law swirl)['region']['halfHeight']==2" "$(law swirl)['region']['halfHeight']==$h"
drag_handle strength 0 0 1.4
expect gesture "dragging the swirl arrow across its anchor reversed the circulation" "e['handle']=='strength' and e['field']['expression']['strength'] < 0"
v=$(logq field $APP_LOG gesture field.expression.strength)
undo_redo swirl "Change strength" "$(law swirl)['expression']['strength']==8" "$(law swirl)['expression']['strength']==$v"
drag_handle coreRadius 0 0 0.65
expect gesture "the vortex core handle changed only ε" "e['handle']=='coreRadius' and e['field']['expression']['coreRadius'] > 0.3"
shot handles-05-swirl-edited

segment "handles: directional box and drag gauge"
activate
select_law sideways
drag_handle strength 0.8 0 0
expect gesture "the directional arrow tip set the strength" "e['handle']=='strength' and e['field']['expression']['strength'] > 13 and e['field']['expression']['direction']==[1, 0, 0]"
drag_handle halfExtents.0 -1 0 0
expect gesture "a box face handle changed one half-extent" "e['handle']=='halfExtents.0' and e['field']['region']['halfExtents'][0] > 1.6 and e['field']['region']['halfExtents'][1:]==[2, 1.5]"
press add-linearDrag
expect control "Drag is created" "e.get('create')=='linearDrag' and e['id']=='drag'"
drag_handle coefficient 0 1.2 0
expect gesture "the drag gauge set the coefficient" "e['handle']=='coefficient' and e['field']['expression']['coefficient'] > 2.5"
shot handles-06-drag

# A drag cancelled with Escape restores its start and records nothing.
layout
from=(${=$(lawhandle edgeFade)}); to=(${=$(world ${=$(logq lawhandleworld $APP_LOG edgeFade -0.35 -0.35 -0.35)})})
idle_gate; guard_point $from[1] $from[2]; guard_point $to[1] $to[2]
cliclick -e 5 dd:$from[1],$from[2] w:120 dm:$(( (from[1] + to[1]) / 2 )),$(( (from[2] + to[2]) / 2 )) w:60 dm:$to[1],$to[2] w:150; touched
key_code 53
cliclick du:$to[1],$to[2]; touched; sleep 0.5
expect gesture "Escape cancelled the fade drag and restored its start" "e['phase']=='cancel' and e['handle']=='edgeFade' and e['field']['edgeFade']==0.25"
undo
expect history "the cancelled drag left no undo entry: undo reaches the coefficient drag" "e['action']=='undo' and e['label']=='Change drag'"
redo

segment "handles: save, relaunch, open"
activate
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes $SCENE
wait_log document 1 15
expect document "Save As wrote the edited multi-law scene" "e['action']=='save-as' and e['outcome']=='saved' and e['file']=='$SCENE'"
saved=$(logq last $APP_LOG history)
activate
keys kd:cmd t:q ku:cmd
wait_exit

launch handles-b $RECOVERY
activate
keys kd:cmd t:o ku:cmd
open_panel $SCENE
wait_log document 1 15
expect document "the saved scene opened transactionally" "e['action']=='open' and e['outcome']=='committed' and e['file']=='$SCENE'"
python3 -I - $QA_STATE/scenes/$SCENE <<PY | tee -a $QA_OUT/qa-steps.log
import json, sys
saved = json.loads('''$saved''')
fields = {f['id']: f for f in json.load(open(sys.argv[1]))['semantic']['fields']}
ok = True
for law in saved['laws']:
    f = fields[law['id']]
    same = f['region'] == law['region'] and f['expression'] == law['expression'] and f['edgeFade'] == law['edgeFade'] and f['pose']['position'] == law['position']
    print('PASS' if same else 'FAIL', f"saved file holds {law['id']} exactly as last applied")
    ok = ok and same
sys.exit(0 if ok else 1)
PY
(( pipestatus[1] == 0 )) || fail "the saved file differs from the applied laws"
expect sim-control "the reopened scene holds the four edited laws plus the recipe law at tick 0" "e['action']=='load' and e['tick']==0 and [l['id'] for l in e['laws']]==['drag', 'pull', 'sideways', 'swirl']"
select_law swirl
keys t:s
drag_handle halfHeight 0 1 0
undo
expect history "undo works after load: the reopened half-height returns" "e['action']=='undo' and $(law swirl)['region']['halfHeight']==$h"
layout
shot handles-07-reopened
keys kd:shift t:d ku:shift
wait_log fixtures 1 120
expect fixtures "reset and 30/60/144 Hz fixtures agree exactly on the reopened multi-law scene" "e['allEqual'] is True"
activate
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
say "m3-handles complete"
