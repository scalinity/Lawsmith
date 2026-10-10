# P3 default construction separately, then three independent 10s warm/restore/60s captures.
# Display 1600×1000 CSS, DPR capped1.5,60Hz; screen recording off. Input protection in lib.zsh.
source ${0:A:h}/lib.zsh
RECORDER=
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/p3-futures.lawsmith.json $QA_STATE/scenes/
ORIGINAL_MODE=$(osascript -l JavaScript $NATIVE/display.js get)
restore_mode() { local d=${ORIGINAL_MODE%@*}; osascript -l JavaScript $NATIVE/display.js set ${=${d/x/ }} ${ORIGINAL_MODE#*@} >/dev/null; }
trap 'running && kill $APP_PID; restore_mode; gui_unlock' EXIT
seed_folder $QA_STATE/scenes
segment "P3 three active comparison runs, about five minutes"
say "60Hz More Space: $(osascript -l JavaScript $NATIVE/display.js set 1728 1117 60)"
sleep 2
launch m7-perf $QA_STATE/recovery-m7-perf-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
activate
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID)
  set position of window \"Lawsmith\" to {40,45}
  set size of window \"Lawsmith\" to {1600,1000}
end tell" >/dev/null
sleep 1
keys kd:cmd t:o ku:cmd
open_panel p3-futures.lawsmith.json
sleep 0.5
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
layout
expect layout "P3 viewport and body workload" "e['viewport']==[1600,1000] and len(e['bodies'])==100"
press trails-off
press_expect compare-from comparison
n=$(count comparison)
press_expect baseline-compute comparison
wait_log comparison $(( n + 2 )) 20
expect comparison "P3 construction ≤3s and budget" "e['action']=='baseline-committed' and e['horizon']==600 and e['metrics']['elapsedMs'] <= 3000 and e['bytes'] <= 67108864"
n=$(count comparison)
keys kd:shift t:k ku:shift
wait_log comparison $(( n + 2 )) 30
expect comparison "full 7200 tick baseline admitted" "e['action']=='baseline-committed' and e['horizon']==7200 and e['bytes'] <= 67108864"
for run in 1 2 3; do
  local_start=$(count p3-run)
  keys kd:shift t:p ku:shift
  say "P3 $run: warm10s, restore fork, measure60s"
  wait_log p3-run $(( local_start + 1 )) 90
  # A fresh presentation clock admits no elapsed time on its first frame. SPEC §18 gates
  # 60 s of measured playback and sim/wall ≥0.98, with every completed step counted.
  expect p3-run "P3 $run valid and meets all gates" "e['mode']=='packaged' and e['invalid'] is None and e['incomplete'] is None and e['wallMs']>=60000 and 0<e['ticks']<=7200 and e['samples']['steps']==e['ticks'] and e['samples']['edits']>=50 and e['samples']['frames']>=3000 and e['bodies']==100 and e['workload']['laws']==4 and e['viewport']['css']==[1600,1000] and e['viewport']['pixelRatio']<=1.5 and e['stepMs'][1]<=3 and e['stepMs'][2]<=5 and e['workMs'][1]<=14 and e['intervalMs'][1]<=20 and e['intervalMs'][2]<=34 and e['editMs'][1]<=50 and e['simWallRatio']>=0.98 and e['comparison']['bytes']<=67108864"
done
press_expect comparison-close comparison
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
restore_mode
say "m7-perf complete"
