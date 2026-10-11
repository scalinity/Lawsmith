# Supplemental current-package UI checks; no application edits or private owner scenes.
source <checkout>/scripts/verify/native/lib.zsh
RECORDER=
mkdir -p $QA_STATE/scenes
cp $REPO/examples/two-futures.lawsmith.json $QA_STATE/scenes/
cp ${0:A:h}/controlled-comparison-fault.lawsmith.json $QA_STATE/scenes/
trap 'running && kill $APP_PID; gui_unlock' EXIT
reveal() {
  local i p panel
  for i in {1..25}; do
    layout; p=(${=$(point $1)}); panel=(${=$(field layout controls.panel | tr -d '[],')})
    if (( p[2]>=WIN_Y+panel[2]+8 && p[2]<=WIN_Y+panel[2]+panel[4]-8 )); then click $p[1] $p[2]; return; fi
    if (( p[2]<WIN_Y+panel[2]+8 )); then scroll_at $(( WIN_X+25 )) $(( WIN_Y+350 )) 120; else scroll_at $(( WIN_X+25 )) $(( WIN_Y+350 )) -120; fi
  done
  fail "supplemental control $1 not visible"
}
edit_value() { reveal $1; keys kd:cmd t:a ku:cmd t:$2 kp:return; key_code 53; }
law() {
  layout
  local index=$(python3 -I -c "import json,sys; e=json.loads(sys.argv[1]); print(next(i for i,r in enumerate(e['laws']) if r['id']=='$1'))" "$(logq last $APP_LOG layout)")
  reveal laws.$index.$2
}
baseline() {
  local n=$(count comparison)
  press_expect compare-from comparison; press_expect baseline-compute comparison
  wait_log comparison $(( n+3 )) 20; layout
  expect layout "supplement real 600 tick baseline" "e['comparison']['horizon']==600"
}
presentation() {
  layout
  expect layout "custom root and post-root law presentation" "len(e['laws'])==2 and any(r['id']=='push' and r['label']=='Custom post-root law' and r['color']=='#c58ae5' and r['visibleState']=='false' for r in e['laws']) and any(r['id']=='sideways' and r['label']=='Custom root law' and r['color']=='#55aaa4' and r['visibleState']=='true' for r in e['laws'])"
}
seed_folder $QA_STATE/scenes
segment "M7 post-root presentation and controlled visible fault"
osascript -l JavaScript $NATIVE/display.js set 1728 1117 60 >/dev/null
launch m7-presentation-fault $QA_STATE/recovery
activate
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
 set position of window \"Lawsmith\" to {40,45}
 set size of window \"Lawsmith\" to {1280,800}
end tell" >/dev/null
sleep 1; window_origin
press_panel file-open; open_panel two-futures.lawsmith.json
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
press_expect run-record recording
press_expect add-directional control
edit_value controls.law-label 'Custom post-root law'
layout; local purple=(${=$(point swatches.#c58ae5)}); click $purple[1] $purple[2]
law push visible
press_expect run-stop recording
law sideways select; edit_value controls.law-label 'Custom root law'
presentation
SOURCE_AUTHORITY=$(field layout authority)
baseline; presentation; shot custom-compare
edit_value inputs.Strength 2
press_expect step sim-control
replay_events=$(count comparison)
press_expect alternate-replay comparison
wait_log comparison $(( replay_events+2 )) 15
presentation; shot custom-replay-alternate
press_expect alternate-new comparison
presentation
expect layout "New retains fork presentation and clears suffix" "e['comparison']['suffix']==0 and e['authority']['tick']==0"
shot custom-new-alternate
press_expect comparison-close comparison; layout
[[ $(field layout authority) == $SOURCE_AUTHORITY ]] || fail "custom source authority changed"
# Dispose this isolated recording through its explicit guard before the fault fixture.
press_panel file-open; open_panel controlled-comparison-fault.lawsmith.json
for guard in 1 2; do
  [[ $(depth) == 1 ]] || break
  if [[ $(axq buttons $APP_PID) == *'Save Recording…'* ]]; then alert_for recording "Don't Save"; else alert_for scene "Don't Save"; fi
  sleep 0.4
done
layout; expect document "controlled supported-domain fault fixture opened" "e['action']=='open' and e['outcome']=='committed'"
SOURCE_AUTHORITY=$(field layout authority)
baseline
edit_value inputs.Strength 200
press_expect play sim-control
wait_log simulation-fault 1 15
layout
expect simulation-fault "controlled B crosses the speed limit" "'Speed above the supported 350 m/s' in e['reason']"
expect layout "fault pauses B and omits authored Reset" "e['playing'] is False and e['comparison'] is not None and e['controls']['sim-error-reset'] is None and e['controls']['alternate-new'] is not None and e['controls']['comparison-close'] is not None"
osascript -l JavaScript $NATIVE/ax.js buttons $APP_PID > $QA_OUT/fault-visible-buttons.txt
shot controlled-comparison-fault
press_expect alternate-new comparison; layout
expect layout "New Alternate recovers the faulted B" "e['authority']['tick']==0 and e['comparison']['suffix']==0 and e['controls']['sim-error-reset'] is None"
press_expect step sim-control; layout
expect layout "recovered B actually advances" "e['authority']['tick']==1"
shot controlled-comparison-recovered
press_expect comparison-close comparison; layout
[[ $(field layout authority) == $SOURCE_AUTHORITY ]] || fail "fault source authority changed"
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "presentation and controlled fault supplement complete"
