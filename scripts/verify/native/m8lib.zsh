# M8 helpers over lib.zsh. Source after lib.zsh. lib.zsh keeps the shared GUI lock, the topmost-window
# and frontmost hit tests and the external-input abort; this adds the approved window's deadline, the
# display mode restore, examples, Interface Scale, focus walking and the layout assertions in m8q.py.
#
# QA_DEADLINE (epoch seconds) is the end of the owner-approved hands-off window. lib.zsh checks it
# before every input and native mutation; the M8 scenarios refuse to start without it.
: ${QA_DEADLINE:?set QA_DEADLINE to the end of the approved hands-off window, in epoch seconds}
[[ $QA_DEADLINE == <->(|.<->) ]] || { print -u2 "QA_DEADLINE must be epoch seconds"; exit 2 }

RECORDER=
ORIGINAL_MODE=$(osascript -l JavaScript $NATIVE/display.js get)
restore_mode() {
  local dimensions=${ORIGINAL_MODE%@*} hz=${ORIGINAL_MODE#*@}
  osascript -l JavaScript $NATIVE/display.js set ${=${dimensions/x/ }} $hz >/dev/null
  say "display restored to $ORIGINAL_MODE"
}
# Whatever happens: stop the owned recorder, the owned app, restore the display, release the lock.
trap '[[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; running && kill $APP_PID; restore_mode; restore_preferences; gui_unlock' EXIT

window_size() {
  require_lock "resizing the window"
  idle_gate 3; guard_front
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
    idle_gate; guard_front
    osascript -e 'tell application "System Events" to key code 48 using option down' >/dev/null; touched
    sleep 0.3
    layout
    m8q focus >/dev/null
    [[ $(logq last $APP_LOG layout | python3 -I -c "import json,sys; f=json.load(sys.stdin)['focus']; print(bool($1))") == True ]] && return 0
  done
  fail "Tab never reached a control where $1"
}

traffic_lights() { osascript -l JavaScript $NATIVE/lights.js $APP_PID $WIN_X $WIN_Y }
