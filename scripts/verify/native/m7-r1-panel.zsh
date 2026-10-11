# Targeted R1 checks. Shift+L only reads DOM/host state; it never refreshes the panel.
# Requires an approved hands-off window. Shared lock, input gates and hit tests are from lib.zsh.
source ${0:A:h}/lib.zsh
set -e
mkdir -p $QA_STATE/scenes
cp $REPO/examples/two-futures.lawsmith.json $QA_STATE/scenes/
ORIGINAL_MODE=$(osascript -l JavaScript $NATIVE/display.js get)
HAD_PREFS=false
defaults export local.lawsmith $QA_STATE/preferences-before.plist >/dev/null 2>&1 && HAD_PREFS=true
cleanup() {
  running && kill $APP_PID 2>/dev/null
  sleep 0.5
  local dimensions=${ORIGINAL_MODE%@*} hz=${ORIGINAL_MODE#*@}
  osascript -l JavaScript $NATIVE/display.js set ${=${dimensions/x/ }} $hz >/dev/null
  defaults delete local.lawsmith >/dev/null 2>&1 || true
  if $HAD_PREFS; then defaults import local.lawsmith $QA_STATE/preferences-before.plist >/dev/null; fi
  defaults export local.lawsmith $QA_STATE/preferences-after.plist >/dev/null 2>&1 || true
  gui_unlock
}
trap cleanup EXIT
# This bounded run aborts a focus change rather than reactivating over an unrelated app.
guard_front() { [[ $(front_pid) == $APP_PID ]] || fail "unrelated frontmost app; input aborted" 3; }
window_size() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set position of window \"Lawsmith\" to {40, 45}
    set size of window \"Lawsmith\" to {1280, 800}
  end tell" >/dev/null
  sleep 1; window_origin
}
open_fixture() {
  press_panel file-open; open_panel two-futures.lawsmith.json
  [[ $(depth) == 1 ]] && alert_for scene "Don't Save"
  layout; expect layout "fresh fixture at zero" "e['authority']['tick']==0 and e['selected']=='sideways'"
}
baseline() {
  layout; SOURCE_AUTHORITY=$(field layout authority)
  local n=$(count comparison)
  press_expect compare-from comparison; press_expect baseline-compute comparison
  wait_log comparison $(( n + 3 )) 15
  layout; expect layout "real baseline through 600" "e['comparison']['horizon']==600 and e['comparison']['tick']==0"
  BASELINE_HASH=$(field layout comparison.receipt.baselineHash)
}
steps_to() {
  layout
  local current=$(field layout authority.tick) n=$(( $1 - current ))
  (( n >= 0 )) || fail "step target is behind displayed world"
  if (( n )); then
    local dots=$(python3 -I -c "print('.' * $n)")
    keys t:$dots
  fi
  layout; expect layout "exact paused boundary $1" "e['authority']['tick']==$1 and e['playing'] is False"
}
reveal() {
  local i p panel
  for i in {1..25}; do
    layout; p=(${=$(point $1)})
    panel=(${=$(field layout controls.panel | tr -d '[],')})
    if (( p[2] > WIN_Y + panel[2] + 8 && p[2] < WIN_Y + panel[2] + panel[4] - 8 )); then click $p[1] $p[2]; return; fi
    if (( p[2] < WIN_Y + panel[2] + 8 )); then scroll_at $(( WIN_X + 25 )) $(( WIN_Y + 350 )) 120; else scroll_at $(( WIN_X + 25 )) $(( WIN_Y + 350 )) -120; fi
  done
  fail "control $1 not visible"
}
law() {
  layout
  local index=$(python3 -I -c "import json,sys; e=json.loads(sys.argv[1]); print(next(i for i,r in enumerate(e['laws']) if r['id']=='$1'))" "$(logq last $APP_LOG layout)")
  reveal laws.$index.$2
}
edit_value() { reveal $1; keys kd:cmd t:a ku:cmd t:$2 kp:return; key_code 53; }
replay_paused() {
  layout; local play=(${=$(point controls.play)})
  press_expect alternate-replay comparison
  # Pause before the first tick-120 command. Neither Play/Pause nor layoutReport calls renderPanel.
  click $play[1] $play[2]
  layout; expect layout "Replay paused before first retained command" "e['playing'] is False and e['comparison']['replaying'] is True and e['authority']['tick'] < 120"
}
finish_replay() {
  steps_to 396
  expect layout "terminal replay is exact and editable" "e['comparison']['replaying'] is False and all(not r['locked'] for r in e['laws'])"
  python3 -I $NATIVE/m7q.py replay $APP_LOG
  [[ $(field layout comparison.receipt.baselineHash) == $BASELINE_HASH ]] || fail "baseline changed"
}
close_comparison() {
  press_expect comparison-close comparison; layout
  [[ $(field layout authority) == $SOURCE_AUTHORITY ]] || fail "source world changed"
}

