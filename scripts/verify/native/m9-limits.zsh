# M9 work-limit characterization (the M5 thread SPEC §15.2's limits left open) on the packaged app: the
# P9 Work Limits scene (scripts/verify/scenes/p9-work-limits.lawsmith.json: P5 Compound's bodies and arena
# under 32 laws of 57 nodes and depth 8, 256 leaves) with 2,000 CPU probes, 32 trails and default arrows,
# at 1600×1000 CSS, DPR 2 rendered at the 1.5 cap, Interface Scale 100%, the HUD shown and 60 Hz.
# One Shift+P capture (10 s warmup, 60 s measured, every raw sample kept) with real guarded drags of a law
# throughout. This is a characterization, never a gate: it is not P2 or any P0–P3 workload, not a supported
# capacity, and it reports its figures without judging them against any budget. It checks only that the
# harness obtained what it claims: the packaged WebGPU runtime, this exact workload and protocol, a valid
# complete capture with its samples and at least one measured edit. Performance never fails this scenario.
#   QA_STATE=… QA_OUT=… QA_DEADLINE=… scripts/verify/verify.sh native m9-limits
# lib.zsh owns the GUI lock (or adopts a lent one), the hit tests and the outside-input abort; m8lib.zsh the
# deadline and the display and preference restore on exit. Screen recording stays off during the capture;
# a whole-window capture is taken only after it.
source ${0:A:h}/lib.zsh
source ${0:A:h}/m8lib.zsh
SCENE=p9-work-limits
mkdir -p $QA_STATE/scenes
cp ${NATIVE:h}/scenes/$SCENE.lawsmith.json $QA_STATE/scenes/

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
  } > $QA_OUT/environment-m9-limits.txt 2>&1
}

segment "M9 work-limit characterization: display mode and launch"
deadline_gate 300
seed_folder $QA_STATE/scenes
display_set 1728 1117 60
launch m9-limits $QA_STATE/recovery-m9-limits-$EPOCHSECONDS
expect qualification "qualified packaged runtime identity" "e['mode']=='packaged' and e['qualified'] is True"
expect backend "packaged WebGPU backend" "e['mode']=='packaged' and e['backend']=='WebGPU' and e['coordinateSystemIsWebGPU'] is True"
activate
window_size 1600 1000
set_scale 100
n=$(count document)
keys kd:cmd t:o ku:cmd
open_panel $SCENE.lawsmith.json
sleep 0.5
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_log document $(( n + 1 )) 20
expect document "$SCENE opened" "e['action']=='open' and e['outcome']=='committed'"
layout
expect layout "P9 Work Limits at 1600×1000 CSS, DPR capped at 1.5, 100%, HUD shown, 32 laws, a law selected" "e['viewport']==[1600,1000] and e['pixelRatio']==1.5 and e['canvas']==[2400,1500] and e['interfaceScale']==1 and e['hudHidden'] is False and len(e['appliedLaws'])==32 and e['selectedField'] is not None"
open_draw_options
press probes-toggle
press trails-all
press play
sleep 2

segment "M9 work-limit characterization: one capture with real law drags"
deadline_gate 150
environment
runs=$(count p0-run); measures=$(count p0)
keys kd:shift t:p ku:shift
wait_log p0 $(( measures + 2 )) 30
say "work-limit capture measuring (characterization, not a gate)"
start=$EPOCHSECONDS; flip=0
# The selected law's X handle, dragged 0.4 m along X and back from where the law sits.
pos=(${=$(logq last $APP_LOG layout | python3 -I -c "import json,sys; print(*json.load(sys.stdin)['selectedField']['pose']['position'])")})
while (( $(count p0-run) == runs && EPOCHSECONDS - start < 56 )); do
  if (( flip )); then drag_law_to $(( pos[1] + 0.4 )) $pos[2] $pos[3] $pos[1] $pos[2] $pos[3]; else drag_law_to $pos[1] $pos[2] $pos[3] $(( pos[1] + 0.4 )) $pos[2] $pos[3]; fi
  flip=$(( 1 - flip ))
  sleep 1.5
