// M8 owner feedback (above 100% Interface Scale the two columns crowded out the viewport): executes the
// production focus-layout block in src/main.ts (not a copy) with stand-in nodes. It decides when the
// single-column focus layout applies, moves the same nodes into the Scene panel in reading order and
// back, and folds the drawing options in focus. Geometry itself is for the native matrix.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf("  const panelEl = $('panel');");
const end = source.indexOf("  window.addEventListener('resize', applyFocus);\n", start) + "  window.addEventListener('resize', applyFocus);\n".length;

function page(innerWidth, uiScale, compact = false) {
  const moves = [];
  const node = (id) => ({
    id, hidden: false, dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    after: (...n) => moves.push(['after', id, n.map((x) => x.id)]),
    append: (...n) => moves.push(['append', id, n.map((x) => x.id)]),
    addEventListener() {},
  });
  const ids = ['panel', 'panel-nav', 'laws', 'details', 'explain', 'run', 'comparison', 'draw-toggle', 'overlays', 'context-column'];
  const nodes = Object.fromEntries(ids.map((id) => [id, node(id)]));
  nodes['context-column'].children = ['sim-error', 'conditions', 'run', 'comparison', 'details', 'explain'].map((id) => nodes[id] ?? { id });
  let onResize;
  const window = { innerWidth, addEventListener: (type, fn) => { if (type === 'resize') onResize = fn; } };
  const document = { documentElement: { dataset: compact ? { compact: 'true' } : {} } };
  const context = createContext({
    $: (id) => nodes[id], window, document, uiScale, report: () => {}, keepFocus: (move) => move(),
    overlaysCluster: nodes.overlays, contextColumn: nodes['context-column'],
  });
  runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  return { moves, nodes, document, context, window, resize: () => onResize() };
}

describe('the focus layout (applyFocus)', () => {
  it.each([
    [1280, 2, false, true], [1280, 1.5, false, true], [1280, 1.25, false, true], [1600, 1.25, false, false],
    [1280, 1, false, false], [900, 1, false, false], [900, 2, true, true],
  ])('%i px wide at %s× (compact %s) is focus: %s', (width, scale, compact, focus) => {
    const p = page(width, scale, compact);
    expect(p.document.documentElement.dataset.focus).toBe(String(focus));
    expect(p.nodes['panel-nav'].hidden).toBe(!focus);
    expect(p.nodes.overlays.dataset.folded).toBe(String(focus));
    if (focus) expect(p.moves).toEqual([['after', 'laws', ['details', 'explain']], ['append', 'panel', ['run', 'comparison']]]);
    else expect(p.moves).toEqual([['append', 'context-column', ['sim-error', 'conditions', 'run', 'comparison', 'details', 'explain']]]);
  });

  it('moves the cards back to the right column in their original order when the window widens', () => {
    const p = page(1280, 2);
    p.window.innerWidth = 2400;
    p.resize();
    p.resize();
    expect(p.moves.slice(2)).toEqual([['append', 'context-column', ['sim-error', 'conditions', 'run', 'comparison', 'details', 'explain']]]);
    expect(p.document.documentElement.dataset.focus).toBe('false');
    expect(p.nodes.overlays.dataset.folded).toBe('false');
    expect(p.nodes['draw-toggle'].attrs['aria-expanded']).toBe('true');
  });
});
