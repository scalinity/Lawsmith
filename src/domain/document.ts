// The document controller (SPEC §4): owns the authored scene, its presentation and author undo.
// Semantic edits become validated commands for the host and enter the authored scene only when
// the host acknowledges them, so a later reset, save or recovery uses exactly what was applied.
import { primitiveDescriptor, type PrimitiveKind } from '../fields/registry';
import { commandTarget, type CommandAck, type SimulationHost } from '../simulation/host';
import {
  SCENE_LIMITS,
  checkId,
  checkLawPresentation,
  cloneFrozen,
  defaultLawPresentation,
  validateField,
  type FieldDefinition,
  type LawPresentation,
  type SceneDefinition,
  type SceneDocument,
  type SceneMetadata,
  type ScenePresentation,
  type Validated,
  type Vec3,
} from './scene';

/** The boundary fade a created law starts with (SPEC §2.2). */
const CREATED_FADE = 0.25;

/** One law's complete authored state; null in a transaction means the law is absent. */
export interface LawState {
  readonly field: FieldDefinition;
  readonly presentation: LawPresentation;
}

/** One author-undo entry (SPEC §10.3): a law's state before and after one user action. */
export interface Transaction {
  readonly label: string;
  readonly id: string;
  readonly before: LawState | null;
  readonly after: LawState | null;
}

export type LawPresentationPatch = Partial<Pick<LawPresentation, 'label' | 'color' | 'visible'>>;

const failure = (reason: string, path = ''): { ok: false; reason: string; path: string } => ({ ok: false, reason, path });

