// Explicit document workflows (SPEC §15.3): Open, Save, Save As, New, launch recovery, Save and Open
// Recording, Start Recording, and the shared close/quit/replace guard. One workflow runs at a time, so
// destination binding cannot be reordered; a save acknowledges only the revision it captured; replies
// from an older document generation never touch the current one; nothing is replaced, retired or
// dropped until a transition commits. The guard protects two separate artifacts by name: the main
// authored scene and an unsaved recording.
import type { DocumentController } from '../domain/document';
import type { SceneDocument, ScenePresentation } from '../domain/scene';
import type { RunCoordinator } from '../simulation/contexts';
import type { SimulationHost } from '../simulation/host';
import { exportRun } from '../simulation/recorder';
import type { LinearReplay } from '../simulation/replay';
import { defaultDocument } from './defaultScene';
import type { DocumentIo, IoFailure } from './io';
import { RecoveryWriter, describeFailure, parseRecovery, serializeRecovery, type RecoveryCapture, type RecoveryEnvelope } from './recovery';
import { RUN_SUFFIX, parseRun, suggestedRunName, type RunExpectations, type RunRecord } from './runFile';
import { createDocument, parseScene, serializeScene } from './sceneFile';

/** A candidate world, with whatever else its promotion needs, owned by the workflow until commit. */
export interface Candidate {
  dispose(): void;
}

/** What the workflow needs from the running application. */
export interface WorkflowApp<C extends Candidate = SimulationHost, R extends Candidate = LinearReplay> {
  readonly controller: DocumentController;
  /** Pauses, discards scheduling debt and ends any gesture at its last accepted value. */
  quiesce(reason: string): void;
  /** Freezes authored edits and context-changing commands while a guard decides. */
  freeze(frozen: boolean): void;
  gestureActive(): boolean;
  /** The camera framing a save records. */
  camera(): ScenePresentation['camera'];
  /**
   * Builds one unstepped candidate world for a validated document, and prepares everything its
   * promotion needs (its view included); throws if it cannot, leaving nothing allocated.
   */
  candidate(document: SceneDocument): C;
  /**
   * Promotes a candidate: the controller adopts the document and the displaced world is disposed.
   * It must not fail: everything fallible belongs in `candidate`, before anything is replaced.
   */
  commit(document: SceneDocument, candidate: C): void;
  /** The run coordinator: the recording, its finalized record and the replay context (SPEC §13.2). */
  readonly runs: RunCoordinator;
  /** This build's simulation and runtime, which an opened recording must match (SPEC §13.1). */
  runExpectations(): RunExpectations;
  /** Builds one unstepped candidate replay world, and its view, for a validated record; throws, allocating nothing. */
  runCandidate(record: RunRecord): R;
  /** Promotes the candidate to the selected replay of `record`; the displaced replay is freed. It must not fail. */
  commitRun(record: RunRecord, candidate: R): void;
  /** Starts a new recorded experiment from tick zero; throws, changing nothing, if the scene cannot be recorded. */
  startRecording(): void;
  log(kind: string, data: Record<string, unknown>): void;
  now(): number;
  onChange(): void;
}

export interface WorkflowMessage {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

export interface RecoveryOffer {
  readonly envelope: RecoveryEnvelope;
  /** True when the newest snapshot was unusable and this is the previous one. */
  readonly older: boolean;
  readonly newestProblem: string | null;
}

type SceneDecision = { kind: 'clean' } | { kind: 'saved' } | { kind: 'discard'; generation: number };
type RecordingDecision = { kind: 'none' } | { kind: 'saved' } | { kind: 'discard' };
/** A guard's decisions, one per artifact. A Discard is staged: nothing is retired or dropped until the transition commits. */
interface GuardDecision {
  readonly scene: SceneDecision;
  readonly recording: RecordingDecision;
}
/** What a transition would drop: the main authored scene, an unsaved recording, or both. */
interface GuardItems {
  readonly scene: boolean;
  readonly recording: boolean;
}
const BOTH: GuardItems = { scene: true, recording: true };
const RECORDING_ONLY: GuardItems = { scene: false, recording: true };

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A file name suggested from the scene title, with the explicit `.lawsmith.json` suffix. */
export function suggestedName(title: string): string {
  const base = title.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
  return `${base}.lawsmith.json`;
}

export class DocumentWorkflow<C extends Candidate = SimulationHost, R extends Candidate = LinearReplay> {
  private binding: { token: number; name: string } | null = null;
  /** The revision of this generation stored at the binding; null if it has never been saved. */
  private savedRevision: number | null = 0;
  private running: { kind: string; done: Promise<unknown> } | null = null;
  /** A candidate world not yet committed; disposed if its workflow ends any other way. */
  private uncommitted: C | null = null;
  private uncommittedRun: R | null = null;
  private exitPending = false;
  /**
   * Launch recovery is answered once the lookup finds nothing to offer, or the user recovers or
   * discards what it offered. Until then no explicit file workflow runs and no recovery is written:
   * a save would retire the earlier session's snapshots, and a write would rotate them, unanswered.
   */
  private launchAnswered = false;
  /** The document came from recovery and has not been saved since. */
  recovered = false;
  message: WorkflowMessage | null = null;
  readonly recovery: RecoveryWriter;

