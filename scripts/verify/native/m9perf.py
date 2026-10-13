"""M9 checks over the packaged app's own events (SPEC §18, MILESTONES M9). Everything fails closed: a missing,
malformed or out-of-order event, field or series is a failure, never a pass by absence.

  m9perf.py run LOG WORKLOAD            the last capture of WORKLOAD in LOG: protocol, presentation,
                                        profile, workload, budgets and every gate, recomputed from raw
  m9perf.py summary LOG WORKLOAD OUT    exactly three independent captures from the one launch in LOG, in
                                        lifecycle order (P3: SPEC §18.2's setup order), per-run p50/p95/p99/
                                        max of every gated and profile series, and the worst run per gate
  m9perf.py construction LOG            the last default 600-tick baseline (≤3 s, ~8 ms batches, ≤64 MiB)
  m9perf.py cancel LOG                  the last canceled baseline: a job really running, canceled before
                                        it committed, with the frames shown meanwhile
  m9perf.py seek-cancel LOG             the last pending seek canceled from its Cancel control after its
                                        progress showed, never committed
  m9perf.py cycles LOG OUT              Shift+Y and Shift+U (T11), each rechecked from its raw cycles
  m9perf.py smoke LOG SKIP HZ           pacing events after the first SKIP: playing, DPR capped at 1.5, the
                                        display's rate, no new stall, simulated/wall ≥0.98 from ticks and t
  m9perf.py startup LOG...              the first-frame figures of every launch, as measured (cache state
                                        not controlled)
Percentiles use the production rank floor(p·n) (m8perf.percentiles) and are never averaged across runs.
Simulated/wall is recomputed from ticks and wallMs, never read from the rounded ratio.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from m8perf import COMMON, GATES, finite, percentiles, series_problems  # noqa: E402  (unchanged M8 helpers)

MIB = 1024 * 1024
STEP_MS = 1000 / 120  # SPEC §10.1: simulated time is n/120 s
PROFILE_DT = 0.008333333767950535  # the engine-reported f32 step (AGENTS.md)
INITIAL_TICKS, FULL_TICKS = 600, 7200
BATCH_LIMIT_MS = 8 + 2  # ~8 ms batches, within one unit of work over the budget (as the seek fixtures gate)
# The M9 profile series: per completed step (field, engine) and per frame (prep, submit, draw calls).
PROFILE_COUNTS = {'fieldMs': 'steps', 'engineMs': 'steps', 'prepMs': 'frames', 'submitMs': 'frames', 'drawCalls': 'frames'}
GATED = [('step p95', 'stepMs', 1, 'step95'), ('step p99', 'stepMs', 2, 'step99'), ('CPU work p95', 'workMs', 1, 'work95'),
         ('interval p95', 'intervalMs', 1, 'interval95'), ('interval p99', 'intervalMs', 2, 'interval99'), ('edit p95', 'editMs', 1, 'edit95')]
REPORTED = ['stepMs', 'tickMs', 'workMs', 'intervalMs', 'editMs', 'fieldMs', 'engineMs', 'prepMs', 'submitMs', 'drawCalls', 'probeMs', 'trailMs']
RENDER_KEYS = ['worlds', 'objects', 'geometries', 'textures', 'materials', 'traceBytes', 'comparisonBytes']


class Failed(AssertionError):
    pass


def require(problems):
    if problems:
        raise Failed('; '.join(problems))


def read_log(path):
    """Every `[lawsmith] {…}` line as an event. A line that starts as one and does not parse fails the log."""
    out, bad = [], 0
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    out.append(json.loads(line[len('[lawsmith] '):]))
                except json.JSONDecodeError:
                    bad += 1
    if bad:
        raise Failed(f'{bad} malformed [lawsmith] lines in {path}')
    if not out:
        raise Failed(f'no [lawsmith] events in {path}')
    return out


def of(evs, kind):
    return [e for e in evs if e.get('kind') == kind]


def num(value):
    return finite(value)


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def tick_cursor_engine(identity):
    """The fork's state part of a comparison identity: tick, cursor and engine-bytes hash."""
    parts = identity.split(':') if isinstance(identity, str) else []
    return tuple(parts[-3:]) if len(parts) >= 3 else None


# ------------------------------------------------------------------ one capture

