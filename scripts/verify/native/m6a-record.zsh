# M6A visual QA and exact replay in the packaged app (MILESTONES M6A Visual QA; AC1–AC6, AC8, AC10).
# Session A records a real intervention on the M6A lab scene: a law dragged while the stream plays, a
# law disabled and enabled, a triangle gain given to a compound law's swirl (two paused edits at one
# tick), that change undone, then two paused edits at the final tick, and Stop. A third, unrecorded edit
# at the same tick must leave the record alone. A replay then shows the recording's root laws, not the
# newer authored ones, plays to its frozen end and checks itself; Return to authoring brings back the
# retained world. The run is saved through the native panel and the app quits.
# Session B is a fresh launch of the same build: Open Recording through the native panel, replay under
# changed visualization and through a Hide, reach the identical end; then the app's own M6A fixtures
# (the linear oracle and T11's cycles). m6aq.py compares the two sessions' logs and audits the file.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6a-record
source ${0:A:h}/lib.zsh
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; gui_unlock' EXIT
RECOVERY=$QA_STATE/recovery-m6a-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h}/scenes/m6a-lab.lawsmith.json $QA_STATE/scenes/
rm -f $QA_STATE/scenes/m6a-qa.lawsmith-run.json

m6aq() { python3 -I $NATIVE/m6aq.py "$@" }
verdict() {
  local description=$1; shift
  local result=$(m6aq "$@")
  say "${result%% *}  [m6aq $1] $description: ${result#* }"
  [[ $result == PASS* ]] || fail "expectation failed: $description"
}
box() {
  logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
try:
    b = $1
except (StopIteration, KeyError, IndexError, TypeError):
    b = None
if b: print(round($WIN_X + b[0] + b[2] / 2), round($WIN_Y + b[1] + b[3] / 2), round(b[1]), round(b[3]))"
}
# reveal EXPR [KIND]: scrolls the Scene panel with hit-tested wheel steps until that box is in view, then
# clicks it; with KIND, a click the app logs as that event, resent once if lost.
reveal() {
  local i p panel
  for i in {1..30}; do
    layout
    p=(${=$(box "$1")})
    [[ -n $p[1] ]] || fail "the layout has no box for $1"
    panel=(${=$(logq field $APP_LOG layout controls.panel | tr -d '[],')})
    if (( p[3] >= panel[2] + 4 && p[3] + p[4] <= panel[2] + panel[4] - 4 )); then
      if [[ -n $2 ]]; then click_expect $p[1] $p[2] $2; else click $p[1] $p[2]; fi
      return 0
    fi
    local sx=$(( WIN_X + ${panel[1]%.*} + 8 )) sy=$(( WIN_Y + ${panel[2]%.*} + ${panel[4]%.*} / 2 ))
    if (( p[3] < panel[2] + 4 )); then scroll_at $sx $sy 120; else scroll_at $sx $sy -120; fi
  done
  fail "could not bring $1 into the panel's view"
}
row() { print -r -- "next(r['$2'] for r in e['ingredients']['rows'] if r['label']=='$1')" }
button() { print -r -- "next(b['box'] for b in e['ingredients']['buttons'] if b['action']=='$1'${2:+ and b['value']=='$2'})" }
law() { reveal "next(l['$2'] for l in e['laws'] if l['id']=='$1')" $([[ $2 == select ]] && print selection || print control) }
# select_law ID: selects a law from its row unless it already is (a second click deselects).
select_law() { layout; [[ $(logq field $APP_LOG layout selected) == "\"$1\"" ]] || law $1 select }
pause() { [[ $(field sim-control action) == '"play"' ]] && press_expect play sim-control; sleep 0.3 }
run_field() { logq field $APP_LOG layout run.$1 }

seed_folder $QA_STATE/scenes

