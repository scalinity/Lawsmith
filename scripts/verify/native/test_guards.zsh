#!/bin/zsh
# Non-native checks of the production guards in lib.zsh and m8lib.zsh. The OS-facing commands
# (cliclick, open, osascript, defaults, ioreg) are shell functions that only log what would have been
# sent; nothing here moves the pointer, types, launches, changes the display or touches preferences.
# The GUI lock is a real flock on a temporary file. Each case runs in its own subshell and is judged by
# its exit status and by which mutations reached the log.
#   zsh scripts/verify/native/test_guards.zsh        prints one line per case and exits non-zero on a failure
zmodload zsh/datetime
HERE=${0:A:h}
ROOT=$(mktemp -d)
trap 'rm -rf $ROOT' EXIT
passed=0
failed=0

# run_case NAME WANT_STATUS BODY: BODY runs after the stubs, in a subshell with fresh state.
run_case() {
  local name=$1 want=$2 body=$3 dir=$ROOT/$1
  mkdir -p $dir/state $dir/out
  : > $dir/calls
  (
    export QA_STATE=$dir/state QA_OUT=$dir/out GUI_LOCK=$dir/gui.lock QA_IDLE=1
    CALLS=$dir/calls
    IDLE_FILE=$dir/idle; print 1000 > $IDLE_FILE
    DOMAIN_FILE=$dir/domain.plist
    DISPLAY_FILE=$dir/display; print 1168x755@120 > $DISPLAY_FILE
    SET_REPLY_FILE=$dir/set-reply; : > $SET_REPLY_FILE
    source $HERE/lib.zsh
    APP_PID=4242
    APP_LOG=$dir/app.log; : > $APP_LOG
    sleep() { : }
    cliclick() { print -r -- "cliclick $*" >> $CALLS; [[ -n $CLICLICK_TAKES ]] && command sleep $CLICLICK_TAKES; [[ -n $CLICLICK_GESTURE ]] && print -r -- '[lawsmith] {"kind":"gesture","phase":"begin"}' >> $APP_LOG; true }
    open() { print -r -- "open $*" >> $CALLS }
    ioreg() { print -r -- "    | |   \"HIDIdleTime\" = $(( $(<$IDLE_FILE) * 1000000000 ))" }
    defaults() {
      print -r -- "defaults $*" >> $CALLS
      # The real semantics on this macOS: a missing domain reads as exit 1 with exactly this message, and
      # exports as an empty dictionary with exit 0. READ_FAILS injects any other read failure.
      case $1 in
        read)
          if [[ -n $READ_FAILS ]] && (( $(cat $CALLS.reads 2>/dev/null || print 0) >= ${READ_FAILS_AFTER:-0} )); then
            print -u2 -r -- $READ_FAILS; return ${READ_CODE:-1}
          fi
          print $(( $(cat $CALLS.reads 2>/dev/null || print 0) + 1 )) > $CALLS.reads
          if [[ -f $DOMAIN_FILE ]]; then print -r -- '{ OwnerValue = hidden; }'; return 0; fi
          print -u2 -r -- "Error: Domain '$2' not found."; return 1 ;;
        export)
          [[ -n $EXPORT_FAILS ]] && return 1
          if [[ -f $DOMAIN_FILE ]]; then cp $DOMAIN_FILE $3
          else print -r -- '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>' > $3; fi ;;
        import) [[ -z $IMPORT_FAILS ]] && cp $3 $DOMAIN_FILE ;;
        delete) [[ -f $DOMAIN_FILE ]] && rm $DOMAIN_FILE ;;
      esac
    }
    osascript() {
      local all="$*"
      case $all in
        *windows.js\ hit*)
          # HIT_TAKES delays a hit check (after the first HIT_DELAY_AFTER of them), as a covering window would.
          local hits=$(( $(cat $CALLS.hits 2>/dev/null || print 0) + 1 )); print $hits > $CALLS.hits
          [[ -n $HIT_TAKES ]] && (( hits > ${HIT_DELAY_AFTER:-0} )) && command sleep $HIT_TAKES
          print -r -- '{"pid":4242,"owner":"lawsmith"}' ;;
        *frontmostApplication*) [[ -n $FRONT_TAKES ]] && command sleep $FRONT_TAKES; print 4242 ;;
        *display.js\ get*) print -r -- "$(<$DISPLAY_FILE)" ;;
        *display.js\ set*)
          print -r -- "display-set $all" >> $CALLS
          local reply=$(<$SET_REPLY_FILE) want="${@[-3]}x${@[-2]}@${@[-1]}"
          if [[ -z $reply ]]; then print -r -- $want > $DISPLAY_FILE; print -r -- "set $want"
          elif [[ $reply == wrong:* ]]; then print -r -- ${reply#wrong:} > $DISPLAY_FILE; print -r -- "set $want"
          else print -r -- $reply; fi ;;
        *ax.js\ depth*) [[ -n $DEPTH_TAKES ]] && command sleep $DEPTH_TAKES; print 1 ;;
        *ax.js\ value*) print scenes ;;
        *ax.js\ buttons*) print -r -- "Save"$'\n'"Don't Save"$'\n'"Cancel" ;;
        *ax.js*) print -r -- "ax $all" >> $CALLS; print pressed ;;
        *NSUserDefaults*) print -r -- "seed-preferences" >> $CALLS ;;
        *) print -r -- "osascript $all" >> $CALLS ;;
      esac
    }
    eval "$body"
  ) > $dir/output 2>&1
  local got=$?
  if (( got == want )) && { [[ -z $4 ]] || eval "$4" }; then
    (( passed++ )); print -r -- "ok   $name"
  else
    (( failed++ )); print -r -- "FAIL $name (exit $got, wanted $want)"; sed 's/^/     /' $dir/output | tail -5; sed 's/^/     calls: /' $dir/calls
  fi
}
calls() { cat $ROOT/$1/calls }
none() { ! grep -q -- "$2" $ROOT/$1/calls }
has() { grep -q -- "$2" $ROOT/$1/calls }
now() { print $EPOCHREALTIME }

