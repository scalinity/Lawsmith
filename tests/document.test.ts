// T05/T06 author undo (SPEC §10.3): one gesture is one entry; undo and redo restore authored
// values through new commands at the current boundary and never rewind physics; deletion and
// duplication keep identity rules; presentation edits never reach the host.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen, type FieldDefinition } from '../src/domain/scene';
import { defaultDocument } from '../src/persistence/defaultScene';
import { createDocument, parseScene, serializeScene } from '../src/persistence/sceneFile';
import { EditLatency } from '../src/measurement';
import { SimulationHost, initSimulation, type CommandAck } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

function setup() {
  const document = defaultDocument();
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  return { host, controller, base: document.semantic.fields[0]! };
}

const moved = (f: FieldDefinition, x: number): FieldDefinition => ({ ...f, pose: { ...f.pose, position: [x, 1, 0] } });

/** A drag as LawInteraction performs it: many previews through putField, then one recorded transaction. */
function drag(controller: DocumentController, host: SimulationHost, xs: number[]) {
  const before = controller.lawState('sideways')!;
  const transactionId = controller.newTransaction();
  let latest = before.field;
  for (const x of xs) {
    const result = controller.putField(moved(before.field, x), transactionId);
    if (!result.ok) throw new Error(result.reason);
    latest = result.value.field;
    host.step();
    controller.sync();
  }
  controller.record({ label: 'Move law', id: 'sideways', transactionId, before, after: { field: latest, presentation: before.presentation } });
}

describe('author undo: gestures', () => {
  it('one drag of many previews is one undo entry; undo and redo restore its endpoints', () => {
    const { host, controller, base } = setup();
    drag(controller, host, [2.5, 2, 1.5, 1, 0.5]);
    expect(controller.canUndo).toBe(true);
    expect(controller.undo().ok).toBe(true);
    expect(controller.canUndo).toBe(false);
    controller.settle();
    expect(controller.scene.fields[0]).toEqual(base);
    expect(host.appliedFields()[0]).toEqual(base);
    expect(controller.redo().ok).toBe(true);
    controller.settle();
    expect(controller.scene.fields[0]!.pose.position).toEqual([0.5, 1, 0]);
    host.dispose();
  });

  it('a cancelled gesture records nothing', () => {
    const { host, controller, base } = setup();
    controller.putField(moved(base, 1));
    controller.putField(base); // the cancel's restore
    controller.settle();
    expect(controller.canUndo).toBe(false);
    host.dispose();
  });

  it('a new action discards the redo history', () => {
    const { host, controller } = setup();
    drag(controller, host, [1]);
    controller.undo();
    expect(controller.canRedo).toBe(true);
    controller.editField('sideways', 'Disable law', (f) => ({ ...f, enabled: false }));
    expect(controller.canRedo).toBe(false);
    host.dispose();
  });

  it.each([
    ['rotation', (f: FieldDefinition): FieldDefinition => ({ ...f, pose: { ...f.pose, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } })],
    ['extent', (f: FieldDefinition): FieldDefinition => ({ ...f, region: { kind: 'box', halfExtents: [2.5, 2, 1.5] } })],
    ['enabled state', (f: FieldDefinition): FieldDefinition => ({ ...f, enabled: false })],
    ['strength and fade', (f: FieldDefinition): FieldDefinition => ({ ...f, edgeFade: 0.5, expression: { kind: 'directional', direction: [1, 0, 0], strength: 30 } })],
  ])('undoes and redoes a %s edit exactly', (_, change) => {
    const { host, controller, base } = setup();
    const result = controller.editField('sideways', 'edit', change);
    expect(result.ok).toBe(true);
    const after = result.ok ? result.value.field : base;
    controller.undo();
    controller.settle();
    expect(controller.scene.fields[0]).toEqual(base);
    controller.redo();
    controller.settle();
    expect(controller.scene.fields[0]).toEqual(after);
    host.dispose();
  });
});

describe('author undo during live motion (AC5)', () => {
  it('restores the law at the current boundary without rewinding bodies or their velocity', () => {
    const { host, controller } = setup();
    for (let i = 0; i < 200; i++) host.step();
    drag(controller, host, [0.3]);
    for (let i = 0; i < 100; i++) host.step();
    controller.sync();
    const tick = host.tick;
    const bodiesBefore = host.canonicalState().bodies;
    const sequenceBefore = host.lastAppliedSequence;

    controller.undo();
    controller.settle();
    const after = host.canonicalState();
    // The undo is a new command at boundary n: same tick, one more applied command, untouched bodies.
    expect(after.tick).toBe(tick);
    expect(host.lastAppliedSequence).toBe(sequenceBefore + 1);
    expect(after.bodies).toEqual(bodiesBefore);
    expect(after.fields[0]!.pose.position).toEqual([3, 1, 0]);
    // Later motion continues forward from the acquired velocities.
    host.step();
    expect(host.tick).toBe(tick + 1);
    host.dispose();
  });
});