export class DocumentController {
  private authored!: SceneDefinition;
  private lawPresentation = new Map<string, LawPresentation>();
  private view!: Omit<ScenePresentation, 'laws'>;
  private meta!: SceneMetadata;
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];

  /** Identity of the loaded document; a reply from an older generation never touches this one (SPEC §15.3). */
  generation = 0;
  /** Revision of the last accepted edit, semantic or presentation. */
  revision = 0;
  /** Revision of the last semantic edit the host acknowledged, i.e. the one its laws now include. */
  appliedRevision = 0;

  constructor(
    document: SceneDocument,
    private host: SimulationHost,
  ) {
    this.adopt(document);
  }

  get scene(): SceneDefinition {
    return this.authored;
  }

  get metadata(): SceneMetadata {
    return this.meta;
  }

  get arrows(): boolean {
    return this.view.arrows;
  }

  get camera(): ScenePresentation['camera'] {
    return this.view.camera;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The presentation of a law; one without a stored entry gets the constructor default. */
  presentationOf(id: string): LawPresentation {
    return this.lawPresentation.get(id) ?? defaultLawPresentation(id);
  }

  /**
   * Replaces the document with a validated one whose world `host` was built from it (a committed
   * import, SPEC §15.2). Starts a new generation: revisions, undo and acknowledgments restart.
   */
  load(document: SceneDocument, host: SimulationHost): void {
    this.host = host;
    this.adopt(document);
  }

  private adopt(document: SceneDocument): void {
    this.authored = document.semantic;
    this.lawPresentation = new Map(document.presentation.laws.map((p) => [p.id, p]));
    const { camera, arrows } = document.presentation;
    this.view = camera ? { camera, arrows } : { arrows };
    this.meta = document.metadata;
    this.undoStack = [];
    this.redoStack = [];
    this.generation += 1;
    this.revision = 0;
    this.appliedRevision = 0;
  }

  /**
   * Applies pending commands at the current boundary and adopts their acknowledgments, so the
   * authored scene holds every accepted edit. Save, recovery, reset and structural edits settle first.
   */
  settle(): CommandAck[] {
    this.host.settleBoundary();
    return this.sync();
  }

  /** The authored document at the settled current revision: semantic block, presentation, metadata. */
  snapshot(camera: ScenePresentation['camera']): { revision: number; semantic: SceneDefinition; presentation: ScenePresentation; metadata: SceneMetadata } {
    this.settle();
    const laws = this.authored.fields.map((f) => this.presentationOf(f.id));
    const presentation: ScenePresentation = camera ? { camera, arrows: this.view.arrows, laws } : { arrows: this.view.arrows, laws };
    return { revision: this.revision, semantic: this.authored, presentation, metadata: this.meta };
  }

  /** Validates a complete law value and queues it for the next boundary. Invalid input never reaches the host. */
  putField(candidate: FieldDefinition): Validated<{ revision: number; field: FieldDefinition }> {
    const result = validateField(candidate);
    if (!result.ok) return result;
    this.revision += 1;
    this.host.submit({ kind: 'putField', field: result.value }, this.revision);
    return { ok: true, value: { revision: this.revision, field: result.value } };
  }

  /** Adopts the host's acknowledgments into the authored scene; the current run root is untouched (SPEC §10.2). */
  sync(): CommandAck[] {
    const acks = this.host.takeAcks();
    if (!acks.length) return acks;
    const fields = [...this.authored.fields];
    for (const { payload, documentRevision } of acks) {
      const index = fields.findIndex((f) => f.id === commandTarget(payload));
      if (payload.kind === 'removeField') {
        if (index >= 0) fields.splice(index, 1);
      } else if (index >= 0) fields[index] = payload.field;
      else fields.push(payload.field);
      this.appliedRevision = documentRevision;
    }
    fields.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.authored = Object.freeze({ ...this.authored, fields: Object.freeze(fields) });
    return acks;
  }

  /**
   * SPEC §13.2 reset: settle pending edits, freeze a new run root from the authored scene and
   * rebuild the world at tick 0. It restarts the current configuration; it never replays a drag.
   */
  reset(): SceneDefinition {
    this.settle();
    const root = cloneFrozen(this.authored);
    this.host.reset(root);
    return root;
  }

  /** A law's settled authored state, or null if it does not exist. */
  lawState(id: string): LawState | null {
    const field = this.authored.fields.find((f) => f.id === id);
    return field ? { field, presentation: this.presentationOf(id) } : null;
  }

  /** Records a completed user action as one undo entry; a later redo history is discarded. */
  record(transaction: Transaction): void {
    if (sameState(transaction.before, transaction.after)) return;
    this.undoStack.push(transaction);
    this.redoStack = [];
  }

  /** One complete edit of a law's semantic value, as one undo entry (a toggle or a precise value). */
  editField(id: string, label: string, change: (field: FieldDefinition) => FieldDefinition): Validated<{ revision: number; field: FieldDefinition }> {
    this.settle();
    const before = this.lawState(id);
    if (!before) return failure(`no law ${id}`);
    const result = this.putField(change(before.field));
    if (result.ok) this.record({ label, id, before, after: { field: result.value.field, presentation: before.presentation } });
    return result;
  }

  /** Changes a law's display state. It advances the document revision but never the simulation. */
  setLawPresentation(id: string, patch: LawPresentationPatch): Validated<{ revision: number }> {
    this.settle();
    const before = this.lawState(id);
    if (!before) return failure(`no law ${id}`);
    const next = { ...before.presentation, ...patch };
    const error = checkLawPresentation(next);
    if (error) return failure(error, Object.keys(patch)[0] ?? '');
    this.applyPresentation(id, next);
    this.record({ label: 'Change appearance', id, before, after: { field: before.field, presentation: next } });
    return { ok: true, value: { revision: this.revision } };
  }

  /** The arrows visualization default: presentation, not an undoable law edit. */
  setArrows(arrows: boolean): void {
    if (arrows === this.view.arrows) return;
    this.view = { ...this.view, arrows };
    this.revision += 1;
  }

  /** Records the camera framing that a save captures. Not a document edit: it never dirties the scene. */
  setCamera(camera: ScenePresentation['camera']): void {
    this.view = camera ? { ...this.view, camera } : { arrows: this.view.arrows };
  }

  /**
   * Duplicates a law under a new stable ID (SPEC §10.3: an ordinary duplicate creates a new ID),
   * offset 1 m along +X when that stays in range.
   */
  duplicate(id: string): Validated<{ id: string; revision: number }> {
    this.settle();
    const source = this.lawState(id);
    if (!source) return failure(`no law ${id}`);
    if (this.authored.fields.length >= SCENE_LIMITS.fields) return failure(`a scene holds at most ${SCENE_LIMITS.fields} laws`);
    const { newId, suffix } = this.freshId(id);
    const [x, y, z] = source.field.pose.position;
    const offset = x + 1 <= 1000 ? x + 1 : x;
    const result = this.putField({ ...source.field, id: newId, pose: { ...source.field.pose, position: [offset, y, z] } });
    if (!result.ok) return result;
    const label = `${source.presentation.label.replace(/ \d+$/, '')} ${suffix}`.slice(0, SCENE_LIMITS.textLength);
    const presentation = { ...source.presentation, id: newId, label };
    this.lawPresentation.set(newId, presentation);
    this.record({ label: 'Duplicate law', id: newId, before: null, after: { field: result.value.field, presentation } });
    return { ok: true, value: { id: newId, revision: this.revision } };
  }

  /**
   * Creates a law of one primitive kind at `position` (the tool shelf, SPEC §11.1): a new stable ID
   * from the kind's verb, identity rotation, the registry's default region and parameters, and a
   * presentation entry. One undo entry; undo removes it, redo restores it with the same ID.
   */
  create(kind: PrimitiveKind, position: Vec3): Validated<{ id: string; revision: number }> {
    this.settle();
    if (this.authored.fields.length >= SCENE_LIMITS.fields) return failure(`a scene holds at most ${SCENE_LIMITS.fields} laws`);
    const descriptor = primitiveDescriptor(kind);
    const { newId, suffix } = this.freshId(descriptor.verb.toLowerCase(), true);
    const result = this.putField({
      id: newId,
      enabled: true,
      pose: { position, rotation: [0, 0, 0, 1] },
      region: descriptor.defaultRegion,
      edgeFade: CREATED_FADE,
      expression: descriptor.defaults,
    });
    if (!result.ok) return result;
    const presentation = { id: newId, label: suffix ? `${descriptor.verb} ${suffix}` : descriptor.verb, color: descriptor.color, visible: true };
    this.lawPresentation.set(newId, presentation);
    this.record({ label: 'Add law', id: newId, before: null, after: { field: result.value.field, presentation } });
    return { ok: true, value: { id: newId, revision: this.revision } };
  }

  /** Deletes a law through the command path; undo restores it with its original ID. */
  remove(id: string): Validated<{ revision: number }> {
    this.settle();
    const before = this.lawState(id);
    if (!before) return failure(`no law ${id}`);
    this.applyState(id, null);
    this.record({ label: 'Delete law', id, before, after: null });
    return { ok: true, value: { revision: this.revision } };
  }

  /** Restores the state before the latest action, through new commands at the current boundary. */
  undo(): Validated<Transaction> {
    const transaction = this.undoStack[this.undoStack.length - 1];
    if (!transaction) return failure('nothing to undo');
    const applied = this.restore(transaction.id, transaction.before);
    if (!applied.ok) return applied;
    this.undoStack.pop();
    this.redoStack.push(transaction);
    return { ok: true, value: transaction };
  }

  redo(): Validated<Transaction> {
    const transaction = this.redoStack[this.redoStack.length - 1];
    if (!transaction) return failure('nothing to redo');
    const applied = this.restore(transaction.id, transaction.after);
    if (!applied.ok) return applied;
    this.redoStack.pop();
    this.undoStack.push(transaction);
    return { ok: true, value: transaction };
  }

  private restore(id: string, state: LawState | null): Validated<null> {
    this.settle();
    const current = this.lawState(id);
    // A deleted law comes back with its original ID only if that ID is free (SPEC §10.3).
    if (state && !current && this.idInUse(id)) return failure(`id ${id} is in use`);
    if (state && !current && this.authored.fields.length >= SCENE_LIMITS.fields) return failure(`a scene holds at most ${SCENE_LIMITS.fields} laws`);
    this.applyState(id, state);
    return { ok: true, value: null };
  }

  /** Makes a law's authored state equal `state`, submitting only what differs. */
  private applyState(id: string, state: LawState | null): void {
    const current = this.lawState(id);
    if (!state) {
      if (current) {
        this.revision += 1;
        this.host.submit({ kind: 'removeField', id }, this.revision);
      }
      this.lawPresentation.delete(id);
      return;
    }
    if (!current || !sameField(current.field, state.field)) {
      this.revision += 1;
      this.host.submit({ kind: 'putField', field: state.field }, this.revision);
    }
    if (!current || !samePresentation(current.presentation, state.presentation)) this.applyPresentation(id, state.presentation);
  }

  private applyPresentation(id: string, presentation: LawPresentation): void {
    this.lawPresentation.set(id, presentation);
    this.revision += 1;
  }

  private idInUse(id: string): boolean {
    const s = this.authored;
    return s.fields.some((f) => f.id === id) || s.bodies.some((b) => b.id === id) || s.emitters.some((e) => e.id === id);
  }

  /** `base-2`, `base-3`, …: the first free ID, deterministic and never random; `base` itself first when `bare` (suffix 0). */
  private freshId(id: string, bare = false): { newId: string; suffix: number } {
    const base = id.replace(/-\d+$/, '');
    if (bare && !checkId(base) && !this.idInUse(base)) return { newId: base, suffix: 0 };
    for (let suffix = 2; ; suffix++) {
      const tail = `-${suffix}`;
      const newId = `${base.slice(0, SCENE_LIMITS.idLength - tail.length)}${tail}`;
      if (!checkId(newId) && !this.idInUse(newId)) return { newId, suffix };
    }
  }
}

function sameField(a: FieldDefinition, b: FieldDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function samePresentation(a: LawPresentation, b: LawPresentation): boolean {
  return a.label === b.label && a.color === b.color && a.visible === b.visible;
}

function sameState(a: LawState | null, b: LawState | null): boolean {
  if (!a || !b) return a === b;
  return sameField(a.field, b.field) && samePresentation(a.presentation, b.presentation);
}
