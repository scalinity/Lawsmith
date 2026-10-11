"""M8 P0/P1/P2/P3 checks over the packaged app's own capture events (SPEC §18.1–18.2, MILESTONES M8
Performance gate). Each capture is one production `p0-run` (P0, P1, P2) or `p3-run` (P3) event: 10 s of
warmup the app keeps out of the sample, then 60 s measured, with every raw sample in the event.

  m8perf.py run LOG WORKLOAD          the last capture: protocol, workload and every gate, with its
                                      percentiles recomputed from the raw samples (rank floor(p·n))
  m8perf.py summary LOG WORKLOAD OUT  exactly three independent valid captures in LOG, the log of
                                      that workload's own launch; per-run table to OUT (JSON)
  m8perf.py construction LOG          P3's separately measured default 600-tick baseline
Percentiles are never averaged across runs. A gate with no samples fails; absence never reads as zero.
"""
import json
import math
import sys

MIB64 = 64 * 1024 * 1024
# SPEC §18.2 table: P0's own targets from M1/M2, and the P1/P2/P3 baseline.
GATES = {
    'P0': {'step95': 2, 'step99': 4, 'work95': 12},
    'P1': {'step95': 3, 'step99': 5, 'work95': 14},
    'P2': {'step95': 3, 'step99': 5, 'work95': 14},
    'P3': {'step95': 3, 'step99': 5, 'work95': 14},
}
COMMON = {'interval95': 20, 'interval99': 34, 'edit95': 50, 'simWall': 0.98}
SERIES = {'stepMs': 'stepMs', 'editMs': 'editMs', 'intervalMs': 'intervalMs', 'workMs': 'workMs'}
# How the production capture fills each raw series during the measured minute (src/main.ts timedStep and
# the frame callback): every completed step pushes stepMs and tickMs; probeMs only while probes are on and
# trailMs only while trails are not off, once per step; intervalMs and workMs once per frame together;
# editMs once per accepted edit. The sample counts the event reports must match these lengths exactly.
COUNTS = {'stepMs': 'steps', 'tickMs': 'steps', 'editMs': 'edits', 'intervalMs': 'frames', 'workMs': 'frames', 'probeMs': 'probeSteps', 'trailMs': 'trailSteps'}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def series_problems(e):
    """Every raw series complete, finite and nonnegative, its length the production count, and every
    reported percentile array exactly four finite values equal to the recomputation."""
    problems = []
    raw = e.get('raw') or {}
    samples = e.get('samples') or {}
    for key, count in COUNTS.items():
        values = raw.get(key)
        n = samples.get(count)
        if not isinstance(values, list):
            problems.append(f'raw {key} missing')
            continue
        if not (isinstance(n, int) and not isinstance(n, bool) and n >= 0):
            problems.append(f'sample count {count} is {n!r}')
        elif len(values) != n:
            problems.append(f'raw {key} has {len(values)} samples for {count}={n}')
        if not all(finite(v) and v >= 0 for v in values):
            problems.append(f'raw {key} holds a non-finite or negative value')
        reported = e.get(key)
        if values:
            if not (isinstance(reported, list) and len(reported) == 4 and all(finite(v) for v in reported)):
                problems.append(f'reported {key} is {reported!r}, not four finite percentiles')
            elif all(finite(v) and v >= 0 for v in values):
                again = percentiles(values)
                if any(abs(a - b) > 0.0015 for a, b in zip(again, reported)):
                    problems.append(f'{key} reported {reported}, recomputed {again}')
        elif reported is not None:
            problems.append(f'reported {key} {reported!r} without samples')
    steps = samples.get('steps')
    if steps != e.get('ticks'):
        problems.append(f'{steps} step samples for {e.get("ticks")} ticks')
    for count in ('probeSteps', 'trailSteps'):
        if samples.get(count) not in (0, steps):
            problems.append(f'{count}={samples.get(count)} is neither 0 nor the {steps} steps')
    return problems


