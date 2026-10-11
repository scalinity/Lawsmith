# M8 helpers over lib.zsh. Source after lib.zsh. lib.zsh keeps the shared GUI lock, the topmost-window
# and frontmost hit tests and the external-input abort; this adds the approved window's deadline, the
# display mode restore, examples, Interface Scale, focus walking and the layout assertions in m8q.py.
#
# QA_DEADLINE (epoch seconds) is the end of the owner-approved hands-off window. lib.zsh checks it
# before every input and native mutation; the M8 scenarios refuse to start without it.
: ${QA_DEADLINE:?set QA_DEADLINE to the end of the approved hands-off window, in epoch seconds}
[[ $QA_DEADLINE == <->(|.<->) ]] || { print -u2 "QA_DEADLINE must be epoch seconds"; exit 2 }

RECORDER=
# Cleanup, whatever happens: stop the owned recorder and app (and let the app finish writing its
# preferences), restore the display and preferences this run changed, release the lock. A restoration
# that fails turns a passing run into a failure (exit 6); its receipt is in QA_OUT/cleanup.jsonl.
m8_cleanup() {
  local code=$? restored=1 i
  [[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null
  if running; then
    kill $APP_PID
    for i in {1..50}; do running || break; command sleep 0.1; done
  fi
  restore_display_mode || restored=0
  restore_preferences || restored=0
  gui_unlock
  if (( ! restored )); then
    say "cleanup could not restore everything; see cleanup.jsonl"
    (( code == 0 )) && code=6
  fi
  exit $code
}
trap m8_cleanup EXIT

window_size() {
  require_lock "resizing the window"
  idle_gate 3; guard_front; idle_gate 3
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set position of window \"Lawsmith\" to {40, 45}
    set size of window \"Lawsmith\" to {$1, $2}
  end tell" >/dev/null
  sleep 1
  window_origin
}

# m8q COMMAND [ARGS…]: one m8q.py assertion over this run's log; its verdict is kept in m8-checks.jsonl.
m8q() { local command=$1; shift; python3 -I $NATIVE/m8q.py $command $APP_LOG "$@" | tee -a $QA_OUT/m8-checks.jsonl; (( ${pipestatus[1]} == 0 )) || fail "M8 $command check failed" }

# set_scale PERCENT: ⌘0, then ⌘+ in 25% steps; the app reports each change.
set_scale() {
  local steps=$(( ($1 - 100) / 25 )) i
  keys kd:cmd t:0 ku:cmd
  for (( i = 0; i < steps; i++ )); do keys kd:cmd t:= ku:cmd; done
  sleep 0.5
  layout
  expect layout "Interface Scale $1%" "e['interfaceScale']==$1/100"
}

# open_example TITLE KEY: chooses TITLE from the examples pop-up menu by typing it, then Return. Any
# unsaved-work question is answered Don't Save: every scene here is disposable.
open_example() {
  local n=$(count document) guard
  press example-open
  sleep 0.6
  keys t:"$1"
  key_code 36
  for guard in 1 2; do
    sleep 0.6
    [[ $(depth) == 1 ]] || break
    if [[ $(axq buttons $APP_PID) == *'Save Recording…'* ]]; then alert_for recording "Don't Save"; else alert_for scene "Don't Save"; fi
  done
  wait_log document $(( n + 1 )) 15
  expect document "example $2 opened" "e['action']=='example' and e['outcome']=='committed' and e['title']=='$1'"
}

# tab_to PREDICATE [LIMIT]: Option-Tab until the focused control satisfies a Python predicate on `f` (the
# layout's focus), checking that every stop shows its focus ring inside the window.
# WebKit moves Tab only between text fields and lists unless macOS Keyboard navigation is on; Option-Tab
# reaches every control either way, so the walk neither depends on nor changes the owner's setting.
tab_to() {
  local i
  for (( i = 0; i < ${2:-120}; i++ )); do
    idle_gate 1; guard_front; idle_gate 1
    osascript -e 'tell application "System Events" to key code 48 using option down' >/dev/null; touched
    sleep 0.3
    layout
    m8q focus >/dev/null
    [[ $(logq last $APP_LOG layout | python3 -I -c "import json,sys; f=json.load(sys.stdin)['focus']; print(bool($1))") == True ]] && return 0
  done
  fail "Tab never reached a control where $1"
}

traffic_lights() { osascript -l JavaScript $NATIVE/lights.js $APP_PID $WIN_X $WIN_Y }

# drag_window DX DY: drags the window by a point in the drag band, clear of the traffic lights, from a
# fresh readback and window origin (lib.zsh's drag hit-tests both ends), and records the window's actual
# displacement in MOVED and in m8-checks.jsonl. A displacement other than the drag is the M1 jump watch.
# A drag that does not move the window at all is recorded as failed and stops the run: there is nothing
# to reverse, and no endpoint is ever assumed from the drag asked for (M8 R21).
drag_window() {
  layout
  local band=(${=$(logq field $APP_LOG layout controls.drag-region | tr -d '[],')})
  (( $#band == 4 )) || fail "no drag band in the layout"
  local x=$(( WIN_X + ${band[1]%.*} + (${band[3]%.*} > 300 ? 200 : ${band[3]%.*} / 2) )) y=$(( WIN_Y + ${band[2]%.*} + ${band[4]%.*} / 2 ))
  local before=($WIN_X $WIN_Y)
  drag $x $y $(( x + $1 )) $(( y + $2 )) 16
  sleep 0.6
  window_origin
  local dx=$(( WIN_X - before[1] )) dy=$(( WIN_Y - before[2] ))
  local pass=$(( dx == $1 && dy == $2 ? 1 : 0 ))
  print -r -- "{\"check\":\"window-drag\",\"pass\":$( (( pass )) && print true || print false ),\"scale\":$(field layout interfaceScale),\"from\":[$x,$y],\"asked\":[$1,$2],\"moved\":[$dx,$dy]}" >> $QA_OUT/m8-checks.jsonl
  MOVED=($dx $dy)
  if (( dx == 0 && dy == 0 )); then
    fail "the window did not move for a ($1,$2) drag from the drag band at ($x,$y)"
  elif (( ! pass )); then
    say "WATCH: the window moved ($dx,$dy) for a ($1,$2) drag from the drag band (M1 jump watch)"
  else
    say "window moved exactly ($dx,$dy) from the drag band"
  fi
}

# window_round_trip DX DY: drags the window, then back by the displacement it actually made.
window_round_trip() {
  drag_window $1 $2
  local back=($(( -MOVED[1] )) $(( -MOVED[2] )))
  drag_window $back[1] $back[2]
}