  constructor(
    private readonly io: DocumentIo,
    private readonly app: WorkflowApp<C, R>,
  ) {
    this.recovery = new RecoveryWriter({
      io,
      capture: () => this.captureRecovery(),
      log: app.log,
      onStatus: () => app.onChange(),
      now: app.now,
    });
  }

  get fileName(): string | null {
    return this.binding?.name ?? null;
  }

  /** The workflow in progress, if any. */
  get busy(): string | null {
    return this.running?.kind ?? null;
  }

  get dirty(): boolean {
    return this.savedRevision === null || !this.app.controller.unchangedSince(this.savedRevision);
  }

  get stored(): number | null {
    return this.savedRevision;
  }

  /** Called after accepted edits: recovery follows after a short debounce. */
  edited(): void {
    if (this.dirty) this.recovery.schedule();
    this.app.onChange();
  }

  save(): Promise<boolean | null> {
    return this.explicit('save', () => this.saveNow(false));
  }

  saveAs(): Promise<boolean | null> {
    return this.explicit('save-as', () => this.saveNow(true));
  }

  open(): Promise<boolean | null> {
    return this.explicit('open', () => this.openNow());
  }

  newScene(): Promise<boolean | null> {
    return this.explicit('new', () => this.replace('new', defaultDocument(), null, 0));
  }

  /** Save Recording (SPEC §13.2): the immutable record, never the scene; a running recording is stopped first. */
  saveRecording(): Promise<boolean | null> {
    return this.explicit('save-recording', () => this.saveRecordingNow());
  }

  /** Open Recording: a validated run replaces the current record and replays, read-only; the authored scene stays. */
  openRecording(): Promise<boolean | null> {
    return this.explicit('open-recording', () => this.openRecordingNow());
  }

  /** Start Recording: a new experiment from tick zero, after protecting an unsaved earlier recording. */
  record(): Promise<boolean | null> {
    return this.explicit('record', () => this.recordNow());
  }

  /**
   * A native close or quit request. Simultaneous requests coalesce; a workflow already running
   * settles first, then the guard evaluates the latest generation and revision.
   */
  async requestExit(request: 'close' | 'quit'): Promise<boolean> {
    if (this.exitPending) {
      this.app.log('guard', { request, outcome: 'coalesced' });
      return false;
    }
    this.exitPending = true;
    try {
      while (this.running) await this.running.done.catch(() => {});
      const proceed = await this.exclusive(request, async () => {
        const decision = await this.guard(request);
        if (!decision) return false;
        if (!(await this.commitDiscard(decision))) return false;
        // Nothing may exit while a write or retirement is still in flight (SPEC §15.3).
        await this.recovery.settled();
        return true;
      });
      if (!proceed) return false;
      this.app.log('guard', { request, outcome: 'exit' });
      try {
        await this.io.exit();
      } catch (error) {
        this.release();
        this.fail(`Lawsmith could not quit: ${String(error)}.`);
        return false;
      }
      return true;
    } finally {
      this.exitPending = false;
    }
  }