# --- F4: the deadline and outside input stop every new action -------------------------------------
run_case expired-click 5 'QA_DEADLINE=$(( EPOCHSECONDS - 1 )); LAST_INPUT=$EPOCHREALTIME; click 10 10' 'none expired-click cliclick'
run_case allowed-click 0 'QA_DEADLINE=$(( EPOCHSECONDS + 60 )); LAST_INPUT=$EPOCHREALTIME; click 10 10' 'has allowed-click "cliclick -e 20 c:10,10"'
run_case old-runner-click 0 'unset QA_DEADLINE; LAST_INPUT=$EPOCHREALTIME; click 10 10' 'has old-runner-click "c:10,10"'
run_case outside-input-keys 4 'QA_DEADLINE=$(( EPOCHSECONDS + 60 )); print 0 > $IDLE_FILE; LAST_INPUT=$(( EPOCHREALTIME - 5 )); keys kd:cmd t:s ku:cmd' 'none outside-input-keys cliclick'
run_case chord-reserve 5 'QA_DEADLINE=$(( EPOCHREALTIME + 0.5 )); LAST_INPUT=$EPOCHREALTIME; keys kd:cmd t:s ku:cmd' 'none chord-reserve cliclick'
run_case drag-reserve 5 'QA_DEADLINE=$(( EPOCHREALTIME + 2 )); LAST_INPUT=$EPOCHREALTIME; drag 1 1 50 50 24' 'none drag-reserve cliclick'
# The drag's reserve covers one resent release; a drag that stalls beyond it meets the closed window, and
# the lost release is not resent.
run_case drag-retry-after-deadline 5 'QA_DEADLINE=$(( EPOCHREALTIME + 3.5 )); LAST_INPUT=$EPOCHREALTIME; CLICLICK_TAKES=4; CLICLICK_GESTURE=1; drag 1 1 50 50 8' 'has drag-retry-after-deadline "dd:1,1" && none drag-retry-after-deadline "cliclick du:"'
run_case drag-retry-outside-input 4 'QA_DEADLINE=$(( EPOCHSECONDS + 60 )); LAST_INPUT=$EPOCHREALTIME; CLICLICK_TAKES=1; CLICLICK_GESTURE=1; cliclick() { print -r -- "cliclick $*" >> $CALLS; command sleep 1; print 0 > $IDLE_FILE; print -r -- "[lawsmith] {\"kind\":\"gesture\",\"phase\":\"begin\"}" >> $APP_LOG }; touched() { LAST_INPUT=$(( EPOCHREALTIME - 2 )) }; drag 1 1 50 50 8' 'none drag-retry-outside-input "cliclick du:"'
run_case save-after-panel-wait 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.5 )); LAST_INPUT=$EPOCHREALTIME; DEPTH_TAKES=1; save_panel $QA_STATE/scenes a.lawsmith.json' 'none save-after-panel-wait "ax .*set" && none save-after-panel-wait "press 4242 Save"'
run_case alert-after-deadline 5 'QA_DEADLINE=$(( EPOCHSECONDS - 1 )); LAST_INPUT=$EPOCHREALTIME; alert "Don'"'"'t Save"' 'none alert-after-deadline "ax "'
run_case open-press-after-deadline 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.2 )); LAST_INPUT=$EPOCHREALTIME; osascript() { case "$*" in *itempos*) print 10 10 ;; *depth*) print 1 ;; *windows.js\ hit*) print -r -- "{\"pid\":4242}" ;; *) print -r -- "ax $*" >> $CALLS; print pressed ;; esac }; CLICLICK_TAKES=1; open_panel a.lawsmith.json' 'has open-press-after-deadline "c:10,10" && none open-press-after-deadline "press 4242 Open"'
run_case lock-wait-bounded 5 'python3 -I -c "import fcntl,sys,time; f=open(sys.argv[1],\"a+\"); fcntl.flock(f, fcntl.LOCK_EX); time.sleep(20)" $GUI_LOCK & holder=$!; command sleep 0.5; QA_DEADLINE=$(( EPOCHREALTIME + 1 )); gui_lock test; kill $holder' 'none lock-wait-bounded cliclick'
run_case quiet-wait-bounded 5 'QA_DEADLINE=$(( EPOCHREALTIME + 0.5 )); print 0 > $IDLE_FILE; wait_quiet'
run_case launch-needs-lock 3 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); LAST_INPUT=$EPOCHREALTIME; launch x $QA_STATE/recovery' 'none launch-needs-lock "open "'
run_case launch-reserve 5 'command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHSECONDS + 10 )); LAST_INPUT=$EPOCHREALTIME; launch x $QA_STATE/recovery' 'none launch-reserve "open "'
run_case activate-after-deadline 5 'command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHSECONDS - 1 )); LAST_INPUT=$EPOCHREALTIME; activate' 'none activate-after-deadline "System Events"'
run_case seed-takes-lock-first 0 'unset QA_DEADLINE; seed_folder $QA_STATE/scenes; [[ -n $LOCK_HOLDER ]]' 'has seed-takes-lock-first seed-preferences'
run_case seed-after-deadline 5 'QA_DEADLINE=$(( EPOCHSECONDS - 1 )); seed_folder $QA_STATE/scenes' 'none seed-after-deadline seed-preferences'
run_case record-reserve 5 'command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHSECONDS + 50 )); LAST_INPUT=$EPOCHREALTIME; screencapture() { print -r -- "screencapture $*" >> $CALLS }; record_start clip 100' 'none record-reserve screencapture'
run_case window-after-deadline 5 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8lib.zsh; command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHSECONDS - 1 )); LAST_INPUT=$EPOCHREALTIME; window_size 1280 800' 'none window-after-deadline "set size"'
run_case m8-requires-deadline 1 'unset QA_DEADLINE; source $HERE/m8lib.zsh'

