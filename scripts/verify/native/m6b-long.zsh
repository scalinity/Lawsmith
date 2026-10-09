# M6B long reconstructions in the packaged app (MILESTONES M6B Visual QA and performance gate; AC5, AC7,
# AC8): the P1 workshop at a 1600×1000 CSS viewport under More Space, recorded while a law is dragged until
# the 60 s limit closes it. In its replay an uncached seek to the end shows its progress and Cancel seek
# after 100 ms, and Cancel leaves the displayed replay exactly as it was. Another uncached seek is left
# pending while Return to authoring is pressed: it never commits, and the retained authoring world's
# digests are those it had when the replay began. Then, with screen recording off, the app's M6B fixtures
# (Shift+C) on this recording: every target against the checkpoint-free oracle, cached seek latency
# (p95 ≤ 250 ms), an uncached and a canceled seek, and 20 seek/reset cycles.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6b-long
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-m6b-long-$EPOCHSECONDS
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
m6bq() { python3 -I $NATIVE/m6bq.py "$@" }
verdict() {
  local description=$1; shift
  local result=$(m6bq "$@")
  say "${result%% *}  [m6bq $1] $description: ${result#* }"
  [[ $result == PASS* ]] || fail "expectation failed: $description"
}
# seek_click TICK: clicks the replay timeline at TICK and waits for its request, not for its end.
seek_click() {
  layout
  local p=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $1)}) n=$(count seek) i
  click $p[1] $p[2]
  for i in {1..10}; do (( $(count seek) > n )) && return 0; sleep 0.1; done
  say "the synthetic click on the timeline was lost (no seek event); sending it again"
  click $p[1] $p[2]
  wait_log seek $(( n + 1 )) 3
}
# progress_shown: waits until the pending seek shows its progress and Cancel seek, by layout readback.
progress_shown() {
  local i
  for i in {1..20}; do
    layout
    [[ $(logq last $APP_LOG layout | python3 -I -c "import json,sys; r=json.load(sys.stdin)['run']; print(bool(r['seeking'] and r['seeking']['shown'] and r['buttons']['cancel']))") == True ]] && return 0
    [[ $(logq all $APP_LOG seek | python3 -I -c "import json,sys; print(any(json.loads(l)['action']=='committed' for l in sys.stdin))") == True ]] && fail "the seek committed before its progress could be shown"
    sleep 0.3
  done
  fail "no progress or Cancel seek was shown"
}

seed_folder $QA_STATE/scenes
segment "P1 recorded with drags until the 60 s limit, at 1600×1000 under More Space"
LARGER_TEXT=$(screen_size)
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
launch m6b-long $RECOVERY
activate
window_size 40 50 1600 1000
keys kd:cmd t:o ku:cmd
open_panel p1-workshop.lawsmith.json
wait_log document 1 15
layout
expect layout "the content viewport is 1600×1000 CSS, drag-0 selected" "e['viewport']==[1600, 1000] and e['selected']=='drag-0'"
n=$(count recording)
press_expect run-record recording
wait_log recording $(( n + 1 )) 10
press_expect play sim-control
flip=0
deadline=$(( EPOCHSECONDS + 120 ))
until [[ $(logq all $APP_LOG recording | python3 -I -c "import json,sys; print(any(json.loads(l).get('stopped')=='duration' for l in sys.stdin))") == True ]]; do
  (( EPOCHSECONDS > deadline )) && fail "the recording did not close at its 60 s limit"
  if (( flip )); then drag_law_to -2.6 -0.5 -3 -3 -0.5 -3; else drag_law_to -3 -0.5 -3 -2.6 -0.5 -3; fi
  flip=$(( 1 - flip ))
  sleep 1.5
