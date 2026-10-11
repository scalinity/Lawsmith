"""M8 R20: lib.zsh press() clicks a control only once it lies wholly inside the visible box of the scrolling
region the app names as its owner (the Scene panel or the context column), clipped to the window; until
then it sends a guarded wheel step over that region and reads the layout again. The geometry below is the
sixth native attempt's last readback, where the old press() clicked the details toggle's unclipped center
above the window and the hit guard met the menu bar. Nothing runs natively."""
from pathlib import Path
import importlib.util
import re
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('logq', HERE / 'logq.py')
logq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logq)

ORIGIN = (40, 45)


def layout(toggle, column=(834.1, 54, 433.9, 628), viewport=(1280, 800), extra=None):
    controls = {'context-column': list(column), 'details-toggle': list(toggle), 'play': [960, 700, 96, 28], 'panel': [24, 300, 284, 400]}
    owners = {'details-toggle': 'context-column', 'play': 'dock', 'context-column': 'context-column', 'panel': 'panel'}
    for key, (box, owner) in (extra or {}).items():
        controls[key] = list(box)
        owners[key] = owner
    return {'viewport': list(viewport), 'controls': controls, 'owners': {'controls': owners}}


def reach(value, control='details-toggle'):
    return logq.reach(value, *ORIGIN, control).split()


class Reach(unittest.TestCase):
    def test_r20_toggle_above_the_column_is_scrolled_into_view_not_clicked(self):
        action = reach(layout([1161.4, -39.4, 93.6, 28]))
        self.assertEqual(action[0], 'scroll')
        x, y, delta = int(action[1]), int(action[2]), int(action[3])
        self.assertEqual(delta, 120)  # the content moves down, toward a control above the visible box
        # The wheel point lies inside the column's visible box on screen, never at the toggle's old point (1248, 20).
        self.assertTrue(40 + 834.1 <= x <= 40 + 834.1 + 433.9 and 45 + 54 <= y <= 45 + 54 + 628)
        self.assertNotEqual((x, y), (1248, 20))

    def test_once_inside_the_column_it_is_clicked_at_its_fresh_center(self):
        self.assertEqual(reach(layout([1161.4, 70, 93.6, 28])), ['click', str(round(40 + 1161.4 + 46.8)), str(round(45 + 70 + 14))])

    def test_partly_clipped_at_either_edge_still_scrolls(self):
        self.assertEqual(reach(layout([1161.4, 40, 93.6, 28]))[0::3], ['scroll', '120'])
        self.assertEqual(reach(layout([1161.4, 670, 93.6, 28]))[0::3], ['scroll', '-120'])

    def test_the_visible_box_is_clipped_to_the_window(self):
        tall = (834.1, 54, 433.9, 1200)  # a column reported taller than the 800 px window
        self.assertEqual(reach(layout([1161.4, 780, 93.6, 28], column=tall))[0::3], ['scroll', '-120'])
        self.assertEqual(reach(layout([1161.4, 700, 93.6, 28], column=tall))[0], 'click')

    def test_controls_outside_the_scrolling_regions_are_clicked_as_before(self):
        value = layout([1161.4, 70, 93.6, 28])
        self.assertEqual(reach(value, 'play'), ['click', str(round(40 + 960 + 48)), str(round(45 + 700 + 14))])

    def test_panel_controls_follow_the_panel(self):
        value = layout([1161.4, 70, 93.6, 28], extra={'add-linearDrag': ([40, 760, 80, 24], 'panel')})
        self.assertEqual(reach(value, 'add-linearDrag')[0::3], ['scroll', '-120'])

    def test_unreachable_is_reported_not_clicked(self):
        self.assertEqual(reach(layout([1161.4, 70, 93.6, 28], column=(834.1, 54, 433.9, 0)))[0], 'unreachable')
        self.assertEqual(reach(layout([1161.4, 70, 93.6, 28]), 'comparison-close')[0], 'unreachable')


class PressInLib(unittest.TestCase):
    def body(self, name):
        text = (HERE / 'lib.zsh').read_text(encoding='utf-8')
        start = text.index(f'\n{name}() {{')
        return text[start:text.index('\n}\n', start)]

    def test_press_acts_only_through_the_guarded_helpers_with_fresh_geometry(self):
        body = self.body('press')
        self.assertNotRegex(body, r'\bcliclick\b|scroll\.js|osascript')
        self.assertRegex(body, r'for i in \{1\.\.25\}; do\n\s+layout\n\s+act=.*logq reach')
        self.assertIn('click) click $act[2] $act[3]; return 0', body)
        self.assertIn('scroll) scroll_at $act[2] $act[3] $act[4]', body)
        self.assertRegex(body, r'\*\) fail ')
        self.assertRegex(body, r'done\n\s+fail ')

    def test_press_expect_still_resends_at_most_once(self):
        self.assertEqual(len(re.findall(r'^\s+press \$1$', self.body('press_expect'), re.M)), 2)


if __name__ == '__main__':
    unittest.main()