done
wait_log p0-run $(( runs + 1 )) 40
n=$(count visual-resources)
keys kd:shift t:v ku:shift
wait_log visual-resources $(( n + 1 )) 10
shot m9-limits-window

# The characterization record. Harness completion (exit status) is separate from the figures, which are
# reported as measured and never compared with a budget.
python3 -I - $APP_LOG ${NATIVE:h}/scenes/$SCENE.lawsmith.json $QA_OUT/m9-limits-characterization.json $NATIVE <<'PY' | tee -a $QA_OUT/m9-limits-checks.jsonl
import json, sys
log, scene_path, out, native = sys.argv[1:5]
sys.path.insert(0, native)
from m8perf import finite, percentiles  # unchanged M8 helpers

events, malformed = [], 0
with open(log, encoding='utf-8', errors='replace') as f:
    for line in f:
        if line.startswith('[lawsmith] {'):
            try:
                events.append(json.loads(line[len('[lawsmith] '):]))
            except json.JSONDecodeError:
                malformed += 1
of = lambda kind: [e for e in events if e.get('kind') == kind]
scene = json.load(open(scene_path, encoding='utf-8'))['semantic']
dynamic = [b for b in scene['bodies'] if b.get('type') == 'dynamic']
fixed = [b for b in scene['bodies'] if b.get('type') == 'fixed']
problems = []
need = lambda ok, text: ok or problems.append(text)

need(malformed == 0, f'{malformed} malformed [lawsmith] lines')
q, b, runs, phases = of('qualification'), of('backend'), of('p0-run'), of('p0')
need(len(q) == 1 and q[0].get('mode') == 'packaged' and q[0].get('qualified') is True, 'not exactly one qualified packaged launch')
need(len(b) == 1 and b[0].get('backend') == 'WebGPU' and b[0].get('coordinateSystemIsWebGPU') is True, 'not the WebGPU backend')
need(len(runs) == 1, f'{len(runs)} captures, not one')
e = runs[-1] if runs else {}
run = e.get('run')
mine = [p for p in phases if p.get('run') == run]
if [p.get('phase') for p in mine] == ['warmup', 'measure'] and finite(e.get('t')):
    tw, tm, te = mine[0]['t'], mine[1]['t'], e['t']
    need(tm - tw >= 9990 and te - tm >= 59990, f'warmup {tm - tw} ms, measured {te - tm} ms')
else:
    problems.append(f'capture lifecycle {[p.get("phase") for p in mine]}')
    tm = te = None
need(e.get('mode') == 'packaged', f'capture mode {e.get("mode")!r}')
# The exact workload: this scene's laws, leaves, bodies and contacts, with probes, trails and default arrows on.
w, vis = e.get('workload') or {}, e.get('visualization') or {}
need(w.get('title') == 'P9 Work Limits' and w.get('laws') == 32 and w.get('primitiveLeaves') == 256, f'workload {w.get("title")!r}, laws {w.get("laws")!r}, leaves {w.get("primitiveLeaves")!r}')
need(w.get('fixedColliders') == len(fixed) and w.get('authoredDynamic') == len(dynamic), f'bodies {w.get("authoredDynamic")!r}+{w.get("fixedColliders")!r}, scene {len(dynamic)}+{len(fixed)}')
need((vis.get('probes') or {}).get('enabled') is True and (vis.get('probes') or {}).get('live') == 2000, f'probes {vis.get("probes")!r}')
need((vis.get('trails') or {}).get('mode') == 'all' and (vis.get('trails') or {}).get('count') == 32, f'trails {vis.get("trails")!r}')
need(isinstance(e.get('arrows'), int) and e['arrows'] > 0, f'arrows {e.get("arrows")!r}')
# The protocol.
v, s = e.get('viewport') or {}, e.get('presentation') or {}
need(v.get('css') == [1600, 1000] and v.get('pixelRatio') == 1.5 and v.get('canvas') == [2400, 1500], f'viewport {v!r}')
need(s.get('interfaceScale') == 1 and s.get('hudHidden') is False and s.get('developerReadout') is False, f'presentation {s!r}')
# Samples present and complete; at least one real edit measured.
raw, samples = e.get('raw') or {}, e.get('samples') or {}
counts = {'stepMs': 'steps', 'tickMs': 'steps', 'probeMs': 'probeSteps', 'trailMs': 'trailSteps', 'fieldMs': 'steps', 'engineMs': 'steps',
          'intervalMs': 'frames', 'workMs': 'frames', 'prepMs': 'frames', 'submitMs': 'frames', 'drawCalls': 'frames', 'editMs': 'edits'}
