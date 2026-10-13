# M9 presentation smoke (SPEC §18.2: "Separately smoke-test 1280×800 and Retina/high-refresh presentation"),
# on the packaged app, Sideways Rain with its law dragged in the stream:
#   (a) 1280×800 CSS at 60 Hz under More Space, DPR 2 rendered at the 1.5 cap;
#   (b) the same Retina display at 120 Hz, 1600×1000 CSS.
# Each runs about 30 s; m9perf.py smoke checks the pacing events of that window: playing, the capped ratio,
# the display's frame rate, no new stall over 50 ms, simulated/wall ≥0.98 from ticks and t. These are
# smoke results, not SPEC §18 gates.
#   QA_STATE=… QA_OUT=… QA_DEADLINE=… scripts/verify/verify.sh native m9-smoke
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
m9q() { python3 -I $NATIVE/m9perf.py "$@" | tee -a $QA_OUT/m9-smoke-checks.jsonl; (( ${pipestatus[1]} == 0 )) || fail "M9 smoke check failed: $1 $4" }

# window_smoke HZ WIDTH HEIGHT: resizes, reads back the layout, then about 30 s of play with law drags.
window_smoke() {
  window_size $2 $3
  layout
  expect layout "$2×$3 CSS, DPR capped at 1.5, Interface Scale 100%" "e['viewport']==[$2,$3] and e['devicePixelRatio']>=1.5 and e['pixelRatio']==1.5 and e['canvas']==[round($2*1.5),round($3*1.5)] and e['interfaceScale']==1"
  sleep 5
  local skip=$(count pacing) start=$EPOCHSECONDS flip=0
  while (( EPOCHSECONDS - start < 30 )); do
    if (( flip )); then drag_law_to 0.7 1 0 0.4 1 0; else drag_law_to 0.4 1 0 0.7 1 0; fi
    flip=$(( 1 - flip ))
    sleep 1.5
  done
  m9q smoke $APP_LOG $skip $1
}

segment "M9 smoke: 1280×800 at 60 Hz, then 120 Hz"
deadline_gate 240
# Snapshots the Lawsmith preferences before Interface Scale or the panel folder can be written.
seed_folder $QA_STATE
display_set 1728 1117 60
launch m9-smoke $QA_STATE/recovery-m9-smoke-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
activate
set_scale 100
open_example "Sideways Rain" sideways-rain
press play
sleep 3
drag_law_to 3 1 0 0.4 1 0
window_smoke 60 1280 800
display_set 1728 1117 120
activate
window_smoke 120 1600 1000
m9q startup $APP_LOG
keys kd:cmd t:q ku:cmd
sleep 0.6
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m9-smoke complete"