# --- F4 (reopened): a slow hit or front check cannot spend the action's reserve -----------------------
# Each case passes the entry check, then a delayed check leaves less than the action needs: nothing is
# dispatched. The positive twin has the same delays and enough time.
# The reviewer's shape: two slow hit checks (1.7 s each) leave about 1.1 s of a 4.5 s window, while the
# 40-step batch needs 2.85 s.
run_case drag40-delayed-hits-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 4.5 )); LAST_INPUT=$EPOCHREALTIME; HIT_TAKES=1.7; drag 1 1 50 50 40' 'none drag40-delayed-hits-refused "dd:"'
run_case drag40-delayed-hits-enough-time 0 'QA_DEADLINE=$(( EPOCHREALTIME + 10 )); LAST_INPUT=$EPOCHREALTIME; HIT_TAKES=1.7; drag 1 1 50 50 40' 'has drag40-delayed-hits-enough-time "dd:1,1"'
# A resent release whose hit check is slow: the batch went out, the release is not resent.
run_case drag-retry-delayed-hit-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 3.3 )); LAST_INPUT=$EPOCHREALTIME; HIT_TAKES=2.5; HIT_DELAY_AFTER=2; CLICLICK_GESTURE=1; drag 1 1 50 50 8' 'has drag-retry-delayed-hit-refused "dd:1,1" && none drag-retry-delayed-hit-refused "cliclick du:"'
run_case keys-delayed-front-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.6 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; keys kd:cmd t:s ku:cmd' 'none keys-delayed-front-refused cliclick'
run_case keys-delayed-front-enough-time 0 'QA_DEADLINE=$(( EPOCHREALTIME + 5 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; keys kd:cmd t:s ku:cmd' 'has keys-delayed-front-enough-time "kd:cmd t:s ku:cmd"'
run_case keycode-delayed-front-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.6 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; key_code 36' 'none keycode-delayed-front-refused "key code"'
run_case keycode-delayed-front-enough-time 0 'QA_DEADLINE=$(( EPOCHREALTIME + 5 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; key_code 36' 'has keycode-delayed-front-enough-time "key code 36"'
run_case click-delayed-hit-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.5 )); LAST_INPUT=$EPOCHREALTIME; HIT_TAKES=1.0; click 10 10' 'none click-delayed-hit-refused cliclick'
run_case scroll-delayed-hit-refused 5 'QA_DEADLINE=$(( EPOCHREALTIME + 1.5 )); LAST_INPUT=$EPOCHREALTIME; HIT_TAKES=1.0; scroll_at 10 10 -120' 'none scroll-delayed-hit-refused cliclick'
run_case window-delayed-front-refused 5 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8lib.zsh; command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHREALTIME + 3.5 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; window_size 1280 800' 'none window-delayed-front-refused "set size"'
run_case window-delayed-front-enough-time 0 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8lib.zsh; command sleep 30 & LOCK_HOLDER=$!; LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; window_origin() { : }; window_size 1280 800; trap - EXIT' 'has window-delayed-front-enough-time "set size"'
run_case tab-delayed-front-refused 5 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8lib.zsh; QA_DEADLINE=$(( EPOCHREALTIME + 1.6 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; tab_to "True" 1' 'none tab-delayed-front-refused "key code 48"'
# M8 G4: the pinned Wry's tabFocusesLinks=YES makes ordinary Tab reach buttons and Option-Tab skip them.
# tab_to, the production helper, must send key code 48 with no modifier.
run_case tab-sends-plain-tab 0 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8lib.zsh; LAST_INPUT=$EPOCHREALTIME; layout() { : }; m8q() { : }; logq() { print -r -- "{\"focus\":{\"id\":\"play\"}}" }; tab_to "f[\"id\"]==\"play\"" 1' 'has tab-sends-plain-tab "key code 48" && none tab-sends-plain-tab "using option down"'

# --- F5: the owner's preferences are snapshotted under the lock and restored exactly ----------------
PLIST='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>OwnerSetting</key><string>kept</string></dict></plist>'
QA_WRITES='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>NSOSPLastRootDirectory</key><string>qa</string></dict></plist>'
same_plist() { cmp -s <(plutil -convert xml1 -o - $1) <(print -r -- $PLIST | plutil -convert xml1 -o - -) }
run_case prefs-existing-restored 0 "unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; seed_folder \$QA_STATE/scenes; print -r -- '$QA_WRITES' > \$DOMAIN_FILE; restore_preferences && grep -q '\"original\":\"present\"' \$QA_OUT/cleanup.jsonl && grep -q '\"preferences\":\"restored\"' \$QA_OUT/cleanup.jsonl" 'same_plist $ROOT/prefs-existing-restored/domain.plist && has prefs-existing-restored "defaults import"'
run_case prefs-absent-removed 0 "unset QA_DEADLINE; seed_folder \$QA_STATE/scenes; print -r -- '$QA_WRITES' > \$DOMAIN_FILE; restore_preferences && [[ ! -e \$DOMAIN_FILE ]] && grep -q '\"original\":\"absent\"' \$QA_OUT/cleanup.jsonl" 'none prefs-absent-removed "defaults import"'
run_case prefs-no-snapshot-no-cleanup 0 "print -r -- '$PLIST' > \$DOMAIN_FILE; restore_preferences" 'none prefs-no-snapshot-no-cleanup defaults && same_plist $ROOT/prefs-no-snapshot-no-cleanup/domain.plist'
run_case prefs-early-failure-keeps-domain 5 "print -r -- '$PLIST' > \$DOMAIN_FILE; trap 'restore_preferences' EXIT; QA_DEADLINE=\$(( EPOCHSECONDS - 1 )); seed_folder \$QA_STATE/scenes" 'none prefs-early-failure-keeps-domain "defaults delete" && same_plist $ROOT/prefs-early-failure-keeps-domain/domain.plist'
run_case prefs-snapshot-failure-writes-nothing 1 "unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; EXPORT_FAILS=1; seed_folder \$QA_STATE/scenes" 'none prefs-snapshot-failure-writes-nothing seed-preferences && same_plist $ROOT/prefs-snapshot-failure-writes-nothing/domain.plist'
run_case prefs-restore-failure-reported 1 "unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; seed_folder \$QA_STATE/scenes; IMPORT_FAILS=1; restore_preferences" 'grep -q "\"preferences\":\"failed\"" $ROOT/prefs-restore-failure-reported/out/cleanup.jsonl && [[ -s $ROOT/prefs-restore-failure-reported/state/preferences-original.plist ]]'
run_case prefs-snapshot-needs-lock 1 'unset QA_DEADLINE; snapshot_preferences' 'none prefs-snapshot-needs-lock "defaults "'
run_case prefs-snapshot-private 1 'unset QA_DEADLINE; QA_STATE=$REPO/qa-state-inside; command sleep 30 & LOCK_HOLDER=$!; snapshot_preferences' 'none prefs-snapshot-private "defaults "'

# --- F10: a campaign driver lends the shared lock; the runner adopts it only if it is really held ------
# The test shell lends: it opens the lock file on a descriptor and a helper takes the flock on that same
# open file, which then stays locked for as long as the descriptor is open.
LEND='exec {lfd}>>$GUI_LOCK; python3 -I -c "import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX)" $lfd'
HELD='python3 -I -c "import fcntl,sys
f=open(sys.argv[1],\"a+\")
try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
sys.exit(1)" $GUI_LOCK'
run_case lock-adopted-nested-kept 0 "$LEND; QA_LOCK_FD=\$lfd; QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); segment one; [[ \$LOCK_HOLDER == inherited:\$lfd ]] || exit 9; segment two; require_lock 'launching Lawsmith'; gui_unlock; [[ \$LOCK_HOLDER == inherited:\$lfd ]] || exit 8; $HELD || exit 7; [[ -z \$(print \$QA_STATE/.gui-lock-*(N)) ]] || exit 6"
run_case lock-not-the-lock-file 3 ": >> \$GUI_LOCK; exec {lfd}>>\$QA_STATE/other.lock; python3 -I -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX)' \$lfd; QA_LOCK_FD=\$lfd; gui_lock x" 'grep -q "is not the GUI lock" $ROOT/lock-not-the-lock-file/output'
run_case lock-nobody-holds 3 'exec {lfd}>>$GUI_LOCK; QA_LOCK_FD=$lfd; gui_lock x' 'grep -q "nobody holds the GUI lock" $ROOT/lock-nobody-holds/output'
run_case lock-competing-holder 3 'python3 -I -c "import fcntl,sys,time; f=open(sys.argv[1],\"a+\"); fcntl.flock(f, fcntl.LOCK_EX); time.sleep(20)" $GUI_LOCK & holder=$!; command sleep 0.5; exec {lfd}>>$GUI_LOCK; QA_LOCK_FD=$lfd; gui_lock x; kill $holder' 'grep -q "held, but not through descriptor" $ROOT/lock-competing-holder/output'
run_case lock-closed-descriptor 3 'QA_LOCK_FD=57; gui_lock x' 'grep -q "descriptor 57 is not open" $ROOT/lock-closed-descriptor/output'
run_case lock-adoption-failure-acts-on-nothing 3 "exec {lfd}>>\$GUI_LOCK; QA_LOCK_FD=\$lfd; QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); LAST_INPUT=\$EPOCHREALTIME; segment x; seed_folder \$QA_STATE/scenes" 'none lock-adoption-failure-acts-on-nothing seed-preferences && none lock-adoption-failure-acts-on-nothing "defaults "'
run_case set-window-guarded 5 'command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHREALTIME + 3.5 )); LAST_INPUT=$EPOCHREALTIME; FRONT_TAKES=1.0; set_window 40 45 1280 800' 'none set-window-guarded "set size"'
run_case set-window-enough-time 0 'command sleep 30 & LOCK_HOLDER=$!; QA_DEADLINE=$(( EPOCHSECONDS + 600 )); LAST_INPUT=$EPOCHREALTIME; window_origin() { : }; set_window 40 45 1280 800' 'has set-window-enough-time "set size"'

# --- F5 (reopened): only the exact not-found answer is absence; any other read failure stops the run ----
run_case prefs-existing-unexpected-read-failure 1 "unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; READ_FAILS='Error: could not read domain (cfprefsd unavailable)'; trap 'restore_preferences' EXIT; seed_folder \$QA_STATE/scenes" 'none prefs-existing-unexpected-read-failure seed-preferences && none prefs-existing-unexpected-read-failure "defaults delete" && none prefs-existing-unexpected-read-failure "defaults export" && same_plist $ROOT/prefs-existing-unexpected-read-failure/domain.plist && grep -q "\"preferences\":\"unknown\"" $ROOT/prefs-existing-unexpected-read-failure/out/cleanup.jsonl'
run_case prefs-existing-read-crash 1 "unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; READ_FAILS='zsh: segmentation fault'; READ_CODE=139; seed_folder \$QA_STATE/scenes" 'none prefs-existing-read-crash seed-preferences && none prefs-existing-read-crash "defaults delete" && same_plist $ROOT/prefs-existing-read-crash/domain.plist'
run_case prefs-not-found-for-another-domain 1 "unset QA_DEADLINE; READ_FAILS=\"Error: Domain 'local.other' not found.\"; seed_folder \$QA_STATE/scenes" 'none prefs-not-found-for-another-domain seed-preferences'
run_case prefs-confirmed-absent-seeds 0 'unset QA_DEADLINE; seed_folder $QA_STATE/scenes; grep -q "\"original\":\"absent\"" $QA_OUT/cleanup.jsonl' 'has prefs-confirmed-absent-seeds seed-preferences && none prefs-confirmed-absent-seeds "defaults export"'
run_case prefs-cleanup-unknown-read-is-failure 1 "unset QA_DEADLINE; seed_folder \$QA_STATE/scenes; print -r -- '$QA_WRITES' > \$DOMAIN_FILE; READ_FAILS='Error: could not read domain'; READ_FAILS_AFTER=1; restore_preferences" 'grep -q "\"preferences\":\"failed\"" $ROOT/prefs-cleanup-unknown-read-is-failure/out/cleanup.jsonl && none prefs-cleanup-unknown-read-is-failure "\"preferences\":\"restored\""'

# --- Earlier campaign runners: their rewritten helpers, run against the stubs ----------------------------
LEGIBLE='eval "$(sed -n "/^screen_size()/p;/^display_mode()/p;/^window_size()/p;/^restore_display()/p" $HERE/m5-legible.zsh)"'
run_case legible-display-verified-and-restored 0 "$LEGIBLE; QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); command sleep 30 & LOCK_HOLDER=\$!; LAST_INPUT=\$EPOCHREALTIME; display_mode 1728 1117; [[ \$(<\$DISPLAY_FILE) == 1728x1117@120 ]] || exit 9; restore_display; [[ \$(<\$DISPLAY_FILE) == 1168x755@120 ]]" 'none legible-display-verified-and-restored cliclick'
run_case legible-display-needs-lock 3 "$LEGIBLE; unset QA_DEADLINE; display_mode 1728 1117" 'none legible-display-needs-lock display-set'
run_case legible-failed-mode-refused 1 "$LEGIBLE; command sleep 30 & LOCK_HOLDER=\$!; LAST_INPUT=\$EPOCHREALTIME; print -r -- 'no 1728x1117 HiDPI mode at 120 Hz' > \$SET_REPLY_FILE; display_mode 1728 1117"
R1='eval "$(sed -n "/^cleanup() {/,/^}/p" $HERE/m7-r1-panel.zsh)"'
run_case r1-cleanup-keeps-absent-absent 0 "$R1; unset QA_DEADLINE; seed_folder \$QA_STATE/scenes; print -r -- '<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>' > \$DOMAIN_FILE; running() { false }; cleanup; [[ ! -e \$DOMAIN_FILE ]]" 'none r1-cleanup-keeps-absent-absent "defaults import"'
run_case r1-cleanup-restores-existing 0 "$R1; unset QA_DEADLINE; print -r -- '$PLIST' > \$DOMAIN_FILE; seed_folder \$QA_STATE/scenes; print -r -- '$QA_WRITES' > \$DOMAIN_FILE; running() { false }; cleanup" 'same_plist $ROOT/r1-cleanup-restores-existing/domain.plist'

# --- F6: a display change is its exact token and readback; only a change QA made is restored ---------
LOCKED='command sleep 30 & LOCK_HOLDER=$!; LAST_INPUT=$EPOCHREALTIME'
run_case display-set-and-restore 0 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; display_set 1728 1117 60 && [[ \$(<\$DISPLAY_FILE) == 1728x1117@60 ]] && restore_display_mode && [[ \$(<\$DISPLAY_FILE) == 1168x755@120 ]] && grep -q '\"display\":\"restored\"' \$QA_OUT/cleanup.jsonl"
run_case display-failure-string 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; print -r -- 'no 1728x1117 HiDPI mode at 60 Hz' > \$SET_REPLY_FILE; trap 'restore_display_mode' EXIT; display_set 1728 1117 60" '[[ $(grep -c display-set $ROOT/display-failure-string/calls) == 1 ]]'
run_case display-configure-failed 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; print -r -- 'configure failed' > \$SET_REPLY_FILE; display_set 1728 1117 60" '[[ $(<$ROOT/display-configure-failed/display) == 1168x755@120 ]]'
run_case display-wrong-refresh 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; print -r -- 'wrong:1728x1117@120' > \$SET_REPLY_FILE; trap 'print -n > \$SET_REPLY_FILE; restore_display_mode' EXIT; display_set 1728 1117 60" '[[ $(<$ROOT/display-wrong-refresh/display) == 1168x755@120 ]] && grep -q "\"display\":\"restored\"" $ROOT/display-wrong-refresh/out/cleanup.jsonl'
run_case display-wrong-size 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; print -r -- 'wrong:1600x1000@60' > \$SET_REPLY_FILE; display_set 1728 1117 60" 'grep -q "reads back 1600x1000@60" $ROOT/display-wrong-size/output'
run_case display-restore-failure 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; display_set 1728 1117 60; print -r -- 'complete failed 1001' > \$SET_REPLY_FILE; restore_display_mode" 'grep -q "\"display\":\"failed\"" $ROOT/display-restore-failure/out/cleanup.jsonl'
run_case display-needs-lock 3 'unset QA_DEADLINE; trap "restore_display_mode" EXIT; display_set 1728 1117 60' 'none display-needs-lock display-set'
run_case display-after-deadline 5 "QA_DEADLINE=\$(( EPOCHSECONDS - 1 )); $LOCKED; trap 'restore_display_mode' EXIT; display_set 1728 1117 60" 'none display-after-deadline display-set'
run_case display-unreadable-original 1 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); $LOCKED; print -r -- 'garbled' > \$DISPLAY_FILE; trap 'restore_display_mode' EXIT; display_set 1728 1117 60" 'none display-unreadable-original display-set'
run_case m8-cleanup-restores 0 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); source \$HERE/m8lib.zsh; $LOCKED; display_set 1728 1117 120; exit 0" '[[ $(<$ROOT/m8-cleanup-restores/display) == 1168x755@120 ]]'
run_case m8-cleanup-failure-fails-run 6 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); source \$HERE/m8lib.zsh; $LOCKED; display_set 1728 1117 120; print -r -- 'complete failed 1001' > \$SET_REPLY_FILE; exit 0"
run_case m8-cleanup-keeps-failure-code 5 "QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); source \$HERE/m8lib.zsh; $LOCKED; display_set 1728 1117 120; QA_DEADLINE=\$(( EPOCHSECONDS - 1 )); click 1 1" '[[ $(<$ROOT/m8-cleanup-keeps-failure-code/display) == 1168x755@120 ]]'

