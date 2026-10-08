# M5 compound performance in the packaged app (MILESTONES M5 performance gate; SPEC §18): the named P5
# workload, 100 colliding spheres under eight compound laws of four primitive leaves each, three runs at
# 1600×1000 CSS (DPR capped at 1.5). Gates: completed active physics step p95 ≤ 3 ms and accepted edit
# to first frame submission p95 ≤ 50 ms; pacing, frame work, sim/wall and p99s are recorded beside them.
# Protocol as m4-perf: 10 s warmup, 60 s measured, real drags of a compound law feeding edit latency,
# More Space for this login session only and restored on exit, recording off. P0/P2 are m4-perf, P1 m3-p1.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m5-perf
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p5-compound.lawsmith.json $QA_STATE/scenes/

screen_size() { osascript -l JavaScript $NATIVE/display.js get }
display_mode() {
  say "display → $1×$2: $(osascript -l JavaScript $NATIVE/display.js set $1 $2 2>&1)"
  sleep 3
}
window_size() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set position of window \"Lawsmith\" to {$1, $2}
    set size of window \"Lawsmith\" to {$3, $4}
  end tell" >/dev/null
  sleep 1.2
  window_origin
}
restore_display() { [[ $(screen_size) == $LARGER_TEXT ]] || display_mode ${=${${LARGER_TEXT%@*}/x/ }}; cliclick m:584,300; touched; say "display restored to $(screen_size)" }
capture() {
  local label=$1 gates=$2 run runs measures start flip
  for run in 1 2 3; do
    runs=$(count p0-run)
    measures=$(count p0)
    keys kd:shift t:p ku:shift
    wait_log p0 $(( measures + 2 )) 20
    say "$label run $run measuring"
    start=$EPOCHSECONDS
    flip=0
    while (( $(count p0-run) == runs && EPOCHSECONDS - start < 56 )); do
      if (( flip )); then drag_law_to $6 $7 $8 $3 $4 $5; else drag_law_to $3 $4 $5 $6 $7 $8; fi
      flip=$(( 1 - flip ))
      sleep 1.5
    done
    wait_log p0-run $(( runs + 1 )) 30
    expect p0-run "$label run $run is valid and meets its gates" "e['invalid'] is None and e['incomplete'] is None and $gates"
  done
}

seed_folder $QA_STATE/scenes
segment "P5 compound at 1600×1000 under More Space (about 5 minutes)"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"

launch perf5 $QA_STATE/recovery-perf5-$EPOCHSECONDS
activate
window_size 40 50 1600 1000
keys kd:cmd t:o ku:cmd
open_panel p5-compound.lawsmith.json
wait_log document 1 15
expect document "P5 opened" "e['action']=='open' and e['outcome']=='committed'"
layout
expect layout "the content viewport is 1600×1000 CSS at DPR 2, and the first compound law is selected" "e['viewport']==[1600, 1000] and e['devicePixelRatio']==2 and e['selected']=='cell-0' and e['selectedField']['expression']['kind']=='sum'"
press trails-off
expect visualization "no probes, no trails, nothing explained: the workload is the laws and bodies" "e['probes']['enabled'] is False and e['trails']['mode']=='off' and e['explained'] is None"
press play
sleep 6
expect pacing "100 bodies are live" "e['bodies']==100 and e['playing'] is True"
shot p5-1600x1000
capture P5 "e['bodies']==100 and e['workload']['laws']==8 and e['workload']['primitiveLeaves']==32 and 'sum' in e['workload']['lawKinds'] and 'gain' in e['workload']['lawKinds'] and 'mask' in e['workload']['lawKinds'] and e['stepMs'][1] <= 3 and e['editMs'][1] <= 50" 0 -1.5 0 0.4 -1.5 0

activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m5-perf complete"
