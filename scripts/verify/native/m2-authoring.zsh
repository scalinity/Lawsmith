# M2 authoring in the packaged app (AC4, AC5, AC6): one drag is one undo entry; undo and redo restore
# exact law values; undo while playing never rewinds bodies; duplicate and delete keep identity;
# camera, color, label, visibility and arrows leave the semantic digest unchanged while disabling a
# law changes it; an out-of-range precise value is rejected and the last valid value stays.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m2-authoring
source ${0:A:h}/lib.zsh

# Types a value into a field and commits it (Tab); a click on the panel's empty top padding then
# releases focus, so later shortcuts reach the viewport rather than the next field.
type_into() {
  local p=(${=$(point $1)}); click $p[1] $p[2]
  keys kd:cmd t:a ku:cmd; keys t:"$2"; key_code 48; sleep 0.4
  click $(( WIN_X + 18 )) $(( WIN_Y + 58 ))
}

seed_folder $QA_STATE/scenes
segment "authoring: undo and identity"
launch auth-a $QA_STATE/recovery-auth-$EPOCHSECONDS
activate

# One drag, one undo entry; undo and redo restore its endpoints exactly.
drag_law_to 3 1 0 1.5 1 0
expect gesture "one move gesture" "e['phase']=='commit' and e['transformMode']=='translate'"
moved=$(logq field $APP_LOG gesture field.position)
keys kd:cmd t:z ku:cmd
expect history "one undo restores the law to where the drag began" "e['action']=='undo' and e['label']=='Move law' and e['laws'][0]['position']==[3, 1, 0]"
keys kd:cmd,shift t:z ku:cmd,shift
expect history "redo restores the dragged position exactly" "e['action']=='redo' and e['laws'][0]['position']==$moved"
keys kd:cmd t:z ku:cmd
expect history "a second undo is the same entry again" "e['action']=='undo' and e['laws'][0]['position']==[3, 1, 0]"

# Undo while the simulation runs is a new command at the current tick: no rewind, motion continues.
keys kd:cmd,shift t:z ku:cmd,shift
press play
sleep 3
keys kd:cmd t:z ku:cmd
expect history "undo while playing applies at the current tick" "e['action']=='undo' and e['tick'] > 200"
undo_tick=$(field history tick)
sleep 2
grep -q '"action":"reset"' $APP_LOG && fail "undo reset the run"
press play
expect sim-control "the run kept advancing after the undo" "e['action']=='pause' and e['tick'] > $undo_tick"

# Duplicate and delete keep identity; undo restores the original ID.
layout
press law-duplicate
expect control "duplicate creates the next free ID" "e.get('created')=='sideways-2'"
press law-delete
expect control "delete removes the selected copy through the command path" "e.get('delete')=='sideways-2' and e.get('ok') is True"
keys kd:cmd t:z ku:cmd
expect history "undo of delete brings back sideways-2 with its ID" "e['label']=='Delete law' and [l['id'] for l in e['laws']]==['sideways', 'sideways-2']"
keys kd:cmd t:z ku:cmd
expect history "undo of duplicate removes the copy" "e['label']=='Duplicate law' and [l['id'] for l in e['laws']]==['sideways']"
keys kd:cmd,shift t:z ku:cmd,shift
expect history "redo of duplicate recreates the same ID" "e['label']=='Duplicate law' and [l['id'] for l in e['laws']]==['sideways', 'sideways-2']"
shot auth-01-duplicate

segment "authoring: presentation versus semantics"
activate
layout
p=(${=$(point laws.0.select)}); click $p[1] $p[2]
layout
p=(${=$(point 'swatches.#c58ae5')}); click $p[1] $p[2]
reference=$(field digest semanticSha256)
expect digest "a color change keeps the semantic digest" "e['reason']=='color'"
p=(${=$(point laws.0.visible)}); click $p[1] $p[2]
expect digest "hiding the law keeps the semantic digest" "e['reason']=='visibility' and e['semanticSha256']==$reference"
press arrows-toggle
expect digest "turning arrows off keeps the semantic digest" "e['reason']=='arrows' and e['semanticSha256']==$reference"
type_into inputs.law-label Push
expect digest "renaming the law keeps the semantic digest" "e['reason']=='label' and e['semanticSha256']==$reference"
layout
camera_before=$(field layout camera)
c=(${=$(world 0 -2 6)})
drag $c[1] $c[2] $(( c[1] + 80 )) $(( c[2] - 30 ))
cliclick du:$(( c[1] + 80 )),$(( c[2] - 30 )); touched
layout
[[ $(field layout camera) != $camera_before ]] || fail "the camera did not move"
expect digest "moving the camera made no document edit" "e['reason']=='label'"
say "PASS  the camera moved without a document edit"
shot auth-02-presentation
p=(${=$(point laws.0.enabled)}); click $p[1] $p[2]
expect digest "disabling the law changes the semantic digest" "e['reason']=='enabled' and e['semanticSha256']!=$reference"

# A precise value outside the supported range is rejected; the last valid value stays applied.
type_into 'inputs.Position x' 2000
expect control "an out-of-range position is rejected" "e.get('rejected') is not None and '1000' in e['rejected']"
layout
shot auth-03-rejected-value
type_into 'inputs.Position x' 2.5
expect control "a valid precise value is one validated edit" "e.get('precise')=='Move law' and e['field']['position'][0]==2.5"
activate
keys kd:cmd t:q ku:cmd
alert "Don't Save"
wait_exit
say "m2-authoring complete"
