# M6A guards and imports in the packaged app (AC6, AC9; T06): with a dirty main scene and an unsaved
# recording, Quit asks about the scene first from authoring and about the recording first from replay;
# a later Cancel keeps an earlier staged Discard uncommitted and an earlier Save saved, and returns to the
# same paused context. Invalid, incompatible and scene-shaped files opened from a replay change nothing;
# a valid one replaces the replay. Finally, quitting from replay saves the retained main authored scene,
# never the replay's laws, and a relaunch offers no stale recovery.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6a-guard
source ${0:A:h}/lib.zsh
RECOVERY=$QA_STATE/recovery-m6a-guard-$EPOCHSECONDS
SCENES=$QA_STATE/scenes
mkdir -p $RECOVERY $SCENES
cp ${NATIVE:h}/scenes/m6a-lab.lawsmith.json $SCENES/
rm -f $SCENES/guard-run.lawsmith-run.json $SCENES/broken.lawsmith-run.json $SCENES/foreign.lawsmith-run.json

box() {
  logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
try:
    b = $1
except (StopIteration, KeyError, IndexError, TypeError):
    b = None
if b: print(round($WIN_X + b[0] + b[2] / 2), round($WIN_Y + b[1] + b[3] / 2))"
}
law() { layout; local p=(${=$(box "next(l['$2'] for l in e['laws'] if l['id']=='$1')")}); click_expect $p[1] $p[2] $([[ $2 == select ]] && print selection || print control) }
pause() { [[ $(field sim-control action) == '"play"' ]] && press_expect play sim-control; sleep 0.3 }
open_run() {
  local n=$(count document)
  press_panel run-open
  open_panel $1
  wait_log document $(( n + 1 )) 15
}

seed_folder $SCENES