def events(path, kind):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    event = json.loads(line[len('[lawsmith] '):])
                except json.JSONDecodeError:
                    continue
                if event.get('kind') == kind:
                    out.append(event)
    return out


def percentiles(values):
    """The production convention: the value at rank floor(p·n), capped to the last sample, and the max."""
    if not values:
        return None
    s = sorted(values)
    return [round(s[min(len(s) - 1, math.floor(p * len(s)))], 3) for p in (0.5, 0.95, 0.99)] + [round(s[-1], 3)]


def check_run(e, workload):
    """Raises AssertionError listing every protocol, workload and gate failure of one capture."""
    g = {**GATES[workload], **COMMON}
    p3 = workload == 'P3'
    problems = []

    def need(condition, text):
        if not condition:
            problems.append(text)

    need(e.get('kind') == ('p3-run' if p3 else 'p0-run'), f'not a {"p3-run" if p3 else "p0-run"} event')
    need(e.get('mode') == 'packaged', f'mode {e.get("mode")}, not packaged')
    need(e.get('invalid') is None, f'invalid: {e.get("invalid")}')
    need(e.get('incomplete') is None, f'incomplete: {e.get("incomplete")}')
    need((e.get('wallMs') or 0) >= 60000, f'measured {e.get("wallMs")} ms, not 60 s')
    samples = e.get('samples') or {}
    need((samples.get('edits') or 0) >= (50 if p3 else 1), f'{samples.get("edits", 0)} accepted edits measured')
    need((samples.get('frames') or 0) >= 3000, f'{samples.get("frames", 0)} frames')
    problems.extend(series_problems(e))
    if p3:
        need(0 < (e.get('ticks') or 0) <= 7200, f'{e.get("ticks")} P3 ticks')
    # Protocol: 1600×1000 CSS, DPR capped at 1.5, a canvas at that ratio, 60 Hz callbacks.
    v = e.get('viewport') or {}
    need(v.get('css') == [1600, 1000], f'content {v.get("css")}, not 1600×1000')
    dpr = v.get('devicePixelRatio') or 0
    pr = v.get('pixelRatio') or 0
    need(dpr >= 1.5 and pr == 1.5, f'DPR {dpr} rendered at {pr}, not capped at 1.5')
    need(v.get('canvas') == [round(1600 * pr), round(1000 * pr)], f'canvas {v.get("canvas")} at pixel ratio {pr}')
    # The gates read the recomputation from the raw arrays, never the reported values.
    raw = e.get('raw') or {}
    got = {}
    for key in SERIES:
        values = raw.get(key) if isinstance(raw.get(key), list) and all(finite(v) and v >= 0 for v in raw.get(key)) else []
        got[key] = percentiles(values)
        need(got[key] is not None, f'no {key} samples')
    if all(got[k] is not None for k in SERIES):
        need(15.5 <= got['intervalMs'][0] <= 18.5, f'median callback interval {got["intervalMs"][0]} ms is not 60 Hz')
        need(got['stepMs'][1] <= g['step95'] and got['stepMs'][2] <= g['step99'], f'step p95/p99 {got["stepMs"][1:3]} over {g["step95"]}/{g["step99"]} ms')
        need(got['workMs'][1] <= g['work95'], f'CPU work p95 {got["workMs"][1]} over {g["work95"]} ms')
        need(got['intervalMs'][1] <= g['interval95'] and got['intervalMs'][2] <= g['interval99'], f'interval p95/p99 {got["intervalMs"][1:3]} over 20/34 ms')
        need(got['editMs'][1] <= g['edit95'], f'edit p95 {got["editMs"][1]} over 50 ms')
    need((e.get('simWallRatio') or 0) >= g['simWall'], f'simulated/wall {e.get("simWallRatio")} under 0.98')
    # The named workload (SPEC §18.1) with the final default visuals.
    w = e.get('workload') or {}
    vis = e.get('visualization') or {}
    probes = vis.get('probes') or {}
    trails = vis.get('trails') or {}
    bodies, arrows = e.get('bodies'), e.get('arrows')
    if workload == 'P0':
        need(w.get('title') == 'Sideways Rain', f'P0 scene {w.get("title")}')
        need(w.get('laws') == 1 and bodies is not None and bodies <= 64, f'P0 laws {w.get("laws")}, bodies {bodies}')
        need(arrows is not None and arrows <= 125, f'P0 arrows {arrows}')
        need(probes.get('enabled') is False and trails.get('mode') == 'selected', f'P0 visuals not the defaults: probes {probes.get("enabled")}, trails {trails.get("mode")}')
    elif workload == 'P1':
        need(bodies == 200 and w.get('laws') == 16 and w.get('primitiveLeaves') == 16, f'P1 bodies {bodies}, laws {w.get("laws")}, leaves {w.get("primitiveLeaves")}')
        need(w.get('fixedColliders') == 16 and w.get('allBodyContacts') is True, f'P1 fixed {w.get("fixedColliders")}, contacts {w.get("allBodyContacts")}')
        need(arrows is not None and arrows <= 250, f'P1 arrows {arrows}')
        need(trails.get('mode') == 'all' and trails.get('count') == 32, f'P1 trails {trails}')
    elif workload == 'P2':
        need(bodies == 100 and w.get('laws') == 4, f'P2 bodies {bodies}, laws {w.get("laws")}')
        need(probes.get('enabled') is True and probes.get('live') == 2000, f'P2 probes {probes}')
        need(trails.get('mode') == 'all' and trails.get('count') == 32, f'P2 trails {trails}')
        need(arrows is not None and arrows > 0, f'P2 arrows {arrows}')
    else:
        need(bodies == 100 and w.get('laws') == 4, f'P3 bodies {bodies}, laws {w.get("laws")}')
        need(((e.get('comparison') or {}).get('bytes') or MIB64 + 1) <= MIB64, f'P3 comparison bytes {(e.get("comparison") or {}).get("bytes")}')
    assert not problems, '; '.join(problems)
    return {'run': e.get('run'), 'wallMs': e.get('wallMs'), 'ticks': e.get('ticks'), 'samples': samples,
            **{k: got[k] for k in SERIES}, 'simWallRatio': e.get('simWallRatio'), 'bodies': bodies, 'arrows': arrows}


