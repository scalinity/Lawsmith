// M8 owner feedback: the immersive view hides the whole HUD with plain H and brings it back with H or
// Escape. Executes the production setHudHidden, the keydown listener, the HUD-alert restore and
// applyFreeze from src/main.ts with stand-in elements, and reads the hiding rules from src/style.css and
// index.html. It does not qualify WKWebView key delivery, focus or rendering; the native checks do.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start) + to.length;
  if (start < 0 || end < to.length) throw new Error(`missing ${from}`);
  return source.slice(start, end);
};
const hud = slice('  let hudFocus: HTMLElement | null = null;', "  $('hud-hide').addEventListener('click', () => setHudHidden(true, 'button'));\n");
const keydown = slice("  window.addEventListener('keydown', (event) => {", '\n  });\n');
const alert = slice('    const hudAlert =', '    hudAlertSeen = hudAlert;\n');
const freeze = slice('  const applyFreeze = () => {', '\n  };\n');

class Element {
  constructor(id = '', parent = null) { Object.assign(this, { id, parent, disabled: false, isContentEditable: false, focused: 0, blurred: 0, listeners: {} }); }
  get isConnected() { return true; }
  closest() { return null; }
  contains(n) { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  focus() { this.focused++; doc.activeElement = this; }
  blur() { this.blurred++; doc.activeElement = doc.body; }
}
class HTMLElement extends Element {}
class HTMLInputElement extends HTMLElement { constructor(id, parent, type = 'text') { super(id, parent); this.type = type; } }
class HTMLTextAreaElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}
class HTMLButtonElement extends HTMLElement {}

let doc;
let calls;
let context;
let listener;
let shell;
function setup() {
  calls = [];
  const spy = (name) => (...args) => { calls.push([name, ...args]); };
  shell = new HTMLElement('shell');
  const elements = new Map([['shell', shell], ['hud-hide', new HTMLButtonElement('hud-hide', shell)]]);
  doc = { body: new HTMLElement('body'), activeElement: null, documentElement: { dataset: {} } };
  doc.activeElement = doc.body;
  context = createContext({
    HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement, document: doc,
    $: (id) => elements.get(id), hudHidden: false, frozen: false, report: spy('report'), applyFreeze: spy('applyFreeze'),
    window: { addEventListener: (type, fn) => { if (type === 'keydown') listener = fn; } },
    pendingSeek: null, explained: null, comparing: () => false, workflow: { busy: null, message: null }, scheduler: { playing: false },
    interaction: { gesture: null, cancel: () => false, select: spy('select') }, runParts: { timeline: {} },
    layoutReport: spy('layoutReport'), runFile: spy('runFile'), undo: spy('undo'), setInterfaceScale: spy('setInterfaceScale'),
    stepInterfaceScale: spy('stepInterfaceScale'), setMode: spy('setMode'), frameLaw: spy('frameLaw'), setPlaying: spy('setPlaying'),
    requestedPlaying: () => false, stepOnce: spy('stepOnce'), resetScene: spy('resetScene'), deleteSelected: spy('deleteSelected'),
    cancelPendingSeek: spy('cancelPendingSeek'), setExplained: spy('setExplained'), explainNearest: spy('explainNearest'),
    reportExplanation: spy('reportExplanation'), visualizationState: () => ({}), startP0: spy('startP0'),
    runFixtures: () => Promise.resolve(), runRunFixtures: () => Promise.resolve(), runSeekFixtures: () => Promise.resolve(),
    computeBaseline: spy('computeBaseline'), COMPARISON_LIMITS: { ticks: 7200 }, comparisonQualification: () => Promise.resolve(),
    identity: {}, renderPanel: spy('renderPanel'), guardFrozen: false, DEV: false,
  });
  runInContext(stripTypeScriptTypes(`${hud}\n${keydown.replaceAll('import.meta.env.DEV', 'DEV')}\nglobalThis.setHudHidden = setHudHidden;
globalThis.alertCheck = () => { ${alert} };`), context);
  return elements;
}
function press(key, target = doc.body, mods = {}) {
  const event = { key, target, keyCode: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...mods, prevented: 0 };
  event.preventDefault = () => { event.prevented++; };
  listener(event);
  return event;
}
const others = () => calls.filter((c) => !['report', 'applyFreeze'].includes(c[0]));
const hidden = () => context.hudHidden;

