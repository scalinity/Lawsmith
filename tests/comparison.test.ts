// T10/T11 M7. The reference advances the original world or accepted checkpoint-free LinearReplay;
// it does not use Comparison's restore/trace/advance helpers to establish expected state.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cloneFrozen, type FieldDefinition, type SceneDocument } from '../src/domain/scene';
import { COMPARISON_LIMITS, Comparison, preflightComparison } from '../src/simulation/comparison';
import { SimulationHost, initSimulation, resetPeakWorlds, worldCounts } from '../src/simulation/host';
import { LinearReplay, firstDivergence, observe } from '../src/simulation/replay';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { fnv64 } from '../src/simulation/checkpoints';
import { interventionRecord, laboratory, session } from './support/run';
import twoFutures from '../examples/two-futures.lawsmith.json?raw';
import { pairedBody } from '../src/observation/comparison';
import { createComparisonView } from '../src/rendering/comparisonView';
import { Scene, Quaternion, Vector3, type LineSegments } from 'three/webgpu';
import { comparisonQualification, p3Document } from '../src/simulation/comparisonFixtures';
import { TEST_IDENTITY } from './support/run';

beforeAll(initSimulation);
const owned: { dispose(): void }[] = [];
afterEach(() => { while (owned.length) owned.pop()!.dispose(); });
const keep = <T extends { dispose(): void }>(value: T): T => { owned.push(value); return value; };
function example(): SceneDocument { const result = parseScene(twoFutures); if (!result.ok) throw result.error; return result.document; }
function setup(document = example(), tick = 0) {
  const s = session(document);
  keep(s.live());
  s.steps(tick);
  const c = keep(s.coordinator.enterComparison());
  return { s, c };
}
function compute(c: Comparison, ticks = 600) { const job = c.begin(ticks); while (c.batch(job, Infinity, () => 0, 240) === 'working') {} return c.metrics!; }
const shape = (host: SimulationHost) => { const a = new Float32Array(host.count * 7); host.writePoses(a, 0); return { ids: [...host.ids], poses: a }; };
function assertFrame(c: Comparison, host: SimulationHost) {
  const frame = c.frame(host.tick)!;
  const actual = shape(host);
  expect(frame.ids).toEqual(actual.ids);
  expect(Array.from(frame.poses)).toEqual(Array.from(actual.poses));
}
const edit = (field: FieldDefinition, strength: number): FieldDefinition => ({ ...field, expression: { kind: 'directional', direction: [0, 1, 0], strength } });