def check_run(e, workload):
    """Every protocol, presentation, profile, workload, budget and gate failure of one capture."""
    if workload not in GATES:
        raise Failed(f'unknown workload {workload}')
    g = {**GATES[workload], **COMMON}
    p3 = workload == 'P3'
    problems = []

    def need(condition, text):
        if not condition:
            problems.append(text)

    need(e.get('kind') == ('p3-run' if p3 else 'p0-run'), f'not a {"p3-run" if p3 else "p0-run"} event')
    need(e.get('mode') == 'packaged', f'mode {e.get("mode")!r}, not packaged')
    need(e.get('invalid') is None, f'invalid: {e.get("invalid")!r}')
    need(e.get('incomplete') is None, f'incomplete: {e.get("incomplete")!r}')
    wall, ticks = e.get('wallMs'), e.get('ticks')
    need(num(wall) and wall >= 60000, f'measured {wall!r} ms, not 60 s')
    need(integer(ticks) and ticks > 0, f'ticks {ticks!r}')
    problems.extend(series_problems(e))
    raw, samples = e.get('raw') or {}, e.get('samples') or {}
    for key, count in PROFILE_COUNTS.items():
        values, n = raw.get(key), samples.get(count)
        if not isinstance(values, list) or not values:
            problems.append(f'raw {key} missing or empty')
            continue
        need(len(values) == n, f'raw {key} has {len(values)} samples for {count}={n!r}')
        need(all(num(v) and v >= 0 for v in values), f'raw {key} holds a non-finite or negative value')
        if key == 'drawCalls':
            need(all(integer(v) for v in values), 'draw calls are not whole numbers')
    need(integer(samples.get('frames')) and samples.get('frames') >= 3000, f'{samples.get("frames")!r} frames')
    # Recomputed gates and the simulated/wall ratio.
    got = {}
    for key in REPORTED:
        values = raw.get(key)
        got[key] = percentiles(values) if isinstance(values, list) and values and all(num(v) and v >= 0 for v in values) else None
    for key in ('stepMs', 'workMs', 'intervalMs', 'editMs'):
        need(got[key] is not None, f'no {key} samples')
    if all(got[k] is not None for k in ('stepMs', 'workMs', 'intervalMs', 'editMs')):
        need(15.5 <= got['intervalMs'][0] <= 18.5, f'median callback interval {got["intervalMs"][0]} ms is not 60 Hz')
        for name, key, index, limit in GATED:
            need(got[key][index] <= g[limit], f'{name} {got[key][index]} over {g[limit]}')
    ratio = ticks * STEP_MS / wall if integer(ticks) and num(wall) and wall > 0 else None
    need(ratio is not None and ratio >= g['simWall'], f'simulated/wall {ratio} under {g["simWall"]} (recomputed from ticks and wallMs)')
    need(num(e.get('droppedMs')), f'dropped wall time {e.get("droppedMs")!r} not reported')
    # Protocol: 1600×1000 CSS, DPR capped at 1.5, the canvas at that ratio.
    v = e.get('viewport') or {}
    pr, dpr = v.get('pixelRatio'), v.get('devicePixelRatio')
    need(v.get('css') == [1600, 1000], f'content {v.get("css")!r}, not 1600×1000')
    need(num(dpr) and dpr >= 1.5 and pr == 1.5, f'DPR {dpr!r} rendered at {pr!r}, not capped at 1.5')
    need(num(pr) and v.get('canvas') == [round(1600 * pr), round(1000 * pr)], f'canvas {v.get("canvas")!r}')
    # Default presentation at 100% with the HUD shown and the developer readout off.
    s = e.get('presentation') or {}
    need(s.get('interfaceScale') == 1, f'Interface Scale {s.get("interfaceScale")!r}, not 100%')
    need(s.get('hudHidden') is False, f'HUD hidden {s.get("hudHidden")!r}')
    need(s.get('developerReadout') is False, f'developer readout {s.get("developerReadout")!r}')
    # The fixed step and no sleeping, as observed.
    prof = e.get('profile') or {}
    need(isinstance(prof.get('id'), str) and prof.get('id'), 'no simulation profile id')
    need(prof.get('dt') == PROFILE_DT, f'step {prof.get("dt")!r}, not the profile dt {PROFILE_DT}')
    need(prof.get('sleepingBodies') == 0, f'{prof.get("sleepingBodies")!r} sleeping bodies')
    gpu = e.get('gpuTiming') or {}
    need(isinstance(gpu.get('timestampQueryExposed'), bool) and gpu.get('measured') is False, f'GPU timing status {gpu!r}')
    # Edits: P0–P2 from input; P3 from its own periodic resolved edits.
    edits = samples.get('edits')
    if p3:
        need(e.get('editOrigin') == 'app-periodic' and integer(e.get('periodicEdits')) and e.get('periodicEdits') >= 50, f'P3 edits {e.get("editOrigin")!r} × {e.get("periodicEdits")!r}')
        need(integer(edits) and edits >= 50, f'{edits!r} P3 edits measured')
    else:
        need(e.get('editOrigin') == 'input' and e.get('periodicEdits') == 0, f'edit origin {e.get("editOrigin")!r}')
        need(integer(edits) and edits >= 1, f'{edits!r} accepted edits measured')
    # Budgets: trace/probe buffers under 32 MiB, checkpoint cache and comparison within 64 MiB.
    vis = e.get('visualization') or {}
    total = vis.get('totalBytes')
    need(num(total) and total < 32 * MIB, f'trace/probe bytes {total!r} not under 32 MiB')
    contexts = vis.get('contexts') or {}
    need(num(contexts.get('checkpointBytes')) and contexts['checkpointBytes'] <= 64 * MIB, f'checkpoint bytes {contexts.get("checkpointBytes")!r}')
    render = e.get('render') or {}
    for key in ('geometries', 'textures', 'materials', 'objects', 'drawCallsLastFrame'):
        need(integer(render.get(key)) and render[key] >= 0, f'render {key} {render.get(key)!r}')
    # The named workload (SPEC §18.1) with the final default visuals.
    w = e.get('workload') or {}
    probes, trails = vis.get('probes') or {}, vis.get('trails') or {}
    bodies, arrows = e.get('bodies'), e.get('arrows')
    if workload == 'P0':
        need(w.get('title') == 'Sideways Rain' and w.get('laws') == 1, f'P0 scene {w.get("title")!r}, laws {w.get("laws")!r}')
        need(integer(bodies) and 0 < bodies <= 64 and integer(arrows) and arrows <= 125, f'P0 bodies {bodies!r}, arrows {arrows!r}')
        need(probes.get('enabled') is False and trails.get('mode') == 'selected', f'P0 visuals {probes.get("enabled")!r}, {trails.get("mode")!r}')
    elif workload == 'P1':
        need(bodies == 200 and w.get('laws') == 16 and w.get('primitiveLeaves') == 16, f'P1 bodies {bodies!r}, laws {w.get("laws")!r}, leaves {w.get("primitiveLeaves")!r}')
        need(w.get('fixedColliders') == 16 and w.get('allBodyContacts') is True, f'P1 fixed {w.get("fixedColliders")!r}, contacts {w.get("allBodyContacts")!r}')
        need(integer(arrows) and arrows <= 250 and trails.get('mode') == 'all' and trails.get('count') == 32, f'P1 arrows {arrows!r}, trails {trails!r}')
    elif workload == 'P2':
        need(bodies == 100 and w.get('laws') == 4, f'P2 bodies {bodies!r}, laws {w.get("laws")!r}')
        need(probes.get('enabled') is True and probes.get('live') == 2000, f'P2 probes {probes!r}')
        need(trails.get('mode') == 'all' and trails.get('count') == 32 and integer(arrows) and arrows > 0, f'P2 trails {trails!r}, arrows {arrows!r}')
    else:
        need(bodies == 100 and w.get('laws') == 4, f'P3 bodies {bodies!r}, laws {w.get("laws")!r}')
        need(integer(ticks) and ticks <= FULL_TICKS, f'{ticks!r} P3 ticks')
        cmp_ = e.get('comparison') or {}
        need(num(cmp_.get('bytes')) and cmp_['bytes'] <= 64 * MIB and cmp_.get('horizon') is not None, f'P3 comparison {cmp_!r}')
        problems.extend(setup_problems(e.get('setup'), cmp_))
    require(problems)
    return {'run': e.get('run'), 'wallMs': wall, 'ticks': ticks, 'simWall': round(ratio, 4), 'droppedMs': e.get('droppedMs'),
            'samples': samples, 'bodies': bodies, 'arrows': arrows, 'editOrigin': e.get('editOrigin'), 'periodicEdits': e.get('periodicEdits'),
            'traceBytes': total, 'render': render, 'gpuTiming': gpu, 'profile': prof, 'setup': e.get('setup'),
            **{k: got[k] for k in REPORTED}}