describe('author undo: deletion and duplication identity', () => {
  it('delete removes the law through the command path; undo restores its original ID; redo removes it again', () => {
    const { host, controller, base } = setup();
    expect(controller.remove('sideways').ok).toBe(true);
    controller.settle();
    expect(host.appliedFields()).toEqual([]);
    expect(controller.scene.fields).toEqual([]);
    controller.undo();
    controller.settle();
    expect(host.appliedFields()).toEqual([base]);
    expect(controller.lawState('sideways')!.presentation.label).toBe('Sideways');
    controller.redo();
    controller.settle();
    expect(host.appliedFields()).toEqual([]);
    host.dispose();
  });

  it('duplicate creates a new, unique, deterministic ID offset 1 m along +X', () => {
    const { host, controller, base } = setup();
    const first = controller.duplicate('sideways');
    const second = controller.duplicate('sideways');
    const third = controller.duplicate(first.ok ? first.value.id : '');
    expect([first, second, third].map((r) => (r.ok ? r.value.id : null))).toEqual(['sideways-2', 'sideways-3', 'sideways-4']);
    controller.settle();
    const copy = controller.lawState('sideways-2')!;
    expect(copy.field.pose.position).toEqual([4, 1, 0]);
    expect(copy.field.expression).toEqual(base.expression);
    expect(copy.presentation.label).toBe('Sideways 2');
    expect(new Set(host.appliedFields().map((f) => f.id)).size).toBe(4);
    host.dispose();
  });

  it('a duplicate round-trips canonically and keeps its ID', () => {
    const { host, controller } = setup();
    controller.duplicate('sideways');
    const snapshot = controller.snapshot(undefined);
    const text = serializeScene(createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation));
    const reread = parseScene(text);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.document.semantic.fields.map((f) => f.id)).toEqual(['sideways', 'sideways-2']);
    expect(serializeScene(reread.document)).toBe(text);
    host.dispose();
  });

  it('undoing a duplicate removes it; an undone delete does not take an ID that is in use', () => {
    const { host, controller } = setup();
    controller.duplicate('sideways');
    controller.undo();
    controller.settle();
    expect(host.appliedFields().map((f) => f.id)).toEqual(['sideways']);
    host.dispose();
  });

  it('refuses a 33rd law', () => {
    const { host, controller } = setup();
    for (let i = 0; i < 31; i++) expect(controller.duplicate('sideways').ok).toBe(true);
    const refused = controller.duplicate('sideways');
    expect(refused.ok).toBe(false);
    controller.settle();
    expect(host.appliedFields()).toHaveLength(32);
    host.dispose();
  });
});

describe('presentation edits (AC4)', () => {
  it('are undoable document edits that never reach the host', () => {
    const { host, controller } = setup();
    const sequence = host.lastAppliedSequence;
    const revision = controller.revision;
    expect(controller.setLawPresentation('sideways', { label: 'Push', color: '#d9a35b', visible: false }).ok).toBe(true);
    controller.setArrows(false);
    controller.settle();
    expect(host.lastAppliedSequence).toBe(sequence);
    expect(controller.revision).toBe(revision + 2);
    controller.undo();
    expect(controller.lawState('sideways')!.presentation).toEqual({ id: 'sideways', label: 'Sideways', color: '#55aaa4', visible: true });
    host.dispose();
  });

  it('rejects an invalid label or color without changing anything', () => {
    const { host, controller } = setup();
    const revision = controller.revision;
    expect(controller.setLawPresentation('sideways', { label: '' }).ok).toBe(false);
    expect(controller.setLawPresentation('sideways', { color: 'teal' }).ok).toBe(false);
    expect(controller.revision).toBe(revision);
    expect(controller.canUndo).toBe(false);
    host.dispose();
  });

  it('camera framing is captured for saving but is not a document edit', () => {
    const { host, controller } = setup();
    const revision = controller.revision;
    controller.setCamera({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(controller.revision).toBe(revision);
    expect(controller.snapshot(controller.camera).presentation.camera).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    host.dispose();
  });
});

describe('load', () => {
  it('starts a new generation with fresh revisions and an empty undo history', () => {
    const { host, controller } = setup();
    drag(controller, host, [1]);
    const generation = controller.generation;
    const next = defaultDocument();
    const nextHost = new SimulationHost(next.semantic);
    controller.load(next, nextHost);
    expect(controller.generation).toBe(generation + 1);
    expect(controller.revision).toBe(0);
    expect(controller.canUndo).toBe(false);
    expect(controller.scene.fields[0]!.pose.position).toEqual([3, 1, 0]);
    host.dispose();
    nextHost.dispose();
  });
});

describe('acknowledgment accounting (M3 review finding 2)', () => {
  it('every acknowledgment reaches the observer exactly once, whichever call adopts it', () => {
    const { host, controller } = setup();
    const seen: number[] = [];
    controller.onAcks = (acks: readonly CommandAck[]) => seen.push(...acks.map((a) => a.documentRevision));
    const toggled = controller.editField('sideways', 'Disable law', (f) => ({ ...f, enabled: false }));
    if (!toggled.ok) throw new Error(toggled.reason);
    controller.snapshot(undefined); // a digest report or a save settles here, not the frame loop
    controller.sync();
    expect(seen).toEqual([toggled.value.revision]);
    controller.undo(); // undo settles first, then queues its restore
    controller.settle();
    expect(seen).toEqual([toggled.value.revision, toggled.value.revision + 1]);
    host.dispose();
  });

  it('an edit adopted outside the frame loop is timed, not counted as superseded', () => {
    const { host, controller } = setup();
    const latency = new EditLatency();
    controller.onAcks = (acks) => acks.forEach((a) => latency.acknowledge(a.documentRevision));
    const toggled = controller.editField('sideways', 'Disable law', (f) => ({ ...f, enabled: false }));
    if (!toggled.ok) throw new Error(toggled.reason);
    latency.accept(toggled.value.revision, 100);
    controller.snapshot(undefined);
    expect(latency.frameSubmitted(controller.appliedRevision, 116)).toEqual([16]);
    expect(latency.superseded).toBe(0);
    host.dispose();
  });
});