segment "session A: record a real intervention"
launch m6a-rec $RECOVERY
activate
keys kd:cmd t:o ku:cmd
n=$(count document)
open_panel m6a-lab.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "the M6A lab opened transactionally" "e['action']=='open' and e['outcome']=='committed'"
expect qualification "the packaged build reports a complete, qualified identity" "e['qualified'] is True and e['identity']['build']=='packaged' and e['identity']['bundle'].startswith('index-')"
record_start m6a-record 110
layout
expect layout "idle: Record from tick 0 and Open recording are offered" "e['run']['state']=='idle' and e['run']['buttons']['record'] and e['run']['buttons']['open'] and not e['run']['buttons']['stop']"
shot record-01-idle
n=$(count recording)
press_expect run-record recording
wait_log recording $(( n + 1 )) 10
expect recording "Record from tick 0 started a new experiment at (0, 0)" "e['action']=='start' and e['tick']==0 and e['cursor']==0 and e['qualified'] is True"
press_expect play sim-control
sleep 1.2
select_law push
drag_law_to -1.5 1 0 0.4 1 0
expect gesture "the push was dragged while the stream played: one gesture of many samples" "e['phase']=='commit' and e['transformMode']=='translate' and e['samples'] > 3"
sleep 1
law storm-bottle enabled
expect control "the Storm Bottle disabled, live" "e.get('law')=='storm-bottle' and e['enabled'] is False"
sleep 1.5
law storm-bottle enabled
expect control "and enabled again" "e.get('law')=='storm-bottle' and e['enabled'] is True"
sleep 1
pause
select_law storm-bottle
reveal "$(row Swirl select)" ingredient-focus
reveal "$(button add-gain)" control
expect control "paused: the swirl got a gain" "e.get('ingredient')=='Add gain'"
reveal "$(button gain-kind triangle)" control
expect control "and, at the same tick, a triangle" "e.get('ingredient')=='Change gain' and e['field']['expression']['terms'][1]['gain']['kind']=='triangle'"
shot record-02-recording
press_expect play sim-control
sleep 2
n=$(count history)
keys kd:cmd t:z ku:cmd
wait_log history $(( n + 1 ))
expect history "live undo of the triangle, while playing" "e['action']=='undo' and e['ok'] is True and e['label']=='Change gain'"
sleep 1.5
pause
law push enabled
law push enabled
expect control "two paused edits at the final tick" "e.get('law')=='push' and e['enabled'] is True"
layout
expect layout "recording: Stop, and progress toward the limits" "e['run']['state']=='recording' and e['run']['buttons']['stop'] and e['run']['meter'] is not None and e['run']['recording']['count'] > 10"
n=$(count recording)
press_expect run-stop recording
wait_log recording $(( n + 2 )) 10
expect recording "Stop froze the record at its final address, with a final check" "e['action']=='stopped' and e['stopped']=='user' and e['finalCheck'] is not None"
run_id=$(field recording runId)
final_tick=$(field recording finalTick)
final_cursor=$(field recording lastAppliedSequence)
say "recorded $run_id: final address ($final_tick, $final_cursor)"
# A third edit at the same tick, after the stop: the live scene changes, the record does not.
law push enabled
layout
expect layout "the post-stop edit left the record's final address" "e['run']['record']['lastAppliedSequence']==$final_cursor and e['run']['record']['finalTick']==$final_tick and e['run']['state']=='recorded'"
expect control "the post-stop edit applied to the live scene" "e.get('law')=='push' and e['enabled'] is False"
shot record-03-stopped

segment "session A: replay shows the recording, then Return to authoring"
activate
n=$(count context)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
expect context "replay: a second world from the frozen root, the authoring world kept" "e['reason']=='replay' and e['selected']=='replay' and e['replay']==1 and e['tick']==0 and e['cursor']==0"
select_law push
layout
expect layout "the replay shows the root's push (enabled, at -1.5), not the newer authored one" "e['selectedField']['id']=='push' and e['selectedField']['enabled'] is True and e['selectedField']['pose']['position'][0]==-1.5 and [l['id'] for l in e['laws']]==['calm','push','storm-bottle']"
expect layout "read-only replay: its title, Replay from start and Return to authoring, no Record" "e['run']['state']=='replay' and e['run']['title']=='Replay of “M6A lab”' and e['run']['buttons']['restart'] and e['run']['buttons']['return'] and not e['run']['buttons']['record']"
shot replay-01-root
press_expect play sim-control
wait_log replay-complete 1 $(( final_tick / 120 + 20 ))
expect replay-complete "the replay reached the frozen address and matched the recorded end" "e['runId']=='$run_id' and e['tick']==$final_tick and e['cursor']==$final_cursor and e['check']['kind']=='match'"
sleep 0.5
layout
expect layout "at the end: read-only, paused, the check shown" "e['run']['replay']['complete'] is True and e['run']['check'].startswith('Reached the recorded end exactly')"
shot replay-02-end
n=$(count file-control)
keys kd:cmd t:s ku:cmd
wait_log file-control $(( n + 1 ))
expect file-control "⌘S during replay saves nothing: ordinary Save Scene is off" "e['action']=='save' and e['outcome']=='refused' and e['reason']=='replay'"
n=$(count context-live)
press_expect run-return context
wait_log context-live $(( n + 1 )) 10
expect context "Return to authoring freed the replay world" "e['reason']=='return' and e['selected']=='authoring' and e['replay']==0 and e['tick']==$final_tick"
select_law push
layout
expect layout "the retained authoring scene is back: the push disabled after the stop" "e['selectedField']['id']=='push' and e['selectedField']['enabled'] is False"
verdict "the authoring world, revision and history are identical before and after the replay" retained $APP_LOG
shot replay-03-returned

