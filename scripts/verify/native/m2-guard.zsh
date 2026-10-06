# M2 unsaved-work guard and launch recovery in the packaged app (AC9, AC10): Close, Quit and Dock
# Quit share one guard; Cancel keeps everything; Close and Quit together raise one alert; Save in
# the guard saves first; a crash is recovered at the next launch; a corrupt newest snapshot offers the
# older one; an Open asks before replacing unsaved work; saved or discarded work never comes back.
# Needs QA_STATE/scenes/calibration.lawsmith.json (any valid scene).
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m2-guard
source ${0:A:h}/lib.zsh
stamp=$EPOCHSECONDS

recovery_files() { ls $1 2>/dev/null | grep -c lawsmith-recovery }
fresh() { launch $1 $2; activate }
nothing_offered() {
  launch $1 $2
  expect recovery "saved or discarded work is not offered after restart" "e['action']=='launch' and e['current']=='absent' and e['previous']=='absent'"
  activate; keys kd:cmd t:q ku:cmd; wait_exit
}
dock_quit() { osascript -e 'tell application id "local.lawsmith" to quit' >/dev/null 2>&1; touched }

seed_folder $QA_STATE/scenes

# --- Cancel keeps everything: Close, Quit and Dock Quit -------------------------------------------
segment "guard: cancel, coalesce, discard"
R1=$QA_STATE/recovery-guard-1-$stamp
fresh guard-a $R1
toggle_law
sleep 1.5
expect recovery "the edit is kept in a recovery snapshot" "e['action']=='write' and e['revision']>=1"
for request in close quit dock; do
  n=$(count guard)
  case $request in
    close) keys kd:cmd t:w ku:cmd ;;
    quit) keys kd:cmd t:q ku:cmd ;;
    dock) dock_quit ;;
  esac
  wait_depth 1
  [[ $request == close ]] && shot guard-01-alert
  alert Cancel
  sleep 0.8
  running || fail "$request with Cancel closed the app"
  expect guard "$request then Cancel keeps the app open with edits unfrozen" "e.get('frozen') is False"
  activate
done
(( $(recovery_files $R1) >= 1 )) || fail "Cancel retired recovery"
say "PASS  recovery eligibility survived three canceled requests"
keys kd:cmd t:z ku:cmd
expect history "undo still works after the canceled guards" "e['action']=='undo' and e['ok'] is True"
keys kd:cmd,shift t:z ku:cmd,shift
expect history "redo restores the edit" "e['action']=='redo' and e['ok'] is True"

# Quit while the Close alert is up joins the running guard: one alert; Don't Save discards and exits.
# (AppKit holds a quit Apple Event while an alert is up, so the second request is ⌘Q, as a person would.)
keys kd:cmd t:w ku:cmd
wait_depth 1
keys kd:cmd t:q ku:cmd
sleep 0.8
(( $(depth) == 1 )) || fail "a second alert appeared"

grep -q '"outcome":"coalesced"' $APP_LOG || fail "the second request was not coalesced"
say "PASS  simultaneous Close and Quit coalesced into one guard"
alert "Don't Save"
wait_exit
expect recovery "Don't Save retired this generation's recovery" "e['action']=='discard'"
(( $(recovery_files $R1) == 0 )) || fail "discarded work is still on disk"
nothing_offered guard-b $R1

# --- Save in the guard ---------------------------------------------------------------------------
segment "guard: save"
R2=$QA_STATE/recovery-guard-2-$stamp
fresh guard-c $R2
toggle_law
sleep 1.5
keys kd:cmd t:q ku:cmd
alert Save
save_panel $QA_STATE/scenes guard-saved.lawsmith.json
wait_exit
expect document "Save in the guard saved through Save As before quitting" "e['action']=='save-as' and e['outcome']=='saved' and e['recoveryRetired'] is True"
[[ -s $QA_STATE/scenes/guard-saved.lawsmith.json ]] || fail "the guard's save wrote nothing"
nothing_offered guard-d $R2

# --- A crash is recovered at the next launch ---------------------------------------------------------
segment "recovery after a crash"
R3=$QA_STATE/recovery-guard-3-$stamp
fresh guard-e $R3
toggle_law
sleep 1.5
toggle_law
sleep 1.5
expect recovery "the latest revision is in recovery before the crash" "e['action']=='write' and e['revision']>=2"
kill -9 $APP_PID
say "the test instance was killed (simulated crash)"
launch guard-f $R3
activate
expect recovery "the crashed session's work is found at launch" "e['action']=='launch' and isinstance(e['current'], dict) and e['current']['revision']>=2"
layout
[[ $(logq field $APP_LOG layout controls.recovery-accept) != null ]] || fail "no recovery offer is shown"
shot guard-02-recovery-offer
controls=$(count control)
toggle_law
(( $(count control) == controls )) || fail "a law edit went through while the recovery offer was waiting"
say "PASS  editing is frozen while the recovery offer waits"
press recovery-accept
wait_log document 1 15
expect document "Recover opens the work unbound, paused at tick 0" "e['action']=='recover' and e['outcome']=='committed' and e['file'] is None"
sleep 1.5
expect recovery "recovered work is written as a snapshot of this session" "e['action']=='write' and e['generation']==2"
shot guard-03-recovered
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
nothing_offered guard-g $R3

# --- A corrupt newest snapshot offers the older one --------------------------------------------------
segment "corrupt newest snapshot"
R4=$QA_STATE/recovery-guard-4-$stamp
fresh guard-h $R4
toggle_law
sleep 1.5
toggle_law
sleep 1.5
kill -9 $APP_PID
print -n 'not a snapshot {' > $R4/current.lawsmith-recovery.json
say "the newest snapshot was overwritten with invalid bytes"
launch guard-i $R4
activate
expect recovery "the corrupt newest copy is reported and the previous one found" "e['action']=='launch' and 'invalid' in e['current'] and isinstance(e['previous'], dict)"
layout
shot guard-04-older-offer
press recovery-discard
sleep 1
grep -q '"action":"discard-launch"' $APP_LOG || fail "the launch Discard was not acknowledged"
expect recovery "the offer is resolved by Discard" "e['action']=='offer-resolved' and e['outcome'] is True"
(( $(recovery_files $R4) == 0 )) || fail "discarded launch recovery is still on disk"
activate
keys kd:cmd t:q ku:cmd
wait_exit
nothing_offered guard-j $R4

# --- Open asks before replacing unsaved work -------------------------------------------------------
segment "open replaces unsaved work"
R5=$QA_STATE/recovery-guard-5-$stamp
fresh guard-k $R5
toggle_law
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel calibration.lawsmith.json
alert Cancel
wait_log document $(( n + 1 )) 10
expect document "a canceled replacement keeps the scene and frees the candidate" "e['action']=='open' and e['outcome']=='canceled' and e['stage']=='guard'"
activate
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel calibration.lawsmith.json
alert "Don't Save"
wait_log document $(( n + 1 )) 10
expect document "Don't Save lets the opened scene replace the unsaved one" "e['action']=='open' and e['outcome']=='committed'"
activate
keys kd:cmd t:q ku:cmd
wait_exit
nothing_offered guard-l $R5
say "m2-guard complete"
