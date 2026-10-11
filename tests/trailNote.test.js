// M8 review R-FB1: the "click a moving body" trail note must follow the explained body on every path,
// including a context change (replay, restart, return), which sets it directly in showWorld rather than
// through setExplained. Executes the production refreshTrailNote and showWorld from src/main.ts.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start) + to.length;
  if (start < 0 || end < to.length) throw new Error(`missing ${from}`);
  return source.slice(start, end);
};
const note = slice('  const refreshTrailNote = () => {', '\n  };\n');
const showWorld = slice('  const showWorld = (reason: string, keep: string | null = null) => {', '\n  };\n');

function page({ mode = 'selected', explained = null, ids = [] } = {}) {
  const trailNote = { hidden: true };
  const simError = { hidden: true };
  const shown = { ids, generation: 2, fault: null, explain: () => {} };
  const context = createContext({
    $: (id) => (id === 'trail-note' ? trailNote : simError),
    trails: { mode }, explained, host: shown, runs: { shown, selected: 'authoring' },
    setPlaying: () => {}, scheduler: { pause: () => {} }, drawWait: null, ingredientPanel: { reset: () => {} },
    interaction: { selectedId: null, select: () => {} }, appliedLaw: () => true, showSimError: () => {}, canResetScene: () => false,
  });
  runInContext(`${stripTypeScriptTypes(note + showWorld)}\nglobalThis.showWorld = showWorld; globalThis.refreshTrailNote = refreshTrailNote;`, context);
  return { trailNote, context };
}

describe('the trail note follows the explained body through context changes', () => {
  it('a replay that drops the selected body shows the note again', () => {
    const p = page({ explained: 'stream:3', ids: [] });
    p.context.refreshTrailNote();
    expect(p.trailNote.hidden).toBe(true);
    p.context.showWorld('replay');
    expect(p.context.explained).toBe(null);
    expect(p.trailNote.hidden).toBe(false);
  });

  it('a return that keeps an explained body hides the note', () => {
    const p = page({ explained: null, ids: ['stream:3'] });
    p.context.refreshTrailNote();
    expect(p.trailNote.hidden).toBe(false);
    p.context.showWorld('return', 'stream:3');
    expect(p.context.explained).toBe('stream:3');
    expect(p.trailNote.hidden).toBe(true);
  });

  it('only the Selected body mode ever shows it', () => {
    const p = page({ mode: 'all', explained: 'stream:3', ids: [] });
    p.context.showWorld('replay');
    expect(p.trailNote.hidden).toBe(true);
  });
});
