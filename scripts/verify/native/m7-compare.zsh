# M7 packaged workflow. Requires an agreed hands-off window; lib.zsh owns the shared GUI lock,
# topmost/frontmost hit tests and external-input abort. Disposable files/recovery only.
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp $REPO/examples/two-futures.lawsmith.json $QA_STATE/scenes/
cp ${NATIVE:h}/scenes/p3-futures.lawsmith.json $QA_STATE/scenes/
RECORDER=
ORIGINAL_MODE=$(osascript -l JavaScript $NATIVE/display.js get)
restore_mode() {
  local dimensions=${ORIGINAL_MODE%@*} hz=${ORIGINAL_MODE#*@}
  osascript -l JavaScript $NATIVE/display.js set ${=${dimensions/x/ }} $hz >/dev/null
}
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; running && kill $APP_PID; restore_mode; gui_unlock' EXIT
window_size() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set position of window \"Lawsmith\" to {40, 45}
    set size of window \"Lawsmith\" to {$1, $2}
  end tell" >/dev/null
  sleep 1
  window_origin
}
open_fixture() {
  local n=$(count document)
  press_panel file-open
  open_panel $1
  sleep 0.5
  [[ $(depth) == 1 ]] && alert_for scene "Don't Save"
  wait_log document $(( n + 1 )) 15
  expect document "fixture opened" "e['action']=='open' and e['outcome']=='committed'"
}
baseline() {
  local n=$(count comparison)
  press_expect baseline-compute comparison
  wait_log comparison $(( n + 2 )) 20
  expect comparison "600 tick baseline committed" "e['action']=='baseline-committed' and e['horizon']==600 and e['metrics']['elapsedMs'] <= 3000 and e['bytes'] <= 67108864"
  layout
  BASELINE_HASH=$(field layout comparison.receipt.baselineHash)
}
assert_baseline() { [[ $(field layout comparison.receipt.baselineHash) == $BASELINE_HASH ]] || fail "retained baseline hash changed"; }
numeric_check() { python3 -I $NATIVE/m7q.py $1 $APP_LOG || fail "M7 $1 assertion failed"; }
reveal_strength() {
  local panel i p
  for i in {1..25}; do
    layout
    p=(${=$(point inputs.Strength)})
    panel=(${=$(logq field $APP_LOG layout controls.panel | tr -d '[],')})
    if (( p[2] > WIN_Y + panel[2] + 8 && p[2] < WIN_Y + panel[2] + panel[4] - 8 )); then click $p[1] $p[2]; return 0; fi
    scroll_at $(( WIN_X + 25 )) $(( WIN_Y + 350 )) -100
  done
  fail "strength did not become visible"
}
seed_folder $QA_STATE/scenes
segment "M7 two futures and packaged authority fixtures"
say "More Space, 60 Hz: $(osascript -l JavaScript $NATIVE/display.js set 1728 1117 60)"
sleep 2
launch m7-compare $QA_STATE/recovery-m7-compare-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
activate
window_size 1280 800
open_fixture two-futures.lawsmith.json
layout
expect layout "1280×800 and known law selected" "e['viewport']==[1280,800] and e['selected']=='sideways'"
SOURCE_AUTHORITY=$(field layout authority)
record_start m7-two-futures 100
press_expect compare-from comparison
baseline
shot m7-01-common-fork
reveal_strength
keys kd:cmd t:a ku:cmd t:2 kp:return
# The numeric field keeps focus after commit; Escape releases it before diagnostic shortcuts.
key_code 53
sleep 0.4
layout
expect layout "B intervention recorded without moving source" "e['comparison']['suffix']==1 and e['run']['contexts']['selected']=='comparison'"
press_expect play sim-control
sleep 1.5
press_expect play sim-control
layout
expect layout "equal tick intervention" "e['comparison']['tick'] >= 120 and e['comparison']['tick'] < 600 and e['comparison']['suffix']==1 and e['playing'] is False"
numeric_check separation
assert_baseline
shot m7-02-divergence
press baseline-ghosts
press baseline-ghosts
numeric_check ghosts
replay_events=$(count comparison)
press_expect alternate-replay comparison
wait_log comparison $(( replay_events + 2 )) 15
layout
numeric_check replay
assert_baseline
shot m7-03-replayed
press_expect alternate-new comparison
layout
expect layout "New Alternate deliberately clears edits" "e['comparison']['suffix']==0 and e['comparison']['tick']==0 and e['comparison']['cursor']==0"
assert_baseline
shot m7-04-new
press_expect baseline-extend comparison
sleep 0.5
layout
expect layout "real extension retains fork and reaches 1200" "e['comparison']['horizon']==1200 and e['comparison']['tick']==0"
expect layout "no fabricated baseline frame" "e['comparison']['receipt']['framePastHorizon'] is False"
press_panel alternate-export
save_panel $QA_STATE/scenes two-futures-alternate.lawsmith.json
sleep 0.5
expect document "ordinary alternate setup export" "e['action']=='export-alternate' and e['outcome']=='saved'"
press_expect comparison-close comparison
layout
expect layout "source restored at entry address" "e['comparison'] is None and e['run']['contexts']['selected']=='authoring' and e['selectedField']['expression']['strength']==0"
[[ $(field layout authority) == $SOURCE_AUTHORITY ]] || fail "retained source authority changed"
record_stop
keys kd:shift t:j ku:shift
local_wait=0
while (( local_wait++ < 180 )); do
  [[ $(logq field $APP_LOG m7-fixtures complete 2>/dev/null) == true ]] && break
  sleep 0.2
done
expect m7-fixtures "packaged independent M7 fixtures completed" "e.get('complete') is True"
numeric_check fixtures
say "20 view/context cycles"
for i in {1..20}; do
  press_expect compare-from comparison
  baseline
  press_expect step sim-control
  replay_events=$(count comparison)
  press_expect alternate-replay comparison
  wait_log comparison $(( replay_events + 2 )) 15
  layout
  numeric_check replay
  assert_baseline
  press_expect alternate-new comparison
  layout
  assert_baseline
  press_expect comparison-close comparison
  keys kd:shift t:v ku:shift
done
numeric_check resources
shot m7-05-closed
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
restore_mode
say "m7-compare complete"
