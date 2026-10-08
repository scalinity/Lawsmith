# M5 legibility at 1280×800 in the packaged app (SPEC §11.1; MILESTONES M5 visual QA): the Storm Bottle in
# the stream, selected, its drag ingredient open with its mask's fields, and a body explained. The bottle's
# support and that body stay clear of every panel, nothing scrolls sideways, the opened editor's top is in
# view, and the primary controls are reachable: the transport and history in view, Save within the
# panel's width (it scrolls vertically to the editor; ⌘S needs no scrolling). A one-leaf law's added rows are measured beside it, since
# the panel's height (M2 finding 8) belongs to M8 and M5 must not make it materially worse.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m5-legible
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/storm-bottle.lawsmith.json $QA_STATE/scenes/

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
reveal() {
  local i p panel
  for i in {1..30}; do
    layout
    p=(${=$(box "$1")})
    [[ -n $p[1] ]] || fail "the layout has no box for $1"
    panel=(${=$(logq field $APP_LOG layout controls.panel | tr -d '[],')})
    if (( p[3] >= panel[2] + 4 && p[3] + p[4] <= panel[2] + panel[4] - 4 )); then
      click $p[1] $p[2]
      return 0
    fi
    local sx=$(( WIN_X + ${panel[1]%.*} + 8 )) sy=$(( WIN_Y + ${panel[2]%.*} + ${panel[4]%.*} / 2 ))
    if (( p[3] < panel[2] + 4 )); then scroll_at $sx $sy 120; else scroll_at $sx $sy -120; fi
  done
  fail "could not bring $1 into the panel's view"
}

seed_folder $QA_STATE/scenes
segment "1280×800 with the Storm Bottle's ingredient editor open, under More Space"
LARGER_TEXT=$(screen_size)
trap 'running && kill $APP_PID; restore_display; gui_unlock' EXIT
display_mode 1728 1117
[[ $(screen_size) != $LARGER_TEXT ]] || fail "the display did not change mode"
launch legible5 $QA_STATE/recovery-legible5-$EPOCHSECONDS
activate
window_size 40 50 1280 800
layout
expect layout "the content viewport is 1280×800 CSS" "e['viewport']==[1280, 800]"
say "one-leaf law (the recipe): the ingredient rows add $(logq field $APP_LOG layout ingredients.box | python3 -I -c 'import json,sys; print(round(json.load(sys.stdin)[3]))') px below its fade field; panel scroll height $(logq field $APP_LOG layout scroll.panel.scrollHeight) of $(logq field $APP_LOG layout scroll.panel.clientHeight) visible"
shot m5-1280x800-one-leaf
keys kd:cmd t:o ku:cmd
open_panel storm-bottle.lawsmith.json
sleep 1.2
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_log document 1 15
expect document "Storm Bottle opened" "e['action']=='open' and e['outcome']=='committed'"
press play
sleep 1
drag_law_to 3.2 1.6 0 0 1.6 0
sleep 6
press play
reveal "next(r['select'] for r in e['ingredients']['rows'] if r['label']=='Drag')"
sleep 0.5
n=$(count explain-select)
keys t:b
wait_log explain-select $(( n + 1 ))
keys t:.
layout
expect layout "the bottle, its support and the explained body are clear of the panels, tools, transport and switches; nothing scrolls sideways; the opened editor's top is in view; the transport and history are in view and Save is in the panel's width" "e['viewport']==[1280, 800] and e['selected']=='storm-bottle' and e['ingredients']['focus']==[2] and e['explained']['point'] is not None and all(not (a[0] < e['support'][2] and a[0] + a[2] > e['support'][0] and a[1] < e['support'][3] and a[1] + a[3] > e['support'][1]) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and all(not (a[0] - 6 <= e['explained']['point'][0] <= a[0] + a[2] + 6 and a[1] - 6 <= e['explained']['point'][1] <= a[1] + a[3] + 6) for a in [e['controls'][k] for k in ('panel', 'tools', 'transport', 'overlays', 'explain')]) and all(s['scrollWidth'] <= s['clientWidth'] for s in e['scroll'].values()) and e['controls']['panel'][1] <= e['ingredients']['detail'][1] <= e['controls']['panel'][1] + e['controls']['panel'][3] - 40 and all(0 <= e['controls'][k][0] and e['controls'][k][0] + e['controls'][k][2] <= 1280 and 0 <= e['controls'][k][1] and e['controls'][k][1] + e['controls'][k][3] <= 800 for k in ('play', 'reset', 'undo', 'redo')) and 0 <= e['controls']['file-save'][0] and e['controls']['file-save'][0] + e['controls']['file-save'][2] <= 296"
shot m5-1280x800-storm
say "rects: $(logq last $APP_LOG layout | python3 -I -c 'import json,sys; e=json.load(sys.stdin); print({k: e["controls"][k] for k in ("panel","explain","tools","transport","overlays")}, "support", [round(v) for v in e["support"]], "body", [round(v) for v in e["explained"]["point"]], "detail", e["ingredients"]["detail"])')"
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
restore_display
[[ $(screen_size) == $LARGER_TEXT ]] || fail "the display was not restored"
say "m5-legible complete"
