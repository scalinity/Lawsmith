# M6A pacing in the packaged app (MILESTONES M6A performance gate; supporting, not the P1 protocol): the
# P1 workshop at a 1600×1000 CSS viewport under More Space, recorded for about 50 s while a law is dragged
# every 1.5 s, then replayed at 1× to its end. The app's own 5-second pacing lines (frame interval, step
# and edit latency over the last 240 frames) are summarized for the recording and for the replay; the
# replay must also reach the recorded end exactly. The P1/P2 gates are requalified by m3-p1 and m4-perf.
# Screen recording stays off. Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6a-pace
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-m6a-pace-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p1-workshop.lawsmith.json $QA_STATE/scenes/
screen_size() { osascript -l JavaScript $NATIVE/display.js get }
display_mode() { say "display → $1×$2: $(osascript -l JavaScript $NATIVE/display.js set $1 $2 2>&1)"; sleep 3 }
window_size() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set position of window \"Lawsmith\" to {$1, $2}
    set size of window \"Lawsmith\" to {$3, $4}
  end tell" >/dev/null
  sleep 1.2
  window_origin
}
restore_display() { [[ $(screen_size) == $LARGER_TEXT ]] || display_mode ${=${${LARGER_TEXT%@*}/x/ }}; cliclick m:584,300; touched; say "display restored to $(screen_size)" }
# The pacing lines logged since event T: their p95s, the worst of each.
pacing_since() {
  logq all $APP_LOG pacing | python3 -I -c "
import json, sys
lines = [e for e in map(json.loads, sys.stdin) if e['t'] >= $1 and e['playing']]
worst = lambda key, i: max((e[key][i] for e in lines if e.get(key)), default=None)
print(json.dumps({'lines': len(lines), 'intervalP95Max': worst('intervalMs', 1), 'intervalP99Max': worst('intervalMs', 2), 'stepP95Max': worst('stepMs', 1), 'stepP99Max': worst('stepMs', 2), 'editP95Max': worst('editMs', 1), 'simWallMin': min((e['simWallRatio'] for e in lines), default=None), 'droppedMs': max((e['droppedMs'] for e in lines), default=None), 'bodies': max((e['bodies'] for e in lines), default=None)}))"
}

seed_folder $QA_STATE/scenes
segment "P1 recorded with drags, then replayed, at 1600×1000 under More Space (about 3 minutes)"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
launch m6a-pace $RECOVERY
activate
window_size 40 50 1600 1000
keys kd:cmd t:o ku:cmd
open_panel p1-workshop.lawsmith.json
wait_log document 1 15
layout
expect layout "the content viewport is 1600×1000 CSS, drag-0 selected" "e['viewport']==[1600, 1000] and e['selected']=='drag-0'"
n=$(count recording)
press run-record
wait_log recording $(( n + 1 )) 10
recording_from=$(logq field $APP_LOG recording t)
press play
start=$EPOCHSECONDS
flip=0
while (( EPOCHSECONDS - start < 50 )); do
  if (( flip )); then drag_law_to -2.6 -0.5 -3 -3 -0.5 -3; else drag_law_to -3 -0.5 -3 -2.6 -0.5 -3; fi
  flip=$(( 1 - flip ))
  sleep 1.5
done
n=$(count recording)
press run-stop
wait_log recording $(( n + 2 )) 10
expect recording "about 50 s of P1 recorded with its drags" "e['action']=='stopped' and e['finalTick'] > 5000 and e['commands'] > 100"
say "while recording: $(pacing_since $recording_from)"
final_tick=$(field recording finalTick)
n=$(count context)
press run-replay
wait_log context $(( n + 1 )) 10
replay_from=$(logq field $APP_LOG context t)
press play
wait_log replay-complete 1 $(( final_tick / 120 + 30 ))
expect replay-complete "the P1 replay reached the recorded end exactly" "e['check']['kind']=='match' and e['tick']==$final_tick"
say "while replaying: $(pacing_since $replay_from)"
press run-return
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for recording "Don't Save"
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m6a-pace complete"