  /**
   * Reads launch recovery: the newest valid unsaved snapshot, or the previous one, clearly marked
   * older. Null answers launch recovery; an offer is answered by `recover` or `discardRecovery`.
   */
  async recoveryOffer(): Promise<RecoveryOffer | null> {
    let slots;
    try {
      slots = await this.io.recoveryLoad();
    } catch (error) {
      // The lookup itself failed (an unreadable snapshot is a slot state, not this): nothing can be offered.
      this.app.log('recovery', { action: 'launch', error: String(error) });
      this.launchAnswered = true;
      return null;
    }
    const read = (slot: typeof slots.current) =>
      slot.state === 'present' ? parseRecovery(slot.text) : slot.state === 'unreadable' ? { ok: false as const, reason: slot.reason } : null;
    const current = read(slots.current);
    const previous = read(slots.previous);
    this.app.log('recovery', {
      action: 'launch',
      current: current === null ? 'absent' : current.ok ? { generation: current.envelope.generation, revision: current.envelope.revision } : { invalid: current.reason },
      previous: previous === null ? 'absent' : previous.ok ? { generation: previous.envelope.generation, revision: previous.envelope.revision } : { invalid: previous.reason },
    });
    if (current?.ok) {
      // Only a validated current may become the previous snapshot when this session writes; an
      // unconfirmed one is replaced in place, so the previous fallback survives either way.
      await this.io.recoveryCurrentValid().catch((error: unknown) => this.app.log('recovery', { action: 'validated-current', outcome: 'failed', error: String(error) }));
      return { envelope: current.envelope, older: false, newestProblem: null };
    }
    if (previous?.ok) return { envelope: previous.envelope, older: true, newestProblem: current && !current.ok ? current.reason : 'the newest copy is missing' };
    if (current || previous) this.message = { kind: 'error', text: 'Recovery files from an earlier session could not be read; they were left in place.' };
    this.launchAnswered = true;
    return null;
  }

  /** Opens recovered work as an unsaved, unbound document: its destination is chosen again by Save. */
  recover(offer: RecoveryOffer): Promise<boolean | null> {
    return this.exclusive('recover', async () => {
      const done = await this.replace('recover', offer.envelope.document, null, null);
      if (done) {
        this.launchAnswered = true;
        this.recovered = true;
        // The recovered work gets a snapshot of this session right away.
        this.recovery.schedule();
        this.message = { kind: 'info', text: `Recovered “${offer.envelope.document.metadata.title}” (revision ${offer.envelope.revision}${offer.older ? ', an older copy' : ''}). Save it to choose where it goes.` };
      }
      return done;
    });
  }

  /** Discards the unsaved work offered at launch; snapshots of this session are kept. */
  discardRecovery(): Promise<boolean | null> {
    return this.exclusive('discard-recovery', async () => {
      try {
        await this.io.recoveryDiscardEarlier();
        this.launchAnswered = true;
        this.app.log('recovery', { action: 'discard-launch' });
        return true;
      } catch (error) {
        this.fail(`Recovery files could not be removed: ${describeFailure(error as IoFailure)}.`);
        return false;
      }
    });
  }

  // ------------------------------------------------------------------ internals

  /** Open, Save, Save As and New: refused until launch recovery is answered. */
  private explicit<T>(kind: string, work: () => Promise<T>): Promise<T | null> {
    if (!this.launchAnswered) {
      this.app.log('document', { action: kind, outcome: 'refused', reason: 'launch recovery unanswered' });
      return Promise.resolve(null);
    }
    return this.exclusive(kind, work);
  }

  private async exclusive<T>(kind: string, work: () => Promise<T>): Promise<T | null> {
    if (this.running) {
      this.app.log('document', { action: kind, outcome: 'refused', reason: `${this.running.kind} in progress` });
      return null;
    }
    const running: { kind: string; done: Promise<unknown> } = { kind, done: Promise.resolve() };
    this.running = running;
    this.app.onChange();
    try {
      const done = work();
      running.done = done;
      return await done;
    } catch (error) {
      // An unexpected failure must not leave edits frozen or a candidate world allocated.
      this.uncommitted?.dispose();
      this.uncommitted = null;
      this.uncommittedRun?.dispose();
      this.uncommittedRun = null;
      this.app.freeze(false);
      this.fail(`Something went wrong during ${kind}: ${error instanceof Error ? error.message : String(error)}. Your scene is unchanged.`, { action: kind, outcome: 'error' });
      return null;
    } finally {
      this.running = null;
      this.app.onChange();
    }
  }

  /** Settles and serializes the authored document at its current revision. */
  private capture(): { generation: number; revision: number; text: string } {
    const controller = this.app.controller;
    const snapshot = controller.snapshot(this.app.camera());
    const document = createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation);
    return { generation: controller.generation, revision: snapshot.revision, text: serializeScene(document) };
  }

