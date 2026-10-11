// R1: execute the production frame invalidation and panel renderer, not a copied predicate.
// The small DOM stand-in checks produced controls; it does not qualify WKWebView or native input.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three/webgpu';
import { expressionSummary, isCompound } from '../src/domain/ingredients';
import { defaultLawPresentation } from '../src/domain/scene';
import { primitiveDescriptor, regionDescriptor } from '../src/fields/registry';
import { initSimulation } from '../src/simulation/host';
import { twoFuturesDocument } from '../src/simulation/comparisonFixtures';
import { firstDivergence, observe } from '../src/simulation/replay';
import { driveScheduledFrame, FixedStepScheduler } from '../src/simulation/scheduler';
import { session } from './support/run';

beforeAll(initSimulation);
const owned = [];
afterEach(() => { while (owned.length) owned.pop().dispose(); });
const keep = (v) => { owned.push(v); return v; };
const source = process.env.LAWSMITH_PANEL_SOURCE
  ? execFileSync('git', ['show', `${process.env.LAWSMITH_PANEL_SOURCE}:src/main.ts`], { encoding: 'utf8' })
  : readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }', start) + 4;
  return source.slice(start, end);
}
function productionConst(name) {
  const line = source.split('\n').find((line) => line.startsWith(`  const ${name} =`));
  expect(line).toBeDefined();
  return line;
}

