# M8 keyboard and native-file session on the packaged app (AC3, AC4; T05/T12 keyboard, focus and
# native dialogs) at 1280×800 content and 200% Interface Scale. Requires an owner-approved hands-off
# window: QA_DEADLINE is its end. lib.zsh owns the shared GUI lock, hit tests and the external-input
# abort; m8lib.zsh adds the deadline and the m8q.py assertions. Disposable scenes and recovery only.
#
# Only Option-Tab, Space, Return, Escape, typed text and ⌘ chords reach the app: open an example from its menu,
# select its law from the Laws list, change position, rotation, extent and strength, switch it off and
# on, play, pause, step and reset, undo, save through the macOS Save panel and open the file again.
# Every focus stop must show its ring inside the window. Typing in a text field must not trigger the
# viewport's unmodified shortcuts. Synthetic keys are not a real keyboard: the owner check stays.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
mkdir -p $QA_STATE/scenes
seed_folder $QA_STATE/scenes
law() { logq field $APP_LOG layout "appliedLaws.0.$1" }
# enter VALUE: replaces the focused field's value and commits it with Tab, which also moves focus on.
enter() { keys kd:cmd t:a ku:cmd t:"$1"; key_code 48; sleep 0.3; layout }

segment "M8 keyboard and native files at 1280×800, 200%"
say "More Space, 120 Hz: $(osascript -l JavaScript $NATIVE/display.js set 1728 1117 120)"
sleep 2
launch m8-keyboard $QA_STATE/recovery-m8-keyboard-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
activate
window_size 1280 800
set_scale 200
expect layout "1280×800 content at 200%" "e['viewport']==[1280,800] and e['interfaceScale']==2"
m8q surface

# An example from its pop-up menu: Tab to it, Space opens it, typing chooses, Return opens.
tab_to "f['id']=='example-open'"
key_code 49
sleep 0.6
keys t:"Sideways Rain"
key_code 36
wait_log document 1 15
expect document "Sideways Rain opened from the keyboard" "e['action']=='example' and e['outcome']=='committed'"
layout; m8q example sideways-rain sideways

# Select the law from the Laws list.
tab_to "f['label'].startswith('Sideways') and f['tag']=='button' and not f['id'] and not f['label'].endswith('enabled')"
key_code 49
layout; expect layout "law selected from the list" "e['selected']=='sideways'"

# Position, rotation, extent and strength through their labeled fields.
tab_to "f['label']=='Position x'"; enter 1.5
expect layout "position x from the keyboard" "e['appliedLaws'][0]['pose']['position'][0]==1.5"
tab_to "f['label']=='Rotation about z'"; enter 30
expect layout "rotation from the keyboard" "abs(float(e['inputValues']['Rotation about z']) - 30) < 0.01"
tab_to "f['label']=='Half extent x'"; enter 2
expect layout "extent from the keyboard" "e['appliedLaws'][0]['region']['halfExtents'][0]==2"
tab_to "f['label']=='Strength'"; enter 7
expect layout "strength from the keyboard" "e['appliedLaws'][0]['expression']['strength']==7"

# Typing in the name field never reaches the viewport's unmodified shortcuts (t, r, s, f, Space, period).
tab_to "f['id']=='law-label'"
keys kd:cmd t:a ku:cmd t:"trsf. rain"
key_code 48
layout
expect layout "typing stayed in the text field" "e['transformMode']=='translate' and e['playing'] is False and e['authority']['tick']==0"

# Off and on, from the law's own control.
tab_to "f['label']=='trsf. rain enabled'"
key_code 49; layout; expect layout "switched off" "e['appliedLaws'][0]['enabled'] is False"
key_code 49; layout; expect layout "switched on" "e['appliedLaws'][0]['enabled'] is True"

# Play, pause, step and reset from the transport.
tab_to "f['id']=='play'"
key_code 49; sleep 1; key_code 49
layout; expect layout "played and paused" "e['playing'] is False and e['authority']['tick'] > 0"
tab_to "f['id']=='step'"
before=$(field layout authority.tick)
key_code 49; layout; expect layout "one step" "e['authority']['tick']==$before+1"
tab_to "f['id']=='reset'"
key_code 49; layout; expect layout "reset to tick 0" "e['authority']['tick']==0 and e['playing'] is False"

# Undo and redo outside text editing: the last edit (switching on) is undone and redone; the tick stays.
keys kd:cmd t:z ku:cmd
layout; expect layout "⌘Z undid switching on" "e['appliedLaws'][0]['enabled'] is False and e['authority']['tick']==0"
keys kd:shift kd:cmd t:z ku:cmd ku:shift
layout; expect layout "⇧⌘Z redid it" "e['appliedLaws'][0]['enabled'] is True and e['authority']['tick']==0"
m8q surface

# Save through the macOS Save panel, then open the file again.
n=$(count document)
keys kd:cmd t:s ku:cmd
save_panel $QA_STATE/scenes m8-keyboard.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "saved through the Save panel" "e['action']=='save-as' and e['outcome']=='saved'"
SAVED=$(field layout appliedLaws)
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel m8-keyboard.lawsmith.json
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_log document $(( n + 1 )) 15
expect document "reopened through the Open panel" "e['action']=='open' and e['outcome']=='committed'"
layout
[[ $(field layout appliedLaws) == $SAVED ]] || fail "the reopened laws differ from the saved ones"
m8q surface
shot m8-keyboard-reopened-200

keys kd:cmd t:0 ku:cmd
keys kd:cmd t:q ku:cmd
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m8-keyboard complete"
