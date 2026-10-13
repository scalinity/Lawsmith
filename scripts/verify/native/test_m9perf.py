"""Synthetic parser controls for m9perf.py only; these results never qualify native Lawsmith performance.
Each check has a passing case and a negative control that must fail closed."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import m9perf  # noqa: E402
from m8perf import percentiles  # noqa: E402

MIB = 1024 * 1024


def series(n, value):
    return [value] * n


def launch(t=0):
    return [
        {'kind': 'qualification', 'mode': 'packaged', 'qualified': True, 'identity': {'tauri': 'x'}, 'fingerprint': 'f', 't': t},
        {'kind': 'backend', 'mode': 'packaged', 'backend': 'WebGPU', 'coordinateSystemIsWebGPU': True, 'compatibilityMode': False, 'samples': 4, 'adapter': 'unavailable', 'features': ['timestamp-query'], 't': t + 1},
        {'kind': 'ready', 'mode': 'packaged', 'rendererInitMs': 20, 'rapierInitMs': 20, 'firstFrameMs': 2000, 't': t + 2},
    ]


def capture(workload='P1', run=1, t=100000, ticks=7200, wall=60000.0, **over):
    p3 = workload == 'P3'
    frames, edits = 3600, (60 if p3 else 40)
    raw = {'stepMs': series(ticks, 1.0), 'tickMs': series(ticks, 1.2), 'editMs': series(edits, 9.0), 'intervalMs': series(frames, 16.7),
           'workMs': series(frames, 5.0), 'probeMs': series(ticks, 0.5) if workload == 'P2' else [], 'trailMs': series(ticks, 0.1),
           'fieldMs': series(ticks, 0.3), 'engineMs': series(ticks, 0.6), 'prepMs': series(frames, 3.0), 'submitMs': series(frames, 1.5), 'drawCalls': series(frames, 40)}
    e = {'kind': 'p3-run' if p3 else 'p0-run', 'mode': 'packaged', 'run': run, 't': t, 'invalid': None, 'incomplete': None, 'wallMs': wall, 'ticks': ticks,
         'simWallRatio': round(ticks * 1000 / 120 / wall, 3), 'droppedMs': 0,
         'bodies': {'P0': 64, 'P1': 200, 'P2': 100, 'P3': 100}[workload], 'arrows': {'P0': 125, 'P1': 96, 'P2': 24, 'P3': 149}[workload],
         'workload': {'title': 'Sideways Rain' if workload == 'P0' else workload, 'laws': {'P0': 1, 'P1': 16, 'P2': 4, 'P3': 4}[workload], 'primitiveLeaves': 16, 'fixedColliders': 16, 'allBodyContacts': True, 'limitedSteps': 0},
         'visualization': {'probes': {'enabled': workload == 'P2', 'live': 2000 if workload == 'P2' else 0}, 'trails': {'mode': 'selected' if workload == 'P0' else 'all', 'count': 32}, 'totalBytes': 600000, 'contexts': {'checkpointBytes': 0}},
         'viewport': {'css': [1600, 1000], 'devicePixelRatio': 2, 'pixelRatio': 1.5, 'canvas': [2400, 1500]},
         'presentation': {'interfaceScale': 1, 'hudHidden': False, 'developerReadout': False, 'drawFolded': True},
         'profile': {'id': 'lawsmith-profile-1', 'dt': 0.008333333767950535, 'sleepingBodies': 0},
         'gpuTiming': {'timestampQueryExposed': True, 'measured': False},
         'editOrigin': 'app-periodic' if p3 else 'input', 'periodicEdits': 60 if p3 else 0,
         'render': {'drawCallsLastFrame': 40, 'trianglesLastFrame': 1000, 'geometries': 30, 'textures': 2, 'materials': 20, 'objects': 400},
         'samples': {'steps': ticks, 'edits': edits, 'frames': frames, 'probeSteps': ticks if workload == 'P2' else 0, 'trailSteps': ticks},
         'raw': raw}
    for key, values in raw.items():
        e[key] = percentiles(values) if values else None
    if p3:
        e['comparison'] = {'bytes': 50 * MIB, 'horizon': 7200}
        e['setup'] = {'warmRestores': 1, 'warmTicks': 1200, 'restored': {'tick': 0, 'cursor': 0, 'suffix': 0, 'fork': {'tick': 0, 'cursor': 0}},
                      'precompute': {'elapsedMs': 900, 'ticks': 7200, 'batches': 110, 'bytes': 50 * MIB}}
    e.update(over)
    return e


def committed(t, ticks, target, elapsed=150.0):
    return {'kind': 'comparison', 'action': 'baseline-committed', 't': t, 'target': target, 'horizon': target, 'bytes': 30 * MIB if ticks == 600 else 50 * MIB,
            'metrics': {'ticks': ticks, 'elapsedMs': elapsed, 'batches': 13 if ticks == 600 else 110, 'batchMs': [7, 8, 8.5, 9], 'bytes': 1}, 'uiFrames': {'count': 9, 'intervalMs': [16, 17, 17, 18]}}


def p3_capture_events(run, t, engine='abc', old_order=False):
    ident = f'authoring:1:0:0:{engine}'
    out = [{'kind': 'comparison', 'action': 'fork', 't': t, 'identity': ident, 'address': {'tick': 0, 'cursor': 0}},
           {'kind': 'comparison', 'action': 'baseline-start', 't': t + 10, 'target': 600},
           committed(t + 200, 600, 600)]
    if old_order:  # the 7,200-tick baseline before the warmup: SPEC §18.2's order broken
        out += [{'kind': 'comparison', 'action': 'baseline-start', 't': t + 300, 'target': 7200}, committed(t + 1300, 7200, 7200, 900)]
    out += [{'kind': 'p0', 'phase': 'warmup', 'run': run, 't': t + 2000, 'identity': ident},
            {'kind': 'p0', 'phase': 'restore', 'run': run, 't': t + 12000}]
    if not old_order:
        out += [{'kind': 'comparison', 'action': 'baseline-start', 't': t + 12001, 'target': 7200}]
    out += [{'kind': 'p0', 'phase': 'precompute', 'run': run, 't': t + 12002}]
    if not old_order:
        out += [committed(t + 13000, 7200, 7200, 900)]
    out += [{'kind': 'p0', 'phase': 'measure', 'run': run, 't': t + 13100},
            capture('P3', run=run, t=t + 73200),
            {'kind': 'comparison', 'action': 'closed', 't': t + 74000, 'comparison': None}]
    return out


def p0_capture_events(workload, run, t, **over):
    return [{'kind': 'p0', 'phase': 'warmup', 'run': run, 't': t}, {'kind': 'p0', 'phase': 'measure', 'run': run, 't': t + 10000},
            capture(workload, run=run, t=t + 70100, **over)]


def write(events, extra_lines=()):
    f = tempfile.NamedTemporaryFile('w', suffix='.log', delete=False, encoding='utf-8')
    for e in events:
        f.write('[lawsmith] ' + json.dumps(e) + '\n')
    for line in extra_lines:
        f.write(line + '\n')
    f.close()
    return f.name


def resources(**over):
    r = {'worlds': 1, 'checkpoints': 0, 'checkpointBytes': 0, 'comparisonBytes': 0, 'objects': 300, 'geometries': 20, 'textures': 2, 'materials': 15, 'traceBytes': 600000}
    r.update(over)
    return r


def load_cycles():
    keys = ['sideways-rain', 'catch-and-release', 'drag-pocket', 'storm-bottle', 'two-futures']
    cycles = [{'example': keys[i % 5], 'opened': True, 'tick': 0, 'sample': resources(objects=300 + i % 5)} for i in range(20)]
    return {'kind': 'm9-load-cycles', 'period': 5, 'before': resources(), 'cycles': cycles, 'peakWorlds': 2,
            'authority': [{'example': k, 'views': [{'view': 'quiet', 'checkpoints': 5, 'equal': True}, {'view': 'busy', 'checkpoints': 5, 'equal': True}]} for k in keys], 'pass': True}


def seek_cycles():
    outside = resources()
    cycles = []
    for i in range(20):
        cycles.append({'target': {'tick': 7200 if i == 0 else i * 300, 'cursor': 1}, 'action': 'committed', 'source': 'root' if i == 0 else 'checkpoint',
                       'steps': 7200 if i == 0 else 100, 'drawnMs': 5000.0 if i == 0 else 120.0 + i, 'elapsedMs': 5000.0 if i == 0 else 110.0,
                       'batches': 600 if i == 0 else 3, 'batchMs': [8, 8.5, 9, 9.5] if i == 0 else [8, 8, 8, 8], 'progressShownAfterMs': 110.0 if i == 0 else None,
                       'divergence': None, 'forked': True, 'baseline': {'frames': 600, 'working': False}, 'closed': True, 'returned': True,
                       'inReplay': resources(worlds=2), 'inComparison': resources(worlds=3, comparisonBytes=40 * MIB),
                       'after': resources(checkpoints=30, checkpointBytes=20 * MIB)})
    return {'kind': 'm9-seek-cycles', 'finalTick': 7200, 'recordingSeconds': 60, 'outside': outside, 'cycles': cycles, 'peakWorlds': 4, 'pass': True}


class Captures(unittest.TestCase):
    def summary(self, events, workload):
        return m9perf.summarize(m9perf.read_log(write(events)), workload)

    def p1(self, **over):
        return launch() + sum((p0_capture_events('P1', r, 10000 + r * 80000, **(over if r == 2 else {})) for r in (1, 2, 3)), [])

    def test_valid_p1_summary(self):
        s = self.summary(self.p1(), 'P1')
        self.assertEqual(len(s['runs']), 3)
        self.assertEqual(s['launch']['gpuTiming'], {'timestampQueryExposed': True, 'measured': False})
        self.assertEqual(s['runs'][0]['fieldMs'], [0.3, 0.3, 0.3, 0.3])

    def test_missing_profile_series_fails(self):
        e = capture()
        del e['raw']['fieldMs']
        with self.assertRaises(m9perf.Failed):
            m9perf.check_run(e, 'P1')

    def test_rounded_ratio_is_not_trusted(self):
        # 7,000 ticks in 60 s is 0.972 of real time, though the event claims 0.98.
        e = capture(ticks=7000, simWallRatio=0.98)
        with self.assertRaisesRegex(m9perf.Failed, 'simulated/wall'):
            m9perf.check_run(e, 'P1')

    def test_presentation_profile_and_budgets(self):
        for over, text in [({'presentation': {'interfaceScale': 2, 'hudHidden': False, 'developerReadout': False}}, 'Interface Scale'),
                           ({'presentation': {'interfaceScale': 1, 'hudHidden': True, 'developerReadout': False}}, 'HUD'),
                           ({'profile': {'id': 'p', 'dt': 0.01, 'sleepingBodies': 0}}, 'profile dt'),
                           ({'profile': {'id': 'p', 'dt': 0.008333333767950535, 'sleepingBodies': 3}}, 'sleeping'),
                           ({'gpuTiming': {'timestampQueryExposed': True, 'measured': True}}, 'GPU timing'),
                           ({'editOrigin': 'app-periodic'}, 'edit origin')]:
            with self.subTest(text=text), self.assertRaisesRegex(m9perf.Failed, text):
                m9perf.check_run(capture(**over), 'P1')
        e = capture()
        e['visualization']['totalBytes'] = 32 * MIB
        with self.assertRaisesRegex(m9perf.Failed, '32 MiB'):
            m9perf.check_run(e, 'P1')

    def test_skipped_tick_and_bad_draws(self):
        e = capture()
        e['samples']['steps'] -= 1
        e['raw']['stepMs'].pop()
        with self.assertRaises(m9perf.Failed):
            m9perf.check_run(e, 'P1')
        e = capture()
        e['raw']['drawCalls'][0] = 1.5
        with self.assertRaisesRegex(m9perf.Failed, 'whole numbers'):
            m9perf.check_run(e, 'P1')

    def test_gate_failure_from_raw(self):
        e = capture()
        e['raw']['workMs'] = series(3420, 5.0) + series(180, 20.0)
        e['workMs'] = percentiles(e['raw']['workMs'])
        with self.assertRaisesRegex(m9perf.Failed, 'CPU work p95'):
            m9perf.check_run(e, 'P1')

    def test_one_launch_and_complete_lifecycle(self):
        with self.assertRaisesRegex(m9perf.Failed, 'exactly one launch'):
            self.summary(launch() + launch(5) + self.p1()[3:], 'P1')
        events = [e for e in self.p1() if not (e.get('kind') == 'p0' and e.get('phase') == 'measure' and e.get('run') == 2)]
        with self.assertRaises(m9perf.Failed):
            self.summary(events, 'P1')

    def test_malformed_line_fails(self):
        path = write(self.p1(), ['[lawsmith] {"kind": "p0-run", truncated'])
        with self.assertRaisesRegex(m9perf.Failed, 'malformed'):
            m9perf.read_log(path)


class P3Order(unittest.TestCase):
    def log(self, **kw):
        events = launch()
        for r in (1, 2, 3):
            events += p3_capture_events(r, 100000 * r, **(kw if r == 2 else {}))
        return m9perf.read_log(write(events))

    def test_spec_order_passes(self):
        s = m9perf.summarize(self.log(), 'P3')
        self.assertEqual(len(s['p3Setup']), 3)
        self.assertEqual(s['p3Setup'][0]['construction']['batches'], 13)

    def test_precompute_before_warmup_fails(self):
        with self.assertRaisesRegex(m9perf.Failed, 'precompute|construction'):
            m9perf.summarize(self.log(old_order=True), 'P3')

    def test_forks_must_match(self):
        with self.assertRaisesRegex(m9perf.Failed, 'forks differ'):
            m9perf.summarize(self.log(engine='zzz'), 'P3')

    def test_setup_record_checked(self):
        e = capture('P3')
        e['setup']['restored']['suffix'] = 2
        with self.assertRaisesRegex(m9perf.Failed, 'fork not restored'):
            m9perf.check_run(e, 'P3')
        e = capture('P3')
        e['setup']['warmRestores'] = 0
        with self.assertRaisesRegex(m9perf.Failed, 'warm restores'):
            m9perf.check_run(e, 'P3')

    def test_construction_batches(self):
        c = committed(0, 600, 600)
        self.assertEqual(m9perf.check_construction(c)['batches'], 13)
        c['metrics']['batchMs'] = [8, 12, 13, 14]
        with self.assertRaisesRegex(m9perf.Failed, 'about 8 ms'):
            m9perf.check_construction(c)


class Cancels(unittest.TestCase):
    def test_baseline_cancel(self):
        start = {'kind': 'comparison', 'action': 'baseline-start', 't': 1, 'target': 7200}
        cancel = {'kind': 'comparison', 'action': 'baseline-canceled', 't': 300, 'running': True, 'target': 7200, 'horizon': 2400, 'latencyMs': 0.4, 'uiFrames': {'count': 12, 'intervalMs': [16, 17, 18, 18]}}
        self.assertEqual(m9perf.check_cancel([start, cancel])['horizon'], 2400)
        with self.assertRaisesRegex(m9perf.Failed, 'no running job'):
            m9perf.check_cancel([start, {**cancel, 'running': False}])
        with self.assertRaisesRegex(m9perf.Failed, 'ended before Cancel'):
            m9perf.check_cancel([start, committed(200, 7200, 7200), cancel])
        with self.assertRaisesRegex(m9perf.Failed, 'nothing was canceled'):
            m9perf.check_cancel([start, {**cancel, 'horizon': 7200}])

    def test_seek_cancel(self):
        req = {'kind': 'seek', 'action': 'request', 'id': 4}
        can = {'kind': 'seek', 'action': 'canceled', 'id': 4, 'reason': 'cancel', 'progressShownAfterMs': 108, 'elapsedMs': 900, 'uiFrames': {'count': 50, 'intervalMs': [16, 17, 18, 20]}}
        self.assertEqual(m9perf.check_seek_cancel([req, can])['id'], 4)
        with self.assertRaisesRegex(m9perf.Failed, 'progress'):
            m9perf.check_seek_cancel([req, {**can, 'progressShownAfterMs': None}])
        with self.assertRaisesRegex(m9perf.Failed, 'committed'):
            m9perf.check_seek_cancel([req, can, {'kind': 'seek', 'action': 'committed', 'id': 4}])
        with self.assertRaisesRegex(m9perf.Failed, 'Cancel control'):
            m9perf.check_seek_cancel([req, {**can, 'reason': 'return'}])


class Cycles(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(m9perf.check_load_cycles(load_cycles())['cycles'], 20)
        self.assertEqual(m9perf.check_seek_cycles(seek_cycles())['cachedCount'], 19)

    def test_load_growth_fails(self):
        e = load_cycles()
        e['cycles'][12]['sample']['objects'] += 1
        with self.assertRaisesRegex(m9perf.Failed, 'cycle 12 differs'):
            m9perf.check_load_cycles(e)
        e = load_cycles()
        e['authority'][3]['views'][1]['equal'] = False
        with self.assertRaisesRegex(m9perf.Failed, 'authority'):
            m9perf.check_load_cycles(e)
        e = load_cycles()
        e['pass'] = False
        with self.assertRaisesRegex(m9perf.Failed, 'its own load cycles'):
            m9perf.check_load_cycles(e)

    def test_seek_growth_fails(self):
        e = seek_cycles()
        e['cycles'][15]['after']['geometries'] += 2
        with self.assertRaisesRegex(m9perf.Failed, 'cycle 15: back in authoring'):
            m9perf.check_seek_cycles(e)
        e = seek_cycles()
        e['cycles'][19]['after']['checkpointBytes'] += 1
        with self.assertRaisesRegex(m9perf.Failed, 'still changing'):
            m9perf.check_seek_cycles(e)
        e = seek_cycles()
        for c in e['cycles'][1:]:
            c['drawnMs'] = 300.0
        with self.assertRaisesRegex(m9perf.Failed, '250 ms'):
            m9perf.check_seek_cycles(e)
        e = seek_cycles()
        e['cycles'][0]['source'] = 'checkpoint'
        with self.assertRaisesRegex(m9perf.Failed, 'uncached'):
            m9perf.check_seek_cycles(e)
        e = seek_cycles()
        e['cycles'][7]['divergence'] = {'entity': 'b-3'}
        with self.assertRaisesRegex(m9perf.Failed, 'oracle'):
            m9perf.check_seek_cycles(e)


class Smoke(unittest.TestCase):
    def pacing(self, hz=60, stalls=(0, 0, 0, 0, 0)):
        iv = [16.7, 18, 20] if hz == 60 else [8.3, 9, 10]
        return [{'kind': 'pacing', 't': 5000 * i, 'tick': 600 * i, 'playing': True, 'pixelRatio': 1.5, 'devicePixelRatio': 2, 'intervalMs': iv, 'stallsOver50ms': s} for i, s in enumerate(stalls)]

    def test_smoke(self):
        self.assertEqual(m9perf.check_smoke(self.pacing(), 0, 60)['events'], 5)
        self.assertEqual(m9perf.check_smoke(self.pacing(120), 0, 120)['hz'], 120)
        with self.assertRaisesRegex(m9perf.Failed, 'not 60 Hz'):
            m9perf.check_smoke(self.pacing(120), 0, 60)
        with self.assertRaisesRegex(m9perf.Failed, 'stalls'):
            m9perf.check_smoke(self.pacing(stalls=(0, 0, 1, 1, 1)), 0, 60)
        slow = self.pacing()
        for i, p in enumerate(slow):
            p['tick'] = 500 * i
        with self.assertRaisesRegex(m9perf.Failed, 'simulated/wall'):
            m9perf.check_smoke(slow, 0, 60)
        with self.assertRaisesRegex(m9perf.Failed, 'pacing events'):
            m9perf.check_smoke(self.pacing(), 3, 60)


class Startup(unittest.TestCase):
    def test_startup_reports_without_cache_claim(self):
        s = m9perf.startup([write(launch())])
        self.assertIn('not controlled', s['cache'])
        self.assertEqual(s['launches'][0]['firstFrameMs'], 2000)
        bad = launch()
        del bad[2]['firstFrameMs']
        with self.assertRaises(m9perf.Failed):
            m9perf.startup([write(bad)])


if __name__ == '__main__':
    unittest.main()
