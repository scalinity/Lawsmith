# M9 T11 resources and read-only responsiveness in the packaged app (MILESTONES M9 AC4, Visual QA):
#   1. Shift+Y: 20 scene-load/reset cycles through the examples menu's path and Reset, with equal-tick
#      authority under quiet and busy visualization on each example's root.
#   2. P1 Workshop recorded with real law drags until the 60 s limit (field manipulation in P1).
#   3. Its replay is read-only: the inspector inert, the handle modes off, no gizmo; a drag over the law
#      moves the camera and changes no authority. An uncached seek to the end shows its progress; the camera
#      is dragged while it runs; Cancel seek ends it, never committed, the shown replay unchanged.
#   4. Shift+U: 20 cycles of replay → seek → Compare from here → Close → Return, the first uncached, every
#      target exact against the oracle, resources back to the state before after every cycle.
#   QA_STATE=… QA_OUT=… QA_DEADLINE=… scripts/verify/verify.sh native m9-resources
# lib.zsh owns the GUI lock (or adopts a lent one), the hit tests and the outside-input abort; m8lib.zsh the
# deadline and the display and preference restore on exit. Screen recording stays off.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p1-workshop.lawsmith.json $QA_STATE/scenes/
m9q() { python3 -I $NATIVE/m9perf.py "$@" | tee -a $QA_OUT/m9-resources-checks.jsonl; (( ${pipestatus[1]} == 0 )) || fail "M9 check failed: $1" }

# seek_click TICK and progress_shown, as m6b-long.zsh: a hit-tested click on the replay timeline, then
# layout readbacks until the pending seek shows its progress and Cancel seek.
seek_click() {
  layout
  local p=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $1)}) n=$(count seek) i
  click $p[1] $p[2]
  for i in {1..10}; do (( $(count seek) > n )) && return 0; sleep 0.1; done
  say "the synthetic click on the timeline was lost (no seek event); sending it again"
  click $p[1] $p[2]
  wait_log seek $(( n + 1 )) 3
}
progress_shown() {
  local i
  for i in {1..20}; do
    layout
    [[ $(logq last $APP_LOG layout | python3 -I -c "import json,sys; r=json.load(sys.stdin)['run']; print(bool(r['seeking'] and r['seeking']['shown'] and r['buttons']['cancel']))") == True ]] && return 0
    [[ $(logq all $APP_LOG seek | python3 -I -c "import json,sys; print(any(json.loads(l)['action']=='committed' for l in sys.stdin))") == True ]] && fail "the seek committed before its progress could be shown: it was not a long reconstruction"
    sleep 0.3
  done
  fail "no progress or Cancel seek was shown"
}
# camera: the camera position from the last layout readback.
camera() { field layout camera }

seed_folder $QA_STATE/scenes
segment "M9 resources: display mode and launch"
display_set 1728 1117 60
launch m9-resources $QA_STATE/recovery-m9-resources-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
activate
window_size 1600 1000
set_scale 100
layout
expect layout "1600×1000 CSS, DPR capped at 1.5, Interface Scale 100%, HUD shown" "e['viewport']==[1600,1000] and e['pixelRatio']==1.5 and e['interfaceScale']==1 and e['hudHidden'] is False"

segment "M9 Shift+Y: 20 scene-load/reset cycles and authority under visualization"
deadline_gate 240
keys kd:shift t:y ku:shift
wait_log m9-load-cycles 1 240
expect m9-load-cycles "20 load/reset cycles steady, one world, authority equal under visualization" "e.get('pass') is True"

segment "M9 P1 recorded with law drags until the 60 s limit"
deadline_gate 150
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel p1-workshop.lawsmith.json
sleep 0.5
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_log document $(( n + 1 )) 15
layout
expect layout "P1 open with drag-0 selected at 1600×1000" "e['viewport']==[1600,1000] and e['selected']=='drag-0'"
n=$(count recording)
press_expect run-record recording
wait_log recording $(( n + 1 )) 10
press_expect play sim-control
flip=0
until_tick=$(( EPOCHSECONDS + 120 ))
until [[ $(logq all $APP_LOG recording | python3 -I -c "import json,sys; print(any(json.loads(l).get('stopped')=='duration' for l in sys.stdin))") == True ]]; do
  (( EPOCHSECONDS > until_tick )) && fail "the recording did not close at its 60 s limit"
  if (( flip )); then drag_law_to -2.6 -0.5 -3 -3 -0.5 -3; else drag_law_to -3 -0.5 -3 -2.6 -0.5 -3; fi
  flip=$(( 1 - flip ))
  sleep 1.5
done
expect recording "the P1 recording closed at exactly 60 s with the drags recorded" "e['action']=='stopped' and e['stopped']=='duration' and e['finalTick']==7200 and e['commands'] > 50"
final_tick=$(field recording finalTick)

segment "M9 read-only replay: no field editing, the camera responds, an uncached seek canceled"
deadline_gate 120
n=$(count context)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
layout
expect layout "replay is read-only: inspector and shelf inert, handle modes off, no live gizmo" "e['readOnly'] is True and e['editing']['inspectorInert'] is True and e['editing']['shelfInert'] is True and e['editing']['modesDisabled'] is True and not (e['editing']['gizmoAttached'] and e['editing']['gizmoEnabled'])"
authority_before=$(field layout authority)
camera_before=$(camera)
address_before=$(logq last $APP_LOG layout | python3 -I -c "import json,sys; print(json.dumps(json.load(sys.stdin)['run']['replay']['address']))")
# A drag that starts over the selected law's support: in authoring it would grab the law; here it orbits.
sp=(${=$(logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin); s = e['support']
print(round($WIN_X + (s[0] + s[2]) / 2), round($WIN_Y + (s[1] + s[3]) / 2))")})
drag $sp[1] $sp[2] $(( sp[1] + 140 )) $(( sp[2] + 30 ))
layout
[[ $(field layout authority) == $authority_before ]] || fail "a drag in read-only replay changed the authority"
[[ $(camera) != $camera_before ]] || fail "the camera did not respond to a drag in replay"
expect layout "the drag orbited the camera; the replay address and its laws are unchanged" "json.dumps(e['run']['replay']['address'])=='$address_before' and e['readOnly'] is True"
seek_click $final_tick
progress_shown
pending_camera=$(camera)
pc=(${=$(point controls.run-cancel)})
# The camera while the reconstruction runs: one drag in empty sky above the scene, then Cancel seek.
drag $(( WIN_X + 800 )) $(( WIN_Y + 260 )) $(( WIN_X + 900 )) $(( WIN_Y + 280 ))
click_expect $pc[1] $pc[2] seek
m9q seek-cancel $APP_LOG
layout
[[ $(camera) != $pending_camera ]] || fail "the camera did not respond while the seek was pending"
expect layout "after Cancel seek: the same replay address, paused, no seek world" "json.dumps(e['run']['replay']['address'])=='$address_before' and e['run']['seeking'] is None and e['run']['contexts']['seeking']==0 and e['playing'] is False"
n=$(count context)
press_expect run-return context
wait_log context $(( n + 1 )) 10

segment "M9 Shift+U: 20 seek → fork → close → return cycles"
deadline_gate 300
activate
keys kd:shift t:u ku:shift
wait_log m9-seek-cycles 1 300
expect m9-seek-cycles "20 seek/fork cycles exact and steady, the first uncached" "e.get('pass') is True"
m9q cycles $APP_LOG $QA_OUT/m9-cycles.json
m9q startup $APP_LOG

activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
sleep 1
[[ $(depth) == 1 ]] && alert_for recording "Don't Save"
wait_exit
say "m9-resources complete"
