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
      case $1 in
        read) [[ -f $DOMAIN_FILE ]] ;;
        export) [[ -f $DOMAIN_FILE && -z $EXPORT_FAILS ]] && cp $DOMAIN_FILE $3 ;;
        import) [[ -z $IMPORT_FAILS ]] && cp $3 $DOMAIN_FILE ;;
        delete) [[ -f $DOMAIN_FILE ]] && rm $DOMAIN_FILE ;;
      esac
    }
    osascript() {
      local all="$*"
      case $all in
        *windows.js\ hit*) print -r -- '{"pid":4242,"owner":"lawsmith"}' ;;
        *frontmostApplication*) print 4242 ;;
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
