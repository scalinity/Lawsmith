# M8 window dragging from the empty drag band (MILESTONES M8 Visual QA; AC9), on its own: the last step
# of m8-visual, for a campaign that has already run that scenario's matrix and targeted states on the same
# application and needs only this check (M8 R21). m8-visual keeps the same step; nothing here replaces it.
# Requires an owner-approved hands-off window: QA_DEADLINE is its end. lib.zsh owns the shared GUI lock,
# the topmost-window/frontmost hit tests and the external-input abort; m8lib.zsh adds the deadline, the
# display restore and the shared drag_window. Disposable scenes and recovery only.
#
# At 1280×800 and 100/150/200% Interface Scale, with Sideways Rain's opening framing (nothing beneath
# the band): the drag band is shown and clear of controls, the window follows an (80, 50) drag from it,
# and returns by the displacement it actually made. Any other displacement is recorded (M1 jump watch);
# none at all fails the run.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh

SCALES=(100 150 200)

segment "M8 window dragging from the drag band"
seed_folder $QA_STATE/scenes
display_set 1728 1117 120
sleep 2
launch m8-window $QA_STATE/recovery-m8-window-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU'"
activate
window_size 1280 800
open_example "Sideways Rain" sideways-rain
for pct in $SCALES; do
  set_scale $pct
  expect layout "content 1280×800" "e['viewport']==[1280,800]"
  m8q surface
  m8q lights "$(traffic_lights)"
  window_round_trip 80 50
done

keys kd:cmd t:0 ku:cmd
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m8-window complete"
