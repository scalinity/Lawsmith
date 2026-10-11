// M8 review R-FB3: in the focus layout, a section jump must land below the sticky section bar at the
// bar's actual height (it wraps at large Interface Scale) and move keyboard focus to the section's
// heading, so Tab continues inside the section. Executes the production jumpToSection from src/main.ts.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const SECTION_HEADINGS');
const end = source.indexOf('    return true;\n  };\n', start) + '    return true;\n  };\n'.length;

function page({ uiScale = 2, navHeight = 104, targetTop = 700, hidden = false, shown = true } = {}) {
  let focused = null;
  const box = (top, height = 0) => () => ({ top, height });
  const panelEl = { scrollTop: 300, getBoundingClientRect: box(100) };
  const panelNav = { getBoundingClientRect: box(100, navHeight) };
  const el = (id) => ({ id, hidden, offsetParent: shown ? {} : null, getBoundingClientRect: box(targetTop), focus: (o) => { focused = [id, o]; } });
  const nodes = { laws: el('laws'), details: el('details'), motion: el('motion'), run: el('run') };
  const headings = Object.fromEntries(['laws-title', 'details-title', 'motion-title', 'run-title'].map((id) => [id, { id, focus: (o) => { focused = [id, o]; } }]));
  const document = { getElementById: (id) => nodes[id] ?? headings[id] ?? null };
  const context = createContext({ document, panelEl, panelNav, uiScale });
  runInContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.jump = jumpToSection;`, context);
  return { panelEl, jump: (id) => context.jump(id), focused: () => focused };
}

describe('section jumps (jumpToSection)', () => {
  it('at 200% with a wrapped two-row bar, the section lands just below the bar and its heading takes focus', () => {
    const p = page({ uiScale: 2, navHeight: 104, targetTop: 700 });
    expect(p.jump('details')).toBe(true);
    // 300 + (700 − 100) − 104 − 12: the heading's top ends 12 px below the bar's real height.
    expect(p.panelEl.scrollTop).toBe(784);
    expect(p.focused()).toEqual(['details-title', { preventScroll: true }]);
  });

  it('at 100% the same jump uses the one-row bar height, not a fixed value', () => {
    const p = page({ uiScale: 1, navHeight: 40, targetTop: 700 });
    p.jump('motion');
    expect(p.panelEl.scrollTop).toBe(300 + 600 - 40 - 6);
    expect(p.focused()[0]).toBe('motion-title');
  });

  it('the Recording card is reachable while recording (its heading stays shown when collapsed)', () => {
    const p = page();
    expect(p.jump('run')).toBe(true);
    expect(p.focused()[0]).toBe('run-title');
  });

  it('collapsed details are still a target; hidden details (no law selected) are refused without scrolling', () => {
    expect(page().jump('details')).toBe(true);
    const hidden = page({ hidden: true });
    expect(hidden.jump('details')).toBe(false);
    expect(hidden.panelEl.scrollTop).toBe(300);
    expect(hidden.focused()).toBe(null);
    expect(page({ shown: false }).jump('laws')).toBe(false);
  });
});
