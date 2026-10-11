"""Source audit of the earlier runners the M8 campaign reruns: every native change goes through a lib.zsh
helper (which checks the GUI lock, the deadline and outside input immediately before acting), and a
direct System Events call is allowed only right after such a recheck. Static checks only; nothing runs."""
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
CAMPAIGN = ['m2-demo', 'm2-files', 'm5-compose', 'm5-legible', 'm6a-record', 'm6a-legible', 'm6b-seek', 'm7-compare', 'm7-r1-panel']
# Raw mutations that must not appear in a campaign runner: lib.zsh owns their guarded forms.
FORBIDDEN = [r'display\.js set', r'\bcliclick\b', r'\bdefaults\b', r'\baxq (press|set)\b', r'\bscreencapture\b', r'\bopen -n\b']
UNOWNED_STATE = [r'^ORIGINAL_MODE=', r'^HAD_PREFS=']


def code_lines(name):
    return [(n, line) for n, line in enumerate((HERE / f'{name}.zsh').read_text(encoding='utf-8').splitlines(), 1) if not line.lstrip().startswith('#')]


class CampaignRunners(unittest.TestCase):
    def test_no_raw_mutations(self):
        for name in CAMPAIGN:
            for n, line in code_lines(name):
                for pattern in FORBIDDEN + UNOWNED_STATE:
                    self.assertIsNone(re.search(pattern, line), f'{name}.zsh:{n}: {line.strip()}')

    def test_direct_system_events_calls_follow_a_recheck(self):
        for name in CAMPAIGN:
            lines = code_lines(name)
            for i, (n, line) in enumerate(lines):
                if 'osascript -e' in line:
                    before = lines[i - 1][1]
                    self.assertRegex(before, r'guard_front; idle_gate', f'{name}.zsh:{n} is not preceded by a recheck after its front check')

    def test_display_and_preferences_restored_through_lib(self):
        for name in ('m5-legible', 'm6a-legible', 'm7-compare', 'm7-r1-panel'):
            text = (HERE / f'{name}.zsh').read_text(encoding='utf-8')
            for helper in ('restore_display_mode', 'restore_preferences', 'display_set'):
                self.assertTrue(helper in text, f'{name}.zsh does not use {helper}')


    def test_layout_readback_uses_the_focus_independent_chord(self):
        # M8 R15: plain Shift-L is swallowed by a focused text field or pop-up menu; the readback is Shift-Cmd-L.
        lib = (HERE / 'lib.zsh').read_text(encoding='utf-8')
        body = lib[lib.index('layout() {'):lib.index('\n}', lib.index('layout() {'))]
        self.assertIn('keys kd:cmd,shift t:l ku:cmd,shift', body)
        self.assertNotIn('kd:shift t:l', body)


if __name__ == '__main__':
    unittest.main()
