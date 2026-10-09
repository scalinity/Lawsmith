// The document controller (SPEC §4): owns the authored scene, its presentation and author undo.
// Semantic edits become validated commands for the host and enter the authored scene only when
// the host acknowledges them, so a later reset, save or recovery uses exactly what was applied.
import { expressionStats } from '../fields/expression';
import { primitiveDescriptor, type PrimitiveKind } from '../fields/registry';
import { vec } from './numbers';
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

/**
 * One author-undo entry (SPEC §10.3): a law's state before and after one user action. Its
 * `transactionId` is the one every command of that action carried; undoing it is a new action.
 */
export interface Transaction {
  readonly label: string;
  readonly id: string;
  readonly transactionId: string;
  readonly before: LawState | null;
  readonly after: LawState | null;
}

export type LawPresentationPatch = Partial<Pick<LawPresentation, 'label' | 'color' | 'visible'>>;

const failure = (reason: string, path = ''): { ok: false; reason: string; path: string } => ({ ok: false, reason, path });

/** The refusal of an edit the host did not apply: a recording closed at its limit (SPEC §13.3). */
export const NOT_APPLIED = 'the recording reached its limit and stopped, so this change was not applied';

export class DocumentController {
  private authored!: SceneDefinition;
  private lawPresentation = new Map<string, LawPresentation>();
  private view!: Omit<ScenePresentation, 'laws'>;
  private meta!: SceneMetadata;
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  /**
   * The latest value submitted for each law (null: its removal), applied or still queued. Budgets
   * that span laws are checked against it, so edits awaiting the same boundary cannot pass together.
   */
  private submitted = new Map<string, FieldDefinition | null>();
  /** Transactions issued in this session; never restarts, so a recording never sees one twice. */
  private transactions = 0;

  /** Identity of the loaded document; a reply from an older generation never touches this one (SPEC §15.3). */
  generation = 0;
  /** Revision of the last accepted edit, semantic or presentation. */
  revision = 0;
  /** Revision of the last semantic edit the host acknowledged, i.e. the one its laws now include. */
  appliedRevision = 0;
  /** Revision of the last presentation edit: accepted at once, with no host command. */
  private presentationRevision = 0;
  /**
   * Revisions a recording limit discarded unapplied, `(held, top]` (SPEC §13.3). They were issued
   * when their commands were submitted and changed nothing, so the document at `top` equals `held`.
   */
  private discarded: { held: number; top: number } | null = null;
  /**
   * Observes every batch of acknowledgments as the document adopts it, whichever call settled it
   * (an edit, undo, a digest or a save settles too), so accounting such as edit latency sees each
   * applied command exactly once.
   */
  onAcks: ((acks: readonly CommandAck[]) => void) | null = null;

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
    this.submitted = new Map();
    this.generation += 1;
    this.revision = 0;
    this.appliedRevision = 0;
    this.presentationRevision = 0;
    this.discarded = null;
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

  /**
   * A new transaction identity (SPEC §10.3): one user action, whose commands may span many boundaries,
   * as a gesture's samples do. It groups them for undo and in a recording; it never merges them.
   */
  newTransaction(): string {
    this.transactions += 1;
    return `tx-${this.transactions}`;
  }

  /**
   * Validates a complete law value and queues it for the next boundary. Invalid input, including a
   * law that would take the scene past its primitive-leaf budget, never reaches the host.
   */
  putField(candidate: FieldDefinition, transactionId: string = this.newTransaction()): Validated<{ revision: number; field: FieldDefinition }> {
    const result = validateField(candidate);
    if (!result.ok) return result;
    const over = this.overLeafBudget(result.value);
    if (over) return over;
    this.revision += 1;
    this.submitted.set(result.value.id, result.value);
    this.host.submit({ kind: 'putField', field: result.value }, this.revision, transactionId);
    return { ok: true, value: { revision: this.revision, field: result.value } };
  }

