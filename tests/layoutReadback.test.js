// M8 review F1: execute the production layout readback's box function, not a copy. The stand-in models
// only what the function reads: a `hidden` attribute, CSS `display: none` on an element or an ancestor
// (no client rects, a zero bounding rectangle, as WebKit reports), and a laid-out rectangle otherwise.
// It does not qualify WKWebView layout; the native scenarios read the real boxes.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function layoutBox(');
const end = source.indexOf('\n}\n', start) + 3;
const context = createContext({});
runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
const layoutBox = (element) => runInContext('layoutBox', context)(element);

class Node {
  constructor(rect, parent = null) { this.rect = rect; this.parent = parent; this.hidden = false; this.display = 'block'; }
  rendered() { return this.display !== 'none' && !this.hidden && (!this.parent || this.parent.rendered()); }
  closest(selector) {
    expect(selector).toBe('[hidden]');
    for (let n = this; n; n = n.parent) if (n.hidden) return n;
    return null;
  }
  getClientRects() { return this.rendered() ? [this.rect] : []; }
  getBoundingClientRect() {
    const [left, top, width, height] = this.rendered() ? this.rect : [0, 0, 0, 0];
    return { left, top, width, height };
  }
}

function surface() {
  const column = new Node([12, 52, 284, 640]);
  const documentCard = new Node([12, 52, 284, 220], column);
  const fileOpen = new Node([80, 120, 60.04, 28], documentCard);
  const panel = new Node([12, 280, 284, 400], column);
  const lawRow = new Node([24, 320, 200, 28], panel);
  const nested = new Node([24, 360, 120, 24], new Node([12, 340, 284, 100], panel));
  return { column, fileOpen, panel, lawRow, nested };
}

it('a CSS-collapsed panel and every descendant read back as null, while the scene card keeps its boxes', () => {
  const s = surface();
  s.panel.display = 'none'; // #scene-column[data-collapsed="true"] #panel { display: none }
  expect(layoutBox(s.panel)).toBeNull();
  expect(layoutBox(s.lawRow)).toBeNull();
  expect(layoutBox(s.nested)).toBeNull();
  expect(layoutBox(s.fileOpen)).toEqual([80, 120, 60, 28]);
});

it('expanding the panel again gives every control its positive rectangle', () => {
  const s = surface();
  s.panel.display = 'none';
  s.panel.display = 'block';
  for (const node of [s.panel, s.lawRow, s.nested, s.fileOpen]) {
    const box = layoutBox(node);
    expect(box).not.toBeNull();
    expect(box[2]).toBeGreaterThan(0);
    expect(box[3]).toBeGreaterThan(0);
  }
});

it('a hidden attribute on an ancestor, and a missing element, still read back as null', () => {
  const s = surface();
  s.column.hidden = true;
  expect(layoutBox(s.fileOpen)).toBeNull();
  expect(layoutBox(null)).toBeNull();
});

// M8 review F7: the readback names the region that holds each control by DOM ancestry, so a harness
// scrolls the inspector's column even when an input's unclipped box crosses the dock. The production
// layoutOwner runs against the shipped index.html's ancestry.
const ownerStart = source.indexOf('const LAYOUT_REGIONS');
const ownerEnd = source.indexOf('\n}\n', source.indexOf('function layoutOwner(')) + 3;
runInContext(stripTypeScriptTypes(source.slice(ownerStart, ownerEnd).replace('const LAYOUT_REGIONS', 'var LAYOUT_REGIONS')), context);
const layoutOwner = (element) => runInContext('layoutOwner', context)(element);

function shippedElements() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const byId = new Map();
  for (const [, close, tag, attributes] of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/g)) {
    if (close) { stack.pop(); continue; }
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1] ?? null;
    const element = { id, parent: stack.at(-1) ?? null };
    element.closest = (selector) => {
      const ids = selector.split(',').map((s) => s.trim().slice(1));
      for (let e = element; e; e = e.parent) if (e.id && ids.includes(e.id)) return e;
      return null;
    };
    if (id) byId.set(id, element);
    if (!['meta', 'link', 'input', 'br', 'img'].includes(tag) && !attributes.trimEnd().endsWith('/')) stack.push(element);
  }
  return byId;
}

it('every control reports the region that actually holds it, by ancestry', () => {
  const e = shippedElements();
  const expected = {
    'law-label': 'context-column', 'law-fade': 'context-column', 'ingredients': 'context-column', 'details-toggle': 'context-column',
    'run-record': 'context-column', 'alternate-new': 'context-column', 'sim-error-reset': 'context-column',
    'play': 'dock', 'trails-all': 'dock', 'file-open': 'document', 'example-open': 'document', 'panel-toggle': 'document',
    'undo': 'top-rail', 'frame-view': 'top-rail', 'law-list': 'panel', 'law-shelf': 'panel', 'arrows-toggle': 'panel', 'ui-scale': 'panel',
    'panel': 'panel', 'context-column': 'context-column', 'dock': 'dock',
  };
  for (const [id, region] of Object.entries(expected)) expect(layoutOwner(e.get(id)), id).toBe(region);
  expect(layoutOwner(e.get('viewport'))).toBeNull();
  expect(layoutOwner(null)).toBeNull();
});
