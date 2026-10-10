import { afterEach, beforeAll, expect, it } from 'vitest';
import { Comparison } from '../src/simulation/comparison';
import { initSimulation, worldCounts } from '../src/simulation/host';
import { firstDivergence, observe } from '../src/simulation/replay';
import { driveScheduledFrame, FixedStepScheduler } from '../src/simulation/scheduler';
import { effectiveTriangleDocument, twoFuturesDocument } from '../src/simulation/comparisonFixtures';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { SimulationHost, SimulationFault } from '../src/simulation/host';
import { canResetScene } from '../src/simulation/contexts';
import { session } from './support/run';
import { ProbeField } from '../src/observation/probes';

beforeAll(initSimulation);
const owned: { dispose(): void }[] = [];
afterEach(() => { while (owned.length) owned.pop()!.dispose(); });
const keep = <T extends { dispose(): void }>(v: T): T => { owned.push(v); return v; };
function setup(tick = 0) {
  const s = session(twoFuturesDocument()); keep(s.live()); s.steps(tick);
  const c = keep(s.coordinator.enterComparison());
  const job = c.begin(); while (c.batch(job, Infinity, () => 0) === 'working') {}
  return { s, c };
}

it.each([2, 8])('F1: application frame budget %i stops at the retained endpoint and rejects further implicit steps', (budget) => {
  const { c } = setup();
  c.advance();
  c.controller.editField('sideways', 'Terminal one', (f) => ({ ...f, enabled: false }));
  c.controller.editField('sideways', 'Terminal two', (f) => ({ ...f, enabled: true }));
  const endpoint = observe(c.host), suffix = JSON.stringify(c.suffix), undo = c.controller.canUndo;
  c.replayAlternate();
  const scheduler = new FixedStepScheduler(1000 / 120); scheduler.play(); scheduler.frame(0, 0);
  const frame = scheduler.frame(budget * 1000 / 120, budget * 1000 / 120);
  expect(frame.steps).toBe(budget);
  const samples: number[] = [];
  const steps = driveScheduledFrame(scheduler, frame.steps, () => {
    const stepped = c.advance();
    if (stepped) samples.push(c.host.tick);
    if (!c.replaying) scheduler.pause();
    return stepped;
  });
  expect(steps).toBe(1); expect(samples).toEqual([1]); expect(scheduler.playing).toBe(false);
  expect(firstDivergence(endpoint, observe(c.host))).toBeNull();
  expect(c.host.tick).toBe(1); expect(c.host.lastAppliedSequence).toBe(2);
  expect(JSON.stringify(c.suffix)).toBe(suffix); expect(c.controller.canUndo).toBe(undo);
  expect(c.advance()).toBe(false);
  expect(firstDivergence(endpoint, observe(c.host))).toBeNull();
  expect(c.controller.editField('sideways', 'Later explicit edit', (f) => ({ ...f, enabled: false })).ok).toBe(true);
  c.resumeAlternate(); expect(c.advance()).toBe(true); expect(c.host.tick).toBe(2);
});

it.each([0, 73])('F1: paused-boundary replay at tick %i stays at its exact cursor with no observation', (tick) => {
  const { c } = setup(tick);
  c.controller.editField('sideways', 'Paused one', (f) => ({ ...f, enabled: false }));
  c.controller.editField('sideways', 'Paused two', (f) => ({ ...f, enabled: true }));
  const end = observe(c.host);
  c.replayAlternate(); expect(c.replaying).toBe(false);
  let samples = 0;
  expect(c.advance()).toBe(false);
  const scheduler = new FixedStepScheduler(1000 / 120);
  expect(driveScheduledFrame(scheduler, 8, () => { if (c.advance()) { samples++; return true; } return false; })).toBe(0);
  expect(samples).toBe(0); expect(firstDivergence(end, observe(c.host))).toBeNull();
  expect(c.controller.liveHost).toBe(c.host);
});

