"""M8 owner-feedback repair: the focus layout (large Interface Scale) keeps the details and recording in the
Scene panel's column, so Hide laws no longer removes the whole panel there. m8-visual's "panel collapsed"
expectation is evaluated here, exactly as written in the runner, against synthetic readbacks: it must
pass only when the Laws and Scene sections are really gone and the details and recording stay reachable,
and keep the wide layout's original meaning. m8-keyboard's walk must use the section bar by its ID with
ordinary Tab and Space, under the unchanged tab_to limit. Nothing runs natively."""
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
VISUAL = (HERE / 'm8-visual.zsh').read_text(encoding='utf-8')
KEYBOARD = (HERE / 'm8-keyboard.zsh').read_text(encoding='utf-8')
LIB = (HERE / 'm8lib.zsh').read_text(encoding='utf-8')
EXPR = re.search(r'expect layout "panel collapsed" "(.*)"\n', VISUAL).group(1)


def readback(focus, **controls):
    base = {'panel': [24, 200, 400, 300], 'arrows-toggle': None, 'file-open': [40, 120, 80, 28], 'motion': None, 'display': None,
            'section-laws': None, 'details-toggle': [300, 260, 90, 28], 'run-toggle': [300, 700, 60, 28]}
    base.update(controls)
    return {'panelCollapsed': True, 'focusLayout': focus, 'laws': [{'select': None}], 'controls': base}


def holds(e):
    # The runner's own committed expression, evaluated as lib.zsh's expect does at runtime, on synthetic
    # dictionaries only: no outside input reaches it.
    return eval(EXPR, {}, {'e': e})


class PanelCollapsed(unittest.TestCase):
    def test_wide_layout_keeps_its_meaning(self):
        self.assertTrue(holds(readback(False, panel=None)))
        self.assertFalse(holds(readback(False)))  # a wide panel still shown is not collapsed

    def test_focus_layout_passes_only_with_laws_gone_and_details_and_recording_reachable(self):
        self.assertTrue(holds(readback(True)))

    def test_focus_layout_failures(self):
        self.assertFalse(holds(readback(True, **{'arrows-toggle': [30, 300, 80, 28]})))      # Laws still shown
        self.assertFalse(holds({**readback(True), 'laws': [{'select': [30, 320, 200, 40]}]}))  # a law row still shown
        self.assertFalse(holds(readback(True, motion=[24, 600, 400, 200])))                    # Scene section still shown
        self.assertFalse(holds(readback(True, **{'section-laws': [30, 210, 60, 28]})))         # its jump still offered
        self.assertFalse(holds(readback(True, **{'details-toggle': None})))                     # details unreachable
        self.assertFalse(holds(readback(True, **{'run-toggle': None})))                         # recording unreachable
        self.assertFalse(holds(readback(True, panel=None)))                                     # the column itself gone

    def test_the_file_actions_stay_in_both_layouts(self):
        self.assertFalse(holds(readback(True, **{'file-open': None})))
        self.assertFalse(holds(readback(False, panel=None, **{'file-open': None})))


class KeyboardWalk(unittest.TestCase):
    def test_the_section_bar_is_used_by_id_in_the_focus_layout_only(self):
        block = re.search(r'if \[\[ \$\(field layout focusLayout\) == true \]\]; then\n(.*?)\nfi\n', KEYBOARD, re.S)
        self.assertIsNotNone(block)
        self.assertIn('tab_to "f[\'id\']==\'section-details\'"', block.group(1))
        self.assertIn('key_code 49', block.group(1))
        self.assertIn("e['focus']['id']=='details-title'", block.group(1))
        # The jump comes after the law is selected and before the first inspector field.
        self.assertLess(KEYBOARD.index('law selected from the list'), KEYBOARD.index('section-details'))
        self.assertLess(KEYBOARD.index('section-details'), KEYBOARD.index("tab_to \"f['label']=='Position x'\""))

    def test_tab_to_keeps_ordinary_tab_and_its_finite_limit(self):
        body = LIB[LIB.index('tab_to() {'):LIB.index('\n}\n', LIB.index('tab_to() {'))]
        self.assertIn('${2:-120}', body)
        self.assertIn("key code 48' >/dev/null", body)
        self.assertNotIn('option down', body)
        self.assertIn('idle_gate 1; guard_front; idle_gate 1', body)


if __name__ == '__main__':
    unittest.main()