describe('T10 shared fork and actual continuation', () => {
  it('A: equal complete authority at a nonzero fork, including engine bytes and cursor', () => {
    const { s, c } = setup(laboratory(), 311);
    expect(firstDivergence(observe(s.live()), observe(c.host))).toBeNull();
    expect(c.forkCheckpoint().phase).toBe('settled-before-lifecycle');
    expect(c.host.pendingCount).toBe(0);
  });

  it.each([0, 1, 512, 513])('F/G/H: fork at tick %i preserves the before/after birth/death boundary', (tick) => {
    const { s, c } = setup(laboratory(), tick);
    compute(c);
    for (let i = 0; i < 600; i++) { s.step(); c.advance(); expect(firstDivergence(observe(s.live()), observe(c.host))).toBeNull(); assertFrame(c, s.live()); }
  });

  it('admission refuses active recording, pending seek and unsettled commands before allocation', async () => {
    const s = session(); keep(s.live());
    const steady = worldCounts().allocated;
    s.coordinator.startRecording();
    expect(() => s.coordinator.enterComparison()).toThrow(/Stop/);
    s.step();
    await s.coordinator.stopRecording();
    const field = s.controller.scene.fields[0]!;
    s.controller.putField(field);
    expect(() => s.coordinator.enterComparison()).toThrow(/queued/);
    expect(worldCounts().allocated).toBe(steady);
    s.controller.settle();
    s.coordinator.enterReplay(); s.coordinator.seek({ tick: 1, cursor: 0 });
    expect(() => s.coordinator.enterComparison()).toThrow(/seeking/);
    s.coordinator.cancelSeek(); s.coordinator.returnToAuthoring();
  });

  it('bounded B undo retains recent actions and a suffix refusal never erases earlier consumed values', () => {
    const { c } = setup(); compute(c);
    for (let i = 0; i < 100; i++) c.controller.editField('sideways', 'Toggle', (f) => ({ ...f, enabled: !f.enabled }));
    expect(c.suffixCount).toBe(100); expect(c.controller.historyBytes).toBeLessThanOrEqual(COMPARISON_LIMITS.historyBytes);
    let undos = 0; while (c.controller.canUndo) { expect(c.controller.undo().ok).toBe(true); undos++; }
    expect(undos).toBe(COMPARISON_LIMITS.historyEntries); expect(c.suffixCount).toBe(164);
    const before = c.host.lastAppliedSequence;
    let refusal = false;
    for (let i = 0; i < 2500; i++) {
      const result = c.controller.editField('sideways', 'Toggle', (f) => ({ ...f, enabled: !f.enabled }));
      if (!result.ok) { refusal = true; break; }
    }
    expect(refusal).toBe(true); expect(c.suffixCount).toBe(c.host.lastAppliedSequence); expect(c.host.lastAppliedSequence).toBeGreaterThan(before);
    const suffix = JSON.stringify(c.suffix); c.settle(); expect(c.host.pendingCount).toBe(0); expect(c.host.halted).toBe(false);
    c.advance(); expect(JSON.stringify(c.suffix)).toBe(suffix); expect(c.message).toMatch(/history is full/);
  });

  it('B, G, H: no-op remains exactly equal for 600 ticks through emissions, deaths and contacts', () => {
    const { s, c } = setup(laboratory(), 311);
    const job = c.begin();
    for (let i = 0; i < 600; i++) {
      s.step();
      const result = c.batch(job, Infinity, () => 0, 1);
      const actualA = c.observeBaselineWork();
      if (actualA) expect(firstDivergence(observe(s.live()), actualA)).toBeNull();
      else expect(result).toBe('committed');
    }
    const endpoint = keep(new SimulationHost(c.root.semantic, c.endpointCheckpoint()!));
    expect(firstDivergence(observe(s.live()), observe(endpoint))).toBeNull();
    const reference = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
    assertFrame(c, reference);
    for (let i = 0; i < 600; i++) {
      reference.step();
      expect(c.advance()).toBe(true);
      expect(firstDivergence(observe(reference), observe(c.host))).toBeNull();
      assertFrame(c, reference);
    }
    expect(c.advance()).toBe(false);
    expect(c.host.tick).toBe(911);
  }, 60_000);

  it('C: independent analytic directional oracle exceeds 0.5 m at one second with no limiting', () => {
    const { c } = setup(); compute(c);
    expect(c.controller.editField('sideways', 'Push up', (f) => edit(f, 2)).ok).toBe(true);
    for (let i = 0; i < 120; i++) c.advance();
    const b = c.host.canonicalState().bodies[0]!;
    const baseline = c.frame(120)!;
    const h = c.host.settings.stepNumerator / c.host.settings.stepDenominator;
    expect(b.linvel[1]).toBeCloseTo(2, 4);
    expect(Math.abs(b.translation[1]! - 1)).toBeLessThan(2 * h + 1e-4);
    expect(b.translation[1]! - baseline.poses[1]!).toBeGreaterThanOrEqual(0.5);
    expect(c.host.limitedSteps).toBe(0);
  });

  it('D/E: fork inside a recording omits its tail, including later edits at the same tick', async () => {
    const { record, session: s } = await interventionRecord();
    keep(s.live());
    const r = s.coordinator.enterReplay();
    const target = record.commands.find((command, i) => record.commands[i + 1]?.atTick === command.atTick)!;
    s.coordinator.seek({ tick: target.atTick, cursor: target.sequence });
    while (s.coordinator.seekWork(Infinity, () => 0).kind === 'working') {}
    const source = observe(s.coordinator.shown);
    const sourceText = JSON.stringify(record);
    const mainText = JSON.stringify(s.controller.snapshot(s.controller.camera));
    const c = keep(s.coordinator.enterComparison());
    const oracle = keep(new LinearReplay(record));
    while (oracle.host.tick < target.atTick) { oracle.settle(); oracle.step(); }
    oracle.settle(target.sequence - oracle.host.lastAppliedSequence);
    expect(firstDivergence(observe(oracle.host), observe(c.host))).toBeNull();
    compute(c);
    for (let i = 0; i < 600; i++) { oracle.host.step(); c.advance(); expect(firstDivergence(observe(oracle.host), observe(c.host))).toBeNull(); }
    expect(JSON.stringify(record)).toBe(sourceText);
    expect(JSON.stringify(s.controller.snapshot(s.controller.camera))).toBe(mainText);
    expect(firstDivergence(source, observe(s.coordinator.replay!.host))).toBeNull();
    // Negative control: consuming the recorded tail is observably a different future.
    const uncontaminated = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
    const contaminated = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
    for (const command of record.commands.filter((v) => v.atTick === target.atTick && v.sequence > target.sequence)) contaminated.applyRecorded(command);
    expect(contaminated.tick).toBe(uncontaminated.tick);
    expect(contaminated.lastAppliedSequence).toBeGreaterThan(uncontaminated.lastAppliedSequence);
    expect(contaminated.appliedFields()).not.toEqual(uncontaminated.appliedFields());
    expect(firstDivergence(observe(uncontaminated), observe(contaminated))?.component).toBe('cursor');
    for (let i = 0; i < 600; i++) { uncontaminated.step(); contaminated.step(); }
    expect(contaminated.tick).toBe(uncontaminated.tick);
    expect(contaminated.canonicalState().bodies).not.toEqual(uncontaminated.canonicalState().bodies);
    // Without the injection, equal clocks and all future state remain equal; clock mismatch is no oracle.
    const withoutInjection = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
    for (let i = 0; i < 600; i++) withoutInjection.step();
    expect(firstDivergence(observe(uncontaminated), observe(withoutInjection))).toBeNull();
    s.coordinator.closeComparison(); s.coordinator.returnToAuthoring();
    expect(r.host.pendingCount).toBe(0);
  }, 60_000);

  it('I/J: consumed drag values and later undo remain in the suffix; replay reproduces them and New clears them', () => {
    const { c } = setup(); compute(c);
    const field = c.host.appliedFields()[0]!;
    const tx = c.controller.newTransaction();
    for (const strength of [1, 2, 3]) { c.controller.putField(edit(field, strength), tx); c.controller.settle(); c.advance(); }
    c.controller.endGesture('Push', field, tx);
    c.controller.undo();
    expect(c.suffixCount).toBe(4);
    expect(c.suffix.slice(0, 3).map((v) => [v.atTick, v.sequence, v.transactionId])).toEqual([[0, 1, tx], [1, 2, tx], [2, 3, tx]]);
    expect(c.suffix[3]!.atTick).toBe(3);
    for (let n = 0; n < 240; n++) c.advance();
    const end = observe(c.host);
    const baseline = fnv64(new Uint8Array(c.frame(243)!.poses.buffer));
    const suffix = JSON.stringify(c.suffix);
    c.replayAlternate();
    expect(c.replaying).toBe(true);
    while (c.replaying) c.advance();
    expect(firstDivergence(end, observe(c.host))).toBeNull();
    expect(JSON.stringify(c.suffix)).toBe(suffix);
    expect(c.controller.canRedo).toBe(true);
    c.newAlternate();
    expect(c.suffixCount).toBe(0); expect(c.controller.canUndo).toBe(false); expect(c.controller.canRedo).toBe(false);
    expect(c.host.tick).toBe(0); expect(c.host.lastAppliedSequence).toBe(0);
    expect(fnv64(new Uint8Array(c.frame(243)!.poses.buffer))).toBe(baseline);
  });

  it('K: mutating consumer checkpoint/trace buffers and edits cannot mutate the fork or committed baseline', () => {
    const { s, c } = setup(); compute(c);
    const before = observe(s.live());
    const fork = c.forkCheckpoint(); const bytes = fork.engineBytes.slice(); fork.engineBytes.fill(0);
    expect(c.forkCheckpoint().engineBytes).toEqual(bytes);
    const frame = c.frame(600)!; const positions = frame.poses.slice(); frame.poses.fill(999);
    c.visit(600, (_id, _r, p) => p.fill(-999));
    expect(c.frame(600)!.poses).toEqual(positions);
    c.controller.editField('sideways', 'Change', (f) => edit(f, 2)); c.newAlternate();
    expect(firstDivergence(before, observe(c.host))).toBeNull();
    expect(c.frame(600)!.poses).toEqual(positions);
    expect(Object.isFrozen(c.suffix)).toBe(true);
  });

  it('L: stable-ID pairing handles index changes and explicitly absent counterparts', () => {
    const a = { tick: 8, ids: ['dead', 'kept'], poses: new Float32Array([9, 9, 9, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 1]) };
    const b = { tick: 8, ids: ['kept', 'born'], positions: new Float32Array([2, 3, 4, 5, 6, 7]) };
    expect(pairedBody('kept', a, b).separation).toBe(0);
    expect(pairedBody('dead', a, b)).toMatchObject({ alternate: null, separation: null });
    expect(pairedBody('born', a, b)).toMatchObject({ baseline: null, alternate: [5, 6, 7], separation: null });
    expect(() => pairedBody('kept', { ...a, tick: 9 }, b)).toThrow(/equal ticks/);
    // Negative control: matching index zero would pair different identities and report false divergence.
    expect(Math.hypot(a.poses[0]! - b.positions[0]!, a.poses[1]! - b.positions[1]!)).toBeGreaterThan(0);
  });

  it('M: constructing, drawing, hiding and disposing A outlines cannot enter B physics', () => {
    const { c } = setup(); compute(c);
    const before = observe(c.host);
    const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
    Object.assign(globalThis, { document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '#55aaa4' }) });
    try {
      const scene = new Scene(); const view = createComparisonView(scene, 256);
      view.update(c, true);
      const geometry = (scene.children[0] as LineSegments).geometry;
      const position = geometry.getAttribute('position');
      expect(position.getX(0)).toBeCloseTo(0.18 * 1.08, 6);
      expect(firstDivergence(before, observe(c.host))).toBeNull();
      for (let n = 0; n < 120; n++) c.advance();
      view.update(c, true);
      const pose = c.frame(120)!.poses;
      const point = new Vector3(0.18 * 1.08, 0, 0).applyQuaternion(new Quaternion(pose[3]!, pose[4]!, pose[5]!, pose[6]!));
      expect(position.getX(0)).toBeCloseTo(pose[0]! + point.x, 6);
      const moved = observe(c.host);
      view.update(c, false);
      expect(view.counts()).toMatchObject({ geometries: 1, materials: 1, objects: 1 });
      expect(firstDivergence(moved, observe(c.host))).toBeNull();
      expect(c.host.count).toBe(1); expect(c.host.pendingCount).toBe(0);
      view.dispose(); expect(view.counts()).toMatchObject({ geometries: 0, materials: 0, objects: 0, bytes: 0 });
      expect(scene.children).toHaveLength(0); expect(firstDivergence(moved, observe(c.host))).toBeNull();
    } finally { Object.assign(globalThis, { document: oldDocument, getComputedStyle: oldStyle }); }
  });

  it('N/O: no frame past the horizon; extension is a real exact continuation and preserves old samples', () => {
    const { s, c } = setup(laboratory(), 123); compute(c);
    const old = c.frame(700)!; const oldBytes = old.poses.slice();
    expect(c.frame(724)).toBeNull();
    compute(c, 1200);
    const oracle = keep(new SimulationHost(c.root.semantic, c.forkCheckpoint()));
    for (let i = 0; i < 1200; i++) oracle.step();
    const endpoint = keep(new SimulationHost(c.root.semantic, c.endpointCheckpoint()!));
    expect(firstDivergence(observe(oracle), observe(endpoint))).toBeNull();
    assertFrame(c, oracle); expect(c.frame(700)!.poses).toEqual(oldBytes);
    expect(firstDivergence(observe(s.live()), observe(c.host))).toBeNull();
  });

  it('P: cancel/dispose prevent late commits and replacement preparation cancels work but retains comparison', () => {
    const { s, c } = setup();
    const job = c.begin(); c.batch(job, Infinity, () => 0, 2); c.cancel();
    expect(c.batch(job)).toBe('canceled'); expect(c.frame(2)).toBeNull(); expect(c.horizon).toBe(0);
    const next = c.begin(); computeCancel(c, next);
    const fresh = c.begin(); c.dispose(); expect(c.batch(fresh)).toBe('canceled'); expect(c.bytes).toBe(0);
    s.coordinator.closeComparison(); expect(s.coordinator.selected).toBe('authoring');
  });

  it('Q: exact budget boundary admits, one byte beyond refuses, actual large extension refuses before allocation', () => {
    expect(() => preflightComparison(COMPARISON_LIMITS.bytes)).not.toThrow();
    expect(() => preflightComparison(COMPARISON_LIMITS.bytes + 1)).toThrow(/shorter horizon/);
    const document = example();
    const bodies = Array.from({ length: 256 }, (_, n) => ({ ...document.semantic.bodies[0]!, id: `b-${String(n).padStart(3, '0')}` }));
    const { c } = setup(cloneFrozen({ ...document, semantic: { ...document.semantic, bodies } }));
    compute(c);
    const bytes = c.bytes, worlds = worldCounts().allocated;
    expect(() => c.begin(7200)).toThrow(/managed bytes/);
    expect(c.bytes).toBe(bytes); expect(worldCounts().allocated).toBe(worlds); expect(c.horizon).toBe(600);
  });

  it('export preserves authored body/emitter roots and current B laws, not the live fork poses', () => {
    const { s, c } = setup(example(), 100); compute(c);
    c.controller.editField('sideways', 'Push', (f) => edit(f, 2)); c.advance();
    const exported = c.alternateSetup();
    expect(exported.semantic.bodies).toEqual(s.live().frozenRoot.bodies);
    expect(exported.semantic.bodies[0]!.initialPose.position).toEqual([0, 0, 0]);
    const parsed = parseScene(serializeScene(exported)); expect(parsed.ok).toBe(true);
    const root = keep(new SimulationHost(exported.semantic)); expect(root.tick).toBe(0);
    expect(root.appliedFields()).toEqual(c.host.appliedFields());
  });
});
function computeCancel(c: Comparison, job: ReturnType<Comparison['begin']>) { c.cancel(); expect(c.batch(job)).toBe('canceled'); }