def setup_problems(setup, comparison):
    """P3's setup record (SPEC §18.2): warmed in disposable continuations, the fork restored with no
    intervention, then the full 7,200-tick baseline precomputed within the comparison budget."""
    if not isinstance(setup, dict):
        return ['P3 setup record missing']
    out = []
    restores, warm = setup.get('warmRestores'), setup.get('warmTicks')
    # Ten seconds of warmup at ~1× is ~1,200 ticks, beyond A's 600-tick default horizon: at least one restore.
    if not (integer(restores) and restores >= 1):
        out.append(f'warm restores {restores!r}: the disposable continuation never reached the default horizon')
    if not (integer(warm) and warm >= 1100):
        out.append(f'{warm!r} warmup ticks: not an active ten-second warmup')
    r = setup.get('restored') or {}
    fork = r.get('fork') or {}
    if not (integer(r.get('tick')) and r.get('tick') == fork.get('tick') and r.get('cursor') == fork.get('cursor') and r.get('suffix') == 0):
        out.append(f'fork not restored before the precompute: {r!r}')
    p = setup.get('precompute') or {}
    if not (p.get('ticks') == FULL_TICKS and num(p.get('bytes')) and p['bytes'] <= 64 * MIB and integer(p.get('batches')) and p['batches'] >= 2 and num(p.get('elapsedMs'))):
        out.append(f'7,200-tick precompute {p!r}')
    if num(comparison.get('horizon')) and integer(fork.get('tick')) and comparison['horizon'] - fork['tick'] != FULL_TICKS:
        out.append(f'P3 horizon {comparison["horizon"]} is not the fork plus 7,200')
    return out


