# M8 visual and access matrix on the packaged app (MILESTONES M8 Visual QA; AC2, AC4, AC5, AC9).
# Requires an owner-approved hands-off window: QA_DEADLINE is its end. lib.zsh owns the shared GUI lock,
# the topmost-window/frontmost hit tests and the external-input abort; m8lib.zsh adds the deadline, the
# display restore and the m8q.py layout assertions. Disposable scenes and recovery only.
#
# For every example at 1280×800 and 900×600 content and 100/150/200% Interface Scale: the example opens
# paused with its law selected and invitation shown; one continuous surface (no region covers another,
# no control off the window or under the drag band, nothing scrolls sideways); traffic-light clearance;
# law names in the viewport; scaling leaves the simulation, pixel ratio and canvas unchanged; one whole-
# window capture. Then, at 1280×800: selection through overlapping laws, a long law name, near-zero and
# saturated arrows, the collapsed panel, comparison controls, a controlled comparison fault and window
# dragging from the drag band at each scale (the M1 window jump stays on watch: any jump is recorded).
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/m8-comparison-fault.lawsmith.json $QA_STATE/scenes/
seed_folder $QA_STATE/scenes

EXAMPLES=('sideways-rain:Sideways Rain:sideways' 'catch-and-release:Catch and Release:pull' 'drag-pocket:Drag Pocket:pocket' 'storm-bottle:Storm Bottle:storm-bottle' 'two-futures:Two Futures:sideways')
SCALES=(100 150 200)

# reveal_input LABEL: scrolls the Scene panel over its left edge until the inspector input LABEL is in view, then clicks it.
reveal_input() {
  local i p panel
  for i in {1..30}; do
    layout
    p=(${=$(logq field $APP_LOG layout "inputs.$1" | tr -d '[],')})
    [[ -n $p[1] && $p[1] != null ]] || fail "no inspector input $1"
    panel=(${=$(logq field $APP_LOG layout controls.panel | tr -d '[],')})
    if (( p[2] >= panel[2] + 4 && p[2] + p[4] <= panel[2] + panel[4] - 4 )); then
      click $(( WIN_X + ${p[1]%.*} + ${p[3]%.*} / 2 )) $(( WIN_Y + ${p[2]%.*} + ${p[4]%.*} / 2 ))
      return 0
    fi
    local sx=$(( WIN_X + ${panel[1]%.*} + 8 )) sy=$(( WIN_Y + ${panel[2]%.*} + ${panel[4]%.*} / 2 ))
    if (( p[2] < panel[2] + 4 )); then scroll_at $sx $sy 120; else scroll_at $sx $sy -120; fi
  done
  fail "could not bring $1 into the panel's view"
}
# set_input LABEL VALUE: replaces an inspector value and commits it with Tab.
set_input() { reveal_input "$1"; keys kd:cmd t:a ku:cmd t:"$2"; key_code 48; sleep 0.4 }

# drag_window DX DY: drags the window by a point in the drag band, clear of the traffic lights; records
# the window's actual displacement. A displacement other than the drag is the M1 regression watch.
drag_window() {
  layout
  local band=(${=$(logq field $APP_LOG layout controls.drag-region | tr -d '[],')})
  local x=$(( WIN_X + ${band[1]%.*} + (${band[3]%.*} > 300 ? 200 : ${band[3]%.*} / 2) )) y=$(( WIN_Y + ${band[2]%.*} + ${band[4]%.*} / 2 ))
  local before=($WIN_X $WIN_Y)
  drag $x $y $(( x + $1 )) $(( y + $2 )) 16
  sleep 0.6
  window_origin
  local dx=$(( WIN_X - before[1] )) dy=$(( WIN_Y - before[2] ))
  print -r -- "{\"check\":\"window-drag\",\"scale\":$(field layout interfaceScale),\"from\":[$x,$y],\"asked\":[$1,$2],\"moved\":[$dx,$dy]}" >> $QA_OUT/m8-checks.jsonl
  if (( dx != $1 || dy != $2 )); then
    say "WATCH: the window moved ($dx,$dy) for a ($1,$2) drag from the drag band (M1 jump watch)"
  else
    say "window moved exactly ($dx,$dy) from the drag band"
  fi
}

