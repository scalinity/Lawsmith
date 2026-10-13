# M9 P0/P1/P2/P3 under SPEC §18.2 on the packaged app (MILESTONES M9 AC1–3), with the final default visuals:
# law names on, default arrows and trails, Interface Scale 100%, the HUD shown, nothing disabled to pass.
#   QA_STATE=… QA_OUT=… QA_DEADLINE=… scripts/verify/verify.sh native m9-perf            all four
#   … zsh scripts/verify/native/m9-perf.zsh P1 P3                                         some of them
# QA_DEADLINE is this scenario's finite safety deadline: a workload starts only if it can finish before it.
# lib.zsh owns the GUI lock (or adopts a lent one), the hit tests and the outside-input abort; m8lib.zsh the
# display and preference restore on exit. Screen recording stays off; a running one stops the run.
#
# Protocol: main display 1728×1117 at exactly 60 Hz (verified by readback), window content 1600×1000 CSS,
# device pixel ratio 2 rendered at the 1.5 cap, a visible focused packaged WKWebView on WebGPU. Each
# workload runs in its own launch and log; three independent captures per workload, each the app's own
# Shift+P with 10 s of warmup kept out of the sample and 60 s measured with every raw sample.
#   P0–P2: accepted edits come from real handle drags of the selected law throughout each measured minute.
#   P3, per capture and in SPEC §18.2's order: Compare from here forks and builds A's default 600-tick
#   baseline, measured on its own; Shift+P warms a disposable continuation of the fork (restored from it at
#   A's 600-tick horizon), restores the fork, precomputes the full 7,200-tick baseline, then measures 60 s of
#   active playback with the app's own periodic resolved law edits (their origin is labelled); Close
#   comparison ends the capture, so each capture has its own fork. After the three captures, outside every
#   sample: real drags of B's law while it plays, and a running 7,200-tick baseline canceled from its control.
# m9perf.py checks every capture and the order of P3's setup, recomputing percentiles and simulated/wall
# from the raw samples; nothing is averaged across runs.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
if (( $# )); then WORKLOADS=("$@"); else WORKLOADS=(P0 P1 P2 P3); fi
for w in "${WORKLOADS[@]}"; do [[ $w == P[0-3] ]] || { print -u2 "unknown workload $w"; exit 2 }; done
mkdir -p $QA_STATE/scenes
for f in p1-workshop p2-probes p3-futures; do cp ${NATIVE:h}/scenes/$f.lawsmith.json $QA_STATE/scenes/; done
# About five minutes per workload (launch and setup, three warmed 70 s captures, quitting); P3 adds its
# per-capture fork and precompute and the supplementary drags and cancel.
WORKLOAD_SECONDS=330
P3_SECONDS=420

perfq() { python3 -I $NATIVE/m9perf.py "$@" | tee -a $QA_OUT/m9-perf-checks.jsonl; (( ${pipestatus[1]} == 0 )) || fail "M9 performance check failed: $1 $3" }

# environment LABEL: a read-only record of the display mode, power and thermal state and hardware for one
# capture. A screen recording in progress fails the run instead of being stopped.
environment() {
  pgrep -x screencapture >/dev/null && fail "a screen recording is running; numeric captures need recording off"
  {
    print -r -- "utc $(date -u +%FT%TZ)"
    print -r -- "display $(display_get)"
    print -r -- "model $(sysctl -n hw.model) memory $(sysctl -n hw.memsize)"
    print -r -- "macos $(sw_vers -productVersion) $(sw_vers -buildVersion)"
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

# prepare WORKLOAD SECONDS: a fresh launch at the protocol's size, ratio and scale, with the runtime identity.
prepare() {
  deadline_gate $2
  segment "M9 $1"
  launch m9-perf-$1 $QA_STATE/recovery-m9-perf-$1-$EPOCHSECONDS
  expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
  expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
  activate
  window_size 1600 1000
  set_scale 100
  layout
  expect layout "1600×1000 CSS, DPR capped at 1.5, Interface Scale 100%, HUD shown, law names on" "e['viewport']==[1600,1000] and e['devicePixelRatio']>=1.5 and e['pixelRatio']==1.5 and e['canvas']==[2400,1500] and e['interfaceScale']==1 and e['hudHidden'] is False and len(e['lawLabels'])>0"
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
  perfq summary $APP_LOG $w $QA_OUT/m9-perf-$w.json
}

# compare_from: forks and waits for A's default 600-tick baseline to commit.
compare_from() {
  local n=$(count comparison)
  press_expect compare-from comparison
  wait_log comparison $(( n + 3 )) 20
  expect comparison "A's default 600-tick baseline committed" "e['action']=='baseline-committed' and e['metrics']['ticks']==600"
}
close_comparison() {
  press_expect comparison-close comparison
  expect comparison "comparison closed" "e['action']=='closed' and e['comparison'] is None"
}

# drag_selected DX: the selected law's X handle dragged DX metres along X from where the law is.
drag_selected() {
  layout
  local p=(${=$(logq last $APP_LOG layout | python3 -I -c "import json,sys; print(*json.load(sys.stdin)['selectedField']['pose']['position'])")})
  drag_law_to $p[1] $p[2] $p[3] $(( p[1] + $1 )) $p[2] $p[3]
}

finish() {
  keys kd:cmd t:q ku:cmd
  sleep 0.6
  [[ $(depth) == 1 ]] && alert_for scene "Don't Save"
  wait_exit
}

segment "M9 performance: display mode"
seed_folder $QA_STATE/scenes
display_set 1728 1117 60

for w in $WORKLOADS; do
  case $w in
    P0)
      prepare P0 $WORKLOAD_SECONDS
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
      prepare P1 $WORKLOAD_SECONDS
      open_fixture p1-workshop
      layout; expect layout "P1 opens with drag-0 selected" "e['selected']=='drag-0'"
      open_draw_options
      press trails-all
      press play
      sleep 2
      captures P1 -2.6 -0.5 -3 -3 -0.5 -3
      ;;
    P2)
      prepare P2 $WORKLOAD_SECONDS
      open_fixture p2-probes
      layout; expect layout "P2 opens with its drag law selected" "e['selected']=='drag'"
      open_draw_options
      press probes-toggle
      press trails-all
      press play
      sleep 2
      captures P2 0 -0.5 0 0.4 -0.5 0
      ;;
    P3)
      prepare P3 $P3_SECONDS
      open_fixture p3-futures
      layout; expect layout "P3 workload" "len(e['bodies'])==100"
      for run in 1 2 3; do
        environment P3-$run
        compare_from
        perfq construction $APP_LOG
        runs=$(count p3-run)
        keys kd:shift t:p ku:shift
        say "P3 capture $run: warm a disposable continuation, restore the fork, precompute 7,200 ticks, measure 60 s"
        wait_log p3-run $(( runs + 1 )) 110
        perfq run $APP_LOG P3
        close_comparison
      done
      perfq summary $APP_LOG P3 $QA_OUT/m9-perf-P3.json
      # Supplementary, outside every sample: real drags of B's law while B plays (native field manipulation
      # in the alternate), then a running baseline canceled from its own control.
      segment "M9 P3 supplementary: B dragged while it plays; a running baseline canceled"
      compare_from
      layout
      lp=(${=$(point laws.0.select)})
      click $lp[1] $lp[2]
      layout
      expect layout "B's first law selected for dragging" "e['selectedField'] is not None and e['comparison'] is not None"
      suffix_before=$(logq last $APP_LOG layout | python3 -I -c "import json,sys; print(json.load(sys.stdin)['comparison']['suffix'])")
      press play
      for dx in 0.3 -0.3 0.3; do drag_selected $dx; sleep 0.8; done
      layout
      expect layout "B's law took the real drags as its own interventions" "e['comparison']['suffix'] > $suffix_before"
      # Where Cancel baseline appears (Shift+K pauses B first): the readback is asked for in the same burst as Shift+K, while the
      # 7,200-tick job runs (Cancel baseline is shown only then).
      n=$(count layout)
      keys kd:shift t:k t:l ku:shift
      wait_log layout $(( n + 1 ))
      window_origin
      expect layout "Cancel baseline located while the 7,200-tick job ran" "e['comparison']['working'] is True and e['controls']['baseline-cancel'] is not None"
      cp=(${=$(point controls.baseline-cancel)})
      sleep 3
      close_comparison
      # A fresh fork, then the same job, canceled at once from the known point. If the job finished first, the
      # point holds a disabled control, nothing is canceled, and the check below fails.
      compare_from
      # One burst, as m6b-long's seek clicks: the point is hit-tested, the job started, then the click sent.
      guard_point $cp[1] $cp[2]
      keys kd:shift t:k ku:shift
      idle_gate 1
      cliclick -e 0 c:$cp[1],$cp[2]
      touched
      sleep 1
      perfq cancel $APP_LOG
      close_comparison
      ;;
  esac
  perfq startup $APP_LOG
  finish
done
say "m9-perf complete: ${WORKLOADS[*]}"