describe('the immersive view toggle', () => {
  beforeEach(() => { setup(); });

  it('plain H hides the HUD once; H or Escape brings it back, each doing nothing else', () => {
    press('h');
    expect(hidden()).toBe(true);
    expect(doc.documentElement.dataset.hud).toBe('hidden');
    expect(others()).toEqual([]);
    expect(press('h').prevented).toBe(1);
    expect(hidden()).toBe(false);
    press('h');
    press('Escape');
    expect(hidden()).toBe(false);
    expect(others()).toEqual([]); // Escape restored only: no seek cancel, no deselect
    expect(calls.filter((c) => c[0] === 'report').map((c) => c[2].hud)).toEqual(['hidden', 'shown', 'hidden', 'shown']);
  });

  it('Caps Lock H also toggles; ⇧H, ⌘H, ⌃H and ⌥H never do', () => {
    press('H');
    expect(hidden()).toBe(true);
    press('H');
    for (const mods of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) press(mods.shiftKey ? 'H' : 'h', doc.body, mods);
    expect(hidden()).toBe(false);
  });

  it.each([
    ['a text field', () => new HTMLInputElement('f', shell, 'text')],
    ['a number field', () => new HTMLInputElement('f', shell, 'number')],
    ['a text area', () => new HTMLTextAreaElement('f', shell)],
    ['an editable element', () => Object.assign(new HTMLElement('f', shell), { isContentEditable: true })],
    ['a pop-up menu', () => new HTMLSelectElement('f', shell)],
  ])('typing h in %s types it and never hides', (_, target) => {
    const event = press('h', target());
    expect(hidden()).toBe(false);
    expect(event.prevented).toBe(0);
  });

  it('ignores composition and held keys', () => {
    press('h', doc.body, { isComposing: true });
    press('h', doc.body, { keyCode: 229 });
    press('h', doc.body, { repeat: true });
    expect(hidden()).toBe(false);
    press('h');
    press('h', doc.body, { repeat: true });
    expect(hidden()).toBe(true); // a held H neither restores nor flickers
  });

  it('does not hide while edits are frozen (launch recovery or the save question)', () => {
    context.frozen = true;
    press('h');
    context.setHudHidden(true, 'button');
    expect(hidden()).toBe(false);
  });

  it('while hidden, Space and Step still work; other keys do nothing', () => {
    press('h');
    for (const key of ['t', 'r', 's', 'f', 'R', 'Backspace', 'Delete', 'b', 'L']) press(key);
    expect(others()).toEqual([]);
    press(' ');
    press('.');
    expect(others().map((c) => c[0])).toEqual(['setPlaying', 'stepOnce']);
    expect(hidden()).toBe(true);
  });

  it('⌘O, ⌘S and ⌘Z bring the HUD back before acting; Interface Scale does not', () => {
    for (const [key, action] of [['o', 'runFile'], ['s', 'runFile'], ['z', 'undo']]) {
      press('h');
      press(key, doc.body, { metaKey: true });
      expect(hidden()).toBe(false);
      expect(others().at(-1)[0]).toBe(action);
    }
    press('h');
    press('=', doc.body, { metaKey: true });
    expect(hidden()).toBe(true);
  });

  it('the button hides; focus leaves the hidden HUD and returns to where it was', () => {
    const elements = setup();
    const button = elements.get('hud-hide');
    button.focus();
    button.listeners.click();
    expect(hidden()).toBe(true);
    expect(button.blurred).toBe(1);
    expect(doc.activeElement).toBe(doc.body);
    press('Escape');
    expect(doc.activeElement).toBe(button);
  });

  it('focus outside the HUD (the canvas) is left alone, and a control disabled meanwhile is not refocused', () => {
    const canvas = new HTMLElement('canvas');
    canvas.focus();
    press('h');
    expect(canvas.blurred).toBe(0);
    press('h');
    const field = new HTMLInputElement('emitter-rate', shell, 'number');
    field.focus();
    context.setHudHidden(true, 'test');
    field.disabled = true;
    const before = field.focused;
    press('h');
    expect(field.focused).toBe(before);
  });

  it('a file action starting or a new error brings the HUD back once; hiding again holds', () => {
    press('h');
    context.workflow.message = { kind: 'error', text: 'Not saved' };
    context.alertCheck();
    expect(hidden()).toBe(false);
    press('h');
    context.alertCheck(); // the same message, refreshed
    expect(hidden()).toBe(true);
    context.workflow.message = { kind: 'info', text: 'Saved' };
    context.alertCheck();
    expect(hidden()).toBe(true);
    context.workflow.busy = 'open';
    context.alertCheck();
    expect(hidden()).toBe(false);
  });
});

