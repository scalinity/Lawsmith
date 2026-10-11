# M8 P0/P1/P2/P3 under SPEC §18.2 on the packaged app (MILESTONES M8 Performance gate), with the final
# default visuals: law names on, default arrows and trails, Interface Scale 100%, nothing disabled to pass.
#   QA_STATE=… QA_OUT=… QA_DEADLINE=… scripts/verify/verify.sh native m8-perf            all four
#   … zsh scripts/verify/native/m8-perf.zsh P0 P2                                         some of them
# Requires an owner-approved hands-off window: QA_DEADLINE is its end, and a workload starts only if
# it can finish before it. lib.zsh owns the GUI lock, the hit tests and the external-input abort;
# m8lib.zsh the display and preference restore on exit.
#
# Protocol: main display 1728×1117 at exactly 60 Hz (verified by readback), window content 1600×1000
# CSS, device pixel ratio 2 rendered at the 1.5 cap, a visible focused packaged WKWebView on WebGPU.
# Each workload runs in its own launch and log. Each capture is the app's own Shift+P: 10 s of warmup
# kept out of the sample, then 60 s measured, logged with every raw sample; three independent captures
# per workload. P0, P1 and P2 take accepted edits from real handle drags of the selected law, as the
# accepted P0/P1/P2 runners did; P3 takes the app's own periodic resolved law edits. P3 measures the
# default 600-tick baseline construction separately, then computes the full 7,200-tick baseline
# (Shift+K); each P3 capture warms a disposable continuation, restores the fork and measures active
# playback, excluding setup and horizon pauses. Screen recording stays off: no recording is started,
# and a running one stops the run. m8perf.py checks every capture, recomputing its percentiles from
# the raw samples; nothing is averaged across runs.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
WORKLOADS=(${@:-P0 P1 P2 P3})
for w in $WORKLOADS; do [[ $w == P[0-3] ]] || { print -u2 "unknown workload $w"; exit 2 }; done
mkdir -p $QA_STATE/scenes
for f in p1-workshop p2-probes p3-futures; do cp ${NATIVE:h}/scenes/$f.lawsmith.json $QA_STATE/scenes/; done
# A workload needs about five minutes: launch and setup, three warmed 70 s captures, quitting.
WORKLOAD_SECONDS=330

perfq() { python3 -I $NATIVE/m8perf.py "$@" | tee -a $QA_OUT/m8-perf-checks.jsonl; (( ${pipestatus[1]} == 0 )) || fail "M8 performance check failed: $1 $3" }

# environment LABEL: a read-only record of the display mode, power and thermal state and hardware for
# one capture. A screen recording in progress fails the run instead of being stopped.
environment() {
  pgrep -x screencapture >/dev/null && fail "a screen recording is running; numeric captures need recording off"
  {
    print -r -- "utc $(date -u +%FT%TZ)"
    print -r -- "display $(display_get)"
    print -r -- "model $(sysctl -n hw.model) memory $(sysctl -n hw.memsize)"
    pmset -g batt
    pmset -g | grep -i -E 'powermode|lowpowermode|highpowermode'
    pmset -g therm
  } > $QA_OUT/environment-$1.txt 2>&1
}

open_fixture() {
  local n=$(count document)
  keys kd:cmd t:o ku:cmd
  open_panel $1.lawsmith.json
  sleep 0.5
  [[ $(depth) == 1 ]] && alert_for scene "Don't Save"
  wait_log document $(( n + 1 )) 15
  expect document "$1 opened" "e['action']=='open' and e['outcome']=='committed'"
}

