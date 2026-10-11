// M8 R15: the first native campaign attempt timed out waiting for a layout readback because plain ⇧L
// reached a still-focused examples pop-up menu, whose keys the app rightly leaves alone. This executes the
// production keydown listener (not a copy) with stand-in elements and spies: ⇧⌘L reads back once wherever
// focus is and while frozen, types nothing and selects nothing; ordinary keys and text editing keep their
// meanings. It does not qualify WKWebView key delivery; the native scenarios do.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf("  window.addEventListener('keydown', (event) => {");
const end = source.indexOf('\n  });', start) + 6;

class Element {}
class HTMLInputElement extends Element { constructor(type = 'text') { super(); this.type = type; this.blurred = 0; } blur() { this.blurred++; } }
class HTMLTextAreaElement extends Element { blur() {} }
class HTMLSelectElement extends Element {}
class HTMLButtonElement extends Element {}

let calls;
let context;
function listen() {
  calls = [];
  const spy = (name) => (...args) => { calls.push([name, ...args]); };
  let listener;
  context = createContext({
    HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement, HTMLElement: Element, hudHidden: false, setHudHidden: spy('setHudHidden'),
    window: { addEventListener: (type, fn) => { if (type === 'keydown') listener = fn; } },
    frozen: false, pendingSeek: null, explained: null, comparing: () => false, workflow: { busy: null }, scheduler: { playing: false },
    interaction: { gesture: null, cancel: () => false, select: spy('select') }, runParts: { timeline: {} },
    layoutReport: spy('layoutReport'), runFile: spy('runFile'), undo: spy('undo'), setInterfaceScale: spy('setInterfaceScale'),
    stepInterfaceScale: spy('stepInterfaceScale'), setMode: spy('setMode'), frameLaw: spy('frameLaw'), setPlaying: spy('setPlaying'),
    requestedPlaying: () => false, stepOnce: spy('stepOnce'), resetScene: spy('resetScene'), deleteSelected: spy('deleteSelected'),
    cancelPendingSeek: spy('cancelPendingSeek'), setExplained: spy('setExplained'), explainNearest: spy('explainNearest'),
    reportExplanation: spy('reportExplanation'), report: spy('report'), visualizationState: () => ({}), startP0: spy('startP0'),
    runFixtures: () => Promise.resolve(), runRunFixtures: () => Promise.resolve(), runSeekFixtures: () => Promise.resolve(),
    computeBaseline: spy('computeBaseline'), COMPARISON_LIMITS: { ticks: 7200 }, applyFreeze: spy('applyFreeze'),
    comparisonQualification: () => Promise.resolve(), identity: {}, renderPanel: spy('renderPanel'), guardFrozen: false, DEV: false,
  });
  // The packaged build compiles its dev-only branch out; import.meta cannot appear in a script context.
  runInContext(stripTypeScriptTypes(source.slice(start, end).replaceAll('import.meta.env.DEV', 'DEV')), context);
  return listener;
}

function press(listener, key, target, mods = {}) {
  const event = { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods, prevented: 0 };
  event.preventDefault = () => { event.prevented++; };
  listener(event);
  return event;
}
const named = (name) => calls.filter((c) => c[0] === name);

describe('the layout readback chord (⇧⌘L)', () => {
  let listener;
  beforeEach(() => { listener = listen(); });

  it.each([
    ['a text field', () => new HTMLInputElement('text')],
    ['a number field', () => new HTMLInputElement('number')],
    ['a text area', () => new HTMLTextAreaElement()],
    ['a pop-up menu (the first native attempt)', () => new HTMLSelectElement()],
    ['a button', () => new HTMLButtonElement()],
    ['the page', () => ({})],
  ])('reads back exactly once from %s, consuming the chord', (_, target) => {
    const event = press(listener, 'L', target(), { metaKey: true, shiftKey: true });
    expect(named('layoutReport')).toHaveLength(1);
    expect(event.prevented).toBe(1);
    expect(calls.length).toBe(1);                       // nothing else runs: no mode, file, undo or scale action
  });

  it('reads back while edits are frozen (a guard or launch recovery in progress)', () => {
    context.frozen = true;
    press(listener, 'l', new HTMLSelectElement(), { metaKey: true, shiftKey: true });
    expect(named('layoutReport')).toHaveLength(1);
  });

  it('⌘L without Shift does nothing and leaves the key to the system', () => {
    const event = press(listener, 'l', new HTMLInputElement(), { metaKey: true });
    expect(calls).toEqual([]);
    expect(event.prevented).toBe(0);
  });
});

describe('ordinary keys keep their meanings (unchanged behavior)', () => {
  let listener;
  beforeEach(() => { listener = listen(); });

  it('a focused text field keeps every unmodified key, including ⇧L: typed, never a readback or shortcut', () => {
    for (const [key, shiftKey] of [['L', true], ['t', false], ['r', false], [' ', false], ['.', false]]) {
      const event = press(listener, key, new HTMLInputElement(), { shiftKey });
      expect(event.prevented).toBe(0);
    }
    expect(calls).toEqual([]);
  });

  it('a focused pop-up menu keeps its keys: type-to-select and Space are not taken', () => {
    for (const key of ['L', 'S', ' ', 't']) expect(press(listener, key, new HTMLSelectElement()).prevented).toBe(0);
    expect(calls).toEqual([]);
  });

  it('⌘Z in a text field is the field’s own undo; outside it is author undo, once', () => {
    press(listener, 'z', new HTMLInputElement(), { metaKey: true });
    expect(named('undo')).toHaveLength(0);
    press(listener, 'z', {}, { metaKey: true });
    expect(named('undo')).toEqual([['undo', false]]);
  });

  it('viewport keys still act on the page, and plain ⇧L still reads back there', () => {
    press(listener, 't', {});
    press(listener, 'L', {}, { shiftKey: true });
    expect(named('setMode')).toEqual([['setMode', 'translate']]);
    expect(named('layoutReport')).toHaveLength(1);
  });

  it('Escape in a text field blurs it', () => {
    const field = new HTMLInputElement();
    press(listener, 'Escape', field);
    expect(field.blurred).toBe(1);
  });
});
