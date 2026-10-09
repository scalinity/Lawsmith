// Shared M6A fixtures: a scene with several independent laws (one compound, one untouched), a live
// session through the real document controller and run coordinator, and a drag that submits as
// LawInteraction does (one transaction, samples that coalesce until a boundary consumes them).
import { DocumentController } from '../../src/domain/document';
import { cloneFrozen, type FieldDefinition, type SceneDocument } from '../../src/domain/scene';
import { RUN_FORMAT, type QualificationIdentity, type RunExpectations, type RunRecord } from '../../src/persistence/runFile';
import { parseScene } from '../../src/persistence/sceneFile';
import { RunCoordinator } from '../../src/simulation/contexts';
import { SimulationHost } from '../../src/simulation/host';
import { SIMULATION_FINGERPRINT } from '../../src/simulation/recorder';
import { observe, type Observed } from '../../src/simulation/replay';
import stormBottle from '../../examples/storm-bottle.lawsmith.json?raw';

/** The identity a headless run reports: never `packaged`, so never an exactness claim. */
export const TEST_IDENTITY: QualificationIdentity = Object.freeze({
  app: 'Lawsmith 0.0.0',
  build: 'headless',
  bundle: 'vitest (unbundled sources)',
  tauri: 'none: Node harness',
  webkit: 'none: Node V8',
  os: 'test host',
  arch: 'test',
});

export const EXPECT: RunExpectations = { fingerprint: SIMULATION_FINGERPRINT, identity: TEST_IDENTITY };

export const FORMAT = RUN_FORMAT;

const push = (id: string, x: number): FieldDefinition => ({
  id,
  enabled: true,
  pose: { position: [x, 1, 0], rotation: [0, 0, 0, 1] },
  region: { kind: 'box', halfExtents: [1.5, 2, 1.5] },
  edgeFade: 0.25,
  expression: { kind: 'directional', direction: [1, 0, 0], strength: 12 },
});

/**
 * The Storm Bottle in the colliding stream, beside an independent push and an untouched drag: a
 * compound law, three independent laws, an emitter's births and deaths, and body contacts.
 */
export function laboratory(): SceneDocument {
  const parsed = parseScene(stormBottle);
  if (!parsed.ok) throw parsed.error;
  const document = parsed.document;
  const calm: FieldDefinition = {
    id: 'calm',
    enabled: true,
    pose: { position: [-3, 0, 0], rotation: [0, 0, 0, 1] },
    region: { kind: 'sphere', radius: 1.2 },
    edgeFade: 0.2,
    expression: { kind: 'linearDrag', coefficient: 1.5 },
  };
  const fields = [...document.semantic.fields, push('push', -1.5), calm].sort((a, b) => (a.id < b.id ? -1 : 1));
  return cloneFrozen({ ...document, semantic: { ...document.semantic, fields } });
}

export interface Session {
  readonly controller: DocumentController;
  readonly coordinator: RunCoordinator;
  readonly live: () => SimulationHost;
  /** The frame loop's boundary: queued commands consumed at the current tick, adopted by the document. */
  boundary(): void;
  /** One fixed step of the live world, as a playing frame takes it, then adoption. */
  step(): void;
  steps(n: number): void;
  limits: string[];
}

export function session(document: SceneDocument = laboratory(), runIds = ['run-test-1', 'run-test-2', 'run-test-3', 'run-test-4', 'run-test-5']): Session {
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  const limits: string[] = [];
  const ids = [...runIds];
  const coordinator = new RunCoordinator({ controller, identity: () => TEST_IDENTITY, runId: () => ids.shift() ?? `run-${Math.random()}`, onLimit: (reason) => limits.push(reason) });
  const live = () => controller.liveHost;
  const s: Session = {
    controller,
    coordinator,
    live,
    boundary: () => {
      controller.settle();
    },
    step: () => {
      live().settleBoundary();
      controller.sync();
      live().step();
      controller.sync();
    },
    steps: (n) => {
      for (let i = 0; i < n; i++) s.step();
    },
    limits,
  };
  return s;
}

/**
 * A drag as LawInteraction performs it: every sample is a complete law value submitted through the
 * document under the gesture's one transaction; `between` runs after each sample (a frame boundary
 * or a step). At release the controller ends it as main.ts does: one undo entry from its start to
 * what the host applied.
 */
export function drag(s: Session, id: string, samples: readonly ((f: FieldDefinition) => FieldDefinition)[], between: (i: number) => void): { transactionId: string; latest: FieldDefinition } {
  const { controller } = s;
  controller.settle();
  const before = controller.lawState(id)!;
  const transactionId = controller.newTransaction();
  let latest = before.field;
  samples.forEach((sample, i) => {
    const result = controller.putField(sample(before.field), transactionId);
    if (!result.ok) throw new Error(result.reason);
    latest = result.value.field;
    between(i);
  });
  controller.endGesture('Move law', before.field, transactionId);
  return { transactionId, latest };
}

export const moveTo = (x: number, y = 1, z = 0) => (f: FieldDefinition): FieldDefinition => ({ ...f, pose: { ...f.pose, position: [x, y, z] } });

/** The live world's state at each settled boundary of a run, keyed `tick:cursor`. */
export class Trajectory {
  readonly at = new Map<string, Observed>();
  capture(host: SimulationHost): void {
    const o = observe(host);
    this.at.set(`${o.address.tick}:${o.address.cursor}`, o);
  }
}

/**
 * M6B's recorded fixture: the laboratory over 1,100 ticks, so the stream's births (every 8th tick), its
 * deaths (from tick 512) and its contacts with the floor run through four 240-tick checkpoints. It holds
 * a drag over five boundaries, an ambient change, three paused edits at tick 500, two at tick 720 (a
 * checkpoint tick), a law created at 800 and removed at 900, and two edits at the final tick.
 */
export async function interventionRecord(): Promise<{ record: RunRecord; session: Session }> {
  const s = session();
  const { controller, coordinator } = s;
  const ok = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error('fixture edit refused');
  };
  coordinator.startRecording();
  s.steps(100);
  drag(s, 'push', [moveTo(-1.2), moveTo(-0.9), moveTo(-0.6), moveTo(-0.3), moveTo(0)], () => s.step());
  s.steps(195);
  ok(controller.setAmbient([0.5, -9, 0]));
  s.steps(200);
  ok(controller.editField('push', 'Strength', (f) => ({ ...f, expression: { kind: 'directional', direction: [1, 0, 0], strength: 18 } })));
  ok(controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false })));
  ok(controller.editField('storm-bottle', 'Move law', moveTo(2.6, 1.6)));
  s.steps(220);
  ok(controller.editField('calm', 'Enable law', (f) => ({ ...f, enabled: true })));
  ok(controller.editField('push', 'Move law', moveTo(0.4)));
  s.steps(80);
  const created = controller.create('vortexY', [0, 2, 0]);
  if (!created.ok) throw new Error('fixture create refused');
  s.steps(100);
  ok(controller.remove(created.value.id));
  s.steps(200);
  ok(controller.editField('push', 'Strength', (f) => ({ ...f, expression: { kind: 'directional', direction: [1, 0, 0], strength: 9 } })));
  ok(controller.editField('storm-bottle', 'Move law', moveTo(2.2, 1.6)));
  const record = (await coordinator.stopRecording())!;
  return { record, session: s };
}