# --- F7: reveals scroll the region the app says holds the target, never one its box happens to cross --
# The reviewer's case: an inspector input scrolled below the context column, its center over the dock.
layout_line() { print -r -- "[lawsmith] {\"kind\":\"layout\",\"controls\":{\"context-column\":[900,52,312,600],\"dock\":[850,700,418,88],\"document\":[12,52,284,200],\"top-rail\":[0,0,1280,40],\"panel\":[12,260,284,400],\"play\":[1100,750,96,28],\"file-open\":[80,120,60,28],\"undo\":[700,6,60,28]},\"inputs\":{\"Strength\":[$1,$2,100,26]},\"owners\":{\"controls\":{\"play\":\"dock\",\"file-open\":\"document\",\"undo\":\"top-rail\"},\"inputs\":\"context-column\",\"ingredients\":\"context-column\",\"laws\":\"panel\"}}" }
OWNERS='print -r -- "$(layout_line 1050 727)" > $APP_LOG'
run_case region-input-over-dock 0 "$(typeset -f layout_line); $OWNERS; region_of inputs.Strength; [[ \$REGION == '900 52 312 600' ]]"
run_case region-input-above 0 "$(typeset -f layout_line); print -r -- \"\$(layout_line 1050 10)\" > \$APP_LOG; region_of inputs.Strength; [[ \$REGION == '900 52 312 600' ]]"
run_case region-ingredient-expr 0 "$(typeset -f layout_line); $OWNERS; region_of \"next(r['select'] for r in e['ingredients']['rows'] if r['label']=='Drag')\"; [[ \$REGION == '900 52 312 600' ]]"
run_case region-fixed-dock 0 "$(typeset -f layout_line); $OWNERS; region_of controls.play; [[ \$REGION == '850 700 418 88' ]]"
run_case region-fixed-document 0 "$(typeset -f layout_line); $OWNERS; region_of \"e['controls']['file-open']\"; [[ \$REGION == '12 52 284 200' ]]"
run_case region-tools 0 "$(typeset -f layout_line); $OWNERS; region_of controls.undo; [[ \$REGION == '0 0 1280 40' ]]"
run_case region-laws-row 0 "$(typeset -f layout_line); $OWNERS; region_of laws.0.select; [[ \$REGION == '12 260 284 400' ]]"
run_case region-unknown-owner 1 "$(typeset -f layout_line); $OWNERS; region_of controls.mystery"
run_case region-no-owners-readback 1 'print -r -- "[lawsmith] {\"kind\":\"layout\",\"controls\":{\"dock\":[850,700,418,88]},\"inputs\":{\"Strength\":[1050,727,100,26]}}" > $APP_LOG; region_of inputs.Strength'
# m7-compare's own reveal loop: the first readback has the input under the dock, so it scrolls the
# context column (over its left edge) before clicking; the second has it inside the column.
REVEAL="$(typeset -f layout_line); QA_DEADLINE=\$(( EPOCHSECONDS + 600 )); LAST_INPUT=\$EPOCHREALTIME; WIN_X=0; WIN_Y=0; eval \"\$(sed -n '/^reveal_strength() {/,/^}/p' \$HERE/m7-compare.zsh)\"; print -r -- \"\$(layout_line 1050 727)\" > \$APP_LOG; layout() { [[ -f \$QA_STATE/scrolled ]] && print -r -- \"\$(layout_line 1050 400)\" >> \$APP_LOG; true }; osascript() { case \"\$*\" in *windows.js\\ hit*) print -r -- '{\"pid\":4242}' ;; *scroll.js*) print -r -- \"scroll \$*\" >> \$CALLS; : > \$QA_STATE/scrolled ;; *) ;; esac }; reveal_strength"
run_case reveal-scrolls-column-before-click 0 "$REVEAL" 'has reveal-scrolls-column-before-click "scroll .*scroll.js -100" && has reveal-scrolls-column-before-click "m:908,352" && [[ $(grep -n "scroll.js" $ROOT/reveal-scrolls-column-before-click/calls | head -1 | cut -d: -f1) -lt $(grep -n "c:1100,413" $ROOT/reveal-scrolls-column-before-click/calls | cut -d: -f1) ]] && none reveal-scrolls-column-before-click "c:1100,740"'