  /**
   * Replaces the ambient acceleration (SPEC §10.2): a physics command applied at the current boundary.
   * No control offers it yet; it exists so the full command vocabulary records and replays.
   */
  setAmbient(acceleration: Vec3): Validated<{ revision: number }> {
    if (!acceleration.every(Number.isFinite) || Math.hypot(...acceleration) > 200) {
      return failure('ambient acceleration must be finite with magnitude at most 200 m/s²', 'acceleration');
    }
    this.settle();
    this.revision += 1;
    const revision = this.revision;
    this.host.submit({ kind: 'setAmbient', acceleration: Object.freeze(vec(acceleration)) }, revision, this.newTransaction());
    if (!this.applied(revision)) return failure(NOT_APPLIED);
    return { ok: true, value: { revision } };
  }

  /** Settles a command just submitted at `revision`: true once the host applied it. */
  private applied(revision: number): boolean {
    this.settle();
    return this.appliedRevision >= revision;
  }

  /**
   * Drops every command still queued and unapplied (SPEC §13.3: a recording closed at a limit). The
   * acknowledgments are adopted first, so the authored scene holds everything the host applied and
   * nothing else changes.
   */
  discardPending(): void {
    this.sync();
    this.host.discardPending();
    this.submitted = new Map();
    const held = Math.max(this.appliedRevision, this.presentationRevision);
    if (this.revision > held) this.discarded = { held, top: this.revision };
  }

  /**
   * Whether the document still holds what it held at `revision` (SPEC §15.3: only accepted edits make
   * it unsaved). Revisions discarded unapplied at a recording limit changed nothing; any later edit
   * moves past them.
   */
  unchangedSince(revision: number): boolean {
    if (revision === this.revision) return true;
    const d = this.discarded;
    return d !== null && d.top === this.revision && revision >= d.held && revision <= d.top;
  }

  /** SPEC §15.2's scene-wide leaf budget with `field` in place of its law's latest submitted value. */
  private overLeafBudget(field: FieldDefinition): { ok: false; reason: string; path: string } | null {
    let leaves = expressionStats(field.expression).leaves;
    for (const f of this.authored.fields) if (f.id !== field.id && !this.submitted.has(f.id)) leaves += expressionStats(f.expression).leaves;
    for (const [id, f] of this.submitted) if (id !== field.id && f) leaves += expressionStats(f.expression).leaves;
    return leaves > SCENE_LIMITS.primitiveLeaves ? failure(`a scene's laws hold at most ${SCENE_LIMITS.primitiveLeaves} primitive leaves`, 'expression') : null;
  }

  /** Adopts the host's acknowledgments into the authored scene; the current run root is untouched (SPEC §10.2). */
  sync(): CommandAck[] {
    const acks = this.host.takeAcks();
    if (!acks.length) return acks;
    const fields = [...this.authored.fields];
    let simulation = this.authored.simulation;
    for (const { payload, documentRevision } of acks) {
      if (payload.kind === 'setAmbient') simulation = Object.freeze({ ...simulation, ambientAcceleration: payload.acceleration });
      else {
        const index = fields.findIndex((f) => f.id === commandTarget(payload));
        if (payload.kind === 'removeField') {
          if (index >= 0) fields.splice(index, 1);
        } else if (index >= 0) fields[index] = payload.field;
        else fields.push(payload.field);
      }
      this.appliedRevision = documentRevision;
    }
    fields.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.authored = Object.freeze({ ...this.authored, simulation, fields: Object.freeze(fields) });
    this.onAcks?.(acks);
    return acks;
  }

  /**
   * SPEC §13.2 reset: settle pending edits, freeze a new run root from the authored scene and
   * rebuild the world at tick 0. It restarts the current configuration; it never replays a drag.
   * `root`, when given, must be a frozen copy of the settled authored scene (a recording's root).
   */
  reset(root?: SceneDefinition): SceneDefinition {
    this.settle();
    const frozen = root ?? cloneFrozen(this.authored);
    this.host.reset(frozen);
    return frozen;
  }

