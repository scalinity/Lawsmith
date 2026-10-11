// M8 review R-FB2: moving a node out of the document and back clears keyboard focus. The focus layout
// (applyFocus) and the compact arrangement (applyCompact) move whole cards, so a focused field or
// button inside one would lose focus on a scale change or a resize. Executes the production keepFocus,
// applyCompact and applyFocus from src/main.ts with a stand-in DOM that drops focus on removal, as WebKit does.
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
const block = slice('  const keepFocus = (move: () => void) => {', "  window.addEventListener('resize', applyFocus);\n");

class HTMLElement {
  constructor(id, doc, parent = null) {
    Object.assign(this, { id, doc, parent, hidden: false, disabled: false, dataset: {}, attrs: {}, children: [], shown: true });
    if (parent) parent.children.push(this);
  }
  get isConnected() { return true; }
  // Not rendered when hidden itself or inside a folded cluster: the stand-in models CSS display: none.
  get offsetParent() {
    for (let n = this; n; n = n.parent) if (!n.shown || n.dataset.folded === 'true') return null;
    return {};
  }
  contains(n) { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners ??= {})[type] = fn; }
  focus() { this.doc.activeElement = this; }
  // Moving a node detaches it first: focus inside it falls to the body.
  move(...nodes) { for (const n of nodes) if (n.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; }
  after(...n) { this.move(...n); }
  append(...n) { this.move(...n); }
  prepend(...n) { this.move(...n); }
}
class HTMLInputElement extends HTMLElement {
  constructor(id, doc, parent) { super(id, doc, parent); Object.assign(this, { selectionStart: 0, selectionEnd: 0, selectionDirection: 'none' }); }
  setSelectionRange(a, b, d) { Object.assign(this, { selectionStart: a, selectionEnd: b, selectionDirection: d }); }
}
class HTMLTextAreaElement extends HTMLInputElement {}

function page(innerWidth, innerHeight, uiScale) {
  const doc = { body: null, activeElement: null, documentElement: { dataset: {} } };
  doc.body = new HTMLElement('body', doc);
  doc.activeElement = doc.body;
  const ids = ['panel', 'panel-nav', 'laws', 'details', 'explain', 'run', 'comparison', 'draw-toggle', 'overlays', 'context-column', 'dock'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new HTMLElement(id, doc, doc.body)]));
  nodes['context-column'].children = [nodes.run, nodes.comparison, nodes.details, nodes.explain];
  const strength = new HTMLInputElement('law-strength', doc, nodes.details);
  const record = new HTMLElement('run-record', doc, nodes.run);
  const trails = new HTMLElement('trails-all', doc, nodes.overlays);
  let onResize = [];
  const window = { innerWidth, innerHeight, addEventListener: (type, fn) => { if (type === 'resize') onResize.push(fn); } };
  const context = createContext({ $: (id) => nodes[id], window, document: doc, uiScale, report: () => {}, HTMLElement, HTMLInputElement, HTMLTextAreaElement });
  runInContext(stripTypeScriptTypes(block), context);
  return { doc, nodes, strength, record, trails, window, context, resize: () => onResize.forEach((f) => f()), clickDraw: () => nodes['draw-toggle'].listeners.click() };
}

describe('focus survives a layout move', () => {
  it('a focused inspector field keeps focus and its selection when the focus layout gathers the cards', () => {
    const p = page(2400, 900, 1);
    p.strength.focus();
    p.strength.setSelectionRange(1, 3, 'forward');
    p.window.innerWidth = 1280;
    p.context.uiScale = 2;
    p.resize();
    expect(p.doc.documentElement.dataset.focus).toBe('true');
    expect(p.doc.activeElement).toBe(p.strength);
    expect([p.strength.selectionStart, p.strength.selectionEnd, p.strength.selectionDirection]).toEqual([1, 3, 'forward']);
  });

  it('a focused recording button keeps focus when the cards go back to the right column', () => {
    const p = page(1280, 900, 2);
    p.record.focus();
    p.window.innerWidth = 2400;
    p.resize();
    expect(p.doc.documentElement.dataset.focus).toBe('false');
    expect(p.doc.activeElement).toBe(p.record);
  });

  it('a focused drawing option keeps focus when the compact arrangement moves the cluster', () => {
    const p = page(1600, 900, 2);
    p.clickDraw(); // open: drawing options start folded
    p.trails.focus();
    p.window.innerHeight = 600;
    p.resize();
    expect(p.doc.documentElement.dataset.compact).toBe('true');
    expect(p.doc.activeElement).toBe(p.trails);
  });

  it('a control that ends up hidden or disabled is not given focus back', () => {
    const p = page(2400, 900, 1);
    p.strength.focus();
    p.strength.shown = false;
    p.window.innerWidth = 1280;
    p.context.uiScale = 2;
    p.resize();
    expect(p.doc.activeElement).toBe(p.doc.body);
    const q = page(2400, 900, 1);
    q.record.focus();
    q.record.disabled = true;
    q.window.innerWidth = 1280;
    q.context.uiScale = 2;
    q.resize();
    expect(q.doc.activeElement).toBe(q.doc.body);
  });

  it('folding the drawing options while one of them has focus moves focus to the Draw options button', () => {
    const p = page(1600, 900, 1);
    expect(p.nodes.overlays.dataset.folded).toBe('true');
    expect(p.trails.offsetParent).toBe(null);
    p.clickDraw();
    p.trails.focus();
    p.clickDraw();
    expect(p.nodes.overlays.dataset.folded).toBe('true');
    expect(p.doc.activeElement).toBe(p.nodes['draw-toggle']);
  });

  it('a layout change never folds or opens the drawing options, so it never hides a focused one', () => {
    const p = page(2400, 900, 1);
    p.clickDraw();
    p.trails.focus();
    p.window.innerWidth = 1280;
    p.context.uiScale = 2;
    p.resize();
    expect(p.doc.documentElement.dataset.focus).toBe('true');
    expect(p.nodes.overlays.dataset.folded).toBe('false');
    expect(p.doc.activeElement).toBe(p.trails);
  });
});
