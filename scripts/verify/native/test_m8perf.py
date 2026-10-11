"""Synthetic parser controls only; these results never qualify native Lawsmith performance."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import m8perf


def series(n, value, tail=None):
    values = [value] * n
    if tail is not None:
        values[-1] = tail
    return values


def capture(workload='P0'):
    raw = {'stepMs': series(7200, 0.8, 3.0), 'editMs': series(140, 16.0, 30.0), 'intervalMs': series(3600, 16.7, 25.0), 'workMs': series(3600, 3.0, 9.0)}
    e = {
        'kind': 'p3-run' if workload == 'P3' else 'p0-run', 'mode': 'packaged', 'run': 1, 'invalid': None, 'incomplete': None,
        'wallMs': 60010.5, 'ticks': 7200, 'simWallRatio': 0.9998,
        'samples': {'steps': 7200, 'edits': 140, 'frames': 3600},
        'viewport': {'css': [1600, 1000], 'devicePixelRatio': 2, 'pixelRatio': 1.5, 'canvas': [2400, 1500]},
        'raw': raw, 'bodies': 64, 'arrows': 120,
        'workload': {'title': 'Sideways Rain', 'laws': 1, 'primitiveLeaves': 1, 'fixedColliders': 1, 'allBodyContacts': False},
        'visualization': {'probes': {'enabled': False, 'live': 0}, 'trails': {'mode': 'selected', 'count': 0}},
    }
    for key in m8perf.SERIES:
        e[key] = m8perf.percentiles(raw[key])
    if workload == 'P1':
        e.update(bodies=200, arrows=240)
        e['workload'] = {'title': 'P1 Workshop', 'laws': 16, 'primitiveLeaves': 16, 'fixedColliders': 16, 'allBodyContacts': True}
        e['visualization'] = {'probes': {'enabled': False, 'live': 0}, 'trails': {'mode': 'all', 'count': 32}}
    if workload == 'P2':
        e.update(bodies=100, arrows=200)
        e['workload'] = {'title': 'P2 Probes', 'laws': 4, 'primitiveLeaves': 4, 'fixedColliders': 5, 'allBodyContacts': True}
        e['visualization'] = {'probes': {'enabled': True, 'live': 2000}, 'trails': {'mode': 'all', 'count': 32}}
    if workload == 'P3':
        e.update(bodies=100, arrows=0, comparison={'bytes': 50_000_000})
        e['workload'] = {'title': 'P3 — Two Futures', 'laws': 4, 'primitiveLeaves': 4, 'fixedColliders': 0, 'allBodyContacts': False}
    return e


class Runs(unittest.TestCase):
    def test_valid_capture_of_each_workload(self):
        for workload in ('P0', 'P1', 'P2', 'P3'):
            result = m8perf.check_run(capture(workload), workload)
            self.assertEqual(result['stepMs'], [0.8, 0.8, 0.8, 3.0])

    def fails(self, workload, change):
        e = capture(workload)
        change(e)
        with self.assertRaises(AssertionError):
            m8perf.check_run(e, workload)

    def test_incomplete_or_invalid_or_short_capture_fails(self):
        self.fails('P0', lambda e: e.update(incomplete='no accepted edits during the capture: edit latency not measured'))
        self.fails('P0', lambda e: e.update(invalid='paused during capture'))
        self.fails('P0', lambda e: e.update(wallMs=45000))
        self.fails('P0', lambda e: e.update(mode='dev'))

    def test_empty_edits_never_read_as_zero(self):
        def empty(e):
            e['raw']['editMs'] = []; e['editMs'] = None; e['samples']['edits'] = 0
        self.fails('P0', empty)
        self.fails('P3', lambda e: e['samples'].update(edits=12))

    def test_protocol_size_ratio_and_refresh(self):
        self.fails('P0', lambda e: e['viewport'].update(css=[1280, 800]))
        self.fails('P0', lambda e: e['viewport'].update(pixelRatio=2, canvas=[3200, 2000]))
        self.fails('P0', lambda e: e['viewport'].update(canvas=[1600, 1000]))
        def hz120(e):
            e['raw']['intervalMs'] = series(7200, 8.3); e['intervalMs'] = m8perf.percentiles(e['raw']['intervalMs'])
        self.fails('P0', hz120)

    def test_each_gate(self):
        def raw(key, values):
            def change(e):
                e['raw'][key] = values; e[key] = m8perf.percentiles(values)
            return change
        self.fails('P0', raw('stepMs', series(7200, 2.5)))           # P0 step p95 over 2 ms
        m8perf.check_run({**capture('P1'), **{}}, 'P1')
        self.fails('P1', raw('stepMs', series(7200, 3.5)))           # P1 step p95 over 3 ms
        self.fails('P0', raw('workMs', series(3600, 13)))            # P0 CPU work p95 over 12 ms
        self.fails('P2', raw('workMs', series(3600, 15)))            # P2 CPU work p95 over 14 ms
        self.fails('P0', raw('intervalMs', series(3500, 16.7) + series(100, 40)))  # interval p99 over 34 ms
        self.fails('P3', raw('editMs', series(140, 60)))             # edit p95 over 50 ms
        self.fails('P0', lambda e: e.update(simWallRatio=0.97))

    def test_reported_percentiles_must_match_the_raw_samples(self):
        self.fails('P0', lambda e: e.update(stepMs=[0.5, 0.5, 0.5, 0.5]))

    def test_workloads(self):
        self.fails('P0', lambda e: e['visualization'].update(trails={'mode': 'off', 'count': 0}))   # P0 keeps default visuals
        self.fails('P0', lambda e: e.update(bodies=80))
        self.fails('P0', lambda e: e['workload'].update(title='Falling stream'))
        self.fails('P1', lambda e: e.update(arrows=300))
        self.fails('P1', lambda e: e['visualization'].update(trails={'mode': 'all', 'count': 20}))
        self.fails('P1', lambda e: e['workload'].update(allBodyContacts=False))
        self.fails('P2', lambda e: e['visualization'].update(probes={'enabled': True, 'live': 1000}))
        self.fails('P3', lambda e: e.update(comparison={'bytes': 70_000_000}))
        self.fails('P3', lambda e: e.update(ticks=7300))


class Summary(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def log(self, runs):
        path = Path(self.dir.name) / 'app.log'
        path.write_text(''.join('[lawsmith] ' + json.dumps(e) + '\n' for e in runs), encoding='utf-8')
        return str(path)

    def test_exactly_three_valid_runs(self):
        out = str(Path(self.dir.name) / 'summary.json')
        m8perf.main(['m8perf.py', 'summary', self.log([capture('P2') for _ in range(3)]), 'P2', out])
        self.assertEqual(len(json.loads(Path(out).read_text(encoding='utf-8'))['runs']), 3)
        for runs in ([capture('P2')] * 2, [capture('P2')] * 4):
            with self.assertRaises(AssertionError):
                m8perf.main(['m8perf.py', 'summary', self.log(runs), 'P2', out])
        bad = copy.deepcopy(capture('P2')); bad['invalid'] = 'paused during capture'
        with self.assertRaises(AssertionError):
            m8perf.main(['m8perf.py', 'summary', self.log([capture('P2'), bad, capture('P2')]), 'P2', out])

    def test_construction(self):
        good = {'kind': 'comparison', 'action': 'baseline-committed', 'horizon': 600, 'bytes': 30_000_000, 'metrics': {'elapsedMs': 240, 'batches': 22, 'batchMs': [8, 9, 9, 10]}}
        m8perf.check_construction(good)
        for change in ({'horizon': 7200}, {'metrics': {'elapsedMs': 3200, 'batches': 22}}, {'metrics': {'elapsedMs': 200, 'batches': 1}}, {'bytes': 70_000_000}):
            with self.assertRaises(AssertionError):
                m8perf.check_construction({**good, **change})


if __name__ == '__main__':
    unittest.main()