def check_construction(e):
    m = e.get('metrics') or {}
    problems = []
    if e.get('action') != 'baseline-committed' or e.get('horizon') != 600:
        problems.append(f'not the committed default 600-tick baseline: {e.get("action")} {e.get("horizon")}')
    if (m.get('elapsedMs') or 1e9) > 3000:
        problems.append(f'construction {m.get("elapsedMs")} ms over 3 s')
    if (m.get('batches') or 0) < 2:
        problems.append(f'{m.get("batches")} batches: the construction did not yield')
    if (e.get('bytes') or MIB64 + 1) > MIB64:
        problems.append(f'{e.get("bytes")} bytes over the 64 MiB comparison budget')
    assert not problems, '; '.join(problems)
    return {'elapsedMs': m.get('elapsedMs'), 'batches': m.get('batches'), 'batchMs': m.get('batchMs'), 'bytes': e.get('bytes')}


def main(argv):
    command, log = argv[1], argv[2]
    if command == 'run':
        workload = argv[3]
        result = check_run(events(log, 'p3-run' if workload == 'P3' else 'p0-run')[-1], workload)
    elif command == 'summary':
        workload, out = argv[3], argv[4]
        runs = events(log, 'p3-run' if workload == 'P3' else 'p0-run')
        assert len(runs) == 3, f'{len(runs)} {workload} captures, not three'
        result = {'workload': workload, 'percentiles': 'p50, p95, p99, max', 'runs': [check_run(e, workload) for e in runs]}
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=1)
    elif command == 'construction':
        result = check_construction(events(log, 'comparison')[-1])
    else:
        raise SystemExit(f'unknown command {command}')
    print(json.dumps({'check': command, 'pass': True, **({'runs': len(result['runs'])} if command == 'summary' else result)}))


if __name__ == '__main__':
    main(sys.argv)
