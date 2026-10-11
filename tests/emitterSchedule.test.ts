// M8 owner feedback (F5): spawn rate and body lifetime become editable through one narrow document
// command, DocumentController.setEmitterSchedule. Editing an emitter rebuilds the world from tick 0 (SPEC
// §5.3); undo and redo perform the same explicit reset (SPEC §10.3). Only intervalTicks and lifetimeTicks
// change; identity, seed, pose and template stay; the law undo history interleaves unchanged.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen } from '../src/domain/scene';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { EXAMPLES, exampleDocument } from '../src/scenes/examples';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

function setup() {
  const document = exampleDocument(EXAMPLES.find((e) => e.key === 'sideways-rain')!);
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  for (let i = 0; i < 90; i++) host.step();
  return { controller, host, emitter: document.semantic.emitters[0]! };
}
const schedule = (c: DocumentController) => {
  const e = c.scene.emitters[0]!;
  return { intervalTicks: e.intervalTicks, lifetimeTicks: e.lifetimeTicks };
};

describe('setEmitterSchedule', () => {
  it('applies a new spawn interval and lifetime by rebuilding the world at tick 0, keeping identity and seed', () => {
    const { controller, host, emitter } = setup();
    const generation = host.generation;
    const revision = controller.revision;
    const result = controller.setEmitterSchedule(emitter.id, { intervalTicks: 4, lifetimeTicks: 2400 });
    expect(result.ok).toBe(true);
    expect(host.tick).toBe(0);
    expect(host.generation).toBeGreaterThan(generation);
    expect(controller.revision).toBe(revision + 1);
    expect(controller.unchangedSince(revision)).toBe(false);
    const after = controller.scene.emitters[0]!;
    expect({ ...after, intervalTicks: emitter.intervalTicks, lifetimeTicks: emitter.lifetimeTicks }).toEqual(emitter);
    expect(schedule(controller)).toEqual({ intervalTicks: 4, lifetimeTicks: 2400 });
    // The live world runs the new schedule: births every 4 ticks.
    for (let i = 0; i < 40; i++) host.step();
    expect(host.count).toBe(10);
  });

  it('undo and redo restore each schedule with the same reset, interleaved with law edits', () => {
    const { controller, host, emitter } = setup();
    const law = controller.scene.fields[0]!;
    expect(controller.editField(law.id, 'Strength', (f) => ({ ...f, expression: { ...f.expression, strength: 9 } as typeof f.expression })).ok).toBe(true);
    controller.settle();
    expect(controller.setEmitterSchedule(emitter.id, { intervalTicks: 5, lifetimeTicks: 1000 }).ok).toBe(true);
    expect(controller.editField(law.id, 'Strength', (f) => ({ ...f, expression: { ...f.expression, strength: 11 } as typeof f.expression })).ok).toBe(true);
    controller.settle();

    const strength = () => (controller.scene.fields.find((f) => f.id === law.id)!.expression as { strength: number }).strength;
    expect(controller.undo().ok).toBe(true); // the second law edit
    controller.settle();
    expect(strength()).toBe(9);
    expect(schedule(controller)).toEqual({ intervalTicks: 5, lifetimeTicks: 1000 });

    for (let i = 0; i < 30; i++) host.step();
    const generation = host.generation;
    const undone = controller.undo(); // the schedule: an explicit reset back to the original
    expect(undone.ok && undone.value.kind).toBe('emitter');
    expect(schedule(controller)).toEqual({ intervalTicks: emitter.intervalTicks, lifetimeTicks: emitter.lifetimeTicks });
    expect(host.tick).toBe(0);
    expect(host.generation).toBeGreaterThan(generation);
    expect(strength()).toBe(9);

    expect(controller.undo().ok).toBe(true); // the first law edit
    controller.settle();
    expect(strength()).toBe((law.expression as { strength: number }).strength);

    expect(controller.redo().ok).toBe(true);
    controller.settle();
    expect(controller.redo().ok).toBe(true);
    expect(schedule(controller)).toEqual({ intervalTicks: 5, lifetimeTicks: 1000 });
    expect(host.tick).toBe(0);
  });

  it.each([
    ['zero', { intervalTicks: 0, lifetimeTicks: 600 }],
    ['negative', { intervalTicks: 8, lifetimeTicks: -1 }],
    ['fractional', { intervalTicks: 2.5, lifetimeTicks: 600 }],
    ['NaN', { intervalTicks: NaN, lifetimeTicks: 600 }],
    ['infinite', { intervalTicks: 8, lifetimeTicks: Infinity }],
    ['unsafe', { intervalTicks: 8, lifetimeTicks: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses a %s value with nothing changed: document, world and history', (_, value) => {
    const { controller, host, emitter } = setup();
    const generation = host.generation;
    const tick = host.tick;
    const revision = controller.revision;
    expect(controller.setEmitterSchedule(emitter.id, value).ok).toBe(false);
    expect(schedule(controller)).toEqual({ intervalTicks: emitter.intervalTicks, lifetimeTicks: emitter.lifetimeTicks });
    expect([host.generation, host.tick, controller.revision, controller.canUndo]).toEqual([generation, tick, revision, false]);
  });

  it('is refused while a recording is active, leaving the document, the world and its root untouched', () => {
    const { controller, host, emitter } = setup();
    const root = host.frozenRoot;
    const tick = host.tick;
    host.recorder = {} as typeof host.recorder; // what an active recording leaves on its world
    const result = controller.setEmitterSchedule(emitter.id, { intervalTicks: 4, lifetimeTicks: 2400 });
    expect(result.ok).toBe(false);
    expect(host.tick).toBe(tick);
    expect(host.frozenRoot).toBe(root);
    expect(root.emitters[0]!.intervalTicks).toBe(emitter.intervalTicks);
    expect(schedule(controller)).toEqual({ intervalTicks: emitter.intervalTicks, lifetimeTicks: emitter.lifetimeTicks });
    expect(controller.canUndo).toBe(false);
    host.recorder = null;
  });

  it('a frozen earlier root keeps its own schedule after the change', () => {
    const { controller, host, emitter } = setup();
    const earlier = host.frozenRoot;
    controller.setEmitterSchedule(emitter.id, { intervalTicks: 6, lifetimeTicks: 900 });
    expect(earlier.emitters[0]!.intervalTicks).toBe(emitter.intervalTicks);
    expect(host.frozenRoot.emitters[0]!.intervalTicks).toBe(6);
  });

  it('saves and reopens with the new schedule', () => {
    const { controller, emitter } = setup();
    controller.setEmitterSchedule(emitter.id, { intervalTicks: 12, lifetimeTicks: 3600 });
    const snap = controller.snapshot(undefined);
    const text = serializeScene({ format: 'lawsmith.scene', schemaVersion: 1, requiredCapabilities: [], metadata: snap.metadata, semantic: snap.semantic, presentation: snap.presentation } as never);
    const reopened = parseScene(text);
    if (!reopened.ok) throw reopened.error;
    expect(reopened.document.semantic.emitters[0]).toMatchObject({ id: emitter.id, seed: emitter.seed, intervalTicks: 12, lifetimeTicks: 3600 });
  });
});