# ------------------------------------------------------------------ the P3 setup order and construction

def check_construction(e):
    m = e.get('metrics') or {}
    problems = []
    if e.get('action') != 'baseline-committed':
        problems.append(f'not a committed baseline: {e.get("action")!r}')
    ticks = m.get('ticks')
    if ticks != INITIAL_TICKS:
        problems.append(f'{ticks!r} ticks, not the default 600')
    if not (num(m.get('elapsedMs')) and m['elapsedMs'] <= 3000):
        problems.append(f'construction {m.get("elapsedMs")!r} ms over 3 s')
    if not (integer(m.get('batches')) and m['batches'] >= 2):
        problems.append(f'{m.get("batches")!r} batches: the construction did not yield')
    batch = m.get('batchMs')
    if not (isinstance(batch, list) and len(batch) == 4 and num(batch[1]) and batch[1] <= BATCH_LIMIT_MS):
        problems.append(f'batch p95 {batch!r} is not about 8 ms')
    if not (num(e.get('bytes')) and e['bytes'] <= 64 * MIB):
        problems.append(f'{e.get("bytes")!r} bytes over the 64 MiB comparison budget')
    require(problems)
    return {'elapsedMs': m['elapsedMs'], 'batches': m['batches'], 'batchMs': batch, 'bytes': e['bytes'], 'uiFramesMs': (e.get('uiFrames') or {}).get('intervalMs')}


def p3_order(evs, run):
    """One P3 capture's lifecycle, in order on the launch's clock: its own fork and default 600-tick
    construction after the previous comparison closed; warmup; the fork restored; the 7,200-tick precompute
    started and committed; measure; the run event; then Close. Returns the construction and fork identity."""
    t = lambda e: e.get('t')  # noqa: E731
    phases = [e for e in evs if e.get('kind') == 'p0' and e.get('run') == run]
    want = ['warmup', 'restore', 'precompute', 'measure']
    if [p.get('phase') for p in phases] != want:
        raise Failed(f'run {run}: phases {[p.get("phase") for p in phases]}, not {want}')
    warm, restore, pre, measure = phases
    end = [e for e in evs if e.get('kind') == 'p3-run' and e.get('run') == run]
    if len(end) != 1:
        raise Failed(f'run {run}: {len(end)} p3-run events')
    end = end[0]
    if not all(num(t(e)) for e in (warm, restore, pre, measure, end)):
        raise Failed(f'run {run}: lifecycle times missing')
    if not (t(warm) < t(restore) <= t(pre) < t(measure) < t(end)):
        raise Failed(f'run {run}: lifecycle out of order')
    if t(restore) - t(warm) < 9990 or t(end) - t(measure) < 59990:
        raise Failed(f'run {run}: warmup {t(restore) - t(warm)} ms, measured {t(end) - t(measure)} ms')
    comparisons = [e for e in evs if e.get('kind') == 'comparison']
    before = [e for e in comparisons if t(e) < t(warm)]
    forks = [e for e in before if e.get('action') == 'fork']
    if not forks:
        raise Failed(f'run {run}: no fork before its warmup')
    fork = forks[-1]
    closed_between = [e for e in before if e.get('action') == 'closed' and t(e) > t(fork)]
    if closed_between:
        raise Failed(f'run {run}: its comparison closed before the warmup')
    setup = [e for e in before if t(e) > t(fork)]
    starts = [e for e in setup if e.get('action') == 'baseline-start']
    commits = [e for e in setup if e.get('action') == 'baseline-committed']
    if len(starts) != 1 or len(commits) != 1 or [e.get('action') for e in setup if e.get('action', '').startswith('baseline-')] != ['baseline-start', 'baseline-committed']:
        raise Failed(f'run {run}: not exactly one default construction between fork and warmup: {[e.get("action") for e in setup]}')
    if not (integer((fork.get('address') or {}).get('tick')) and starts[0].get('target') == fork['address']['tick'] + INITIAL_TICKS):
        raise Failed(f'run {run}: construction target {starts[0].get("target")!r} is not the fork plus 600')
    construction = check_construction(commits[0])
    inside = [e for e in comparisons if t(restore) <= t(e) <= t(measure) and e.get('action', '').startswith('baseline-')]
    if [e.get('action') for e in inside] != ['baseline-start', 'baseline-committed']:
        raise Failed(f'run {run}: the precompute between restore and measure was {[e.get("action") for e in inside]}')
    if inside[0].get('target') != fork['address']['tick'] + FULL_TICKS or (inside[1].get('metrics') or {}).get('ticks') != FULL_TICKS:
        raise Failed(f'run {run}: the precompute was not the full 7,200 ticks')
    if not (num(inside[1].get('bytes')) and inside[1]['bytes'] <= 64 * MIB):
        raise Failed(f'run {run}: precompute bytes {inside[1].get("bytes")!r}')
    stray = [e for e in comparisons if t(measure) < t(e) < t(end) and e.get('action', '').startswith('baseline-')]
    if stray:
        raise Failed(f'run {run}: baseline work during the measured minute')
    if warm.get('identity') != fork.get('identity'):
        raise Failed(f'run {run}: the warmup ran on another comparison')
    return {'construction': construction, 'fork': tick_cursor_engine(fork.get('identity')), 'forkAddress': fork.get('address'),
            'precompute': {'elapsedMs': (inside[1].get('metrics') or {}).get('elapsedMs'), 'batches': (inside[1].get('metrics') or {}).get('batches'), 'bytes': inside[1].get('bytes')}}