# --- M8 performance runner: its own guards, extracted from m8-perf.zsh -------------------------------
PERF='eval "$(sed -n "/^environment() {/,/^}/p;/^prepare() {/,/^}/p" $HERE/m8-perf.zsh)"; sysctl() { print stub }; pmset() { print -r -- "pmset $*" }'
run_case perf-refuses-recording 1 "$PERF; pgrep() { [[ \$* == '-x screencapture' ]] }; environment P0-1" '[[ ! -e $ROOT/perf-refuses-recording/out/environment-P0-1.txt ]]'
run_case perf-environment-recorded 0 "$PERF; pgrep() { false }; environment P0-1; grep -q 'display 1168x755@120' \$QA_OUT/environment-P0-1.txt && grep -q 'pmset -g therm' \$QA_OUT/environment-P0-1.txt"
run_case perf-workload-must-fit 5 "$PERF; WORKLOAD_SECONDS=330; QA_DEADLINE=\$(( EPOCHSECONDS + 200 )); prepare P1" 'none perf-workload-must-fit "open " && none perf-workload-must-fit cliclick'
run_case perf-requires-deadline 1 'unset QA_DEADLINE; source $HERE/m8-perf.zsh P0' 'none perf-requires-deadline "open "'
run_case perf-unknown-workload 2 'QA_DEADLINE=$(( EPOCHSECONDS + 600 )); source $HERE/m8-perf.zsh P7' 'none perf-unknown-workload "open "'

print -r -- "$passed passed, $failed failed"
(( failed == 0 ))
