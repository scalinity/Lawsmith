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
