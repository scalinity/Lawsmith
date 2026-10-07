# P1 — Workshop (SPEC §18.1–18.2; MILESTONES M3 performance gate) in the packaged app: the P1 scene
# (200 colliding spheres, 16 one-leaf laws, 16 fixed colliders, no sleeping) at a 1600×1000 CSS
# content viewport, three runs of 10 s warmup and 60 s measured, with real handle drags feeding edit
# latency. Gates: completed step p95 ≤ 3 ms and p99 ≤ 5 ms, edit → frame p95 ≤ 50 ms; pacing, frame
# work and sim/wall are recorded for M9. The protocol and display handling are m2-p0's.
# Screen recording stays off. Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m3-p1
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-p1-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p1-workshop.lawsmith.json $QA_STATE/scenes/

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
# A mode change can leave the pointer clamped to a screen corner, where it reveals the auto-hiding
# Dock over every app; it is parked mid-screen so later segments find the app under test on top.
restore_display() { [[ $(screen_size) == $LARGER_TEXT ]] || display_mode ${=${${LARGER_TEXT%@*}/x/ }}; cliclick m:584,300; touched; say "display restored to $(screen_size)" }

seed_folder $QA_STATE/scenes
segment "P1 at 1600×1000 under More Space (about 7 minutes)"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"

launch p1 $RECOVERY
activate
window_size 40 50 1600 1000
keys kd:cmd t:o ku:cmd
open_panel p1-workshop.lawsmith.json
wait_log document 1 15
expect document "the P1 scene opened" "e['action']=='open' and e['outcome']=='committed' and e['file']=='p1-workshop.lawsmith.json'"
layout
expect layout "the content viewport is 1600×1000 CSS at DPR 2, with drag-0 selected" "e['viewport']==[1600, 1000] and e['devicePixelRatio']==2 and e['selected']=='drag-0'"
press play
sleep 10
expect pacing "200 bodies are live" "e['bodies']==200 and e['playing'] is True"
shot p1-1600x1000

for run in 1 2 3; do
  runs=$(count p0-run)
  measures=$(count p0)
  keys kd:shift t:p ku:shift
  wait_log p0 $(( measures + 2 )) 20
  say "P1 run $run measuring"
  start=$EPOCHSECONDS
  flip=0
  while (( $(count p0-run) == runs && EPOCHSECONDS - start < 56 )); do
    if (( flip )); then drag_law_to -2.6 -0.5 -3 -3 -0.5 -3; else drag_law_to -3 -0.5 -3 -2.6 -0.5 -3; fi
    flip=$(( 1 - flip ))
    sleep 1.5
  done
  wait_log p0-run $(( runs + 1 )) 30
  expect p0-run "P1 run $run is valid with the declared workload and meets the M3 gates" "e['invalid'] is None and e['incomplete'] is None and e['bodies']==200 and e['workload']['laws']==16 and e['workload']['fixedColliders']==16 and e['workload']['allBodyContacts'] is True and e['arrows'] <= 250 and e['stepMs'][1] <= 3 and e['stepMs'][2] <= 5 and e['editMs'][1] <= 50"
done
activate
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m3-p1 complete"
