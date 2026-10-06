# P0 (SPEC §18.2) in the packaged app at a 1600×1000 CSS content viewport, three runs of 10 s warmup
# and 60 s measured, with real handle drags feeding edit latency; then the 1280×800 structural layout
# check (MILESTONES M2 visual QA). The built-in display offers these sizes only at its More Space
# scale (1728×1117), so the scenario switches to it for this login session and restores the previous
# mode, verified by reading the mode back.
# Screen recording stays off. Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m2-p0
source ${0:A:h}/lib.zsh

screen_size() { osascript -l JavaScript $NATIVE/display.js get }
# display_mode WIDTH HEIGHT: a HiDPI mode for this login session only (the saved preference is untouched).
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
restore_display() { [[ $(screen_size) == $LARGER_TEXT ]] || display_mode ${=${${LARGER_TEXT%@*}/x/ }}; say "display restored to $(screen_size)" }

seed_folder $QA_STATE/scenes
segment "P0 at 1600×1000 under More Space (about 7 minutes)"
LARGER_TEXT=$(screen_size)
# On any exit: the test-owned app stops (an aborted capture must not continue at another size), the
# display mode is restored, and the shared lock is released.
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
say "display is $(screen_size)"

launch p0 $QA_STATE/recovery-p0-$EPOCHSECONDS
activate
window_size 40 50 1600 1000
layout
expect layout "the content viewport is 1600×1000 CSS at DPR 2" "e['viewport']==[1600, 1000] and e['devicePixelRatio']==2"
press play
sleep 3
drag_law_to 3 1 0 0.4 1 0
sleep 8
expect pacing "the stream is at full strength with the law inside it" "e['bodies']==64 and e['playing'] is True"
shot p0-1600x1000

for run in 1 2 3; do
  runs=$(count p0-run)
  measures=$(count p0)
  keys kd:shift t:p ku:shift
  wait_log p0 $(( measures + 2 )) 20
  say "P0 run $run measuring"
  start=$EPOCHSECONDS
  flip=0
  while (( $(count p0-run) == runs && EPOCHSECONDS - start < 56 )); do
    if (( flip )); then drag_law_to 0.7 1 0 0.4 1 0; else drag_law_to 0.4 1 0 0.7 1 0; fi
    flip=$(( 1 - flip ))
    sleep 1.5
  done
  wait_log p0-run $(( runs + 1 )) 30
  expect p0-run "run $run is valid and meets every P0 gate" "e['invalid'] is None and e['incomplete'] is None and e['stepMs'][1] <= 2 and e['stepMs'][2] <= 4 and e['editMs'][1] <= 50 and e['intervalMs'][1] <= 20 and e['intervalMs'][2] <= 34 and e['workMs'][1] <= 12 and e['simWallRatio'] >= 0.98"
done

# 1280×800: the selected law, its handles and the primary controls stay unobscured; no header band.
press play
window_size 40 50 1280 800
layout
expect layout "1280×800: the selected law's support is clear of the panel, tools and transport; controls fit; no full-width band" "e['viewport']==[1280, 800] and all(not (a[0] < e['support'][2] and a[0] + a[2] > e['support'][0] and a[1] < e['support'][3] and a[1] + a[3] > e['support'][1]) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport')]) and e['controls']['tools'][2] < e['viewport'][0] / 2 and all(e['controls'][k][1] + e['controls'][k][3] <= 800 for k in ('play', 'reset', 'file-save', 'file-save-as'))"
shot p0-1280x800
activate
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m2-p0 complete"
