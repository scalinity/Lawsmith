# M6B long reconstructions in the packaged app (MILESTONES M6B Visual QA and performance gate; AC5, AC7,
# AC8): the P1 workshop at a 1600×1000 CSS viewport under More Space, recorded while a law is dragged until
# the 60 s limit closes it. In its replay an uncached seek to the end is left pending while Return to
# authoring is pressed: Space and Play pressed while it is pending only toggle playing from its target, it
# never commits, and the retained authoring world's digests are those it had when the replay began. In a
# new replay a long seek shows its progress and Cancel seek after 100 ms, and Cancel leaves the displayed
# replay exactly as it was, paused. A newer request made while a long reconstruction runs
# supersedes it: only the newer one commits and is shown. Then, with
# screen recording off, the app's M6B fixtures
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
# toggles: how many play-on-commit and pause-on-commit events the log holds.
toggles() { logq all $APP_LOG seek | python3 -I -c "import json,sys; print(sum(json.loads(l)['action'].endswith('-on-commit') for l in sys.stdin))" }
# grows N TENTHS COUNT…: whether the command COUNT… reports more than N within TENTHS tenths of a second.
grows() { local n=$1 t=$2 i; shift 2; for i in {1..$t}; do (( $("$@") > n )) && return 0; sleep 0.1; done; return 1 }
# press_at X Y COUNT…: a hit-tested click at a point already read back (a readback during a seek takes
# most of a second), until COUNT… reports one more; a lost click is sent again once, as press_expect does.
press_at() {
  local x=$1 y=$2; shift 2
  local n=$("$@")
  click $x $y
  grows $n 10 "$@" && return 0
  say "the synthetic click at $x,$y was lost (nothing logged); sending it again"
  click $x $y
  grows $n 30 "$@" || fail "the click at $x,$y logged nothing"
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

# Return first, on an empty cache: a full reconstruction (about 5 s) is still pending when Return lands. A
# canceled seek keeps the checkpoints it passed, so the later cancel case starts from one of them.
segment "a seek left pending at Return to authoring; another canceled once its progress shows"
n=$(count context)
lives=$(count context-live)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
# The retained world's digests are hashed asynchronously; each switch logs them once.
wait_log context-live $(( lives + 1 )) 5
live_at_entry=$(logq last $APP_LOG context-live)
record_start m6b-long 100
seek_click $final_tick
pending_id=$(field seek id)
# Space, then Play, while it is pending (M6B review finding 1): each press only toggles playing from the
# target; before the fix the second one started the displayed replay. Space goes first, while the timeline
# holds focus, so it takes the keyboard's path. Play's point comes from seek_click's readback, before the
# request: Play sits in the transport, which a seek never moves, and every readback here costs seek time.
n=$(toggles)
keys kp:space
grows $n 30 toggles || fail "Space during the seek logged no toggle"
pp=(${=$(point controls.play)})
press_at $pp[1] $pp[2] toggles
n=$(count context)
press_expect run-return context
wait_log context $(( n + 1 )) 10
expect context "Return to authoring while the seek was pending: authoring, one world" "e['reason']=='return' and e['selected']=='authoring' and e['worlds']==1 and e['seeking']==0"
sleep 3
expect seek "the pending seek ended with Return and never committed" "e['id']==$pending_id and e['action']=='canceled' and e['reason']=='return'"
verdict "Space and Play during the seek only toggled playing from its target; nothing played the displayed replay" deferred $APP_LOG $pending_id play-on-commit pause-on-commit
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
shot long-01-returned
n=$(count context)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
seek_click $final_tick
progress_shown
expect layout "seeking: the status names the requested tick and its progress, the replay still shows tick 0" "'Seeking to tick $final_tick' in e['run']['status'] and '%' in e['run']['status'] and e['run']['replay']['address']=={'tick': 0, 'cursor': 0} and e['run']['contexts']['seeking']==1"
shot long-02-progress
# Cancel seek's point from the readback that showed the progress, with nothing between them that changes
# the status's lines: the presses above left the cache deeper, so this seek is shorter than a readback allows.
pc=(${=$(point controls.run-cancel)})
press_at $pc[1] $pc[2] count seek
expect seek "Cancel seek ended it, with its progress shown after 100 ms" "e['action']=='canceled' and e['reason']=='cancel' and e['progressShownAfterMs'] >= 100"
layout
expect layout "after Cancel: the same replay at tick 0, paused, no seek world, the timeline back at 0" "e['run']['replay']['address']=={'tick': 0, 'cursor': 0} and e['run']['status'].endswith('Paused.') and e['run']['contexts']['seeking']==0 and e['run']['contexts']['worlds']==2 and e['run']['timeline']['value']==0 and e['run']['seeking'] is None"
shot long-03-canceled

# A newer request while a long reconstruction runs: the canceled seeks left checkpoints only partway, so a
# seek to the end still takes seconds, and the second click lands while it works. (A click that comes
# during a short cached seek reaches the page only after that seek ends: WebKit sends mouse events one at
# a time, each waiting for the page's reply; M6B.md finding.)
segment "a newer request supersedes a long reconstruction; only the newer one is shown"
since=$(logq all $APP_LOG seek | python3 -I -c "import json,sys; print(max(json.loads(l).get('id', 0) for l in sys.stdin))")
# Both points from one readback (a readback during a seek takes most of a second), then two hit-tested
# clicks 300 ms apart: the second lands while the first still reconstructs.
layout
pa=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $final_tick)})
pb=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $(( final_tick * 3 / 10 )))})
guard_point $pa[1] $pa[2]
guard_point $pb[1] $pb[2]
idle_gate
cliclick -e 0 -w 300 c:$pa[1],$pa[2] c:$pb[1],$pb[2]
touched
deadline=$(( EPOCHREALTIME + 30 ))
while [[ $(logq all $APP_LOG seek | python3 -I -c "
import json, sys
burst = [e for e in map(json.loads, sys.stdin) if e.get('id', 0) > $since]
last = [e for e in burst if e['action'] == 'request'][-1]['id']
print(any(e['action'] == 'committed' and e['id'] == last for e in burst))") != True ]]; do
  (( EPOCHREALTIME > deadline )) && fail "the newer request did not commit"
  sleep 0.2
done
layout
verdict "the long reconstruction was superseded; only the newer request committed and is shown" latest $APP_LOG $since 1
shot long-04-superseded
n=$(count context)
press_expect run-return context
wait_log context $(( n + 1 )) 10
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
