// Explicit document workflows (SPEC §15.3): Open, Save, Save As, New, launch recovery and the
// shared close/quit/replace guard. One workflow runs at a time, so destination binding cannot be
// reordered; a save acknowledges only the revision it captured; replies from an older document
// generation never touch the current one; nothing is replaced or retired until a transition commits.
import type { DocumentController } from '../domain/document';
import type { SceneDocument, ScenePresentation } from '../domain/scene';
import type { SimulationHost } from '../simulation/host';
import { defaultDocument } from './defaultScene';
import type { DocumentIo, IoFailure } from './io';
import { RecoveryWriter, describeFailure, parseRecovery, serializeRecovery, type RecoveryCapture, type RecoveryEnvelope } from './recovery';
import { createDocument, parseScene, serializeScene } from './sceneFile';

/** What the workflow needs from the running application. */
export interface WorkflowApp {
  readonly controller: DocumentController;
  /** Pauses, discards scheduling debt and ends any gesture at its last accepted value. */
  quiesce(reason: string): void;
  /** Freezes authored edits and context-changing commands while a guard decides. */
  freeze(frozen: boolean): void;
  gestureActive(): boolean;
  /** The camera framing a save records. */
  camera(): ScenePresentation['camera'];
  /** Builds one unstepped candidate world for a validated document; throws if it cannot. */
  candidate(document: SceneDocument): SimulationHost;
  /** Promotes a candidate: the controller adopts the document and the displaced world is disposed. */
  commit(document: SceneDocument, candidate: SimulationHost): void;
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

type GuardDecision = { kind: 'clean' } | { kind: 'saved' } | { kind: 'discard'; generation: number };

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A file name suggested from the scene title, with the explicit `.lawsmith.json` suffix. */
export function suggestedName(title: string): string {
  const base = title.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
  return `${base}.lawsmith.json`;
}

export class DocumentWorkflow {
  private binding: { token: number; name: string } | null = null;
  /** The revision of this generation stored at the binding; null if it has never been saved. */
  private savedRevision: number | null = 0;
  private running: { kind: string; done: Promise<unknown> } | null = null;
  private exitPending = false;
  /** The document came from recovery and has not been saved since. */
  recovered = false;
  message: WorkflowMessage | null = null;
  readonly recovery: RecoveryWriter;

  constructor(
    private readonly io: DocumentIo,
    private readonly app: WorkflowApp,
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
    return this.savedRevision !== this.app.controller.revision;
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
    return this.exclusive('save', () => this.saveNow(false));
  }

  saveAs(): Promise<boolean | null> {
    return this.exclusive('save-as', () => this.saveNow(true));
  }

  open(): Promise<boolean | null> {
    return this.exclusive('open', () => this.openNow());
  }

  newScene(): Promise<boolean | null> {
    return this.exclusive('new', () => this.replace('new', defaultDocument(), null, 0));
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

  /** Reads launch recovery: the newest valid unsaved snapshot, or the previous one, clearly marked older. */
  async recoveryOffer(): Promise<RecoveryOffer | null> {
    const slots = await this.io.recoveryLoad();
    const read = (slot: typeof slots.current) =>
      slot.state === 'present' ? parseRecovery(slot.text) : slot.state === 'unreadable' ? { ok: false as const, reason: slot.reason } : null;
    const current = read(slots.current);
    const previous = read(slots.previous);
    this.app.log('recovery', {
      action: 'launch',
      current: current === null ? 'absent' : current.ok ? { generation: current.envelope.generation, revision: current.envelope.revision } : { invalid: current.reason },
      previous: previous === null ? 'absent' : previous.ok ? { generation: previous.envelope.generation, revision: previous.envelope.revision } : { invalid: previous.reason },
    });
    if (current?.ok) return { envelope: current.envelope, older: false, newestProblem: null };
    if (previous?.ok) return { envelope: previous.envelope, older: true, newestProblem: current && !current.ok ? current.reason : 'the newest copy is missing' };
    if (current || previous) this.message = { kind: 'error', text: 'Recovery files from an earlier session could not be read; they were left in place.' };
    return null;
  }

  /** Opens recovered work as an unsaved, unbound document: its destination is chosen again by Save. */
  recover(offer: RecoveryOffer): Promise<boolean | null> {
    return this.exclusive('recover', async () => {
      const done = await this.replace('recover', offer.envelope.document, null, null);
      if (done) {
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
        this.app.log('recovery', { action: 'discard-launch' });
        return true;
      } catch (error) {
        this.fail(`Recovery files could not be removed: ${describeFailure(error as IoFailure)}.`);
        return false;
      }
    });
  }

  // ------------------------------------------------------------------ internals

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
      const later = this.app.controller.revision - captured.revision;
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
    let candidate: SimulationHost;
    try {
      candidate = this.app.candidate(document);
    } catch (error) {
      return this.fail(`The scene could not be prepared: ${error instanceof Error ? error.message : String(error)}. Your current scene is unchanged.`, { action, outcome: 'candidate-failed' });
    }
    const candidateMs = this.app.now() - start;
    const decision = await this.guard(action);
    if (!decision || !(await this.commitDiscard(decision))) {
      candidate.dispose();
      this.app.log('document', { action, outcome: 'canceled', stage: 'guard' });
      return false;
    }
    if (decision.kind === 'saved' && binding) {
      // The guard's save may have written the very file being opened: commit what it holds now.
      const reread = await this.reread(binding);
      candidate.dispose();
      if (!reread) {
        this.release();
        return false;
      }
      document = reread.document;
      try {
        candidate = this.app.candidate(document);
      } catch (error) {
        this.release();
        return this.fail(`The scene could not be prepared: ${error instanceof Error ? error.message : String(error)}.`, { action, outcome: 'candidate-failed' });
      }
    }
    const commitStart = this.app.now();
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
   * The shared unsaved-work guard (SPEC §15.3). Pauses, settles and freezes edits, then offers
   * Save, Discard or Cancel for the main authored scene. A Discard is only staged here: the caller
   * retires recovery when the whole transition commits. Null means the transition is canceled.
   */
  private async guard(reason: string): Promise<GuardDecision | null> {
    this.app.quiesce(`guard-${reason}`);
    this.app.freeze(true);
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
    this.app.log('guard', { reason, choice, generation: controller.generation, revision: controller.revision });
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

  /** Retires a staged Discard; the transition proceeds only once recovery for that generation is retired. */
  private async commitDiscard(decision: GuardDecision): Promise<boolean> {
    if (decision.kind !== 'discard') return true;
    try {
      await this.recovery.discard(decision.generation);
      return true;
    } catch (error) {
      this.release();
      this.fail(`Unsaved changes could not be discarded from recovery: ${describeFailure(error as IoFailure)}. Nothing was closed.`);
      return false;
    }
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
