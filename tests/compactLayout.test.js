// M8 R18: executes the production applyCompact in src/main.ts (not a copy). The compact arrangement
// applies exactly when the window is shorter than 360 interface units (the third native attempt failed
// at 900×600 and 200%), and the drawing options move to the scrolling context column and back to the
// head of the dock. Geometry itself is qualified natively by m8q.surface.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf("  const dock = $('dock');");
const end = source.indexOf("  window.addEventListener('resize', applyCompact);\n", start) + "  window.addEventListener('resize', applyCompact);\n".length;

function page(innerHeight, uiScale) {
  const moves = [];
  const node = (id) => ({ id, append: (child) => moves.push(['append', id, child.id]), prepend: (child) => moves.push(['prepend', id, child.id]) });
  const nodes = { dock: node('dock'), overlays: node('overlays'), 'context-column': node('context-column') };
  let onResize;
  const window = { innerHeight, addEventListener: (type, fn) => { if (type === 'resize') onResize = fn; } };
  const document = { documentElement: { dataset: {} } };
  const context = createContext({ $: (id) => nodes[id], window, document, uiScale });
  runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  return { moves, window, document, context, resize: () => onResize() };
}

describe('the compact arrangement (applyCompact)', () => {
  it.each([
    [600, 2, true], [600, 1.75, true], [600, 1.5, false], [600, 1, false], [800, 2, false], [755, 2, false],
  ])('a %i px tall window at %s× is compact: %s', (height, scale, compact) => {
    const p = page(height, scale);
    expect(p.document.documentElement.dataset.compact).toBe(String(compact));
    expect(p.moves).toEqual([compact ? ['append', 'context-column', 'overlays'] : ['prepend', 'dock', 'overlays']]);
  });

  it('follows the window and the scale, moving the drawing options only when the arrangement changes', () => {
    const p = page(800, 2);
    p.resize();
    expect(p.moves).toHaveLength(1);
    p.window.innerHeight = 600;
    p.resize();
    p.resize();
    p.context.uiScale = 1.5;
    p.resize();
    expect(p.moves).toEqual([['prepend', 'dock', 'overlays'], ['append', 'context-column', 'overlays'], ['prepend', 'dock', 'overlays']]);
    expect(p.document.documentElement.dataset.compact).toBe('false');
  });
});
