// M8 review R-HUD1: renderEmitter hides the emitter selector row for a single emitter, but `.field-row`
// sets display: grid, which beats the user agent's [hidden] { display: none }. This resolves the row's
// `display` from src/style.css with postcss. Each selector is matched right to left against the row and
// its ancestors as index.html nests them (section#emitter, aside#panel, div#scene-column, div#shell,
// body, html), with no layout data-* states set. Winners are decided by !important, specificity and
// source order. It is a stylesheet cascade check, not a browser's computed style; the native checks see
// the rendered row.
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync(new URL('../src/style.css', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const row = html.match(/<div class="([^"]*)" id="emitter-pick-row"([^>]*)>/);
// The row's ancestors, nearest first, as index.html nests them (asserted below).
const ANCESTORS = [
  { tag: 'section', id: 'emitter', classes: [], attrs: {} },
  { tag: 'aside', id: 'panel', classes: [], attrs: {} },
  { tag: 'div', id: 'scene-column', classes: [], attrs: {} },
  { tag: 'div', id: 'shell', classes: [], attrs: {} },
  { tag: 'body', id: '', classes: [], attrs: {} },
  { tag: 'html', id: '', classes: [], attrs: {}, root: true },
];

/** Whether one compound selector (no combinators) matches an element. */
function compoundMatches(compound, element) {
  const parts = compound.match(/:not\([^)]*\)|#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+|^[a-z]+|\*/g) ?? [];
  if (parts.join('') !== compound) return false; // a form this check does not model never matches
  return parts.every((part) => {
    if (part.startsWith(':not(')) return !compoundMatches(part.slice(5, -1), element);
    if (part === ':root') return element.root === true;
    if (part.startsWith(':')) return false;
    if (part.startsWith('#')) return part.slice(1) === element.id;
    if (part.startsWith('.')) return element.classes.includes(part.slice(1));
    if (part.startsWith('[')) {
      const [name, value] = part.slice(1, -1).split('=');
      return element.attrs[name] !== undefined && (value === undefined || value.replaceAll('"', '') === element.attrs[name]);
    }
    return part === '*' || part === element.tag;
  });
}
/** Right-to-left selector matching over the element and its ancestor chain. */
function selectorMatches(selector, chain) {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const match = (t, i) => {
    if (t < 0) return true;
    if (i >= chain.length || !compoundMatches(tokens[t], chain[i])) return false;
    if (t === 0) return true;
    if (tokens[t - 1] === '>') return match(t - 2, i + 1);
    for (let j = i + 1; j < chain.length; j++) if (match(t - 1, j)) return true;
    return false;
  };
  return match(tokens.length - 1, 0);
}
const specificity = (selector) => [(selector.match(/#[\w-]+/g) ?? []).length, (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!not\()[\w-]+/g) ?? []).length, (selector.match(/(^|[\s>])[a-z]+/g) ?? []).length];
function beats(a, b) {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
  return a.order > b.order;
}
function display(element) {
  // The user agent's rules sit below every author rule.
  let winner = { value: element.attrs.hidden !== undefined ? 'none' : 'block', important: false, spec: [-1, 0, 0], order: -1, selector: 'user agent' };
  let order = 0;
  const chain = [element, ...ANCESTORS];
  css.walkRules((rule) => {
    if (rule.parent.type === 'atrule' && !/^(media|supports)$/.test(rule.parent.name)) return;
    rule.walkDecls('display', (decl) => {
      order += 1;
      for (const selector of rule.selectors) {
        if (!selectorMatches(selector, chain)) continue;
        const candidate = { value: decl.value, important: decl.important === true, spec: specificity(selector), order, selector };
        if (beats(candidate, winner)) winner = candidate;
      }
    });
  });
  return winner;
}

describe('the emitter selector row (R-HUD1)', () => {
  const element = (hidden) => ({ tag: 'div', id: 'emitter-pick-row', classes: row[1].split(' '), attrs: hidden ? { hidden: '' } : {} });

  it('is the field-row the markup declares, hidden by default, inside the modelled ancestors', () => {
    expect(row[1]).toBe('field-row');
    expect(row[2]).toContain('hidden');
    const at = (id) => html.indexOf(`id="${id}"`);
    expect(at('scene-column') < at('panel') && at('panel') < at('emitter') && at('emitter') < at('emitter-pick-row') && at('emitter-pick-row') < html.indexOf('</aside>', at('panel'))).toBe(true);
  });

  it('the matcher sees descendant rules for other cards as not matching', () => {
    expect(selectorMatches('#run [hidden]', [element(true), ...ANCESTORS])).toBe(false);
    expect(selectorMatches('#panel .field-row', [element(true), ...ANCESTORS])).toBe(true);
    expect(selectorMatches(':root #shell > #scene-column #emitter-pick-row', [element(true), ...ANCESTORS])).toBe(true);
  });

  it('one emitter: hidden wins over .field-row', () => {
    const won = display(element(true));
    expect(won.value, won.selector).toBe('none');
  });

  it('several emitters: the row is a grid like every field row', () => {
    const won = display(element(false));
    expect(won.value, won.selector).toBe('grid');
  });
});
