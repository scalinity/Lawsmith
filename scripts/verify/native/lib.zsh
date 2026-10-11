# Native QA helpers for the packaged Lawsmith.app on macOS. Source this file from a scenario.
#
# Every launch uses disposable state: QA_STATE holds recovery directories and scene files, and
# QA_OUT receives logs and captures. Input is guarded twice:
#   - before every pointer action, the topmost on-screen window at that point must belong to the
#     Lawsmith process under test (by PID), and keys require that process to be frontmost;
#   - the idle gate yields to the owner: any keyboard or mouse input newer than the harness's own
#     last synthetic event aborts the scenario (exit 4), so a run never fights a person.
# Synthetic events reset the HID idle timer, so the gate compares it with our own last event.

zmodload zsh/datetime
NATIVE=${${(%):-%x}:A:h}
REPO=${NATIVE:h:h:h}
APP=${APP:-$REPO/src-tauri/target/release/bundle/macos/Lawsmith.app}
: ${QA_STATE:?set QA_STATE to a disposable directory}
: ${QA_OUT:?set QA_OUT to the evidence output directory}
QA_IDLE=${QA_IDLE:-15}
mkdir -p $QA_STATE $QA_OUT
APP_PID=
APP_LOG=
LAST_INPUT=0
WIN_X=0
WIN_Y=0

# --- Shared screen: other agents on this Mac drive the GUI too ------------------------------------
# Every focus-changing segment (input, activation, app launch) holds an exclusive flock(2) on a lock
# file other sessions also take, and keeps each segment short (aim ≤ 2 minutes). The holder is a small
# process that releases when the segment ends or when this script exits for any reason.
GUI_LOCK=${GUI_LOCK:-/private/tmp/mac-gui-automation.lock}
LOCK_HOLDER=
lock_count=0

gui_lock() {
  gui_unlock
  local flag=$QA_STATE/.gui-lock-$$-$(( ++lock_count ))
  python3 -I -c '
import fcntl, json, os, sys, time
parent = os.getppid()
lock = open(sys.argv[1], "a+")
fcntl.flock(lock, fcntl.LOCK_EX)
lock.seek(0); lock.truncate()
lock.write(json.dumps({"pid": parent, "label": sys.argv[2], "sinceMs": int(time.time() * 1000)})); lock.flush()
open(sys.argv[3], "w").write("held")
while os.getppid() == parent:
    time.sleep(0.25)
' $GUI_LOCK "lawsmith-m2: $1" $flag &
  LOCK_HOLDER=$!
  local waited=0
  while [[ ! -s $flag ]]; do
    sleep 0.25
    (( ++waited % 240 == 0 )) && print -r -- "[qa] still waiting for the shared GUI lock ($1)"
    kill -0 $LOCK_HOLDER 2>/dev/null || fail "the GUI lock holder exited"
  done
}

gui_unlock() {
  [[ -n $LOCK_HOLDER ]] || return 0
  kill $LOCK_HOLDER 2>/dev/null
  wait $LOCK_HOLDER 2>/dev/null
  LOCK_HOLDER=
}
trap gui_unlock EXIT

# segment LABEL: ends the previous segment, takes the shared lock, then waits for quiet input.
segment() {
  gui_lock "$1"
  say "segment: $1"
  wait_quiet
}

say() { print -r -- "[qa $(strftime %H:%M:%S $EPOCHSECONDS)] $*" | tee -a $QA_OUT/qa-steps.log }
fail() { say "FAIL: $*"; [[ -n $RECORDER ]] && kill $RECORDER 2>/dev/null; exit ${2:-1} }
idle_seconds() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1e9; exit}' }
logq() { python3 -I $NATIVE/logq.py "$@" }

# Waits until nobody has touched the keyboard or mouse for QA_IDLE seconds (gives up after ~1 h).
wait_quiet() {
  local tries=0
  while (( $(idle_seconds) < QA_IDLE )); do
    (( tries++ > 720 )) && fail "the owner stayed active; native QA not started" 4
    sleep 5
  done
  LAST_INPUT=$EPOCHREALTIME
}

# Aborts if any input arrived after our own last synthetic event.
idle_gate() {
  local idle=$(idle_seconds)
  local since=$(( EPOCHREALTIME - LAST_INPUT ))
  if (( idle + 0.3 < since )); then
    fail "outside input ${idle}s ago (our last event ${since}s ago): yielding to the owner" 4
  fi
}
touched() { LAST_INPUT=$EPOCHREALTIME }