it.each([0, 7].flatMap((tick) => [false, true].map((gesture) => ({ tick, gesture }))))('F2: immediate replay after suffix refusal at $tick, gesture=$gesture', ({ tick, gesture }) => {
  const { c } = setup(); for (let i = 0; i < tick; i++) c.advance();
  const field = c.host.appliedFields()[0]!, tx = c.controller.newTransaction();
  let refused = false;
  for (let i = 0; i < 2500; i++) {
    if (gesture) {
      c.controller.putField({ ...field, enabled: i % 2 === 0 }, tx);
      c.controller.settle();
      if (c.host.halted) { refused = true; break; }
    } else if (!c.controller.editField('sideways', 'Toggle', (f) => ({ ...f, enabled: !f.enabled })).ok) { refused = true; break; }
  }
  expect(refused).toBe(true); expect(c.host.pendingCount).toBeGreaterThan(0);
  const end = observe(c.host), suffix = JSON.stringify(c.suffix), undo = c.controller.canUndo;
  const worlds = worldCounts().allocated, old = c.host;
  // No intervening Comparison.settle(): replay must resolve the refusal itself.
  expect(() => c.replayAlternate()).not.toThrow();
  expect(old.pendingCount).toBe(0); expect(c.controller.liveHost).toBe(c.host);
  while (c.replaying) c.advance();
  expect(firstDivergence(end, observe(c.host))).toBeNull(); expect(c.host.pendingCount).toBe(0);
  expect(c.host.halted).toBe(false); expect(JSON.stringify(c.suffix)).toBe(suffix);
  expect(c.controller.canUndo).toBe(undo); expect(worldCounts().allocated).toBe(worlds);
  // A further capacity refusal remains coherent, then New Alternate permits ordinary editing.
  c.controller.editField('sideways', 'Later', (f) => ({ ...f, enabled: !f.enabled }));
  expect(() => c.newAlternate()).not.toThrow();
  expect(c.controller.liveHost).toBe(c.host); expect(c.host.pendingCount).toBe(0);
  expect(c.suffixCount).toBe(0); expect(c.controller.canUndo).toBe(false);
  expect(c.controller.editField('sideways', 'After New', (f) => ({ ...f, enabled: !f.enabled })).ok).toBe(true);
  expect(worldCounts().allocated).toBe(worlds);
});

it('F2: failed replacement allocation retains the settled controller and valid suffix', () => {
  const { c } = setup(); c.controller.editField('sideways', 'Valid', (f) => ({ ...f, enabled: false }));
  const before = observe(c.host), host = c.host, suffix = JSON.stringify(c.suffix);
  // Restore failure injection is confined to the fixture; no physical checkpoint semantics change.
  const restore = (c as unknown as { restore: () => never }).restore;
  (c as unknown as { restore: () => never }).restore = () => { throw new Error('fixture restore failed'); };
  try { expect(() => c.replayAlternate()).toThrow('fixture restore failed'); }
  finally { (c as unknown as { restore: typeof restore }).restore = restore; }
  expect(c.host).toBe(host); expect(c.controller.liveHost).toBe(host); expect(c.replaying).toBe(false);
  expect(firstDivergence(before, observe(c.host))).toBeNull(); expect(JSON.stringify(c.suffix)).toBe(suffix);
});

it('F3: completed-step hook preserves original B probes before next-boundary laws; late observation fails', () => {
  const { c } = setup();
  const probes = () => { const p = new ProbeField(); p.configure({ enabled: true, count: 8, seed: 13 }); p.sync(c.host); return p; };
  const sample = (p: ProbeField) => ({ tick: p.tick, x: Array.from(p.position.slice(0, 24)), v: Array.from(p.velocity.slice(0, 24)), alive: Array.from(p.alive.slice(0, 8)) });
  const original = probes(), expected: ReturnType<typeof sample>[] = [];
  for (let tick = 1; tick <= 8; tick++) {
    c.advance(); original.advance(c.host); expected.push(sample(original));
    if (tick === 3) c.controller.editField('sideways', 'Law at n+1', (f) => ({ ...f, expression: { kind: 'directional', direction: [0, 1, 0], strength: 2 } }));
    if (tick === 4) c.controller.setAmbient([0.3, 0, 0]);
    if (tick === 5) c.controller.editField('sideways', 'Drag/gain', (f) => ({ ...f, expression: { kind: 'gain', gain: { kind: 'constant', value: 0.7 }, child: { kind: 'linearDrag', coefficient: 2 } } }));
    if (tick === 8) c.controller.editField('sideways', 'Terminal', (f) => ({ ...f, enabled: false }));
  }
  const end = observe(c.host);
  c.replayAlternate(); const replayed = probes(), actual: ReturnType<typeof sample>[] = [];
  while (c.replaying) c.advance((host) => { replayed.advance(host); actual.push(sample(replayed)); });
  expect(actual).toEqual(expected); expect(firstDivergence(end, observe(c.host))).toBeNull();
  // Accepted M6A late-observation negative control: move observation after boundary settlement.
  c.replayAlternate(); const late = probes(), wrong: ReturnType<typeof sample>[] = [];
  while (c.replaying) { if (c.advance()) { late.advance(c.host); wrong.push(sample(late)); } }
  expect(wrong).not.toEqual(expected); expect(wrong[2]).not.toEqual(expected[2]);
});