# ------------------------------------------------------------------ three captures

def summarize(evs, workload):
    p3 = workload == 'P3'
    kind = 'p3-run' if p3 else 'p0-run'
    problems = []
    qualification, ready, backend = of(evs, 'qualification'), of(evs, 'ready'), of(evs, 'backend')
    if len(qualification) != 1 or len(ready) != 1 or len(backend) != 1:
        raise Failed(f'{len(qualification)} qualification, {len(ready)} ready, {len(backend)} backend events: not exactly one launch')
    q, b, r = qualification[0], backend[0], ready[0]
    if not (q.get('mode') == 'packaged' and q.get('qualified') is True and isinstance(q.get('identity'), dict)):
        problems.append(f'runtime identity not a qualified packaged one: {q.get("mode")!r} {q.get("qualified")!r}')
    if not (b.get('backend') == 'WebGPU' and b.get('coordinateSystemIsWebGPU') is True and isinstance(b.get('features'), list)):
        problems.append(f'backend {b.get("backend")!r}, features {type(b.get("features")).__name__}')
    if not all(num(r.get(k)) for k in ('rendererInitMs', 'rapierInitMs', 'firstFrameMs')):
        problems.append('startup figures missing')
    runs = of(evs, kind)
    ids = [e.get('run') for e in runs]
    if len(runs) != 3 or len(set(ids)) != 3:
        problems.append(f'{len(runs)} {workload} captures with runs {ids}, not three distinct')
    warmups = [e.get('run') for e in of(evs, 'p0') if e.get('phase') == 'warmup']
    if sorted(warmups) != sorted(ids):
        problems.append(f'captures started {warmups}, finished {ids}')
    checked, orders = [], []
    for e in runs:
        run = e.get('run')
        try:
            if p3:
                orders.append(p3_order(evs, run))
            else:
                phases = [p for p in of(evs, 'p0') if p.get('run') == run]
                if [p.get('phase') for p in phases] != ['warmup', 'measure']:
                    raise Failed(f'run {run}: phases {[p.get("phase") for p in phases]}')
                tw, tm, te = phases[0].get('t'), phases[1].get('t'), e.get('t')
                if not (all(num(x) for x in (tw, tm, te)) and r.get('t', 0) < tw < tm < te and tm - tw >= 9990 and te - tm >= 59990):
                    raise Failed(f'run {run}: lifecycle ({tw}, {tm}, {te})')
            checked.append(check_run(e, workload))
        except Failed as error:
            problems.append(f'run {run}: {error}')
    if p3 and len(orders) == 3 and len({o['fork'] for o in orders}) != 1:
        problems.append(f'the three forks differ: {[o["fork"] for o in orders]}')
    require(problems)
    limits = {**GATES[workload], **COMMON}
    worst = [{'gate': name, 'limit': limits[limit], 'worst': max(c[key][index] for c in checked),
              'runs': [c['run'] for c in checked if c[key][index] == max(x[key][index] for x in checked)]} for name, key, index, limit in GATED]
    ratio = min(c['simWall'] for c in checked)
    worst.append({'gate': 'simulated/wall', 'limit': limits['simWall'], 'worst': ratio, 'runs': [c['run'] for c in checked if c['simWall'] == ratio]})
    return {'workload': workload, 'percentiles': 'p50, p95, p99, max',
            'launch': {'identity': q.get('identity'), 'fingerprint': q.get('fingerprint'),
                       'backend': {k: b.get(k) for k in ('backend', 'coordinateSystemIsWebGPU', 'compatibilityMode', 'samples', 'adapter', 'features')},
                       'gpuTiming': {'timestampQueryExposed': 'timestamp-query' in b.get('features', []), 'measured': False},
                       'startup': {k: r.get(k) for k in ('rendererInitMs', 'rapierInitMs', 'firstFrameMs')}, 'cache': 'not controlled'},
            'p3Setup': orders or None, 'runs': checked, 'worst': worst}


