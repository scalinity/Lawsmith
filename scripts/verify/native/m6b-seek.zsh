# M6B visual QA in the packaged app (MILESTONES M6B Visual QA; AC1, AC2, AC4, AC5, AC8, AC9). On the M6A
# lab scene a real intervention is recorded: the stream plays, the push is dragged across it, the Storm
# Bottle is disabled and enabled, and two paused edits end it. In its replay the timeline seeks before the
# intervention, plays through it, seeks forward to its result and back again (restoring checkpoints), and
# is scrubbed so that newer requests supersede older ones. After a seek no trail is stored or drawn and the
# status says trails start again; steps rebuild them. Played on to the end, the replay matches the recorded
# final check. m6bq.py then reads the log in order: every replay checkpoint, from whichever world produced
# it (built from the root or restored by a seek), equals the live recording's at its address. Last, the
# app's own M6B fixtures (Shift+C) on this recording.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6b-seek
source ${0:A:h}/lib.zsh
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; running && kill $APP_PID; gui_unlock' EXIT
RECOVERY=$QA_STATE/recovery-m6b-seek-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes
cp ${NATIVE:h}/scenes/m6a-lab.lawsmith.json $QA_STATE/scenes/

m6bq() { python3 -I $NATIVE/m6bq.py "$@" }
verdict() {
  local description=$1; shift
  local result=$(m6bq "$@")
  say "${result%% *}  [m6bq $1] $description: ${result#* }"
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
# reveal EXPR [KIND]: scrolls the Scene panel until that box is in view, then clicks it (as m6a-record).
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
law() { reveal "next(l['$2'] for l in e['laws'] if l['id']=='$1')" $([[ $2 == select ]] && print selection || print control) }
select_law() { layout; [[ $(logq field $APP_LOG layout selected) == "\"$1\"" ]] || law $1 select }
pause() { [[ $(field sim-control action) == '"play"' ]] && press_expect play sim-control; sleep 0.3 }
last_seek_id() { [[ $(count seek) == 0 ]] && print 0 || logq field $APP_LOG seek id }
# seek_to TICK [TIMEOUT_S]: clicks the replay timeline at TICK (resent once if no request follows) and
# waits for that request to end: committed, or nothing to do because the replay already shows it.
seek_to() {
  layout
  local p=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $1)}) n=$(count seek) i action
  click $p[1] $p[2]
  for i in {1..10}; do (( $(count seek) > n )) && break; sleep 0.1; done
  if (( $(count seek) == n )); then
    say "the synthetic click on the timeline was lost (no seek event); sending it again"
    click $p[1] $p[2]
  fi
  local deadline=$(( EPOCHREALTIME + ${2:-30} ))
  while :; do
    action=$(logq field $APP_LOG seek action)
    [[ $action == '"committed"' || $action == '"shown"' ]] && break
    [[ $action == '"failed"' || $action == '"refused"' ]] && fail "the seek to $1 ended $action"
    (( EPOCHREALTIME > deadline )) && fail "the seek to $1 did not end"
    sleep 0.2
  done
  say "seek: $(logq last $APP_LOG seek | python3 -I -c "import json,sys; e=json.load(sys.stdin); print(e['action'], e.get('target'), 'from', (e.get('source') or {}).get('kind'), e.get('source', {}) and (e.get('source') or {}).get('address'), 'steps', e.get('steps'), 'ms', e.get('elapsedMs'))")"
}

seed_folder $QA_STATE/scenes