describe('what the immersive view hides', () => {
  const rule = css.slice(css.indexOf(':root[data-hud="hidden"]'));
  const selectors = rule.slice(0, rule.indexOf('{')).split(',').map((s) => s.trim());

  it('every HUD surface: the shell but its top rail, the tools, the floating labels and the status line', () => {
    expect(selectors).toEqual([
      ':root[data-hud="hidden"] #shell > :not(#top-rail)',
      ':root[data-hud="hidden"] #tools',
      ':root[data-hud="hidden"] #law-labels',
      ':root[data-hud="hidden"] #explain-labels',
      ':root[data-hud="hidden"] #status',
    ]);
    expect(rule.slice(rule.indexOf('{'), rule.indexOf('}'))).toContain('visibility: hidden');
    // Nothing inside the HUD can make itself visible again.
    expect(css).not.toMatch(/visibility:\s*visible/);
  });

  it('keeps the window drag strip, the canvas, the recovery offer and the startup failure', () => {
    const rail = html.slice(html.indexOf('<div id="top-rail">'), html.indexOf('<div id="tools"'));
    expect(rail).toContain('id="drag-region"');
    for (const id of ['viewport', 'recovery-offer', 'failure']) {
      expect(html).toContain(`id="${id}"`);
      expect(html.indexOf(`id="${id}"`) < html.indexOf('<div id="shell">') || html.indexOf(`id="${id}"`) > html.lastIndexOf('<pre id="diagnostics"')).toBe(true);
    }
  });

  it('offers a visible Hide HUD button with its key', () => {
    expect(html).toMatch(/<button type="button" id="hud-hide"[^>]*>Hide HUD <kbd>H<\/kbd><\/button>/);
  });
});

describe('the authoring controls in the scene while hidden', () => {
  it('the gizmo is disabled and not drawn; the rest of applyFreeze is unchanged', () => {
    const elements = new Map();
    const $ = (id) => { if (!elements.has(id)) elements.set(id, { inert: false, disabled: false, title: '' }); return elements.get(id); };
    const gizmo = { enabled: true, helper: { visible: true }, getHelper() { return this.helper; } };
    const ctx = createContext({ $, document: { body: { dataset: {} }, querySelectorAll: () => [] }, guardFrozen: false, launchPending: false, frozen: false, hudHidden: true, readOnly: () => false, comparing: () => false, replaying: () => false, viewport: { gizmo } });
    runInContext(stripTypeScriptTypes(`${freeze}\napplyFreeze();`), ctx);
    expect([gizmo.enabled, gizmo.helper.visible]).toEqual([false, false]);
    ctx.hudHidden = false;
    runInContext('applyFreeze()', ctx);
    expect([gizmo.enabled, gizmo.helper.visible]).toEqual([true, true]);
  });

  it('handles are neither drawn nor grabbed, and a click neither explains nor selects', () => {
    expect(source).toContain('editable: () => !frozen && !readOnly() && !hudHidden,');
    expect(source).toContain('if (readOnly() || hudHidden) return null;');
    expect(slice('      clickBody: (x, y) => {', '        const id = bodyAt(x, y);')).toContain('if (hudHidden) return true;');
  });
});