# launch NAME RECOVERY_DIR: a fresh instance with isolated recovery state; waits for its own guard.
# The log is appended to when a name is reused, so readiness counts new events, not old lines.
launch() {
  APP_LOG=$QA_OUT/$1.log
  local before=(${(f)"$(pgrep -f "$APP/Contents/MacOS/lawsmith")"})
  local ready=$(grep -c '"kind":"guard","action":"ready"' $APP_LOG 2>/dev/null || true)
  open -n $APP --env LAWSMITH_RECOVERY_DIR=$2 --stdout $APP_LOG --stderr $APP_LOG
  local i
  for i in {1..150}; do
    APP_PID=$(pgrep -nf "$APP/Contents/MacOS/lawsmith")
    if [[ -n $APP_PID && ${before[(Ie)$APP_PID]} == 0 ]] && (( $(grep -c '"kind":"guard","action":"ready"' $APP_LOG 2>/dev/null || true) > ${ready:-0} )); then break; fi
    sleep 0.2
  done
  (( $(grep -c '"kind":"guard","action":"ready"' $APP_LOG 2>/dev/null || true) > ${ready:-0} )) || fail "Lawsmith did not become ready ($APP_LOG)"
  window_origin
  say "launched pid $APP_PID, window at $WIN_X,$WIN_Y, log $1.log"
}

window_origin() {
  local xy i
  for i in {1..25}; do
    xy=$(osascript -l JavaScript $NATIVE/windows.js list $APP_PID | python3 -I -c '
import json, sys
w = [w for w in json.load(sys.stdin) if w["layer"] == 0 and w["name"] == "Lawsmith"]
if w:
    b = w[0]["bounds"]
    print(int(b["X"]), int(b["Y"]), int(b["Width"]), int(b["Height"]))')
    [[ -n $xy ]] && break
    sleep 0.2
  done
  [[ -n $xy ]] || fail "no Lawsmith window on screen"
  read WIN_X WIN_Y WIN_W WIN_H <<< $xy
}

running() { [[ -n $APP_PID ]] && kill -0 $APP_PID 2>/dev/null }

# Brings the app under test to the front with its main window key; only then do keys reach the page.
activate() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
    set frontmost to true
    perform action \"AXRaise\" of window \"Lawsmith\"
    set value of attribute \"AXMain\" of window \"Lawsmith\" to true
  end tell" >/dev/null 2>&1
  sleep 0.6
  touched
}

