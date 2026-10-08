# M6A legibility (SPEC §11.1): the recording controls at 1280×800 CSS content under More Space, and at the
# window's 900×600 minimum, in each state (idle, recording, recorded, replay at its end with the check
# shown). The cluster stays inside the viewport and clear of the Scene panel, the tools, the transport, the
# switches, the explained body's readout and the selected law's support, and nothing scrolls sideways.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m6a-legible
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/m6a-lab.lawsmith.json $QA_STATE/scenes/

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
pause() { [[ $(field sim-control action) == '"play"' ]] && press_expect play sim-control; sleep 0.3 }
select_law() {
  layout
  [[ $(logq field $APP_LOG layout selected) == "\"$1\"" ]] && return 0
  local p=(${=$(logq last $APP_LOG layout | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
b = next(l['select'] for l in e['laws'] if l['id'] == '$1')
print(round($WIN_X + b[0] + b[2] / 2), round($WIN_Y + b[1] + b[3] / 2))")})
  click_expect $p[1] $p[2] selection
}
# clear_of_everything STATE W H [ui]: the run cluster, in STATE, inside W×H and overlapping no other UI region
# and, unless `ui` is given, not the selected law's projected support either (SPEC §11.1 sets that at
# 1280×800). With `ui`, the support overlap is measured and reported, not gated.
clear_of_everything() {
  layout
  local scene=$([[ $4 == ui ]] && print 0 || print 1)
  expect layout "$1 at $2×$3: the recording controls are inside the window and clear of every other $([[ $4 == ui ]] && print 'UI region' || print 'region and the selected law')" "
(lambda r, others, w, h: e['run']['state']=='$1' and r is not None and 0 <= r[0] and r[0] + r[2] <= w and 0 <= r[1] and r[1] + r[3] <= h
  and all(o is None or r[0] + r[2] <= o[0] or o[0] + o[2] <= r[0] or r[1] + r[3] <= o[1] or o[1] + o[3] <= r[1] for o in others)
  and all(s['scrollWidth'] <= s['clientWidth'] for s in e['scroll'].values())
)(e['run']['box'], [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain', 'diagnostics')] + ([[e['support'][0], e['support'][1], e['support'][2] - e['support'][0], e['support'][3] - e['support'][1]]] if e['support'] and $scene else []), $2, $3)"
  say "run cluster $1 at $2×$3: $(logq field $APP_LOG layout run.box); selected support $(logq field $APP_LOG layout support)"
}

seed_folder $QA_STATE/scenes
segment "the recording controls at 1280×800 and at the minimum window"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
launch m6a-legible $QA_STATE/recovery-m6a-legible-$EPOCHSECONDS
activate
window_size 40 50 1280 800
keys kd:cmd t:o ku:cmd
open_panel m6a-lab.lawsmith.json
wait_log document 1 15
select_law storm-bottle
layout
expect layout "the content viewport is 1280×800 CSS, the Storm Bottle selected" "e['viewport']==[1280, 800] and e['selected']=='storm-bottle'"
clear_of_everything idle 1280 800
shot m6a-1280x800-idle
press_expect run-record recording
press_expect play sim-control
sleep 2
clear_of_everything recording 1280 800
shot m6a-1280x800-recording
pause
n=$(count recording)
press_expect run-stop recording
wait_log recording $(( n + 2 )) 10
clear_of_everything recorded 1280 800
press_expect run-replay context
select_law storm-bottle
press_expect play sim-control
sleep 1.5
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
wait_log replay-complete 1 30
sleep 0.5
clear_of_everything replay 1280 800
shot m6a-1280x800-replay-end
window_size 40 50 900 600
clear_of_everything replay 900 600 ui
shot m6a-900x600-replay-end
press_expect run-return context
clear_of_everything recorded 900 600 ui
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert_for recording "Don't Save"
sleep 1
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m6a-legible complete"