# prepare WORKLOAD: a fresh launch at the protocol's size, ratio and scale, with the runtime identity.
prepare() {
  deadline_gate $WORKLOAD_SECONDS
  segment "M8 $1, about five minutes"
  launch m8-perf-$1 $QA_STATE/recovery-m8-perf-$1-$EPOCHSECONDS
  expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
  expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
  activate
  window_size 1600 1000
  set_scale 100
  layout
  expect layout "1600×1000 CSS, DPR capped at 1.5, Interface Scale 100%, law names on" "e['viewport']==[1600,1000] and e['devicePixelRatio']>=1.5 and e['pixelRatio']==1.5 and e['canvas']==[2400,1500] and e['interfaceScale']==1 and len(e['lawLabels'])>0"
}

# captures WORKLOAD FX FY FZ TX TY TZ: three captures, each with the selected law dragged between two
# world points throughout its measured minute.
captures() {
  local w=$1 run runs measures start flip
  shift
  for run in 1 2 3; do
    environment $w-$run
    runs=$(count p0-run); measures=$(count p0)
    keys kd:shift t:p ku:shift
    wait_log p0 $(( measures + 2 )) 20
    say "$w capture $run measuring"
    start=$EPOCHSECONDS; flip=0
    while (( $(count p0-run) == runs && EPOCHSECONDS - start < 56 )); do
      if (( flip )); then drag_law_to $4 $5 $6 $1 $2 $3; else drag_law_to $1 $2 $3 $4 $5 $6; fi
      flip=$(( 1 - flip ))
      sleep 1.5
    done
    wait_log p0-run $(( runs + 1 )) 30
    perfq run $APP_LOG $w
  done
  perfq summary $APP_LOG $w $QA_OUT/m8-perf-$w.json
}

finish() {
  keys kd:cmd t:q ku:cmd
  sleep 0.6
  [[ $(depth) == 1 ]] && alert_for scene "Don't Save"
  wait_exit
}

segment "M8 performance: display mode"
seed_folder $QA_STATE/scenes
display_set 1728 1117 60

for w in $WORKLOADS; do
  prepare $w
  case $w in
    P0)
      # Default Sideways Rain, its law dragged into the stream until the stream is at full strength.
      open_example "Sideways Rain" sideways-rain
      press play
      sleep 3
      drag_law_to 3 1 0 0.4 1 0
      sleep 8
      expect pacing "the stream is at full strength with the law inside it" "e['bodies']==64 and e['playing'] is True"
      captures P0 0.4 1 0 0.7 1 0
      ;;
    P1)
      open_fixture p1-workshop
      layout; expect layout "P1 opens with drag-0 selected" "e['selected']=='drag-0'"
      press trails-all
      press play
      sleep 2
      captures P1 -2.6 -0.5 -3 -3 -0.5 -3
      ;;
    P2)
      open_fixture p2-probes
      layout; expect layout "P2 opens with its drag law selected" "e['selected']=='drag'"
      press probes-toggle
      press trails-all
      press play
      sleep 2
      captures P2 0 -0.5 0 0.4 -0.5 0
      ;;
    P3)
      open_fixture p3-futures
      layout; expect layout "P3 workload" "len(e['bodies'])==100"
      environment P3-construction
      # Compare from here forks and computes the default 600-tick baseline at once: fork, start, commit.
      n=$(count comparison)
      press_expect compare-from comparison
      wait_log comparison $(( n + 3 )) 20
      perfq construction $APP_LOG
      n=$(count comparison)
      keys kd:shift t:k ku:shift
      wait_log comparison $(( n + 2 )) 30
      expect comparison "full 7200-tick baseline admitted" "e['action']=='baseline-committed' and e['horizon']==7200 and e['bytes'] <= 67108864"
      for run in 1 2 3; do
        environment P3-$run
        runs=$(count p3-run)
        keys kd:shift t:p ku:shift
        say "P3 capture $run: 10 s warmup, fork restored, 60 s measured"
        wait_log p3-run $(( runs + 1 )) 100
        perfq run $APP_LOG P3
      done
      perfq summary $APP_LOG P3 $QA_OUT/m8-perf-P3.json
      press_expect comparison-close comparison
      ;;
  esac
  finish
done
say "m8-perf complete: ${WORKLOADS[*]}"