guard_point() {
  local hit=$(osascript -l JavaScript $NATIVE/windows.js hit $1 $2 $RECORDING_OVERLAYS) i
  # Notification banners and the owned recorder's Control Center popover can clear by themselves.
  # Wait up to 10 s without input, then require the normal topmost-window check; never skip a popover.
  for i in {1..20}; do
    [[ $hit == *'"owner":"Notification Center"'* || ( -n $RECORDER && $hit == *'"owner":"Control Center"'* ) ]] || break
    sleep 0.5
    hit=$(osascript -l JavaScript $NATIVE/windows.js hit $1 $2 $RECORDING_OVERLAYS)
  done
  idle_gate
  local pid=$(print -r -- $hit | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  if [[ $pid != $APP_PID && -n $LOCK_HOLDER && $pid != None ]]; then
    say "a window of pid $pid covers ($1,$2) during this segment; bringing the app under test back"
    activate
    hit=$(osascript -l JavaScript $NATIVE/windows.js hit $1 $2 $RECORDING_OVERLAYS)
    pid=$(print -r -- $hit | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  fi
  [[ $pid == $APP_PID ]] || fail "refused input at ($1,$2): topmost is $hit" 3
}

# NSWorkspace, not System Events: while a panel is open, System Events can report loginwindow.
front_pid() { osascript -l JavaScript -e 'ObjC.import("AppKit"); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)' }

# While this run holds the shared lock, an app that comes forward on its own (another session's dev
# build relaunching, say) is not someone using the screen, so the app under test is brought back once;
# a person's input is caught by the idle gate instead, which stops the run.
guard_front() {
  local front=$(front_pid)
  if [[ $front != $APP_PID && -n $LOCK_HOLDER ]]; then
    say "pid $front came to the front during this segment; bringing the app under test back"
    activate
    front=$(front_pid)
  fi
  [[ $front == $APP_PID ]] || fail "refused keys: frontmost pid is $front, not $APP_PID" 3
}

click() { idle_gate; guard_point $1 $2; cliclick -e 20 c:$1,$2; touched; sleep 0.3 }

# scroll_at X Y DY: one wheel step of DY pixels over (X,Y), hit-tested like a click; scrolls the panel
# under the pointer, never the scene behind it.
scroll_at() { idle_gate; guard_point $1 $2; cliclick -e 20 m:$1,$2; osascript -l JavaScript $NATIVE/scroll.js $3 >/dev/null; touched; sleep 0.35 }

# drag X1 Y1 X2 Y2 [STEPS]: press, move in steps, release; both ends are hit-tested. A synthetic
# mouse-up is sometimes lost (M0 finding 1; WebKit reads button state from the hardware, so a later
# synthetic move does not reveal it). If a law gesture began but did not end, the release is sent
# again at the same point, and the harness says so.
drag() {
  idle_gate; guard_point $1 $2; guard_point $3 $4
  local n=${5:-24} i args=(dd:$1,$2 w:120)
  local gestures=$(logq count $APP_LOG gesture)
  for i in {1..$n}; do args+=(dm:$(( $1 + ($3 - $1) * i / n )),$(( $2 + ($4 - $2) * i / n )) w:30); done
  args+=(w:120 du:$3,$4)
  cliclick -e 5 $args; touched; sleep 0.5
  for i in 1 2; do
    (( $(logq count $APP_LOG gesture) > gestures )) || break
    [[ $(logq field $APP_LOG gesture phase) == '"begin"' ]] || break
    say "the synthetic release was lost; sending it again"
    cliclick du:$3,$4; touched; sleep 0.5
  done
}

# keys CLICLICK-ARGS…: for example `keys kd:cmd t:s ku:cmd`. A `kp:space` sent this way reached no
# keydown handler in the packaged app (M6B, review re-run), so the scenarios type keys with `t:`.
# Another app can take the front between the check and the keystroke (another session's QA app did,
# once); a front change seen right after sending is reported as possible misdelivery and stops the run.
keys() {
  idle_gate; guard_front; cliclick -e 30 "$@"; touched
  local front=$(front_pid)
  if [[ $front != $APP_PID ]]; then
    # Quitting hands the front to the next app; only a change while the app still runs is suspect.
    sleep 0.5
    running && fail "focus moved to pid $front while keys were sent; they may have reached that app" 3
  fi
  sleep 0.4
}

# key_code N: a named key (48 Tab, 36 Return, 53 Escape, 51 Delete) through System Events; cliclick's
# named keys do not reach WKWebView or AppKit panels here, while its typed text and chords do.
key_code() {
  idle_gate; guard_front
  osascript -e "tell application \"System Events\" to key code $1" >/dev/null; touched
  sleep 0.4
}

# wait_log KIND [COUNT] [TIMEOUT_S]: waits until the log holds at least COUNT events of KIND.
wait_log() {
  local want=${2:-1} deadline=$(( EPOCHREALTIME + ${3:-10} ))
  while (( $(logq count $APP_LOG $1) < want )); do
    (( EPOCHREALTIME > deadline )) && fail "timed out waiting for $want '$1' events"
    sleep 0.2
  done
}
count() { logq count $APP_LOG $1 }
field() { logq field $APP_LOG $1 $2 }

# Layout readback (Shift+L), then screen points from it.
layout() {
  local n=$(count layout)
  keys kd:shift t:l ku:shift
  wait_log layout $(( n + 1 ))
  window_origin
}
point() { logq center $APP_LOG $WIN_X $WIN_Y $1 }
handle() { logq handle $APP_LOG $WIN_X $WIN_Y $1 ${2:-0} }
# press ID: clicks a control by its id, from a fresh readback (the panel reflows as laws come and go).
press() { layout; local p=(${=$(point controls.$1)}); click $p[1] $p[2] }
# press_expect ID KIND: presses a control whose click the app logs as a KIND event. A synthetic click
# that never reached WebKit (M0 finding 1; M5 finding 10) logs nothing, so it is sent again once, and
# the harness says so; a click that did arrive is never repeated, since its event comes at once.
press_expect() {
  local n=$(count $2) i
  press $1
  for i in {1..10}; do (( $(count $2) > n )) && return 0; sleep 0.1; done
  say "the synthetic click on $1 was lost (no $2 event); sending it again"
  press $1
  wait_log $2 $(( n + 1 )) 3
}

# click_expect X Y KIND: a hit-tested click whose effect the app logs as a KIND event, sent once more if
# no event follows within a second (M5 finding 10: a synthetic click can be lost without a trace).
click_expect() {
  local n=$(count $3) i
  click $1 $2
  for i in {1..10}; do (( $(count $3) > n )) && return 0; sleep 0.1; done
  say "the synthetic click at ($1,$2) was lost (no $3 event); sending it again"
  click $1 $2
  wait_log $3 $(( n + 1 )) 3
}
# press_panel ID: presses a control that opens a native panel, once more if no panel appears.
press_panel() {
  local i
  press $1
  for i in {1..12}; do (( $(depth) >= 1 )) && return 0; sleep 0.25; done
  say "the synthetic click on $1 opened no panel; sending it again"
  press $1
}

# Whole-window capture of the app under test (it proves pixels, never what is on top).
shot() {
  local id=$(osascript -l JavaScript $NATIVE/windows.js list $APP_PID | python3 -I -c '
import json, sys
print([w for w in json.load(sys.stdin) if w["layer"] == 0 and w["name"] == "Lawsmith"][0]["id"])')
  screencapture -x -o -l $id $QA_OUT/$1.png
  say "captured $1.png"
}

# --- Native dialogs and alerts, through Accessibility on the app's own sheets --------------------
# Presses go through AX actions, never shared keystrokes, so a dialog is answered exactly once.

axq() { osascript -l JavaScript $NATIVE/ax.js "$@" 2>&1 }
depth() { axq depth $APP_PID }

wait_depth() {
  local i
  for i in {1..60}; do [[ $(depth) == $1 ]] && return 0; sleep 0.25; done
  fail "the sheet depth did not reach $1 (it is $(depth))"
}

# Open and Save panels start in the last folder the app used. Seeding that folder before a launch
# makes them start in the disposable QA folder, so no navigation is needed: synthetic Return and
# Escape do not reliably reach the Go to Folder sheet of this macOS release, so it is never used.
# The preferences domain is Lawsmith's own; restore_preferences removes what QA added.
seed_folder() {
  running && fail "seed the panel folder before launching"
  osascript -l JavaScript -e "ObjC.import('Foundation');
    const url = \$.NSURL.fileURLWithPath('$1');
    const data = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, \$(), \$(), null);
    const prefs = \$.NSUserDefaults.alloc.initWithSuiteName('local.lawsmith');
    prefs.setObjectForKey(data, 'NSOSPLastRootDirectory');
    prefs.synchronize; 'seeded'" >/dev/null
}

wait_panel() {
  local i
  for i in {1..60}; do (( $(depth) >= 1 )) && break; sleep 0.25; done
  (( $(depth) == 1 )) || fail "expected one panel, found sheet depth $(depth)"
  sleep 0.8
}

# save_panel DIR NAME: saves into DIR only if the panel is already there; a Replace confirmation is
# accepted only inside QA_STATE, which is disposable.
save_panel() {
  [[ $1 == $QA_STATE* ]] || fail "refusing to save outside the disposable QA directory"
  wait_panel
  local where=$(axq value $APP_PID 'Where:')
  [[ $where == ${1:t} ]] || { axq press $APP_PID Cancel >/dev/null; fail "the Save panel is in \"$where\", not ${1:t}; canceled" }
  [[ $(axq set $APP_PID 'Save As:' "$2") == set ]] || fail "could not name the file"
  sleep 0.3
  axq press $APP_PID Save >/dev/null
  sleep 0.8
  [[ $(depth) == 2 ]] && axq press $APP_PID Replace >/dev/null
  touched
}

cancel_panel() { wait_panel; axq press $APP_PID Cancel >/dev/null; touched; wait_depth 0 }

# open_panel NAME: opens the file NAME, shown in the panel's seeded folder: a click selects it (a
# synthetic double-click may register as a single one) and the Open button is pressed through AX.
open_panel() {
  wait_panel
  local p=(${=$(axq itempos $APP_PID "$1")}) attempt names
  [[ $p[1] == not ]] && { axq press $APP_PID Cancel >/dev/null; fail "$1 is not shown in the Open panel; canceled" }
  for attempt in 1 2; do
    click $p[1] $p[2]
    sleep 0.4
    [[ $(axq press $APP_PID Open) == pressed ]] || fail "could not press Open"
    touched
    sleep 0.8
    # Done once the panel is gone or has given way to the guard's alert; an Open panel still up means
    # the selecting click was lost (M5 finding 10's class), so the file is selected again, once.
    names=(${(f)"$(axq buttons $APP_PID)"})
    (( $(depth) >= 1 && ${names[(Ie)Open]} )) || return 0
    (( attempt == 1 )) && say "the Open panel stayed open (the click selecting $1 was lost); selecting it again"
  done
}

# alert BUTTON: answers the unsaved-work alert (Save, Don't Save, Cancel).
alert() { wait_depth 1; [[ $(axq press $APP_PID "$1") == pressed ]] || fail "no alert button $1"; touched }
# alert_for scene|recording BUTTON: answers the guard's alert only if it names that artifact: the
# recording's offers "Save Recording…", the scene's a plain "Save" (M6A, SPEC §15.3).
alert_for() {
  wait_depth 1
  local buttons=$(axq buttons $APP_PID)
  case $1 in
    recording) [[ $buttons == *'Save Recording…'* ]] || fail "expected the recording's alert; its buttons are: ${buttons//$'\n'/, }" ;;
    scene) [[ $buttons != *'Save Recording…'* && $buttons == *Save* ]] || fail "expected the scene's alert; its buttons are: ${buttons//$'\n'/, }" ;;
  esac
  say "the guard asks about the $1"
  alert "$2"
}