it.each([8180, 8181, 8192])('F4: alternate title derived from %i characters parses and reopens without changing the main scene', (length) => {
  const document = { ...twoFuturesDocument(), metadata: { title: 'x'.repeat(length) } };
  expect(parseScene(serializeScene(document)).ok).toBe(true);
  const s = session(document); keep(s.live());
  const c = keep(s.coordinator.enterComparison());
  const original = serializeScene(document), main = JSON.stringify(s.controller.snapshot(s.controller.camera));
  const revision = s.controller.revision;
  c.controller.editField('sideways', 'Edit B', (f) => ({ ...f, enabled: false }));
  const exported = c.alternateSetup(), parsed = parseScene(serializeScene(exported));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.document.metadata.title.length).toBeLessThanOrEqual(8192);
  const reopened = keep(new SimulationHost(parsed.document.semantic)); expect(reopened.tick).toBe(0);
  expect(reopened.appliedFields()).toEqual(c.host.appliedFields());
  expect(serializeScene(document)).toBe(original);
  expect(JSON.stringify(s.controller.snapshot(s.controller.camera))).toBe(main);
  expect(s.controller.revision).toBe(revision);
});

it('F5: a faulted comparison offers comparison recovery, preserves source and never offers Reset Scene', () => {
  const { s, c } = setup(); const main = observe(s.live()), document = s.controller.snapshot(s.controller.camera);
  c.advance(); const end = observe(c.host);
  c.host.fault = new SimulationFault(c.host.tick, 'fixture', 'controlled comparison fault');
  expect(canResetScene(s.coordinator.selected)).toBe(false); expect(c.canAdvance).toBe(false);
  c.replayAlternate(); while (c.replaying) c.advance();
  expect(c.host.fault).toBeNull(); expect(firstDivergence(end, observe(c.host))).toBeNull();
  c.host.fault = new SimulationFault(c.host.tick, 'fixture', 'controlled comparison fault');
  c.newAlternate(); expect(c.host.fault).toBeNull(); expect(c.host.tick).toBe(c.address.tick);
  expect(firstDivergence(main, observe(s.live()))).toBeNull();
  s.coordinator.closeComparison(); expect(canResetScene(s.coordinator.selected)).toBe(true);
  expect(s.controller.snapshot(s.controller.camera)).toEqual(document);
  expect(firstDivergence(main, observe(s.live()))).toBeNull();
  expect(canResetScene('replay')).toBe(false);
});

it('Q1: effective absolute triangle at 519 changes real velocity and A/B remain exact for 600 ticks', () => {
  const document = effectiveTriangleDocument(), s = session(document); keep(s.live()); s.steps(519);
  const c = keep(s.coordinator.enterComparison()), job = c.begin();
  const before = s.live().canonicalState().bodies.find((b) => b.id === 'traveler')!;
  expect(before.translation.every((v) => Math.abs(v) < 100)).toBe(true);
  const h = 1 / 120, expectedGain = 0.1 + 0.9 * (2 * ((519 + 13) % 240) / 240);
  expect(expectedGain).toBeCloseTo(0.49, 14);
  let firstDelta = 0;
  for (let i = 0; i < 600; i++) {
    s.step(); c.batch(job, Infinity, () => 0, 1);
    const a = c.observeBaselineWork(); if (a) expect(firstDivergence(observe(s.live()), a)).toBeNull();
    if (i === 0) {
      firstDelta = s.live().canonicalState().bodies.find((b) => b.id === 'traveler')!.linvel[1] - before.linvel[1];
      expect(firstDelta).toBeCloseTo(2 * expectedGain * h, 5);
      expect(Math.abs(firstDelta - 2 * 0.1975 * h)).toBeGreaterThan(0.004);
    }
    expect(c.host.limitedSteps).toBe(0);
  }
  const endpoint = keep(new SimulationHost(c.root.semantic, c.endpointCheckpoint()!));
  expect(firstDivergence(observe(s.live()), observe(endpoint))).toBeNull();
  const uninterrupted = keep(new SimulationHost(document.semantic));
  for (let i = 0; i < 519; i++) uninterrupted.step();
  for (let i = 0; i < 600; i++) {
    uninterrupted.step(); c.advance();
    expect(firstDivergence(observe(uninterrupted), observe(c.host))).toBeNull();
    expect(uninterrupted.canonicalState().bodies.find((b) => b.id === 'traveler')!.translation.every((v) => Math.abs(v) < 100)).toBe(true);
  }
  expect(firstDivergence(observe(s.live()), observe(c.host))).toBeNull();
  // Local-clock mutation: substitute the gain at local zero in an equal fork world.
  const wrong = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
  const law = wrong.appliedFields()[0]!;
  wrong.submit({ kind: 'putField', field: { ...law, expression: { kind: 'directional', direction: [0, 1, 0], strength: 2 * 0.1975 } } }, 1);
  wrong.step();
  const delta = wrong.canonicalState().bodies.find((b) => b.id === 'traveler')!.linvel[1] - before.linvel[1];
  expect(delta).toBeCloseTo(2 * 0.1975 * h, 5); expect(Math.abs(delta - firstDelta)).toBeGreaterThan(0.004);
});