segment "session A: save the recording and quit"
activate
n=$(count document)
press_panel run-save
save_panel $QA_STATE/scenes m6a-qa.lawsmith-run.json
wait_log document $(( n + 1 )) 15
expect document "Save Recording wrote the run file" "e['action']=='save-recording' and e['outcome']=='saved' and e['runId']=='$run_id' and e['bytes'] > 0"
record_stop
verdict "the saved run holds the multi-boundary drag, same-tick and terminal commands, the triangle and its undo" runfile $QA_STATE/scenes/m6a-qa.lawsmith-run.json
keys kd:cmd t:q ku:cmd
alert_for scene "Don't Save"
wait_exit
rec_log=$APP_LOG

segment "session B: a fresh launch opens and replays it"
launch m6a-replay $RECOVERY
activate
record_start m6a-replay 80
n=$(count document)
press_panel run-open
open_panel m6a-qa.lawsmith-run.json
wait_log document $(( n + 1 )) 15
expect document "Open Recording validated and committed the run" "e['action']=='open-recording' and e['outcome']=='committed' and e['runId']=='$run_id'"
expect context "it replays from tick 0, beside the untouched default scene" "e['selected']=='replay' and e['tick']==0 and e['cursor']==0"
# Visualization that session A never had: probes, every trail, one law's arrows, an explained body.
press_expect probes-toggle visualization
press_expect trails-all visualization
press_expect arrows-selected visualization
press_expect play sim-control
sleep 2.5
n=$(count lifecycle)
idle_gate; guard_front
osascript -e "tell application \"System Events\" to set visible of (first process whose unix id is $APP_PID) to false" >/dev/null
touched
wait_log lifecycle $(( n + 1 )) 5
hidden_tick=$(logq last $APP_LOG sim-control | python3 -I -c "import json,sys; print(json.load(sys.stdin)['tick'])")
sleep 3
activate
layout
expect sim-control "Hide paused the replay; nothing advanced while hidden" "e['action']=='pause' and e['tick']==$hidden_tick"
expect layout "still paused at the same tick after coming back: Play stays explicit" "e['run']['replay']['address']['tick']==$hidden_tick and e['run']['replay']['complete'] is False"
keys t:b
press_expect play sim-control
wait_log replay-complete 1 $(( final_tick / 120 + 20 ))
expect replay-complete "after a fresh launch, the same final address and a matching end check" "e['runId']=='$run_id' and e['tick']==$final_tick and e['cursor']==$final_cursor and e['check']['kind']=='match'"
shot replay-04-fresh-end
verdict "the fresh replay's end digests equal the recording's final check" final $rec_log $APP_LOG $run_id
verdict "every live checkpoint of the recording has an equal replay checkpoint" checkpoints $rec_log $APP_LOG $run_id
record_stop

segment "session B: the runtime's own M6A fixtures"
activate
press_expect run-return context
keys kd:shift t:m ku:shift
wait_log m6a-fixtures 1 300
expect m6a-fixtures "the linear oracle agrees with itself and the record; 20+20 cycles and 20 imports hold the counts" "e['pass'] is True and e['oracle']['divergence'] is None and e['oracle']['end']['matchesRecord'] is True and e['lifecycle']['peakWorlds'] <= e['lifecycle']['before']['worlds'] + 2"
n=$(count visual-resources)
keys kd:shift t:v ku:shift
wait_log visual-resources $(( n + 1 ))
expect visual-resources "steady state after the cycles: one authoring world, no replay or candidate" "e['contexts']['replay']==0 and e['contexts']['candidates']==0 and e['contexts']['selected']=='authoring'"
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m6a-record complete"
