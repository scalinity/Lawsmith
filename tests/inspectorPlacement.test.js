// M8 review F3: the selected law's inspector is the contextual right panel (SPEC §11.1). Reads the shipped
// index.html for ownership and executes the production applyFreeze for replay's read-only scope. The
// stand-ins prove structure and state only; the native scenarios qualify layout, reachability and input.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const VOID = new Set(['meta', 'link', 'input', 'br', 'img']);
/** Every element id in index.html with the ids of its ancestors, outermost first. */
function ancestry() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const parents = new Map();
  for (const [, close, tag, attributes] of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/g)) {
    if (close) {
      expect(stack.pop()?.tag).toBe(tag);
      continue;
    }
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1] ?? null;
    if (id) parents.set(id, stack.map((e) => e.id).filter(Boolean));
    if (!VOID.has(tag) && !attributes.trimEnd().endsWith('/')) stack.push({ tag, id });
  }
  expect(stack).toEqual([]);
  return parents;
}

describe('inspector placement', () => {
  const parents = ancestry();
  const within = (id, owner) => parents.get(id).includes(owner);

  it('the selected-law inspector sits in the right context column, outside the scene column and its panel', () => {
    expect(within('details', 'context-column')).toBe(true);
    expect(within('details', 'scene-column')).toBe(false);
    expect(within('details', 'panel')).toBe(false);
    for (const id of ['law-label', 'law-fade', 'law-colors', 'law-support', 'law-params', 'law-region-params', 'ingredients', 'law-duplicate', 'law-delete', 'details-error']) {
      expect(within(id, 'details-body'), id).toBe(true);
    }
  });

  it('scene actions and the small Laws list stay on the left', () => {
    for (const id of ['document', 'file-open', 'file-save', 'example-open', 'panel-toggle']) expect(within(id, 'scene-column'), id).toBe(true);
    for (const id of ['laws', 'law-list', 'law-shelf', 'motion', 'display']) expect(within(id, 'panel'), id).toBe(true);
  });

  it('its collapse control is its own, outside the collapsing body, and names what it controls', () => {
    expect(within('details-toggle', 'details')).toBe(true);
    expect(within('details-toggle', 'details-body')).toBe(false);
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/id="details-toggle" aria-expanded="true" aria-controls="details-body"/);
    // Hide laws collapses the left panel only: the inspector is not inside it.
    expect(html).toMatch(/id="panel-toggle" aria-expanded="true" aria-controls="panel"/);
  });
});

describe('replay keeps the inspector read-only and its collapse control usable (production applyFreeze)', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const applyFreeze = () => {');
  const end = source.indexOf('\n  };', start) + 5;
  const code = stripTypeScriptTypes(source.slice(start, end).replace('const applyFreeze', 'globalThis.applyFreeze'));

  function run({ replay, guard }) {
    const elements = new Map();
    const $ = (id) => {
      if (!elements.has(id)) elements.set(id, { id, inert: false, disabled: false, title: '' });
      return elements.get(id);
    };
    const context = createContext({
      $, frozen: false, guardFrozen: guard, launchPending: false,
      readOnly: () => replay, comparing: () => false, replaying: () => replay,
      document: { body: { dataset: {} }, querySelectorAll: () => [] },
      viewport: { gizmo: { enabled: true, getHelper: () => ({ visible: true }) } },
    });
    runInContext(code, context);
    runInContext('applyFreeze()', context);
    return $;
  }

  it('in replay the fields are inert and the card and its toggle are not', () => {
    const $ = run({ replay: true, guard: false });
    expect($('details-body').inert).toBe(true);
    expect($('details').inert).toBe(false);
    expect($('details-toggle').inert).toBe(false);
  });

  it('in authoring nothing in the inspector is inert; a guard freezes the whole card with the rest', () => {
    expect(run({ replay: false, guard: false })('details-body').inert).toBe(false);
    const frozen = run({ replay: false, guard: true });
    expect(frozen('details').inert).toBe(true);
    expect(frozen('panel').inert).toBe(true);
  });
});