segment "record an intervention on the lab scene"
launch m6b-seek $RECOVERY
activate
keys kd:cmd t:o ku:cmd
n=$(count document)
open_panel m6a-lab.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "the M6A lab opened transactionally" "e['action']=='open' and e['outcome']=='committed'"
expect qualification "the packaged build reports a complete, qualified identity" "e['qualified'] is True and e['identity']['build']=='packaged'"
record_start m6b-seek 170
n=$(count recording)
press_expect run-record recording
wait_log recording $(( n + 1 )) 10
press_expect play sim-control
sleep 3
layout
before_tick=$(logq field $APP_LOG layout run.recording.tick)
select_law push
drag_law_to -1.5 1 0 0.4 1 0
expect gesture "the push dragged across the stream while it played" "e['phase']=='commit' and e['samples'] > 3"
layout
after_tick=$(logq field $APP_LOG layout run.recording.tick)
sleep 1
law storm-bottle enabled
sleep 1.5
law storm-bottle enabled
sleep 2.5
pause
law push enabled
law push enabled
n=$(count recording)
press_expect run-stop recording
wait_log recording $(( n + 2 )) 10
expect recording "stopped by the user, with a final check" "e['action']=='stopped' and e['stopped']=='user' and e['finalCheck'] is not None"
run_id=${$(field recording runId)//\"/}
final_tick=$(field recording finalTick)
say "recorded $run_id to tick $final_tick; the drag began after tick $before_tick and ended by tick $after_tick"

segment "replay: seek before the intervention, play through it, seek forward to its result and back"
n=$(count context)
press_expect run-replay context
wait_log context $(( n + 1 )) 10
layout
expect layout "the replay offers a timeline over the whole recording" "e['run']['state']=='replay' and e['run']['timeline'] is not None and e['run']['timeline']['max']==$final_tick and e['run']['timeline']['value']==0"
shot seek-01-replay
seek_to $(( before_tick - 120 ))
expect seek "before the intervention: nothing cached yet, so rebuilt from the root, out of sight" "e['action']=='committed' and e['source']['kind']=='root' and e['address']==e['target']"
layout
expect layout "the replay shows the requested address, paused, read-only" "e['run']['replay']['address']==$(field seek target) and e['run']['state']=='replay' and not e['run']['seeking']"
shot seek-02-before-intervention
press_expect play sim-control
sleep 5
pause
seek_to $(( after_tick + 200 ))
expect seek "forward to the intervention's result, from a checkpoint" "e['action']=='committed' and e['source']['kind']=='checkpoint' and e['address']==e['target']"
shot seek-03-after-intervention
seek_to $(( before_tick + 30 ))
expect seek "back before it again, restored from a checkpoint at or before the target" "e['action']=='committed' and e['source']['kind']=='checkpoint' and e['source']['address']['tick'] <= e['target']['tick']"
press_expect play sim-control
sleep 4
pause

segment "trails start again after a seek, and rebuild from steps"
press trails-all
press_expect play sim-control
sleep 2
pause
layout
expect layout "trails are stored and drawn while the replay plays" "e['visualization']['trails']['count'] > 0 and e['visualization']['drawn']['trailVertices'] > 0"
seek_to $(( after_tick + 40 ))
layout
expect layout "after the seek no trail is stored or drawn, and the status says they start again" "e['visualization']['trails']['count']==0 and e['visualization']['drawn']['trailVertices']==0 and 'Trails start again from here.' in e['run']['status']"
shot seek-04-trails-start-again
press_expect play sim-control
sleep 1.5
pause
layout
expect layout "steps rebuild trails from the seek's address on" "e['visualization']['trails']['count'] > 0 and 'Trails start again' not in e['run']['status']"
shot seek-05-trails-rebuilt
press trails-selected

segment "scrub: newer requests supersede older ones; only the newest becomes visible"
layout
since=$(last_seek_id)
from=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $(( final_tick / 5 )))})
to=(${=$(logq timeline $APP_LOG $WIN_X $WIN_Y $(( final_tick * 4 / 5 )))})
drag $from[1] $from[2] $to[1] $to[2] 40
deadline=$(( EPOCHREALTIME + 30 ))
while [[ $(logq field $APP_LOG seek action) != '"committed"' ]]; do
  (( EPOCHREALTIME > deadline )) && fail "the scrub's last seek did not commit"
  sleep 0.2
done
layout
verdict "every commit was the newest request; the last request is shown" latest $APP_LOG $since
shot seek-06-scrubbed

segment "play on to the recorded end"
seek_to $(( final_tick - 300 ))
press_expect play sim-control
wait_log replay-complete 1 30
expect replay-complete "the replay reached the recorded end exactly after the seeks" "e['check']['kind']=='match' and e['tick']==$final_tick"
shot seek-07-end
record_stop
verdict "every replay checkpoint equals the live recording's, including those from restored worlds" checkpoints $APP_LOG $run_id
verdict "every committed seek held exactly its target; nothing superseded or canceled committed" seeks $APP_LOG

segment "the app's M6B fixtures on this recording (Shift+C)"
n=$(count context)
press_expect run-return context
wait_log context $(( n + 1 )) 10
keys kd:shift t:c ku:shift
wait_log m6b-fixtures 1 300
expect m6b-fixtures "the M6B fixtures in this runtime pass" "e['pass'] is True and not e['divergent'] and e['compared'] > 40"
verdict "the retained authoring world's digests, at every switch since the replay began, never changed" retained $APP_LOG
say "fixtures: $(logq last $APP_LOG m6b-fixtures | python3 -I -c "import json,sys; e=json.load(sys.stdin); print('compared', e['compared'], e['sources'], 'cached drawn ms (p50 p95 p99 max)', e['cached']['drawnMs'], e['latencyGate'], 'uncached', e['uncached'], e['uncachedGate'], 'cancel', e['cancel'], 'peak worlds', e['lifecycle']['peakWorlds'])")"
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
sleep 1
[[ $(depth) == 1 ]] && alert_for recording "Don't Save"
wait_exit
say "m6b-seek complete"