  /** The world the authored document's commands go to. */
  get liveHost(): SimulationHost {
    return this.host;
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

  /**
   * One complete edit of a law's semantic value, as one undo entry (a toggle or a precise value). It is
   * applied at the current boundary before returning; the undo entry exists only if it applied.
   */
  editField(id: string, label: string, change: (field: FieldDefinition) => FieldDefinition): Validated<{ revision: number; field: FieldDefinition }> {
    this.settle();
    const before = this.lawState(id);
    if (!before) return failure(`no law ${id}`);
    const transactionId = this.newTransaction();
    const result = this.putField(change(before.field), transactionId);
    if (!result.ok) return result;
    if (!this.applied(result.value.revision)) return failure(NOT_APPLIED);
    this.record({ label, id, transactionId, before, after: { field: result.value.field, presentation: before.presentation } });
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
    this.record({ label: 'Change appearance', id, transactionId: this.newTransaction(), before, after: { field: before.field, presentation: next } });
    return { ok: true, value: { revision: this.revision } };
  }

  /** The arrows visualization default: presentation, not an undoable law edit. */
  setArrows(arrows: boolean): void {
    if (arrows === this.view.arrows) return;
    this.view = { ...this.view, arrows };
    this.revision += 1;
    this.presentationRevision = this.revision;
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
    const transactionId = this.newTransaction();
    const result = this.putField({ ...source.field, id: newId, pose: { ...source.field.pose, position: [offset, y, z] } }, transactionId);
    if (!result.ok) return result;
    if (!this.applied(result.value.revision)) return failure(NOT_APPLIED);
    const label = `${source.presentation.label.replace(/ \d+$/, '')} ${suffix}`.slice(0, SCENE_LIMITS.textLength);
    const presentation = { ...source.presentation, id: newId, label };
    this.lawPresentation.set(newId, presentation);
    this.record({ label: 'Duplicate law', id: newId, transactionId, before: null, after: { field: result.value.field, presentation } });
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
    const transactionId = this.newTransaction();
    const result = this.putField(
      {
        id: newId,
        enabled: true,
        pose: { position, rotation: [0, 0, 0, 1] },
        region: descriptor.defaultRegion,
        edgeFade: CREATED_FADE,
        expression: descriptor.defaults,
      },
      transactionId,
    );
    if (!result.ok) return result;
    if (!this.applied(result.value.revision)) return failure(NOT_APPLIED);
    const presentation = { id: newId, label: suffix ? `${descriptor.verb} ${suffix}` : descriptor.verb, color: descriptor.color, visible: true };
    this.lawPresentation.set(newId, presentation);
    this.record({ label: 'Add law', id: newId, transactionId, before: null, after: { field: result.value.field, presentation } });
    return { ok: true, value: { id: newId, revision: this.revision } };
  }

  /** Deletes a law through the command path; undo restores it with its original ID. */
  remove(id: string): Validated<{ revision: number }> {
    this.settle();
    const before = this.lawState(id);
    if (!before) return failure(`no law ${id}`);
    const transactionId = this.newTransaction();
    if (!this.applyState(id, null, transactionId)) return failure(NOT_APPLIED);
    this.record({ label: 'Delete law', id, transactionId, before, after: null });
    return { ok: true, value: { revision: this.revision } };
  }

  /**
   * Restores the state before the latest action, through new commands at the current boundary: a new
   * action with its own transaction, which never removes a consumed command from a recording.
   */
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
    const over = state ? this.overLeafBudget(state.field) : null;
    if (over) return over;
    if (!this.applyState(id, state, this.newTransaction())) return failure(NOT_APPLIED);
    return { ok: true, value: null };
  }

  /**
   * Makes a law's authored state equal `state`, submitting only what differs, and applies it at the
   * current boundary. Its presentation follows only once the host applied the command; false when a
   * recording limit refused it, leaving the law as it was.
   */
  private applyState(id: string, state: LawState | null, transactionId: string): boolean {
    const current = this.lawState(id);
    let revision: number | null = null;
    if (!state) {
      if (current) {
        revision = ++this.revision;
        this.submitted.set(id, null);
        this.host.submit({ kind: 'removeField', id }, revision, transactionId);
      }
    } else if (!current || !sameField(current.field, state.field)) {
      revision = ++this.revision;
      this.submitted.set(id, state.field);
      this.host.submit({ kind: 'putField', field: state.field }, revision, transactionId);
    }
    if (revision !== null && !this.applied(revision)) return false;
    if (!state) this.lawPresentation.delete(id);
    else if (!current || !samePresentation(current.presentation, state.presentation)) this.applyPresentation(id, state.presentation);
    return true;
  }

  private applyPresentation(id: string, presentation: LawPresentation): void {
    this.lawPresentation.set(id, presentation);
    this.revision += 1;
    this.presentationRevision = this.revision;
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
