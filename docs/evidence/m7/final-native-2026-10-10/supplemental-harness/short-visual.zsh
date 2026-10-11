source <checkout>/scripts/verify/native/lib.zsh
RECORDER=
mkdir -p $QA_STATE/scenes
cp $REPO/examples/two-futures.lawsmith.json $QA_STATE/scenes/
ORIGINAL_MODE=$(osascript -l JavaScript $NATIVE/display.js get)
restore_mode() { local d=${ORIGINAL_MODE%@*}; osascript -l JavaScript $NATIVE/display.js set ${=${d/x/ }} ${ORIGINAL_MODE#*@} >/dev/null; }
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; running && kill $APP_PID; restore_mode; gui_unlock' EXIT
seed_folder $QA_STATE/scenes
segment "M7 both-body equal-tick visual supplement"
osascript -l JavaScript $NATIVE/display.js set 1728 1117 60 >/dev/null
sleep 2
launch m7-visual $QA_STATE/recovery-visual
activate
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
 set position of window \"Lawsmith\" to {40,45}
 set size of window \"Lawsmith\" to {1280,800}
end tell" >/dev/null
sleep 1
press_panel file-open
open_panel two-futures.lawsmith.json
sleep 0.5
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
layout
SOURCE_AUTHORITY=$(field layout authority)
record_start m7-both-futures 70
press_expect compare-from comparison
n=$(count comparison)
press_expect baseline-compute comparison
wait_log comparison $(( n+2 )) 20
layout
BASELINE_HASH=$(field layout comparison.receipt.baselineHash)
shot m7-visual-common
for i in {1..25}; do
 layout
 p=(${=$(point inputs.Strength)})
 panel=(${=$(field layout controls.panel | tr -d '[],')})
 if (( p[2]>WIN_Y+panel[2]+8 && p[2]<WIN_Y+panel[2]+panel[4]-8 )); then click $p[1] $p[2]; break; fi
 scroll_at $(( WIN_X+25 )) $(( WIN_Y+350 )) -100
done
keys kd:cmd t:a ku:cmd t:2 kp:return
key_code 53
press_expect play sim-control
play_point=(${=$(point controls.play)})
sleep 0.7
click_expect $play_point[1] $play_point[2] sim-control
layout
python3 -I $NATIVE/m7q.py separation $APP_LOG || fail "short visual separation"
expect layout "both-body visual uses common tick and paused authority" "e['playing'] is False and e['viewport']==[1280,800] and e['comparison']['tick']<300"
[[ $(field layout comparison.receipt.baselineHash) == $BASELINE_HASH ]] || fail "baseline changed"
shot m7-visual-two-futures
press baseline-ghosts
shot m7-visual-ghosts-off
press baseline-ghosts
python3 -I $NATIVE/m7q.py ghosts $APP_LOG || fail "ghosts changed authority"
replay_events=$(count comparison)
press_expect alternate-replay comparison
wait_log comparison $(( replay_events+2 )) 15
layout
python3 -I $NATIVE/m7q.py replay $APP_LOG || fail "visual replay endpoint changed"
shot m7-visual-replayed
press_expect alternate-new comparison
layout
expect layout "New clears suffix and returns fork" "e['comparison']['tick']==0 and e['comparison']['cursor']==0 and e['comparison']['suffix']==0"
shot m7-visual-new
press_expect comparison-close comparison
layout
[[ $(field layout authority) == $SOURCE_AUTHORITY ]] || fail "source changed"
record_stop
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m7 visual supplement complete"
