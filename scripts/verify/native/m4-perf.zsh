# M4 performance and legibility in the packaged app (MILESTONES M4 performance gate, AC7; SPEC §18):
#   P0 with every M4 overlay off (no probes, no trails, nothing explained), three runs at 1600×1000;
#   P2 (100 bodies, four laws, 2,000 probes, 32 trails, default arrows), three runs at 1600×1000;
#   1280×800 with the defaults: the selected law, its support and an explained body stay clear of every
#   panel, nothing scrolls sideways, and probes and trails turn off without touching a law.
# Protocol as m2-p0 and m3-p1: 10 s warmup, 60 s measured, real handle drags feeding edit latency, the
# built-in display at More Space for this login session only and restored on exit. Recording stays off.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m4-perf
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p2-probes.lawsmith.json ${NATIVE:h:h:h}/examples/why-it-moves.lawsmith.json $QA_STATE/scenes/

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
open_scene() {
  activate
  keys kd:cmd t:o ku:cmd
  local n=$(count document)
  open_panel $1.lawsmith.json
  sleep 1.2
  [[ $(depth) == 1 ]] && alert "Don't Save"
  wait_log document $(( n + 1 )) 15
  expect document "$1 opened" "e['action']=='open' and e['outcome']=='committed'"
}
# capture LABEL GATES FROM… TO…: three runs, each with drags of the selected law between two points.
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
segment "P0 with every overlay off, then P2, at 1600×1000 under More Space (about 15 minutes)"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"

launch perf4 $QA_STATE/recovery-perf4-$EPOCHSECONDS
activate
window_size 40 50 1600 1000
layout
expect layout "the content viewport is 1600×1000 CSS at DPR 2" "e['viewport']==[1600, 1000] and e['devicePixelRatio']==2"
press trails-off
expect visualization "every M4 overlay is off: no probes, no trails, nothing explained" "e['probes']['enabled'] is False and e['trails']['mode']=='off' and e['explained'] is None"
press play
sleep 3
drag_law_to 3 1 0 0.4 1 0
sleep 8
expect pacing "the stream is at full strength with the law inside it" "e['bodies']==64 and e['playing'] is True"
shot p0-1600x1000
capture P0 "e['visualization']['probes']['enabled'] is False and e['visualization']['trails']['mode']=='off' and e['samples']['probeSteps']==0 and e['samples']['trailSteps']==0 and e['stepMs'][1] <= 2 and e['stepMs'][2] <= 4 and e['editMs'][1] <= 50 and e['intervalMs'][1] <= 20 and e['intervalMs'][2] <= 34 and e['workMs'][1] <= 12 and e['simWallRatio'] >= 0.98" 0.4 1 0 0.7 1 0

open_scene p2-probes
layout
expect layout "P2 opens with its drag law selected" "e['selected']=='drag'"
press probes-toggle
press trails-all
press play
sleep 10
expect visualization "P2's overlays: 2,000 probes and 32 trails" "e['probes']['enabled'] is True and e['probes']['count']==2000 and e['trails']['mode']=='all'"
expect pacing "100 bodies are live" "e['bodies']==100 and e['playing'] is True"
shot p2-1600x1000
capture P2 "e['bodies']==100 and e['workload']['laws']==4 and e['visualization']['probes']['live']==2000 and e['visualization']['trails']['count']==32 and e['arrows'] > 0 and e['stepMs'][1] <= 3 and e['stepMs'][2] <= 5 and e['workMs'][1] <= 14 and e['intervalMs'][1] <= 20 and e['intervalMs'][2] <= 34 and e['editMs'][1] <= 50 and e['simWallRatio'] >= 0.98" 0 -0.5 0 0.4 -0.5 0

segment "1280×800 legibility with the defaults (AC7)"
activate
open_scene why-it-moves
window_size 40 50 1280 800
press probes-toggle
press trails-all
press play
sleep 5
press play
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
keys t:.
layout
expect layout "1280×800: the selected law's support and the explained body are clear of the panels, tools and transport; nothing scrolls sideways; the probe and trail switches are in view" "e['viewport']==[1280, 800] and e['selected'] is not None and e['explained']['point'] is not None and all(not (a[0] < e['support'][2] and a[0] + a[2] > e['support'][0] and a[1] < e['support'][3] and a[1] + a[3] > e['support'][1]) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and all(not (a[0] - 6 <= e['explained']['point'][0] <= a[0] + a[2] + 6 and a[1] - 6 <= e['explained']['point'][1] <= a[1] + a[3] + 6) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and 0 < e['explained']['point'][0] < 1280 and 0 < e['explained']['point'][1] < 800 and all(s['scrollWidth'] <= s['clientWidth'] for s in e['scroll'].values()) and all(0 <= e['controls'][k][0] and e['controls'][k][0] + e['controls'][k][2] <= 1280 and e['controls'][k][1] + e['controls'][k][3] <= 800 for k in ('probes-toggle', 'trails-off', 'trails-all', 'play', 'reset', 'file-save'))"
shot m4-1280x800
press probes-toggle
press trails-off
expect visualization "probes and trails are off again, every law untouched: no revision, nothing dirty" "e['probes']['enabled'] is False and e['trails']['mode']=='off' and e['revision']==0 and e['dirty'] is False"
layout
shot m4-1280x800-overlays-off
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m4-perf complete"