# ------------------------------------------------------------------ cancellation

def check_cancel(evs):
    """A real baseline cancel: Cancel pressed while a job ran, after its start and before any commit."""
    comparisons = of(evs, 'comparison')
    canceled = [i for i, e in enumerate(comparisons) if e.get('action') == 'baseline-canceled']
    if not canceled:
        raise Failed('no baseline-canceled event')
    i = canceled[-1]
    e = comparisons[i]
    if e.get('running') is not True or not integer(e.get('target')):
        raise Failed(f'Cancel found no running job: running {e.get("running")!r}, target {e.get("target")!r}')
    starts = [j for j in range(i) if comparisons[j].get('action') == 'baseline-start']
    if not starts:
        raise Failed('no baseline-start before the cancel')
    j = starts[-1]
    between = [x.get('action') for x in comparisons[j + 1:i] if str(x.get('action', '')).startswith('baseline-')]
    if between:
        raise Failed(f'the job ended before Cancel: {between}')
    if comparisons[j].get('target') != e.get('target'):
        raise Failed(f'canceled target {e.get("target")} is not the started {comparisons[j].get("target")}')
    if not (num(e.get('horizon')) and e['horizon'] < e['target']):
        raise Failed(f'horizon {e.get("horizon")!r} reached the target {e["target"]}: nothing was canceled')
    frames = e.get('uiFrames') or {}
    if not (integer(frames.get('count')) and frames['count'] >= 1):
        raise Failed('no frame was shown while the baseline ran')
    return {'target': e['target'], 'horizon': e['horizon'], 'latencyMs': e.get('latencyMs'), 'startedT': comparisons[j].get('t'), 'canceledT': e.get('t'), 'frames': frames.get('intervalMs')}


def check_seek_cancel(evs):
    """A long seek canceled from its Cancel control once its progress showed, never committed."""
    seeks = of(evs, 'seek')
    canceled = [e for e in seeks if e.get('action') == 'canceled' and e.get('reason') == 'cancel']
    if not canceled:
        raise Failed('no seek canceled from its Cancel control')
    e = canceled[-1]
    sid = e.get('id')
    if not any(x.get('action') == 'request' and x.get('id') == sid for x in seeks):
        raise Failed(f'seek {sid}: no request')
    if any(x.get('action') == 'committed' and x.get('id') == sid for x in seeks):
        raise Failed(f'seek {sid} committed')
    if not (num(e.get('progressShownAfterMs')) and e['progressShownAfterMs'] >= 100):
        raise Failed(f'seek {sid}: progress shown after {e.get("progressShownAfterMs")!r} ms')
    frames = e.get('uiFrames') or {}
    if not (integer(frames.get('count')) and frames['count'] >= 1):
        raise Failed(f'seek {sid}: no frame shown while it was pending')
    return {'id': sid, 'elapsedMs': e.get('elapsedMs'), 'progressShownAfterMs': e['progressShownAfterMs'], 'maxBatchMs': e.get('maxBatchMs'), 'frames': frames.get('intervalMs')}


# ------------------------------------------------------------------ T11 cycles, rechecked from raw

def same(a, b, keys):
    return all(isinstance(a, dict) and isinstance(b, dict) and integer(a.get(k)) and a.get(k) == b.get(k) for k in keys)