class Element {
  children = [];
  dataset = {};
  attributes = {};
  styles = {};
  style = { setProperty: (key, value) => { this.styles[key] = value; } };
  className = ''; value = ''; textContent = ''; hidden = false; disabled = false;
  constructor(tag) { this.tag = tag; }
  append(...children) { this.children.push(...children.filter((v) => typeof v !== 'string')); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelectorAll(selector) {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    return all.filter((child) => selector === '*' || (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector));
  }
}

function panel(s, selectedId = null) {
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const document = { createElement: (tag) => new Element(tag), activeElement: null };
  const interaction = { selectedId, gesture: false };
  const context = createContext({
    get host() { return s.coordinator.shown; }, runs: s.coordinator, authoring: s.controller,
    $, document, interaction, Euler, Quaternion, expressionSummary, isCompound, primitiveDescriptor, regionDescriptor, defaultLawPresentation,
    workflow: { dirty: false, busy: null, fileName: null, message: null, recovery: { status: { state: 'idle' } } },
    invoke: () => Promise.resolve(), renderRun: () => {}, renderComparison: () => {}, renderSampling: () => {},
    ingredientPanel: { render: () => {} },
    lawList: $('law-list'), details: $('details'), colorGroup: $('law-colors'), labelInput: $('law-label'), fadeInput: $('law-fade'),
    supportGroup: $('law-support'), regionParams: $('law-region-params'), primitiveParams: $('law-params'),
    triples: new Map(['position', 'rotation'].map((key) => [key, Array.from({ length: 3 }, () => new Element('input'))])),
    EYE: '', EYE_OFF: '', BUSY_TEXT: {}, DEGREES: 180 / Math.PI, renderCount: 0,
  });
  const shown = source.match(/  let (shownRevision|shownPanelSignature) = (.*);/).slice(1);
  const frameStart = source.indexOf('      // The panel follows applied changes');
  const frameEnd = source.indexOf('      frameBeforeMs =', frameStart);
  expect(frameStart).toBeGreaterThan(-1); expect(frameEnd).toBeGreaterThan(frameStart);
  const frame = source.slice(frameStart, frameEnd);
  const code = [
    ...['replaying', 'comparing', 'editor', 'readOnly', 'appliedLaw', 'selectedLaw', 'fmt'].map(productionConst),
    // This is the production presentation resolver, including the recorded-created-law fallback.
    source.slice(source.indexOf('  const lawPresentation ='), source.indexOf('\n  };', source.indexOf('  const lawPresentation =')) + 5),
    `let ${shown[0]} = ${shown[1]}; let listSignature = ''; let detailsSignature = ''; let reportedDirty = null;`,
    productionFunction('controlInputs'), productionFunction('renderPanel'),
    'const render = renderPanel; renderPanel = () => { renderCount++; render(); };',
    `function frame() { ${frame} }`,
    `function worldChanged() { listSignature = ''; detailsSignature = ''; ${shown[0]} = ${shown[1]}; }`,
  ].join('\n');
  runInContext(stripTypeScriptTypes(code), context);
  return {
    $, document, interaction,
    frame: () => runInContext('frame()', context),
    worldChanged: () => runInContext('worldChanged()', context),
    renders: () => context.renderCount,
    rows: () => $('law-list').children.map((row) => ({
      id: row.children[0].dataset.id, label: row.children[0].children[0].textContent,
      expression: row.children[0].children[1].textContent, selected: row.children[0].attributes['aria-pressed'],
      enabled: row.children[2].textContent, locked: row.children[2].disabled,
      visible: row.children[1].attributes['aria-pressed'], color: row.styles['--law-color'],
    })),
    input: (key) => $('law-params').querySelectorAll('input').find((input) => input.dataset.control === key),
  };
}

async function setup(recorded = false) {
  const s = session(twoFuturesDocument()); keep({ dispose: () => { s.coordinator.closeComparison(); s.coordinator.returnToAuthoring(); s.live().dispose(); } });
  if (recorded) {
    s.coordinator.startRecording(); s.steps(300);
    s.controller.editField('sideways', 'Source tail', (f) => ({ ...f, enabled: false }));
    s.steps(300); await s.coordinator.stopRecording(); s.coordinator.enterReplay();
  }
  const c = s.coordinator.enterComparison();
  const job = c.begin(); while (c.batch(job, Infinity, () => 0) === 'working') {}
  expect(c.horizon).toBe(600); expect(c.address.tick).toBe(0);
  return { s, c };
}
function advanceTo(c, tick) {
  while (c.host.tick < tick) expect(c.advance()).toBe(true);
}
function retain(s, c) {
  return { endpoint: observe(c.host), suffix: JSON.stringify(c.suffix), undo: c.controller.canUndo,
    baseline: c.baselineIdentity(), fork: JSON.stringify(c.forkCheckpoint()), source: observe(s.live()),
    document: s.controller.snapshot(s.controller.camera), record: JSON.stringify(s.coordinator.record) };
}
function complete(s, c, p, retained) {
  const scheduler = new FixedStepScheduler(1000 / 120); scheduler.play();
  while (c.replaying) {
    driveScheduledFrame(scheduler, 8, () => { const stepped = c.advance(); if (!c.replaying) scheduler.pause(); return stepped; }); p.frame();
  }
  expect(scheduler.playing).toBe(false);
  expect(firstDivergence(retained.endpoint, observe(c.host))).toBeNull();
  expect([c.host.tick, c.host.lastAppliedSequence]).toEqual([retained.endpoint.address.tick, retained.endpoint.address.cursor]);
  expect(c.advance()).toBe(false); expect(firstDivergence(retained.endpoint, observe(c.host))).toBeNull();
  expect(JSON.stringify(c.suffix)).toBe(retained.suffix); expect(c.controller.canUndo).toBe(retained.undo);
  expect(c.baselineIdentity()).toBe(retained.baseline); expect(JSON.stringify(c.forkCheckpoint())).toBe(retained.fork);
  expect(firstDivergence(retained.source, observe(s.live()))).toBeNull();
  expect(s.controller.snapshot(s.controller.camera)).toEqual(retained.document); expect(JSON.stringify(s.coordinator.record)).toBe(retained.record);
  expect(c.controller.liveHost).toBe(c.host);
}

it('R1 created law: frame integration shows Push at an intermediate replay address without incidental refresh', async () => {
  const { s, c } = await setup(true);
  advanceTo(c, 120); const created = c.controller.create('directional', [0, 0, 0]); expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.reason);
  c.settle(); advanceTo(c, 240);
  c.controller.editField(created.value.id, 'Later retained edit', (f) => ({ ...f, edgeFade: 0.2 }));
  advanceTo(c, 396); const retained = retain(s, c);
  expect(c.suffix.map((command) => command.atTick)).toEqual([120, 240]);
  const p = panel(s); p.frame(); expect(p.rows().map((row) => row.label)).toContain('Push');
  c.replayAlternate(); p.worldChanged(); p.frame(); expect(p.rows().map((row) => row.label)).not.toContain('Push');
  advanceTo(c, 121); p.frame(); // The normal frame decision is the only renderer trigger after consumption.
  expect(c.host.appliedFields().some((law) => law.id === created.value.id)).toBe(true);
  expect(c.replaying).toBe(true); expect(c.host.tick).toBeLessThan(396);
  expect(p.rows().map((row) => row.id)).toEqual(c.host.appliedFields().map((law) => law.id));
  expect(p.rows().find((row) => row.id === created.value.id)).toMatchObject({ label: 'Push', enabled: 'On', locked: true });
  const renders = p.renders(); p.frame(); expect(p.renders()).toBe(renders); // Paused, unchanged address.
  complete(s, c, p, retained);
  expect(p.rows().every((row) => !row.locked)).toBe(true);
  c.newAlternate(); p.worldChanged(); p.frame(); expect(p.rows().map((row) => row.label)).not.toContain('Push');
  expect(c.suffixCount).toBe(0); expect(c.controller.canUndo).toBe(false);
  s.coordinator.closeComparison(); p.worldChanged(); p.frame(); expect(p.rows().every((row) => row.locked)).toBe(true);
  s.coordinator.returnToAuthoring(); p.worldChanged(); p.frame(); expect(p.rows().every((row) => !row.locked)).toBe(true);
});

