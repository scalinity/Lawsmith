# M2 file failure paths in the packaged app (AC6, AC7): invalid imports leave the scene untouched;
# a canceled Save As and a refused name write nothing; the untouched bundled scene saves byte for
# byte as the bundled file (AC1); a full disk preserves the existing file and
# leaves editing and Save As elsewhere working; a read-only recovery directory leaves Save working.
# Needs, under QA_STATE: scenes/bad-*.lawsmith.json, and full/ — a volume with no free space holding
# on-full-disk.lawsmith.json, whose pristine copy is QA_STATE/on-full-disk.original.json, reached
# through the symlink scenes/on-full-disk-link.lawsmith.json (so the panels stay in scenes/); and
# recovery-readonly/, a directory without write permission.
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m2-files
source ${0:A:h}/lib.zsh

# --- Invalid imports -------------------------------------------------------------------------
seed_folder $QA_STATE/scenes
segment "invalid imports, canceled and refused saves"
launch files-a $QA_STATE/recovery-files-$EPOCHSECONDS
activate
startup=$(field digest semanticSha256)
typeset -A expected=(
  bad-unknown-capability "e.get('path')=='requiredCapabilities[3]'"
  bad-zero-rotation "e.get('path')=='semantic.fields[0].pose.rotation'"
  bad-not-json "'not valid JSON' in e.get('reason','')"
  bad-latin1 "e.get('failure')=='not-utf8'"
  bad-oversized "e.get('failure')=='too-large'"
)
for name in bad-unknown-capability bad-zero-rotation bad-not-json bad-latin1 bad-oversized; do
  n=$(count document)
  activate
  keys kd:cmd t:o ku:cmd
  open_panel $name.lawsmith.json
  wait_log document $(( n + 1 )) 15
  expect document "$name is rejected before replacing anything" "e['action']=='open' and e['outcome'] in ('rejected','failed') and ${expected[$name]}"
done
expect digest "the current scene's semantics never changed" "e['reason']=='startup' and e['semanticSha256']=='$(print -r -- $startup | tr -d '\"')'"
layout
shot files-01-rejected-import

# --- Canceled Save As and a refused name -------------------------------------------------------
n=$(count document)
keys kd:cmd,shift t:s ku:cmd,shift
cancel_panel
wait_log document $(( n + 1 )) 10
expect document "a canceled Save As writes nothing" "e['action']=='save-as' and e['outcome']=='canceled'"
n=$(count document)
activate
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes refused-name.json
wait_log document $(( n + 1 )) 10
expect document "a name without .lawsmith.json is refused" "e['action']=='save-as' and e['outcome']=='refused-name'"
[[ -e $QA_STATE/scenes/refused-name.json ]] && fail "a refused name was written"
say "PASS  no file was written for the refused name"
shot files-02-refused-name

# Nothing above edited the bundled scene, so its save through the real panel is the bundled file's bytes.
n=$(count document)
activate
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes bundled-roundtrip.lawsmith.json
wait_log document $(( n + 1 )) 10
expect document "the untouched bundled scene saves" "e['action']=='save-as' and e['outcome']=='saved'"
cmp -s $QA_STATE/scenes/bundled-roundtrip.lawsmith.json $REPO/src/scenes/falling-stream.lawsmith.json || fail "the saved bundled scene differs from the bundled file"
say "PASS  the saved bundled scene is byte-identical to the bundled file"
activate
keys kd:cmd t:q ku:cmd
wait_exit

# --- A full disk ------------------------------------------------------------------------------
seed_folder $QA_STATE/scenes
segment "full disk"
launch files-b $QA_STATE/recovery-files-full-$EPOCHSECONDS
activate
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel on-full-disk-link.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "the file on the full disk opened, through a symlink, and bound" "e['outcome']=='committed' and e['file'].startswith('on-full-disk')"
toggle_law
n=$(count document)
activate
keys kd:cmd t:s ku:cmd
wait_log document $(( n + 1 )) 15
expect document "Save to the symlinked file on a full disk fails and says so" "e['action']=='save' and e['outcome']=='failed' and e['failure']=='disk-full'"
cmp -s $QA_STATE/full/on-full-disk.lawsmith.json $QA_STATE/on-full-disk.original.json || fail "the existing file changed"
say "PASS  the existing file is byte-identical after the failed save"
ls -A $QA_STATE/full | grep -q lawsmith-tmp && fail "a temporary file was left behind"
say "PASS  no temporary file was left on the full disk"
shot files-03-disk-full
toggle_law
expect control "editing still works after the failed save" "e.get('enabled') is True and e.get('revision') is not None"
n=$(count document)
activate
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes after-disk-full.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "Save As to another writable location works after the failure" "e['action']=='save-as' and e['outcome']=='saved' and e['file']=='after-disk-full.lawsmith.json'"
activate
keys kd:cmd t:q ku:cmd
wait_exit

# --- A recovery directory without write permission ------------------------------------------------
segment "read-only recovery directory"
launch files-c $QA_STATE/recovery-readonly
activate
toggle_law
sleep 1.5
expect recovery "a recovery write that is denied is reported" "e['action']=='write' and e['outcome']=='failed' and e['failure']=='permission'"
layout
shot files-04-recovery-unavailable
n=$(count document)
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes after-recovery-failure.lawsmith.json
wait_log document $(( n + 1 )) 15
expect document "explicit Save As works while recovery is unavailable" "e['action']=='save-as' and e['outcome']=='saved'"
activate
keys kd:cmd t:q ku:cmd
wait_exit
say "m2-files complete"
