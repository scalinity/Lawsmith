"""Synthetic parser controls only; these results never qualify native Lawsmith behavior."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import m7q


def receipt():
    return {'authority': {'tick': 120, 'cursor': 1, 'stateHash': 'state', 'engineHash': 'engine'},
            'baselineHash': 'baseline', 'framePastHorizon': False,
            'pair': {'tick': 120, 'id': 'traveler', 'baseline': [1, 0, 0], 'alternate': [1, 1, 0], 'separation': 1}}


def layout():
    return {'playing': False, 'comparison': {'tick': 120, 'replaying': False, 'receipt': receipt()}}


class NativeAssertions(unittest.TestCase):
    def test_actual_separation(self):
        m7q.separation(layout())

    def test_zero_separation_fails_despite_label(self):
        value = layout(); value['comparison']['inspect'] = 'Separation 1.000 m'
        value['comparison']['receipt']['pair']['alternate'] = [1, 0, 0]
        with self.assertRaises(AssertionError): m7q.separation(value)

    def test_exact_replay(self):
        m7q.replay({'t': 1, 'retained': receipt(), 'suffix': 1}, {'t': 2, 'receipt': receipt(), 'suffix': 1, 'playing': False}, layout())

    def test_overshot_endpoint_fails_after_replaying_false(self):
        value = layout(); value['comparison']['receipt']['authority']['tick'] = 121
        with self.assertRaises(AssertionError):
            m7q.replay({'t': 1, 'retained': receipt(), 'suffix': 1}, {'t': 2, 'receipt': receipt(), 'suffix': 1, 'playing': False}, value)

    def test_changed_engine_fails(self):
        end = {'t': 2, 'receipt': receipt(), 'suffix': 1, 'playing': False}; end['receipt']['authority']['engineHash'] = 'changed'
        with self.assertRaises(AssertionError): m7q.replay({'t': 1, 'retained': receipt(), 'suffix': 1}, end, layout())

    def test_unpaused_replay_fails(self):
        value = layout(); value['playing'] = True
        with self.assertRaises(AssertionError): m7q.replay({'t': 1, 'retained': receipt(), 'suffix': 1}, {'t': 2, 'receipt': receipt(), 'suffix': 1, 'playing': False}, value)

    def test_ghost_authority_and_baseline(self):
        toggles = [{'shown': False, 'receipt': receipt()}, {'shown': True, 'receipt': receipt()}]
        m7q.ghosts(receipt(), toggles)
        toggles[1]['receipt']['baselineHash'] = 'mutated'
        with self.assertRaises(AssertionError): m7q.ghosts(receipt(), toggles)

    def test_twenty_bounded_cycles_and_growing_count_negative_control(self):
        sample = {'contexts': {'comparison': None, 'worlds': 1, 'authoring': 1, 'replay': 0}, 'render': {'geometries': 1, 'textures': 0, 'objects': 10}, 'bytes': {'probes': 100}, 'totalBytes': 100}
        samples = [copy.deepcopy(sample) for _ in range(20)]
        m7q.resources(samples)
        for i, value in enumerate(samples): value['render']['geometries'] += i
        with self.assertRaises(AssertionError): m7q.resources(samples)

    def test_frame_past_horizon_fails(self):
        value = layout(); value['comparison']['receipt']['framePastHorizon'] = True
        with self.assertRaises(AssertionError): m7q.separation(value)

    def test_canceled_fixture_missing_fails(self):
        with self.assertRaises(AssertionError): m7q.fixtures([{'complete': True}])


if __name__ == '__main__':
    unittest.main()