segment "M8 visual matrix"
say "More Space, 120 Hz: $(osascript -l JavaScript $NATIVE/display.js set 1728 1117 120)"
sleep 2
launch m8-visual $QA_STATE/recovery-m8-visual-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU'"
activate

for size in "1280 800" "900 600"; do
  window_size ${=size}
  for entry in $EXAMPLES; do
    key=${entry%%:*}; rest=${entry#*:}; title=${rest%%:*}; law=${rest#*:}
    keys kd:cmd t:0 ku:cmd
    open_example "$title" $key
    for pct in $SCALES; do
      set_scale $pct
      (( pct == 100 )) && base=$(( $(count layout) - 1 ))
      expect layout "content ${size/ /×}" "e['viewport']==[${size/ /,}]"
      m8q example $key $law
      m8q surface
      m8q lights "$(traffic_lights)"
      m8q labels
      m8q scale $base
      shot m8-$key-${size/ /x}-$pct
    done
  done
done

segment "M8 targeted states at 1280×800"
window_size 1280 800
keys kd:cmd t:0 ku:cmd

# Selection through overlaps: a point inside both the drag pocket and the pull.
open_example "Drag Pocket" drag-pocket
layout
p=(${=$(world -0.2 2.6 0)})
picked=()
for i in 1 2 3; do
  click $p[1] $p[2]
  layout; picked+=($(field layout selected))
done
say "overlap clicks selected: $picked"
[[ $picked[1] != $picked[2] && $picked[1] == $picked[3] ]] || fail "clicking again did not reach the law behind and back: $picked"
shot m8-overlap-selection

# A long law name, and arrows near zero and at the drawn cap, at 100% and 200%.
open_example "Sideways Rain" sideways-rain
for pct in 100 200; do
  set_scale $pct
  set_input law-label "A deliberately long law name that keeps going to test wrapping and clipping"
  layout; m8q surface; m8q labels
  shot m8-long-name-$pct
  set_input Strength 0.05
  layout; m8q surface
  shot m8-near-zero-arrows-$pct
  set_input Strength 200
  layout; m8q surface
  shot m8-saturated-arrows-$pct
  key_code 53
  keys kd:cmd t:z ku:cmd; keys kd:cmd t:z ku:cmd; keys kd:cmd t:z ku:cmd
done

# The collapsed panel: the scene card stays, the laws, inspector and settings go.
for pct in 100 200; do
  set_scale $pct
  press_expect panel-toggle control
  layout
  expect layout "panel collapsed" "e['panelCollapsed'] is True and e['controls']['panel'] is None and e['controls']['file-open'] is not None"
  m8q surface
  shot m8-collapsed-$pct
  press_expect panel-toggle control
done

# Comparison controls: Compare from here computes A at once.
open_example "Two Futures" two-futures
for pct in $SCALES; do
  set_scale $pct
  n=$(count comparison)
  press_expect compare-from comparison
  wait_log comparison $(( n + 3 )) 20
  expect comparison "A computed by Compare from here" "e['action']=='baseline-committed' and e['horizon']==600"
  layout; m8q surface
  shot m8-comparison-$pct
  press_expect comparison-close comparison
done

# A controlled comparison fault: the error heads the context column, beside nothing it could cover.
keys kd:cmd t:0 ku:cmd
n=$(count document)
press_panel file-open
open_panel m8-comparison-fault.lawsmith.json
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_log document $(( n + 1 )) 15
for pct in 100 200; do
  set_scale $pct
  n=$(count comparison)
  press_expect compare-from comparison
  wait_log comparison $(( n + 3 )) 20
  set_input Strength 200
  f=$(count simulation-fault)
  press_expect play sim-control
  wait_log simulation-fault $(( f + 1 )) 15
  layout
  expect layout "fault shown with recovery actions" "e['controls']['sim-error'] is not None and e['controls']['alternate-new'] is not None and e['controls']['comparison-close'] is not None"
  m8q surface
  shot m8-comparison-fault-$pct
  press_expect alternate-new comparison
  press_expect comparison-close comparison
done

# Window dragging from the drag band at each scale, and back.
for pct in $SCALES; do
  set_scale $pct
  drag_window 80 50
  drag_window -80 -50
done

keys kd:cmd t:0 ku:cmd
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m8-visual complete"