segment "M7 R1 targeted panel qualification"
seed_folder $QA_STATE/scenes
osascript -l JavaScript $NATIVE/display.js set 1728 1117 60 >/dev/null
launch m7-r1-panel $QA_STATE/recovery
activate; window_size; open_fixture
expect backend "packaged WebGPU" "e['backend']=='WebGPU' and e['mode']=='packaged'"
baseline
steps_to 120
press_expect add-directional control
layout; expect layout "created Push selected" "e['selected']=='push' and any(r['label']=='Push' for r in e['laws'])"
steps_to 240; edit_value inputs.law-fade 0.2
steps_to 396
law push select # Clear selection before Replay; no later selection is used to rebuild the list.
layout; expect layout "selection cleared" "e['selected'] is None"
replay_paused; steps_to 121
expect layout "intermediate Push host and actual DOM agree" "e['comparison']['replaying'] is True and e['authority']['tick']==121 and e['selected'] is None and {r['id'] for r in e['laws']}=={f['id'] for f in e['appliedLaws']} and any(r['id']=='push' and r['label']=='Push' and r['enabledState']=='true' and r['enabledText']=='On' and r['locked'] for r in e['laws'])"
shot r1-created-intermediate
finish_replay; shot r1-created-endpoint
press_expect undo history; layout
expect layout "retained local undo works" "e['selectedField'] is None and next(f for f in e['appliedLaws'] if f['id']=='push')['edgeFade']==0"
press_expect redo history
press_expect alternate-new comparison; layout
expect layout "New clears Push and history" "e['comparison']['suffix']==0 and e['authority']['tick']==0 and all(r['id']!='push' for r in e['laws'])"
close_comparison

segment "R1 selected law details and ordinary replay"
open_fixture; baseline
edit_value controls.law-label 'Custom current law'
layout; local color=(${=$(point swatches.#c58ae5)}); click $color[1] $color[2]
law sideways visible
steps_to 120; law sideways enabled
steps_to 200; edit_value inputs.Strength 3
steps_to 280; edit_value inputs.law-fade 0.4
steps_to 396
replay_paused
for target in 121 201 281; do
  steps_to $target
  local strength=0 fade=0
  (( target >= 201 )) && strength=3
  (( target >= 281 )) && fade=0.4
  expect layout "actual selected-law controls at $target" "e['comparison']['replaying'] is True and e['selected']=='sideways' and e['selectedField']['enabled'] is False and e['selectedField']['expression']['strength']==$strength and e['selectedField']['edgeFade']==$fade and e['inputValues']['Strength']=='$strength' and e['inputValues']['law-fade']=='$fade' and e['detailTitle']=='Custom current law' and len(e['laws'])==1 and e['laws'][0]['enabledText']=='Off' and e['laws'][0]['enabledState']=='false' and e['laws'][0]['locked'] and e['laws'][0]['visibleState']=='false' and e['laws'][0]['color']=='#c58ae5'"
  shot r1-details-$target
done
finish_replay; shot r1-details-endpoint
press_expect undo history; layout
expect layout "selected local undo retained" "e['inputValues']['law-fade']=='0' and e['selectedField']['edgeFade']==0"
press_expect redo history; layout
expect layout "selected local redo retained" "e['inputValues']['law-fade']=='0.4' and e['selectedField']['edgeFade']==0.4"
close_comparison
open_fixture
press_expect run-record recording
steps_to 120; press_expect add-directional control
steps_to 396; press_expect run-stop recording
press_expect run-replay context
steps_to 121
expect layout "ordinary replay intermediate panel" "e['run']['contexts']['selected']=='replay' and any(r['label']=='Push' and r['enabledState']=='true' and r['locked'] for r in e['laws'])"
shot r1-ordinary-replay
press_expect run-return context
layout; expect layout "retained main authoring restored" "e['authority']['tick']==396 and e['run']['contexts']['selected']=='authoring'"
say "m7-r1-panel complete"