done
expect recording "the P1 recording closed itself at exactly 60 s" "e['action']=='stopped' and e['stopped']=='duration' and e['finalTick']==7200 and e['commands'] > 50"
run_id=${$(field recording runId)//\"/}
final_tick=$(field recording finalTick)

segment "an uncached seek shows progress and is canceled; another is left pending at Return to authoring"
n=$(count context)
lives=$(count context-live)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
# The retained world's digests are hashed asynchronously; each switch logs them once.
wait_log context-live $(( lives + 1 )) 5
live_at_entry=$(logq last $APP_LOG context-live)
record_start m6b-long 60
seek_click $final_tick
progress_shown
expect layout "seeking: the status names the requested tick and its progress, the replay still shows tick 0" "'Seeking to tick $final_tick' in e['run']['status'] and '%' in e['run']['status'] and e['run']['replay']['address']=={'tick': 0, 'cursor': 0} and e['run']['contexts']['seeking']==1"
shot long-01-progress
press_expect run-cancel seek
expect seek "Cancel seek ended it, with its progress shown after 100 ms" "e['action']=='canceled' and e['reason']=='cancel' and e['progressShownAfterMs'] >= 100 and e['source']['kind']=='root'"
layout
expect layout "after Cancel: the same replay at tick 0, no seek world, the timeline back at 0" "e['run']['replay']['address']=={'tick': 0, 'cursor': 0} and e['run']['contexts']['seeking']==0 and e['run']['contexts']['worlds']==2 and e['run']['timeline']['value']==0 and e['run']['seeking'] is None"
shot long-02-canceled
seek_click $(( final_tick * 9 / 10 ))
pending_id=$(field seek id)
progress_shown
n=$(count context)
press_expect run-return context
wait_log context $(( n + 1 )) 10
expect context "Return to authoring while the seek was pending: authoring, one world" "e['reason']=='return' and e['selected']=='authoring' and e['worlds']==1 and e['seeking']==0"
sleep 3
expect seek "the pending seek ended with Return and never committed" "e['id']==$pending_id and e['action']=='canceled' and e['reason']=='return'"
wait_log context-live $(( lives + 2 )) 5
python3 -I -c "
import json, sys
entry = json.loads('''$live_at_entry''')
back = json.loads(sys.argv[1])
same = all(entry[k] == back[k] for k in ('tick', 'cursor', 'stateSha256', 'engineSha256', 'revision', 'generation', 'canUndo', 'canRedo'))
print('PASS' if same else 'FAIL', {k: (entry[k], back[k]) for k in ('tick', 'cursor', 'revision')})
" "$(logq last $APP_LOG context-live)" | read result rest
say "$result  [context-live] the retained authoring world is exactly as it was when the replay began: $rest"
[[ $result == PASS ]] || fail "the retained authoring world changed"
shot long-03-returned
record_stop
verdict "no superseded or canceled seek ever committed" seeks $APP_LOG

segment "the app's M6B fixtures on the P1 recording (Shift+C), screen recording off"
activate
keys kd:shift t:c ku:shift
wait_log m6b-fixtures 1 900
say "fixtures: $(logq last $APP_LOG m6b-fixtures | python3 -I -c "import json,sys; e=json.load(sys.stdin); print('compared', e.get('compared'), e.get('sources'), 'cached drawn ms (p50 p95 p99 max)', e['cached']['drawnMs'], 'committed', e['cached']['committedMs'], 'work', e['cached']['workMs'], 'steps', e['cached']['steps'], e['latencyGate'], 'uncached', e['uncached'], e['uncachedGate'], 'cancel', e['cancel'], 'peak worlds', e['lifecycle']['peakWorlds'], 'error', e.get('error'))")"
expect m6b-fixtures "the M6B fixtures pass on P1: exact at every target, cached p95 to the drawn frame within 250 ms on this 60 s recording, ~8 ms batches, progress at 100 ms, cancel, bounded cycles" "e['pass'] is True and not e['divergent'] and e['latencyGate']['applies'] is True"
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
sleep 1
[[ $(depth) == 1 ]] && alert_for recording "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m6b-long complete"