  private captureRecovery(): RecoveryCapture | null {
    if (!this.launchAnswered) return null;
    if (this.app.gestureActive()) {
      // Only completed gestures become recovery points; try again after this one ends.
      this.recovery.schedule();
      return null;
    }
    if (!this.dirty) return null;
    const controller = this.app.controller;
    const snapshot = controller.snapshot(controller.camera);
    const document = createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation);
    return { generation: controller.generation, revision: snapshot.revision, text: serializeRecovery({ generation: controller.generation, revision: snapshot.revision, document }) };
  }

  private async saveNow(chooseDestination: boolean): Promise<boolean> {
    const action = chooseDestination || !this.binding ? 'save-as' : 'save';
    this.app.quiesce(action);
    let target = this.binding;
    if (action === 'save-as') {
      let choice;
      try {
        choice = await this.io.chooseDestination(this.binding?.name ?? suggestedName(this.app.controller.metadata.title));
      } catch (error) {
        return this.fail(`Save As failed: ${describeFailure(error as IoFailure)}.`, { action, error });
      }
      if (choice.outcome === 'canceled') {
        this.app.log('document', { action, outcome: 'canceled', file: this.binding?.name ?? null });
        this.message = { kind: 'info', text: 'Save As canceled. Nothing was written.' };
        return false;
      }
      if (choice.outcome === 'refused') {
        this.app.log('document', { action, outcome: 'refused-name', name: choice.name });
        this.message = { kind: 'error', text: `Scene files end in .lawsmith.json, so “${choice.name}” was not used. Nothing was written; choose Save As again and keep that ending.` };
        return false;
      }
      target = { token: choice.token, name: choice.name };
    }
    const start = this.app.now();
    const captured = this.capture();
    const captureMs = this.app.now() - start;
    try {
      const { writeMs } = await this.io.writeScene(target!.token, captured.text);
      if (this.app.controller.generation !== captured.generation) {
        // A reply for an older document can neither bind nor clean the current one.
        this.app.log('document', { action, outcome: 'stale', generation: captured.generation });
        return false;
      }
      this.binding = target;
      this.savedRevision = captured.revision;
      this.recovered = false;
      // The save is complete only when recovery through its revision is retired too.
      const retired = await this.recovery.retireThrough(captured.generation, captured.revision);
      // Revisions a recording limit discarded after the capture changed nothing.
      const later = this.app.controller.unchangedSince(captured.revision) ? 0 : this.app.controller.revision - captured.revision;
      this.app.log('document', {
        action,
        outcome: 'saved',
        file: target!.name,
        generation: captured.generation,
        revision: captured.revision,
        laterEdits: later,
        recoveryRetired: retired,
        bytes: captured.text.length,
        captureMs: round(captureMs),
        writeMs: round(writeMs),
        saveMs: round(this.app.now() - start),
      });
      this.message = retired
        ? { kind: 'info', text: later > 0 ? `Saved revision ${captured.revision} to ${target!.name}. Later edits are not saved yet.` : `Saved to ${target!.name}.` }
        : { kind: 'error', text: `Saved to ${target!.name}, but its recovery copy could not be removed${this.recovery.status.state === 'failed' ? ` (${this.recovery.status.reason})` : ''}. Closing waits until it can be.` };
      return true;
    } catch (error) {
      const failure = error as IoFailure;
      return this.fail(`Couldn't save to ${target!.name}: ${describeFailure(failure)}. Your scene is still open; Save As can write it elsewhere.`, {
        action,
        file: target!.name,
        revision: captured.revision,
        failure: failure.kind,
        stage: failure.stage,
        message: failure.message,
      });
    }
  }

  private async openNow(): Promise<boolean> {
    this.app.quiesce('open');
    let outcome;
    try {
      outcome = await this.io.openScene();
    } catch (error) {
      const failure = error as IoFailure;
      return this.fail(`The file was not opened: ${describeFailure(failure)}. Your current scene is unchanged.`, { action: 'open', failure: failure.kind, stage: failure.stage, message: failure.message });
    }
    if (outcome.outcome === 'canceled') {
      this.app.log('document', { action: 'open', outcome: 'canceled' });
      return false;
    }
    const start = this.app.now();
    const parsed = parseScene(outcome.text);
    if (!parsed.ok) {
      return this.fail(`${outcome.name} was not opened: ${parsed.error.message}. Your current scene is unchanged.`, {
        action: 'open',
        outcome: 'rejected',
        file: outcome.name,
        path: parsed.error.path,
        reason: parsed.error.reason,
      });
    }
    const parseMs = this.app.now() - start;
    return this.replace('open', parsed.document, { token: outcome.token, name: outcome.name }, 0, { readMs: outcome.readMs, parseMs, bytes: outcome.text.length });
  }

  /**
   * Transactional replacement (SPEC §15.2): build one unstepped candidate world, run the guard,
   * then commit. A failure or cancellation disposes the candidate and leaves everything as it was.
   */
  private async replace(
    action: string,
    chosen: SceneDocument,
    binding: { token: number; name: string } | null,
    savedRevision: number | null,
    timing: { readMs: number; parseMs: number; bytes: number } | null = null,
  ): Promise<boolean> {
    this.app.quiesce(action);
    let document = chosen;
    const start = this.app.now();
    let candidate: C;
    try {
      candidate = this.app.candidate(document);
    } catch (error) {
      return this.fail(`The scene could not be prepared: ${error instanceof Error ? error.message : String(error)}. Your current scene is unchanged.`, { action, outcome: 'candidate-failed' });
    }
    this.uncommitted = candidate;
    const candidateMs = this.app.now() - start;
    const decision = await this.guard(action);
    if (!decision || !(await this.commitDiscard(decision))) {
      candidate.dispose();
      this.uncommitted = null;
      this.app.log('document', { action, outcome: 'canceled', stage: 'guard' });
      return false;
    }
    if (decision.scene.kind === 'saved' && binding) {
      // The guard's save may have written the very file being opened: commit what it holds now.
      const reread = await this.reread(binding);
      candidate.dispose();
      this.uncommitted = null;
      if (!reread) {
        this.release();
        return false;
      }
      document = reread.document;
      try {
        candidate = this.app.candidate(document);
        this.uncommitted = candidate;
      } catch (error) {
        this.release();
        return this.fail(`The scene could not be prepared: ${error instanceof Error ? error.message : String(error)}.`, { action, outcome: 'candidate-failed' });
      }
    }
    const commitStart = this.app.now();
    // From here the candidate belongs to the application, whatever commit does.
    this.uncommitted = null;
    this.app.commit(document, candidate);
    this.binding = binding;
    this.savedRevision = savedRevision;
    this.recovered = false;
    this.app.freeze(false);
    const commitMs = this.app.now() - commitStart;
    this.app.log('document', {
      action,
      outcome: 'committed',
      file: binding?.name ?? null,
      generation: this.app.controller.generation,
      title: document.metadata.title,
      ...(timing && {
        bytes: timing.bytes,
        readMs: round(timing.readMs),
        parseMs: round(timing.parseMs),
        candidateMs: round(candidateMs),
        commitMs: round(commitMs),
        // Application work only: the native read, validation, candidate world and commit, never dialog time.
        openMs: round(timing.readMs + timing.parseMs + candidateMs + commitMs),
      }),
    });
    if (action !== 'recover') this.message = binding ? { kind: 'info', text: `Opened ${binding.name}. It starts paused at tick 0.` } : null;
    return true;
  }

  private async reread(binding: { token: number; name: string }): Promise<{ document: SceneDocument } | null> {
    try {
      const { text } = await this.io.readScene(binding.token);
      const parsed = parseScene(text);
      if (parsed.ok) {
        this.app.log('document', { action: 'open', outcome: 'reread', file: binding.name });
        return parsed;
      }
      this.fail(`${binding.name} was not opened: ${parsed.error.message}.`, { action: 'open', outcome: 'rejected', file: binding.name, path: parsed.error.path, reason: parsed.error.reason });
    } catch (error) {
      const failure = error as IoFailure;
      this.fail(`${binding.name} was not opened: ${describeFailure(failure)}.`, { action: 'open', failure: failure.kind, stage: failure.stage });
    }
    return null;
  }

  /**
   * The shared unsaved-work guard (SPEC §15.3). Pauses, settles and freezes edits; finalizes a running
   * recording under its normal bounded policy; then asks about each artifact the transition would drop,
   * naming it: the main authored scene (Save, Discard, Cancel) and an unsaved recording (Save Recording,
   * Discard, Cancel). The artifact of the selected context comes first. A Discard is only staged here:
   * the caller retires recovery or drops the recording when the whole transition commits. Any Cancel or
   * failed save returns null, and the transition is abandoned with the selected context paused.
   */
  private async guard(reason: string, items: GuardItems = BOTH): Promise<GuardDecision | null> {
    this.app.quiesce(`guard-${reason}`);
    this.app.freeze(true);
    const runs = this.app.runs;
    this.app.controller.settle();
    if (items.recording && (runs.recordingState === 'recording' || runs.recordingState === 'finalizing')) {
      runs.stopRecording('user');
      try {
        await runs.settled();
      } catch (error) {
        this.fail(`The recording could not be finished: ${error instanceof Error ? error.message : String(error)}. Nothing was closed.`, { action: reason, outcome: 'recording-failed' });
        return this.release();
      }
      this.app.log('guard', { reason, recording: 'finalized', runId: runs.record?.runId ?? null });
    }
    let scene: SceneDecision = { kind: 'clean' };
    let recording: RecordingDecision = { kind: 'none' };
    const order = runs.selected === 'replay' ? (['recording', 'scene'] as const) : (['scene', 'recording'] as const);
    for (const item of order) {
      if (item === 'scene' && items.scene) {
        const decided = await this.guardScene(reason);
        if (!decided) return null;
        scene = decided;
      } else if (item === 'recording' && items.recording) {
        const decided = await this.guardRecording(reason);
        if (!decided) return null;
        recording = decided;
      }
    }
    return { scene, recording };
  }

  /** The main authored scene's question: Save, Discard or Cancel. A Save here writes the retained main document, whatever is displayed. */
  private async guardScene(reason: string): Promise<SceneDecision | null> {
    const controller = this.app.controller;
    controller.settle();
    if (!this.dirty) {
      // A saved revision whose recovery copy is still on disk would come back as unsaved after restart.
      if (!(await this.recovery.ensureRetired())) return this.refuse('Your scene is saved, but its recovery copy could not be removed. Nothing was closed; try again.');
      this.app.log('guard', { reason, outcome: 'clean', generation: controller.generation, revision: controller.revision });
      return { kind: 'clean' };
    }
    let choice: 'save' | 'discard' | 'cancel';
    try {
      choice = await this.io.askUnsaved(controller.metadata.title);
    } catch {
      choice = 'cancel';
    }
    this.app.log('guard', { reason, item: 'scene', choice, generation: controller.generation, revision: controller.revision });
    if (choice === 'cancel') return this.release();
    if (choice === 'discard') return { kind: 'discard', generation: controller.generation };
    const saved = await this.saveNow(false);
    controller.settle();
    // Re-evaluate after the save: only a document that is now clean, with its recovery retired
    // through the saved revision, may be replaced or closed.
    if (!saved || this.dirty) return this.release();
    if (!(await this.recovery.ensureRetired())) return this.refuse('Your scene is saved, but its recovery copy could not be removed. Nothing was closed; try again.');
    return { kind: 'saved' };
  }

  /** An unsaved recording's question: Save Recording, Discard or Cancel. Recordings are not kept for recovery. */
  private async guardRecording(reason: string): Promise<RecordingDecision | null> {
    const runs = this.app.runs;
    const record = runs.record;
    if (!record || runs.exported) return { kind: 'none' };
    const seconds = (record.finalTick / 120).toFixed(2);
    const changes = record.commands.length;
    const detail = `It holds ${changes} recorded ${changes === 1 ? 'change' : 'changes'} over ${seconds} s. Recordings are not kept for recovery, so it is lost if you don't save it. Saving it does not save your scene.`;
    let choice: 'save' | 'discard' | 'cancel';
    try {
      choice = await this.io.askUnsavedRecording(record.root.metadata.title, detail);
    } catch {
      choice = 'cancel';
    }
    this.app.log('guard', { reason, item: 'recording', choice, runId: record.runId, commands: changes, finalTick: record.finalTick });
    if (choice === 'cancel') return this.release();
    if (choice === 'discard') return { kind: 'discard' };
    if (!(await this.saveRecordingNow()) || !runs.exported) return this.release();
    return { kind: 'saved' };
  }

  /** Retires a staged scene Discard; the transition proceeds only once recovery for that generation is retired. A recording's Discard needs no retirement: the commit drops it. */
  private async commitDiscard(decision: GuardDecision): Promise<boolean> {
    if (decision.scene.kind !== 'discard') return true;
    try {
      await this.recovery.discard(decision.scene.generation);
      return true;
    } catch (error) {
      this.release();
      this.fail(`Unsaved changes could not be discarded from recovery: ${describeFailure(error as IoFailure)}. Nothing was closed.`);
      return false;
    }
  }

  // ------------------------------------------------------------------ recordings

  private async saveRecordingNow(): Promise<boolean> {
    const runs = this.app.runs;
    this.app.quiesce('save-recording');
    if (runs.recordingState === 'recording') runs.stopRecording('user');
    let record: RunRecord | null;
    try {
      record = await runs.settled();
    } catch (error) {
      return this.fail(`The recording could not be finished: ${error instanceof Error ? error.message : String(error)}.`, { action: 'save-recording', outcome: 'recording-failed' });
    }
    if (!record) {
      this.message = { kind: 'info', text: 'There is no recording to save yet. Record from tick 0 first.' };
      return false;
    }
    let choice;
    try {
      choice = await this.io.chooseRunDestination(suggestedRunName(record.root.metadata.title));
    } catch (error) {
      return this.fail(`Save Recording failed: ${describeFailure(error as IoFailure)}.`, { action: 'save-recording', error });
    }
    if (choice.outcome === 'canceled') {
      this.app.log('document', { action: 'save-recording', outcome: 'canceled', runId: record.runId });
      this.message = { kind: 'info', text: 'Save Recording canceled. Nothing was written.' };
      return false;
    }
    if (choice.outcome === 'refused') {
      this.app.log('document', { action: 'save-recording', outcome: 'refused-name', name: choice.name });
      this.message = { kind: 'error', text: `Recordings end in ${RUN_SUFFIX}, so “${choice.name}” was not used. Nothing was written; choose Save Recording again and keep that ending.` };
      return false;
    }
    const start = this.app.now();
    try {
      // The exact export, its size checked against the limit the reader enforces.
      const exported = exportRun(record);
      const { writeMs } = await this.io.writeRun(choice.token, exported.text);
      if (runs.record === record) runs.exported = true;
      this.app.log('document', {
        action: 'save-recording',
        outcome: 'saved',
        file: choice.name,
        runId: record.runId,
        bytes: exported.bytes,
        commands: record.commands.length,
        finalTick: record.finalTick,
        lastAppliedSequence: record.lastAppliedSequence,
        stopped: record.stopped,
        writeMs: round(writeMs),
        saveMs: round(this.app.now() - start),
      });
      this.message = { kind: 'info', text: `Saved the recording to ${choice.name}. Your scene is saved separately.` };
      return true;
    } catch (error) {
      const failure = error as IoFailure;
      return this.fail(`Couldn't save the recording to ${choice.name}: ${failure.kind ? describeFailure(failure) : String(error)}. The recording is still here; try Save Recording again elsewhere.`, {
        action: 'save-recording',
        file: choice.name,
        failure: failure.kind ?? 'export',
        stage: failure.stage ?? null,
        message: failure.message ?? String(error),
      });
    }
  }

  private async openRecordingNow(): Promise<boolean> {
    this.app.quiesce('open-recording');
    let outcome;
    try {
      outcome = await this.io.openRun();
    } catch (error) {
      const failure = error as IoFailure;
      return this.fail(`The recording was not opened: ${describeFailure(failure)}. Nothing changed.`, { action: 'open-recording', failure: failure.kind, stage: failure.stage, message: failure.message });
    }
    if (outcome.outcome === 'canceled') {
      this.app.log('document', { action: 'open-recording', outcome: 'canceled' });
      return false;
    }
    const start = this.app.now();
    const parsed = parseRun(outcome.text, this.app.runExpectations());
    if (!parsed.ok) {
      const why = parsed.incompatible ? `it cannot replay exactly here: ${parsed.error.message}` : parsed.error.message;
      return this.fail(`${outcome.name} was not opened: ${why}. Your scene and any recording are unchanged.`, {
        action: 'open-recording',
        outcome: 'rejected',
        incompatible: parsed.incompatible,
        file: outcome.name,
        path: parsed.error.path,
        reason: parsed.error.reason,
      });
    }
    const parseMs = this.app.now() - start;
    return this.replaceRun(parsed.record, { token: outcome.token, name: outcome.name }, { readMs: outcome.readMs, parseMs, bytes: outcome.text.length });
  }

  /**
   * Transactional run replacement (SPEC §15.2): one unstepped candidate replay world, the guard for an
   * unsaved recording, then commit. A failure or cancellation disposes the candidate and leaves the
   * selected context, the scene, the record and its replay exactly as they were.
   */
  private async replaceRun(chosen: RunRecord, source: { token: number; name: string }, timing: { readMs: number; parseMs: number; bytes: number }): Promise<boolean> {
    let record = chosen;
    const start = this.app.now();
    let candidate: R;
    try {
      candidate = this.app.runCandidate(record);
    } catch (error) {
      return this.fail(`The recording could not be prepared: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`, { action: 'open-recording', outcome: 'candidate-failed' });
    }
    this.uncommittedRun = candidate;
    const candidateMs = this.app.now() - start;
    const decision = await this.guard('open-recording', RECORDING_ONLY);
    if (!decision) {
      candidate.dispose();
      this.uncommittedRun = null;
      this.app.log('document', { action: 'open-recording', outcome: 'canceled', stage: 'guard' });
      return false;
    }
    if (decision.recording.kind === 'saved') {
      // The guard's save may have written the very file being opened: open what it holds now.
      candidate.dispose();
      this.uncommittedRun = null;
      let reread: RunRecord | null = null;
      try {
        const { text } = await this.io.readRun(source.token);
        const parsed = parseRun(text, this.app.runExpectations());
        if (parsed.ok) reread = parsed.record;
        else this.fail(`${source.name} was not opened: ${parsed.error.message}.`, { action: 'open-recording', outcome: 'rejected', path: parsed.error.path, reason: parsed.error.reason });
      } catch (error) {
        this.fail(`${source.name} was not opened: ${describeFailure(error as IoFailure)}.`, { action: 'open-recording', failure: (error as IoFailure).kind });
      }
      if (!reread) {
        this.release();
        return false;
      }
      record = reread;
      try {
        candidate = this.app.runCandidate(record);
        this.uncommittedRun = candidate;
      } catch (error) {
        this.release();
        return this.fail(`The recording could not be prepared: ${error instanceof Error ? error.message : String(error)}.`, { action: 'open-recording', outcome: 'candidate-failed' });
      }
    }
    const commitStart = this.app.now();
    this.uncommittedRun = null;
    this.app.commitRun(record, candidate);
    this.app.freeze(false);
    this.app.log('document', {
      action: 'open-recording',
      outcome: 'committed',
      file: source.name,
      runId: record.runId,
      commands: record.commands.length,
      finalTick: record.finalTick,
      lastAppliedSequence: record.lastAppliedSequence,
      bytes: timing.bytes,
      readMs: round(timing.readMs),
      parseMs: round(timing.parseMs),
      candidateMs: round(candidateMs),
      commitMs: round(this.app.now() - commitStart),
    });
    this.message = { kind: 'info', text: `Opened the recording ${source.name}. It replays from tick 0, read-only; Return to authoring brings back your scene as you left it.` };
    return true;
  }

  private async recordNow(): Promise<boolean> {
    const runs = this.app.runs;
    this.app.quiesce('record');
    if (runs.selected === 'replay') {
      this.message = { kind: 'info', text: 'Return to authoring to start a recording.' };
      return false;
    }
    if (runs.recordingState === 'recording' || runs.recordingState === 'finalizing') {
      this.message = { kind: 'info', text: 'A recording is already running.' };
      return false;
    }
    if (runs.recordingAtRisk && !(await this.guard('record', RECORDING_ONLY))) return false;
    try {
      this.app.startRecording();
    } catch (error) {
      this.release();
      return this.fail(`The recording could not start: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`, { action: 'record', outcome: 'refused' });
    }
    this.app.freeze(false);
    this.app.log('document', { action: 'record', outcome: 'started', runId: runs.recorder?.runId ?? null });
    return true;
  }

  private release(): null {
    this.app.freeze(false);
    return null;
  }

  private refuse(text: string): null {
    this.message = { kind: 'error', text };
    this.app.log('guard', { outcome: 'refused', reason: text });
    return this.release();
  }

  private fail(text: string, data: Record<string, unknown> = {}): false {
    this.message = { kind: 'error', text };
    this.app.log('document', { outcome: 'failed', ...data });
    return false;
  }
}