# Removes the preferences domain QA created for Lawsmith (panel folder and sizes); run after the
# last launch. Only call it when the domain did not exist before QA began.
restore_preferences() { defaults delete local.lawsmith >/dev/null 2>&1; say "removed QA panel preferences" }

# Waits for the process under test to end.
wait_exit() {
  local i
  for i in {1..100}; do running || return 0; sleep 0.2; done
  fail "Lawsmith did not exit"
}

# --- Geometry, recording and assertions ---------------------------------------------------------

# world X Y Z: the screen point of a world point, by the last layout's camera.
world() { logq project $APP_LOG $WIN_X $WIN_Y $1 $2 $3 }

# drag_law_to FROM_X FROM_Y FROM_Z TO_X TO_Y TO_Z: drags the selected law's X translate handle by
# the screen displacement between two world points (the handle keeps its offset from the center).
drag_law_to() {
  layout
  local h=(${=$(handle X 0)}) from=(${=$(world $1 $2 $3)}) to=(${=$(world $4 $5 $6)})
  drag $h[1] $h[2] $(( h[1] + to[1] - from[1] )) $(( h[2] + to[2] - from[2] ))
}

# record_start NAME [SECONDS] / record_stop: a recording of the app window (screen recording on).
# ffmpeg's avfoundation screen input delivers no frames on macOS 27.2, so screencapture records a
# fixed length of the window's rectangle (it cannot be stopped early and still write its file);
# record_stop waits for it, then ffmpeg transcodes it to 1168-wide H.264 and the raw file is removed.
# While it records, macOS shows a full-screen overlay above every app; the hit test skips exactly the
# overlay windows that appeared when the recording began, and only until it ends.
RECORDING_OVERLAYS=
record_start() {
  window_origin
  RECORDING=$1
  local before=$(osascript -l JavaScript $NATIVE/windows.js overlays)
  screencapture -x -v -V ${2:-100} -R $WIN_X,$WIN_Y,$WIN_W,$WIN_H $QA_OUT/$1.mov > $QA_OUT/$1.record.log 2>&1 &
  RECORDER=$!
  sleep 1.5
  RECORDING_OVERLAYS=$(python3 -I -c "
before = set('$before'.split(',')) - {''}
print(','.join(i for i in '$(osascript -l JavaScript $NATIVE/windows.js overlays)'.split(',') if i and i not in before))")
  say "recording $1 for ${2:-100} s (overlay windows skipped by the hit test: ${RECORDING_OVERLAYS:-none})"
}
record_stop() {
  [[ -n $RECORDER ]] || return 0
  say "waiting for $RECORDING to finish"
  wait $RECORDER
  RECORDER=
  RECORDING_OVERLAYS=
  [[ -s $QA_OUT/$RECORDING.mov ]] || fail "the recording $RECORDING.mov was not written"
  ffmpeg -hide_banner -loglevel error -i $QA_OUT/$RECORDING.mov -vf scale=1168:-2 -r 30 -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -an -y $QA_OUT/$RECORDING.mp4 < /dev/null \
    && rm -f $QA_OUT/$RECORDING.mov $QA_OUT/$RECORDING.record.log
  say "recording $RECORDING.mp4 written"
}

# expect DESCRIPTION PYTHON-EXPRESSION over the last event `e` of KIND: records PASS or fails.
expect() {
  local kind=$1 description=$2 expression=$3
  local verdict=$(logq last $APP_LOG $kind | python3 -I -c "import json,sys; e=json.load(sys.stdin); print('PASS' if ($expression) else 'FAIL', json.dumps(e)[:300])")
  say "$verdict  [$kind] $description"
  [[ $verdict == PASS* ]] || fail "expectation failed: $description"
}

# toggle_law: clicks the first law's On/Off control (a semantic edit), located by layout readback.
toggle_law() { layout; local p=(${=$(point laws.0.enabled)}); click $p[1] $p[2] }