def check_load_cycles(e):
    problems = []
    if e.get('error'):
        raise Failed(f'Shift+Y: {e["error"]}')
    cycles, before, period = e.get('cycles') or [], e.get('before') or {}, e.get('period')
    if len(cycles) != 20 or not (integer(period) and 1 < period < 20):
        raise Failed(f'{len(cycles)} load/reset cycles, period {period!r}')
    keys = RENDER_KEYS + ['checkpoints', 'checkpointBytes']
    if not all(c.get('opened') is True and c.get('tick') == 0 for c in cycles):
        problems.append('a load was not committed or a reset did not return to tick 0')
    for i in range(period, 20):
        if not same(cycles[i].get('sample'), cycles[i - period].get('sample'), keys):
            problems.append(f'cycle {i} differs from cycle {i - period}: {cycles[i].get("sample")} vs {cycles[i - period].get("sample")}')
    if not all(integer((c.get('sample') or {}).get('worlds')) and c['sample']['worlds'] == before.get('worlds') for c in cycles):
        problems.append('worlds changed across load/reset cycles')
    if not (integer(e.get('peakWorlds')) and integer(before.get('worlds')) and e['peakWorlds'] - before['worlds'] <= 1):
        problems.append(f'peak worlds {e.get("peakWorlds")!r} over one candidate')
    if not all(num((c.get('sample') or {}).get('traceBytes')) and c['sample']['traceBytes'] < 32 * MIB for c in cycles):
        problems.append('trace/probe bytes not under 32 MiB')
    authority = e.get('authority') or []
    if len(authority) != period or not all(len(a.get('views') or []) > 1 and all(v.get('equal') is True and integer(v.get('checkpoints')) and v['checkpoints'] > 0 for v in a['views']) for a in authority):
        problems.append('equal-tick authority under visualization not established for every example')
    if e.get('pass') is not True:
        problems.append('the app reported its own load cycles failing')
    require(problems)
    return {'cycles': 20, 'period': period, 'final': cycles[-1]['sample'], 'peakWorlds': e['peakWorlds'], 'authority': [[a['example'], [v['view'] for v in a['views']]] for a in authority]}


def check_seek_cycles(e):
    problems = []
    if e.get('error'):
        raise Failed(f'Shift+U: {e["error"]}')
    cycles, outside = e.get('cycles') or [], e.get('outside') or {}
    if len(cycles) != 20:
        raise Failed(f'{len(cycles)} seek/fork cycles')
    if not all(c.get('divergence') is None and c.get('action') in ('committed', 'shown') for c in cycles):
        problems.append('a seek was not exact against the oracle')
    first = cycles[0]
    if not (first.get('source') == 'root' and first.get('action') == 'committed'):
        problems.append(f'the first seek was not an uncached reconstruction: {first.get("source")!r}')
    b = first.get('batchMs')
    if b is not None and not (isinstance(b, list) and num(b[1]) and b[1] <= BATCH_LIMIT_MS):
        problems.append(f'uncached batches p95 {b!r}')
    shown = first.get('progressShownAfterMs')
    if not (num(first.get('elapsedMs')) and (first['elapsedMs'] < 100 or (num(shown) and 100 <= shown <= 150))):
        problems.append(f'uncached progress shown after {shown!r} ms')
    cached = [c['drawnMs'] for c in cycles[1:] if c.get('source') == 'checkpoint' and num(c.get('drawnMs'))]
    latency = percentiles(cached)
    if len(cached) < 10:
        problems.append(f'{len(cached)} cached seeks measured')
    if e.get('finalTick') == FULL_TICKS and not (latency and latency[1] <= 250):
        problems.append(f'cached seek p95 {latency} over 250 ms on a 60 s recording')
    w = outside.get('worlds')
    for i, c in enumerate(cycles):
        base = c.get('baseline') or {}
        if not (c.get('forked') and base.get('frames') == INITIAL_TICKS and base.get('working') is False and c.get('closed') and c.get('returned')):
            problems.append(f'cycle {i}: fork {c.get("forked")!r}, baseline {base!r}, closed {c.get("closed")!r}, returned {c.get("returned")!r}')
        if not (integer(w) and (c.get('inReplay') or {}).get('worlds') == w + 1 and (c.get('inComparison') or {}).get('worlds') == w + 2):
            problems.append(f'cycle {i}: worlds in replay/comparison {(c.get("inReplay") or {}).get("worlds")!r}/{(c.get("inComparison") or {}).get("worlds")!r}')
        if not same(c.get('after'), outside, RENDER_KEYS):
            problems.append(f'cycle {i}: back in authoring {c.get("after")} differs from {outside}')
        if not (num((c.get('inComparison') or {}).get('comparisonBytes')) and c['inComparison']['comparisonBytes'] <= 64 * MIB):
            problems.append(f'cycle {i}: comparison bytes')
    series = [(c.get('after') or {}).get('checkpointBytes') for c in cycles]
    if not all(num(x) and x <= 64 * MIB for x in series):
        problems.append(f'checkpoint bytes {series} not within 64 MiB')
    elif len(set(series[-10:])) != 1:
        problems.append(f'checkpoint bytes still changing over the last ten cycles: {series[-10:]}')
    if not (integer(e.get('peakWorlds')) and integer(w) and e['peakWorlds'] - w <= 3):
        problems.append(f'peak worlds {e.get("peakWorlds")!r}')
    if e.get('pass') is not True:
        problems.append('the app reported its own seek/fork cycles failing')
    require(problems)
    return {'cycles': 20, 'recordingSeconds': e.get('recordingSeconds'), 'uncached': {k: first.get(k) for k in ('elapsedMs', 'steps', 'batches', 'batchMs', 'progressShownAfterMs')},
            'cachedDrawnMs': latency, 'cachedCount': len(cached), 'checkpointBytes': series[-1], 'peakWorlds': e['peakWorlds']}


