# M2 defining demonstration (SPEC §2.1, steps 1–10) in the packaged app, recorded, ending with a real
# native Save As → quit → fresh launch → native Open → equal-tick comparison (M2 AC1–AC3, AC8).
# Usage: QA_STATE=… QA_OUT=… scripts/verify/verify.sh native m2-demo
source ${0:A:h}/lib.zsh
SCENE=m2-demo.lawsmith.json
RECOVERY=$QA_STATE/recovery-demo-$EPOCHSECONDS
mkdir -p $RECOVERY $QA_STATE/scenes

seed_folder $QA_STATE/scenes
segment "defining demonstration (about 90 s)"
launch demo-a $RECOVERY
expect recovery "launch finds no unsaved work in isolated recovery" "e['action']=='launch' and e['current']=='absent' and e['previous']=='absent'"
activate
record_start m2-demo
layout
shot demo-01-start

# Steps 1–2: a stream falls under gravity; the law is a selectable translucent box.
press play
sleep 6
expect pacing "a stream of 20–100 bodies is live" "20 <= e['bodies'] <= 100"
shot demo-02-stream

# Step 3: translate the law from outside the stream into it, by its handle.
drag_law_to 3 1 0 0.4 1 0
wait_log law-applied 1 5
expect gesture "one move gesture committed through the command path" "e['phase']=='commit' and e['transformMode']=='translate' and abs(e['field']['position'][0]) < 1.5"
# Step 4: bodies bend sideways while inside the support.
sleep 4
shot demo-03-bent

# Step 5: rotate the law; subsequent motion changes direction.
keys t:r
layout
# TransformControls turns a ring by the drag along axis × eye (not along the ring's tangent), so the
# drag follows that direction's projection on screen.
rotate_from=(${=$(handle Z 0)})
camera=$(logq field $APP_LOG layout camera | tr -d '[] ')
direction=(${=$(python3 -I -c "
c = [$camera]; p = [0.4, 1, 0]
e = [c[i] - p[i] for i in range(3)]; n = sum(v * v for v in e) ** 0.5; e = [v / n for v in e]
d = [-e[1], e[0], 0]; m = (d[0] ** 2 + d[1] ** 2) ** 0.5
print(*(round(p[i] + 0.5 * d[i] / m, 6) for i in range(3)))")})
p0=(${=$(world 0.4 1 0)}); p1=(${=$(world $direction)})
rotate_to=(${=$(python3 -I -c "
dx, dy = $p1[1] - $p0[1], $p1[2] - $p0[2]; n = (dx * dx + dy * dy) ** 0.5
print(round($rotate_from[1] + 42 * dx / n), round($rotate_from[2] + 42 * dy / n))")})
drag $rotate_from[1] $rotate_from[2] $rotate_to[1] $rotate_to[2]
expect gesture "one rotate gesture turned the law by more than 20 degrees" "e['phase']=='commit' and e['transformMode']=='rotate' and abs(e['field']['rotation'][3]) < 0.985"
keys t:t
sleep 4
# Step 6: sparse arrows come from the evaluator (they turn with the law and fade at the boundary).
layout
shot demo-04-rotated

# Step 7: a body that leaves the support keeps its acquired velocity (visible in the recording).
sleep 3

# Step 8: disabling the law removes its contribution; enabling restores it.
p=(${=$(point laws.0.enabled)}); click $p[1] $p[2]
expect control "the law is disabled through a semantic command" "e.get('enabled') is False and e.get('revision') is not None"
sleep 3
shot demo-05-disabled
click $p[1] $p[2]
expect control "the law is enabled again" "e.get('enabled') is True"
sleep 2

# Step 9: Reset rebuilds the fixed authored configuration at tick 0; its run is digested at 600/1200.
digests=$(count run-digest)
press reset
expect sim-control "reset pauses at tick 0 with the authored configuration" "e['action']=='reset' and e['tick']==0"
press play
wait_log run-digest $(( digests + 2 )) 30
logq all $APP_LOG run-digest | tail -2 > $QA_OUT/demo-a-digests.jsonl
say "run A digests: $(cut -c1-200 $QA_OUT/demo-a-digests.jsonl | tr '\n' ' ')"

# Step 10: save the configuration through the real macOS Save panel, quit, reopen in a fresh app.
keys kd:cmd,shift t:s ku:cmd,shift
save_panel $QA_STATE/scenes $SCENE
wait_log document 1 15
expect document "Save As wrote the captured revision and bound the file" "e['action']=='save-as' and e['outcome']=='saved' and e['file']=='$SCENE' and e['recoveryRetired'] is True and e['saveMs'] <= 500"
shot demo-06-saved
activate
keys kd:cmd t:q ku:cmd
wait_exit
say "quit with nothing unsaved: no alert was needed"

launch demo-b $RECOVERY
expect recovery "saved work is not offered as unsaved after restart" "e['action']=='launch' and e['current']=='absent' and e['previous']=='absent'"
activate
keys kd:cmd t:o ku:cmd
open_panel $SCENE
wait_log document 1 15
expect document "the saved file opened transactionally within the 500 ms gate" "e['action']=='open' and e['outcome']=='committed' and e['file']=='$SCENE' and e['openMs'] <= 500"
expect sim-control "an opened scene starts paused at tick 0" "e['action']=='load' and e['tick']==0 and e['playing'] is False"
layout
shot demo-07-reopened
press play
wait_log run-digest 2 30
logq all $APP_LOG run-digest | tail -2 > $QA_OUT/demo-b-digests.jsonl
python3 -I - $QA_OUT/demo-a-digests.jsonl $QA_OUT/demo-b-digests.jsonl <<'PY' | tee -a $QA_OUT/qa-steps.log
import json, sys
# Each run needs its own digest at both ticks; pairing records in order would pass over a missing one.
runs = [{e['tick']: e for e in map(json.loads, open(path))} for path in sys.argv[1:]]
ok = True
for tick in (600, 1200):
    x, y = (run.get(tick) for run in runs)
    if not (x and y):
        print('FAIL', f"equal-tick after native reopen at tick {tick}: run {'A' if not x else 'B'} has no digest")
        ok = False
        continue
    same = x['stateSha256'] == y['stateSha256'] and x['engineSha256'] == y['engineSha256']
    print(('PASS' if same else 'FAIL'), f"equal-tick after native reopen at tick {tick}: state {x['stateSha256'][:8]}/{y['stateSha256'][:8]}, engine {x['engineSha256'][:8]}/{y['engineSha256'][:8]}")
    ok = ok and same
sys.exit(0 if ok else 1)
PY
# tee succeeds whatever the comparison printed, so the comparison's own status decides.
(( pipestatus[1] == 0 )) || fail "equal-tick digests after native reopen are missing or differ"
shot demo-08-reopened-running
press play
keys kd:shift t:d ku:shift
wait_log fixtures 1 60
expect fixtures "reset and 30/60/144 Hz cadence fixtures agree exactly on the reopened scene" "e['allEqual'] is True"
record_stop
activate
keys kd:cmd t:q ku:cmd
wait_exit
say "m2-demo complete"