it('R1 selected details: disabled, strength, expression and fade controls follow multiple paused intermediate boundaries', async () => {
  const { s, c } = await setup();
  c.controller.setLawPresentation('sideways', { label: 'Custom current law', color: '#55aaa4', visible: false });
  advanceTo(c, 120); c.controller.editField('sideways', 'Disable', (f) => ({ ...f, enabled: false }));
  advanceTo(c, 200); c.controller.editField('sideways', 'Strength', (f) => ({ ...f, expression: { kind: 'directional', direction: [0, 1, 0], strength: 3 } }));
  advanceTo(c, 260); c.controller.editField('sideways', 'Expression', (f) => ({ ...f, expression: { kind: 'linearDrag', coefficient: 2 } }));
  advanceTo(c, 320); c.controller.editField('sideways', 'Fade', (f) => ({ ...f, edgeFade: 0.4 }));
  advanceTo(c, 396); const retained = retain(s, c), p = panel(s, 'sideways'); p.frame();
  c.replayAlternate(); p.worldChanged(); p.frame();
  for (const [tick, enabled, key, value, fade] of [[121, false, 'strength', '0', '0'], [201, false, 'strength', '3', '0'], [261, false, 'coefficient', '2', '0'], [321, false, 'coefficient', '2', '0.4']]) {
    advanceTo(c, tick); p.frame();
    const scheduler = new FixedStepScheduler(1000 / 120); scheduler.pause(); p.frame();
    const law = c.host.appliedFields().find((law) => law.id === 'sideways');
    expect(c.replaying).toBe(true); expect(c.host.tick).toBeLessThan(396); expect(p.interaction.selectedId).toBe('sideways');
    expect(law.enabled).toBe(enabled);
    expect.soft(p.rows()).toEqual([{ id: law.id, label: 'Custom current law', expression: expressionSummary(law.expression), selected: 'true', enabled: 'Off', locked: true, visible: 'false', color: '#55aaa4' }]);
    expect(p.$('details').hidden).toBe(false); expect(p.$('details-title').textContent).toBe('Custom current law');
    expect.soft(p.input(key)?.value).toBe(value); expect.soft(p.$('law-fade').value).toBe(fade);
    expect.soft(p.$('law-kind').textContent).toContain(primitiveDescriptor(law.expression.kind).summary(law.expression));
  }
  complete(s, c, p, retained);
  expect(c.controller.undo().ok).toBe(true); p.frame(); expect(p.$('law-fade').value).toBe('0');
  expect(c.controller.redo().ok).toBe(true); p.frame(); expect(p.$('law-fade').value).toBe('0.4');
});

it('ordinary recording replay refreshes created laws and preserves the retained authoring document', async () => {
  const s = session(twoFuturesDocument()); keep({ dispose: () => { s.coordinator.returnToAuthoring(); s.live().dispose(); } }); s.coordinator.startRecording();
  s.steps(120); const created = s.controller.create('directional', [0, 0, 0]); expect(created.ok).toBe(true);
  s.steps(276); await s.coordinator.stopRecording(); const original = observe(s.live());
  const p = panel(s); p.frame(); s.coordinator.enterReplay(); p.worldChanged(); p.frame();
  s.coordinator.advanceReplay(121, Infinity, () => 0); p.frame();
  expect(p.rows().find((row) => row.label === 'Push')).toMatchObject({ enabled: 'On', locked: true });
  expect(firstDivergence(original, observe(s.live()))).toBeNull();
  s.coordinator.returnToAuthoring(); p.worldChanged(); p.frame(); expect(p.rows().every((row) => !row.locked)).toBe(true);
});

it('frame invalidation includes world generation and replay mode, defers gestures and preserves focused input', async () => {
  const { s, c } = await setup(); const p = panel(s, 'sideways'); p.frame();
  const initial = p.renders(); p.frame(); expect(p.renders()).toBe(initial);
  c.newAlternate(); p.frame(); expect(p.renders()).toBe(initial + 1); // Same numeric cursor/revision, new world.
  const input = p.input('strength'); input.value = 'typing'; p.document.activeElement = input;
  p.interaction.gesture = true;
  c.controller.editField('sideways', 'Strength', (f) => ({ ...f, expression: { kind: 'directional', direction: [0, 1, 0], strength: 4 } }));
  p.frame(); expect(p.renders()).toBe(initial + 1);
  p.interaction.gesture = false; p.frame(); expect(p.renders()).toBe(initial + 2); expect(input.value).toBe('typing');
  p.document.activeElement = null;
  advanceTo(c, 2); c.replayAlternate(); p.worldChanged(); p.frame();
  const before = p.renders(); advanceTo(c, 2); p.frame(); expect(p.renders()).toBe(before + 1);
  expect(p.rows().every((row) => !row.locked)).toBe(true); expect(p.input('strength').value).toBe('4');
});