# ------------------------------------------------------------------ smoke and startup

def check_smoke(evs, skip, hz):
    pacing = of(evs, 'pacing')[skip:]
    if len(pacing) < 4:
        raise Failed(f'{len(pacing)} pacing events in the smoke window')
    low, high = {60: (15.5, 18.5), 120: (7.5, 9.5)}[hz]
    problems = []
    for p in pacing:
        iv = p.get('intervalMs')
        if not (p.get('playing') is True and p.get('pixelRatio') == 1.5 and num(p.get('devicePixelRatio')) and p['devicePixelRatio'] >= 1.5):
            problems.append(f'pacing at t {p.get("t")!r}: playing {p.get("playing")!r}, ratio {p.get("pixelRatio")!r}')
        if not (isinstance(iv, list) and len(iv) == 3 and num(iv[0]) and low <= iv[0] <= high):
            problems.append(f'median interval {iv!r} is not {hz} Hz')
    stalls = [p.get('stallsOver50ms') for p in pacing]
    if not all(integer(s) for s in stalls) or stalls[-1] != stalls[0]:
        problems.append(f'stalls over 50 ms during the smoke: {stalls}')
    ticks, ts = pacing[-1].get('tick', 0) - pacing[0].get('tick', 0), pacing[-1].get('t', 0) - pacing[0].get('t', 0)
    ratio = ticks * STEP_MS / ts if num(ts) and ts > 0 else None
    if ratio is None or ratio < 0.98:
        problems.append(f'simulated/wall {ratio} under 0.98 from ticks and t')
    require(problems)
    return {'hz': hz, 'events': len(pacing), 'simWall': round(ratio, 4), 'intervalMs': [p['intervalMs'] for p in pacing]}


def startup(paths):
    out = []
    for path in paths:
        evs = read_log(path)
        for i, r in enumerate(of(evs, 'ready')):
            if not all(num(r.get(k)) for k in ('rendererInitMs', 'rapierInitMs', 'firstFrameMs')):
                raise Failed(f'{path}: launch {i + 1} has incomplete startup figures')
            out.append({'log': Path(path).name, 'launch': i + 1, **{k: r[k] for k in ('rendererInitMs', 'rapierInitMs', 'firstFrameMs')}})
    if not out:
        raise Failed('no launches')
    return {'cache': 'not controlled: neither cold nor warm is established', 'launches': out}


def main(argv):
    command = argv[1]
    if command == 'startup':
        result = startup(argv[2:])
    else:
        evs = read_log(argv[2])
        if command == 'run':
            w = argv[3]
            kind = 'p3-run' if w == 'P3' else 'p0-run'
            runs = of(evs, kind)
            if not runs:
                raise Failed(f'no {kind} event')
            result = check_run(runs[-1], w)
            result = {k: result[k] for k in ('run', 'wallMs', 'ticks', 'simWall', 'stepMs', 'workMs', 'intervalMs', 'editMs')}
        elif command == 'summary':
            result = summarize(evs, argv[3])
            Path(argv[4]).write_text(json.dumps(result, indent=1), encoding='utf-8')
            result = {'workload': argv[3], 'runs': len(result['runs']), 'worst': result['worst']}
        elif command == 'construction':
            commits = [e for e in of(evs, 'comparison') if e.get('action') == 'baseline-committed']
            if not commits:
                raise Failed('no committed baseline')
            result = check_construction(commits[-1])
        elif command == 'cancel':
            result = check_cancel(evs)
        elif command == 'seek-cancel':
            result = check_seek_cancel(evs)
        elif command == 'cycles':
            loads, seeks = of(evs, 'm9-load-cycles'), of(evs, 'm9-seek-cycles')
            if not loads or not seeks:
                raise Failed(f'{len(loads)} Shift+Y and {len(seeks)} Shift+U reports')
            result = {'load': check_load_cycles(loads[-1]), 'seek': check_seek_cycles(seeks[-1])}
            Path(argv[3]).write_text(json.dumps(result, indent=1), encoding='utf-8')
        elif command == 'smoke':
            result = check_smoke(evs, int(argv[3]), int(argv[4]))
        else:
            raise SystemExit(f'unknown command {command}')
    print(json.dumps({'check': command, 'pass': True, **result}))


if __name__ == '__main__':
    try:
        main(sys.argv)
    except (Failed, OSError, KeyError, IndexError, TypeError, ValueError) as error:
        print(json.dumps({'check': sys.argv[1] if len(sys.argv) > 1 else None, 'pass': False, 'error': str(error)}))
        sys.exit(1)