segment "a recording and a dirty scene; Quit from authoring"
launch m6a-guard $RECOVERY
activate
keys kd:cmd t:o ku:cmd
n=$(count document)
open_panel m6a-lab.lawsmith.json
wait_log document $(( n + 1 )) 15
press_expect run-record recording
press_expect play sim-control
sleep 1.2
law storm-bottle enabled
sleep 1
law storm-bottle enabled
pause
n=$(count recording)
press_expect run-stop recording
wait_log recording $(( n + 2 )) 10
run_id=${$(field recording runId)//\"/}
law calm enabled
expect control "the scene is edited after the recording: dirty" "e.get('law')=='calm' and e['enabled'] is False"
sleep 1.5
[[ -n $(ls $RECOVERY) ]] || fail "no recovery snapshot was written for the dirty scene"
recovery_before=$(ls $RECOVERY)
keys kd:cmd t:q ku:cmd
alert_for scene "Don't Save"
alert_for recording "Cancel"
sleep 0.8
running || fail "Lawsmith quit although the recording's question was canceled"
choices=$(logq all $APP_LOG guard | python3 -I -c "import json,sys; print(json.dumps([(e['item'], e['choice']) for e in map(json.loads, sys.stdin) if 'item' in e]))")
[[ $choices == '[["scene", "discard"], ["recording", "cancel"]]' ]] || fail "the guard's choices were $choices"
say "PASS  [guard] the scene was asked first (Discard, staged), then the recording (Cancel): $choices"
layout
expect layout "the recording is kept, unsaved, in authoring" "e['run']['state']=='recorded' and e['run']['record']['exported'] is False and e['run']['record']['runId']=='$run_id'"
[[ -n $(ls $RECOVERY) && $(ls $RECOVERY) == $recovery_before ]] || fail "the staged Discard retired recovery although the transition was canceled"
say "PASS  [recovery] the staged Discard was not committed: the recovery snapshots are still there ($recovery_before)"
shot guard-01-canceled

segment "from replay: Save Recording, then Cancel the scene"
activate
press_expect run-replay context
press_expect play sim-control
sleep 1.5
pause
layout
address=$(logq field $APP_LOG layout run.replay.address)
keys kd:cmd t:w ku:cmd
alert_for recording "Save Recording…"
save_panel $SCENES guard-run.lawsmith-run.json
alert_for scene "Cancel"
sleep 0.8
running || fail "Lawsmith closed although the scene's question was canceled"
choices=$(logq all $APP_LOG guard | python3 -I -c "import json,sys; print(json.dumps([(e['item'], e['choice']) for e in map(json.loads, sys.stdin) if 'item' in e][-2:]))")
[[ $choices == '[["recording", "save"], ["scene", "cancel"]]' ]] || fail "from replay the guard's choices were $choices"
say "PASS  [guard] from replay the recording was asked first (Save Recording), then the scene (Cancel): $choices"
expect document "the guard saved the recording" "e['action']=='save-recording' and e['outcome']=='saved' and e['runId']=='$run_id'"
layout
expect layout "the same paused replay, at the same address; the recording now saved" "e['run']['state']=='replay' and e['run']['replay']['address']==$address and e['run']['record']['exported'] is True"
shot guard-02-replay-kept

segment "files opened from replay: invalid, foreign and scene-shaped ones change nothing"
python3 -I - $SCENES <<'EOF'
import json, sys
d = sys.argv[1]
text = open(f"{d}/guard-run.lawsmith-run.json", encoding="utf-8").read()
open(f"{d}/broken.lawsmith-run.json", "w").write(text.replace('"sequence":2,', '"sequence":3,', 1))
run = json.loads(text)
run["qualification"]["webkit"] = run["qualification"]["webkit"] + ".1"
open(f"{d}/foreign.lawsmith-run.json", "w").write(json.dumps(run, indent=1))
EOF
activate
unchanged() {
  layout
  expect layout "after $1: the same replay, run and address, and no candidate left" "e['run']['state']=='replay' and e['run']['record']['runId']=='$run_id' and e['run']['replay']['address']==$address and e['run']['contexts']['candidates']==0"
}
open_run broken.lawsmith-run.json
expect document "a malformed run is refused at its path" "e['action']=='open-recording' and e['outcome']=='rejected' and e['path']=='commands[1].sequence' and e['incompatible'] is False"
unchanged broken.lawsmith-run.json
open_run foreign.lawsmith-run.json
expect document "a run from another runtime is refused as incompatible, never replayed as exact" "e['outcome']=='rejected' and e['incompatible'] is True and e['path']=='qualification' and 'webkit' in e['reason']"
unchanged foreign.lawsmith-run.json
open_run m6a-lab.lawsmith.json
expect document "a scene opened as a recording is refused with the right command named" "e['outcome']=='rejected' and e['path']=='format' and 'Open Scene' in e['reason']"
unchanged m6a-lab.lawsmith.json
open_run guard-run.lawsmith-run.json
expect document "the saved run opened from replay, with no question (it is saved)" "e['action']=='open-recording' and e['outcome']=='committed' and e['runId']=='$run_id'"
layout
expect layout "a fresh replay of it, from tick 0" "e['run']['state']=='replay' and e['run']['replay']['address']=={'tick': 0, 'cursor': 0} and e['run']['contexts']['replay']==1"
shot guard-03-imports

segment "Quit from replay saves the main authored scene, never the replay"
activate
keys kd:cmd t:q ku:cmd
# From replay the scene's alert names the main authored scene (SPEC §15.3).
alert_for scene "Save Main Scene"
wait_exit
python3 -I - $SCENES/m6a-lab.lawsmith.json <<'EOF' | tee -a $QA_OUT/qa-steps.log
import json, sys
d = json.load(open(sys.argv[1]))
calm = next(f for f in d["semantic"]["fields"] if f["id"] == "calm")
print("PASS  [file] the saved scene is the authored one (calm disabled), not the replay's root" if calm["enabled"] is False else "FAIL  [file] the saved scene holds the replay's calm")
EOF
grep -q "FAIL  \[file\]" $QA_OUT/qa-steps.log && fail "the main authored scene was not what the guard saved"
launch m6a-guard-relaunch $RECOVERY
expect recovery "the relaunch finds no recovery to offer: the saved scene retired it" "e['action']=='launch' and e['current']=='absent' and e['previous']=='absent'"
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && fail "a clean relaunch asked to save"
wait_exit
say "m6a-guard complete"
