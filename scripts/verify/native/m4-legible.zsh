# M4 legibility at 1280×800 in the packaged app (AC7; SPEC §11.1): with the default limits (2,000 probes,
# 32 trails) and a body explained, the selected law, its support and that body stay clear of every panel,
# nothing scrolls sideways, and probes and trails turn off without touching a law (no revision, nothing
# dirty). The built-in display offers 1280×800 only at More Space, so this switches to it for the login
# session and restores the previous mode on exit. Switches are set idempotently: overlay state is session
# state that survives a scene load, so each is pressed only when it differs from what the app reports.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m4-legible
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/why-it-moves.lawsmith.json $QA_STATE/scenes/

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
# set_probes true|false and set_trails off|selected|all: press only when the app reports otherwise.
set_probes() { layout; [[ $(field layout visualization.probes.enabled) == $1 ]] || press probes-toggle; layout; [[ $(field layout visualization.probes.enabled) == $1 ]] || fail "probes did not become $1" }
set_trails() { layout; [[ $(field layout visualization.trails.mode) == "\"$1\"" ]] || press trails-$1; layout; [[ $(field layout visualization.trails.mode) == "\"$1\"" ]] || fail "trails did not become $1" }

seed_folder $QA_STATE/scenes
segment "1280×800 legibility with the defaults (AC7), under More Space"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
launch legible4 $QA_STATE/recovery-legible4-$EPOCHSECONDS
activate
window_size 40 50 1280 800
keys kd:cmd t:o ku:cmd
open_panel why-it-moves.lawsmith.json
wait_log document 1 15
expect document "Why It Moves opened" "e['action']=='open' and e['outcome']=='committed'"
set_probes true
set_trails all
press play
sleep 5
press play
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
keys t:.
layout
expect layout "1280×800 with 2,000 probes and 32 trails: the selected law's support and the explained body are clear of the panels, tools, transport and switches; nothing scrolls sideways; the switches and primary controls are in view" "e['viewport']==[1280, 800] and e['visualization']['probes']['live']==2000 and e['visualization']['trails']['mode']=='all' and e['selected'] is not None and e['explained']['point'] is not None and all(not (a[0] < e['support'][2] and a[0] + a[2] > e['support'][0] and a[1] < e['support'][3] and a[1] + a[3] > e['support'][1]) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and all(not (a[0] - 6 <= e['explained']['point'][0] <= a[0] + a[2] + 6 and a[1] - 6 <= e['explained']['point'][1] <= a[1] + a[3] + 6) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and 0 < e['explained']['point'][0] < 1280 and 0 < e['explained']['point'][1] < 800 and all(s['scrollWidth'] <= s['clientWidth'] for s in e['scroll'].values()) and all(0 <= e['controls'][k][0] and e['controls'][k][0] + e['controls'][k][2] <= 1280 and e['controls'][k][1] + e['controls'][k][3] <= 800 for k in ('probes-toggle', 'trails-off', 'trails-all', 'play', 'reset', 'file-save'))"
shot m4-1280x800
set_probes false
set_trails off
expect visualization "probes and trails are off, every law untouched: no revision, nothing dirty" "e['probes']['enabled'] is False and e['trails']['mode']=='off' and e['revision']==0 and e['dirty'] is False"
layout
expect layout "both laws are still listed; revision 0 above shows neither was edited or disabled" "len(e['laws'])==2"
shot m4-1280x800-overlays-off
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m4-legible complete"
