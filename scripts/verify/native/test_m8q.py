"""Synthetic parser controls only; these results never qualify native Lawsmith behavior."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import m8q


def layout():
    controls = {key: [900, 760, 60, 28] for key in ['play', 'step', 'reset']}
    controls.update({key: [700 + 40 * i, 6, 36, 28] for i, key in enumerate(['undo', 'redo', 'frame-view', 'reset-view', 'mode-translate', 'mode-rotate', 'mode-scale'])})
    controls.update({key: [24 + 60 * i, 120, 56, 28] for i, key in enumerate(['file-new', 'file-open', 'file-save', 'file-save-as'])})
    controls.update({
        'example-open': [24, 156, 260, 28], 'panel-toggle': [220, 60, 60, 28], 'doc-invitation': [24, 190, 260, 40],
        'document': [12, 52, 284, 200], 'panel': [12, 260, 284, 300], 'context-column': [828, 52, 440, 200],
        'dock': [800, 700, 468, 88], 'tools': [690, 6, 330, 28], 'diagnostics': None, 'drag-region': [0, 0, 600, 40],
        'law-fade': [24, 900, 120, 24],  # scrolled below the panel's edge: reachable by scrolling
    })
    return {
        'viewport': [1280, 800], 'interfaceScale': 2, 'pixelRatio': 1.5, 'canvas': [1920, 1200], 'playing': False,
        'authority': {'tick': 0, 'cursor': 0, 'stateHash': 's', 'engineHash': 'e'},
        'controls': controls, 'scroll': {'panel': {'scrollWidth': 282, 'clientWidth': 282, 'scrollHeight': 900, 'clientHeight': 300}},
        'example': 'drag-pocket', 'selected': 'pocket',
        'appliedLaws': [{'id': 'pocket', 'enabled': True}, {'id': 'pull', 'enabled': False}],
        'laws': [{'id': 'pocket', 'visibleState': 'true', 'enabledText': 'On'}, {'id': 'pull', 'visibleState': 'true', 'enabledText': 'Off'}],
        'lawLabels': {'pocket': {'text': 'Drag pocket', 'selected': True}, 'pull': {'text': 'Pull off', 'selected': False}},
        'focus': {'id': 'play', 'focusVisible': True, 'outline': ['solid', '4px'], 'box': [900, 760, 60, 28]},
    }


def lights():
    """Three complete traffic lights, clear of every control in layout()."""
    return [{'name': 'AXCloseButton', 'x': 13, 'y': 14, 'w': 14, 'h': 16},
            {'name': 'AXMinimizeButton', 'x': 33, 'y': 14, 'w': 14, 'h': 16},
            {'name': 'AXFullScreenButton', 'x': 53, 'y': 14, 'w': 14, 'h': 16}]


class Surface(unittest.TestCase):
    def test_continuous_surface(self):
        m8q.surface(layout())

    def test_overlapping_regions_fail(self):
        value = layout(); value['controls']['context-column'] = [200, 100, 440, 200]
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_fixed_control_off_window_fails(self):
        value = layout(); value['controls']['file-open'] = [24, -40, 56, 28]
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_drag_band_under_a_control_fails(self):
        value = layout(); value['controls']['undo'] = [500, 6, 36, 28]
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_sideways_scroll_fails(self):
        value = layout(); value['scroll']['panel']['scrollWidth'] = 300
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_fault_banner_over_comparison_fails(self):
        value = layout(); value['controls']['sim-error'] = [840, 60, 400, 40]; value['controls']['comparison'] = [878, 80, 390, 200]
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_condition_line_over_a_card_fails(self):
        value = layout(); value['controls']['conditions'] = [840, 60, 400, 40]; value['controls']['run'] = [878, 90, 390, 120]
        self.assertRaisesRegex(AssertionError, 'conditions .* overlaps run', m8q.surface, value)

    def test_squeezed_panel_fails(self):
        # M8 R16: the second native attempt's 2 px Scene panel at 1280x800 and 200%.
        value = layout(); value['scroll']['panel'].update(clientHeight=2)
        with self.assertRaises(AssertionError): m8q.surface(value)

    def test_short_panel_shown_whole_passes_and_collapsed_is_exempt(self):
        value = layout(); value['scroll']['panel'].update(scrollHeight=60, clientHeight=60)
        m8q.surface(value)
        value = layout(); value['scroll']['panel'].update(clientHeight=2); value['panelCollapsed'] = True
        m8q.surface(value)

    def test_unreachable_control_fails(self):
        value = layout(); value['controls']['run-record'] = [400, 900, 80, 28]
        with self.assertRaises(AssertionError): m8q.surface(value)


class Other(unittest.TestCase):
    def test_lights_clearance(self):
        result = m8q.lights(layout(), lights())
        self.assertEqual(result['lights'], ['AXCloseButton', 'AXFullScreenButton', 'AXMinimizeButton'])
        value = layout(); value['controls']['file-new'] = [20, 20, 56, 28]
        with self.assertRaises(AssertionError): m8q.lights(value, lights())

    def test_green_may_be_zoom_or_full_screen(self):
        zoom = lights(); zoom[2]['name'] = 'AXZoomButton'
        m8q.lights(layout(), zoom)

    def test_empty_or_unreadable_observation_fails(self):
        for frames in ([], None, {}, 'AXCloseButton'):
            with self.assertRaises(AssertionError): m8q.lights(layout(), frames)

    def test_each_missing_role_fails(self):
        for index in range(3):
            frames = lights(); del frames[index]
            with self.assertRaises(AssertionError): m8q.lights(layout(), frames)

    def test_duplicate_roles_fail(self):
        for extra in ({'name': 'AXCloseButton', 'x': 70, 'y': 14, 'w': 14, 'h': 16}, {'name': 'AXZoomButton', 'x': 70, 'y': 14, 'w': 14, 'h': 16}):
            with self.assertRaises(AssertionError): m8q.lights(layout(), lights() + [extra])

    def test_malformed_geometry_fails(self):
        for key, value in [('x', float('nan')), ('y', float('inf')), ('w', 0), ('h', -14), ('w', float('nan')), ('x', None), ('x', True), ('h', '16')]:
            frames = lights(); frames[1][key] = value
            with self.assertRaises(AssertionError): m8q.lights(layout(), frames)
        frames = lights(); del frames[0]['y']
        with self.assertRaises(AssertionError): m8q.lights(layout(), frames)

    def test_unknown_role_fails(self):
        frames = lights(); frames[0]['name'] = 'AXToolbarButton'
        with self.assertRaises(AssertionError): m8q.lights(layout(), frames)

    def test_scale_must_not_change_simulation_or_renderer(self):
        base = layout(); m8q.scale(base, copy.deepcopy(base))
        for key, value in [('pixelRatio', 2), ('canvas', [960, 600]), ('authority', {'tick': 1})]:
            now = copy.deepcopy(base); now[key] = value
            with self.assertRaises(AssertionError): m8q.scale(base, now)

    def test_example_open_paused_with_invitation(self):
        m8q.example(layout(), 'drag-pocket', 'pocket')
        value = layout(); value['controls']['doc-invitation'] = None
        with self.assertRaises(AssertionError): m8q.example(value, 'drag-pocket', 'pocket')

    def test_labels_mark_selection_and_disabled_without_color(self):
        m8q.labels(layout())
        value = layout(); value['lawLabels']['pull']['text'] = 'Pull'
        with self.assertRaises(AssertionError): m8q.labels(value)

    def test_focus_ring_required(self):
        m8q.focus(layout(), 'play')
        value = layout(); value['focus']['focusVisible'] = False
        with self.assertRaises(AssertionError): m8q.focus(value)


if __name__ == '__main__':
    unittest.main()