for key, count in counts.items():
    values = raw.get(key)
    ok = isinstance(values, list) and values and len(values) == samples.get(count) and all(finite(x) and x >= 0 for x in values)
    need(ok, f'raw {key}: {len(values) if isinstance(values, list) else values!r} samples for {count}={samples.get(count)!r}')
need(samples.get('steps') == e.get('ticks'), f'{samples.get("steps")!r} step samples for {e.get("ticks")!r} ticks')
need(e.get('invalid') is None, f'invalid capture: {e.get("invalid")!r}')
need(e.get('incomplete') is None, f'incomplete capture: {e.get("incomplete")!r}')

ticks, wall = e.get('ticks'), e.get('wallMs')
conditions = [c for c in of('conditions') if tm is not None and te is not None and tm <= c.get('t', -1) <= te]
resources = of('visual-resources')
record = {
    'label': 'M9 work-limit characterization at SPEC §15.2 limits: not a P0–P3 gate, not a supported capacity, no performance verdict',
    'harness': 'complete' if not problems else 'incomplete',
    'problems': problems,
    'capture': {'run': run, 'invalid': e.get('invalid'), 'incomplete': e.get('incomplete'), 'wallMs': wall, 'ticks': ticks,
                'droppedMs': e.get('droppedMs'), 'samples': samples, 'edits': samples.get('edits'), 'editOrigin': e.get('editOrigin')},
    'workload': {**w, 'bodies': e.get('bodies'), 'arrows': e.get('arrows'), 'probes': vis.get('probes'), 'trails': vis.get('trails')},
    'runtime': {'identity': q[0].get('identity') if q else None, 'backend': {k: b[0].get(k) for k in ('backend', 'adapter', 'features', 'compatibilityMode')} if b else None,
                'profile': e.get('profile'), 'gpuTiming': e.get('gpuTiming'), 'viewport': v, 'presentation': s},
    'metrics': {
        'percentiles': 'p50, p95, p99, max (rank floor(p·n), recomputed from raw)',
        **{key: percentiles(raw[key]) if isinstance(raw.get(key), list) and raw[key] else None for key in counts},
        'simWall': round(ticks * 1000 / 120 / wall, 4) if isinstance(ticks, int) and finite(wall) and wall > 0 else None,
    },
    'bytes': {'visualization': vis.get('bytes'), 'totalBytes': vis.get('totalBytes'), 'contexts': vis.get('contexts'), 'render': e.get('render'),
              'afterCapture': resources[-1] if resources else None},
    'conditionsDuringCapture': [{'t': c.get('t'), 'shown': c.get('shown'), 'simWallRatio': c.get('simWallRatio'), 'skippedBirths': c.get('skippedBirths'), 'limiterActive': c.get('limiterActive')} for c in conditions],
    'raw': raw,
}
with open(out, 'w', encoding='utf-8') as f:
    json.dump(record, f, indent=1)
summary = {k: record['metrics'][k] for k in ('stepMs', 'probeMs', 'tickMs', 'intervalMs', 'workMs', 'simWall')}
print(json.dumps({'check': 'm9-limits characterization', 'harness': record['harness'], 'problems': problems, 'metrics': summary, 'conditions': len(conditions)}))
sys.exit(0 if not problems else 1)
PY
(( ${pipestatus[1]} == 0 )) || fail "work-limit characterization incomplete (harness, not performance); see m9-limits-characterization.json"
m9q_startup=$(python3 -I $NATIVE/m9perf.py startup $APP_LOG) && print -r -- $m9q_startup >> $QA_OUT/m9-limits-checks.jsonl

keys kd:cmd t:q ku:cmd
sleep 0.8
[[ $(depth) == 1 ]] && alert_for scene "Don't Save"
wait_exit
say "m9-limits complete (characterization recorded; no performance verdict)"