describe('T11 lifetime and source retention', () => {
  it('P3 full 7200-tick workload fits with 100 living bodies, four active laws and actual endpoint', () => {
    const { c } = setup(p3Document());
    const metrics = compute(c, 7200);
    expect(c.host.count).toBe(100); expect(c.host.appliedFields().length).toBe(4);
    expect(metrics.bytes).toBeLessThanOrEqual(COMPARISON_LIMITS.bytes);
    expect(c.frame(7200)!.ids.length).toBe(100);
    expect(c.endpointCheckpoint()!.tick).toBe(7200);
  });

  it('packaged qualification fixture logic passes in Node, independently of its native run', async () => {
    const events: Record<string, unknown>[] = [];
    await comparisonQualification(TEST_IDENTITY, (data) => events.push(data));
    expect(events.length).toBeGreaterThanOrEqual(10);
    expect(events.every((v) => v.pass === true)).toBe(true);
    expect(events.find((v) => v.case === 'L stable identities and absent counterparts')).toMatchObject({ pass: true, tick: 8, unequalTickRejected: true });
  }, 60_000);

  it('R: 20 enter/calculate/replay/new/close cycles return all comparison worlds and buffers to bounded steady state', () => {
    const s = session(); keep(s.live()); s.steps(311);
    const main = observe(s.live()), document = JSON.stringify(s.controller.snapshot(s.controller.camera));
    const steady = worldCounts().allocated; resetPeakWorlds();
    const cycles = [];
    for (let i = 0; i < 20; i++) {
      const c = s.coordinator.enterComparison(); compute(c, 20);
      c.advance(); c.replayAlternate(); while (c.replaying) c.advance(); c.newAlternate();
      const peak = c.counts(); expect(peak.bytes).toBeLessThanOrEqual(COMPARISON_LIMITS.bytes);
      s.coordinator.closeComparison();
      expect(c.counts()).toMatchObject({ worlds: 0, buffers: 0, bytes: 0, identities: 0, suffix: 0 });
      expect(worldCounts().allocated).toBe(steady);
      cycles.push(peak.bytes);
      expect(firstDivergence(main, observe(s.live()))).toBeNull();
      expect(JSON.stringify(s.controller.snapshot(s.controller.camera))).toBe(document);
    }
    expect(new Set(cycles).size).toBe(1); expect(worldCounts().peak).toBeLessThanOrEqual(steady + 2);
  }, 60_000);
});
