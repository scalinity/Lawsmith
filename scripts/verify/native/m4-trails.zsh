# M4 trails across a paused Reset and a paused Open in the packaged app (AC5; SPEC §12, §13.2; the M4
# review's finding): with 32 trails drawn, a Reset while paused and an Open while paused each leave no
# trail stored and none drawn before any step, and trails come back only from new completed steps.
# The app's readback reports what the renderer submits (`visualization.drawn.trailVertices`).
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m4-trails
source ${0:A:h}/lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h:h:h}/examples/why-it-moves.lawsmith.json $QA_STATE/scenes/
RECOVERY=$QA_STATE/recovery-trails4-$EPOCHSECONDS
pause() { [[ $(field sim-control action) == '"play"' ]] && press play; sleep 0.4 }

seed_folder $QA_STATE/scenes
segment "trails across a paused Reset and a paused Open"
launch trails4 $RECOVERY
activate
press trails-all
press play
sleep 2.5
pause
layout
expect layout "the stream is paused with 32 trails stored and drawn" "e['visualization']['trails']['count']==32 and e['visualization']['drawn']['trailVertices'] > 0"
shot trails-reset-01-before
n=$(count sim-control)
keys kd:shift t:r ku:shift
wait_log sim-control $(( n + 1 ))
expect sim-control "Reset rebuilt the world at tick 0, paused" "e['action']=='reset' and e['tick']==0"
sleep 0.5
layout
expect layout "after the paused Reset no trail is stored or drawn, before any step" "e['visualization']['trails']['count']==0 and e['visualization']['drawn']['trailVertices']==0"
shot trails-reset-02-after-reset
press play
sleep 2.5
pause
layout
expect layout "new completed steps record new trails" "e['visualization']['trails']['count'] > 0 and e['visualization']['drawn']['trailVertices'] > 0"
keys kd:cmd t:o ku:cmd
n=$(count document)
open_panel why-it-moves.lawsmith.json
sleep 1.2
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_log document $(( n + 1 )) 15
expect document "another scene opened while paused" "e['action']=='open' and e['outcome']=='committed'"
sleep 0.5
layout
expect layout "after the paused Open no trail from the previous scene is stored or drawn" "e['visualization']['trails']['count']==0 and e['visualization']['drawn']['trailVertices']==0 and e['visualization']['trails']['mode']=='all'"
shot trails-reset-03-after-open
activate
keys kd:cmd t:q ku:cmd
sleep 1
[[ $(depth) == 1 ]] && alert "Don't Save"
wait_exit
say "m4-trails complete"
