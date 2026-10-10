// The run coordinator (SPEC §13.2, §14.2): the one owner of the authoring context, the recording, the
// replay context, an import's candidate and a seek's offscreen world, and of every transition between
// them. Only the selected context advances. In steady replay the retained authoring world stays paused
// and untouched beside one replay world; a serialized import may add one unstepped candidate, and a
// pending seek one world it reconstructs out of sight (a peak of three).
import type { DocumentController } from '../domain/document';
import { cloneFrozen, deepFreeze, type SceneDocument } from '../domain/scene';
import { compactJson, qualified, type QualificationIdentity, type RunRecord, type StopReason } from '../persistence/runFile';
import { createDocument } from '../persistence/sceneFile';
import { CHECKPOINT_TICKS, CheckpointCache, PrefixIdentities, RestoredReplay, captureCheckpoint, compareAddress, intact, onPath, type Checkpoint, type CheckpointScope } from './checkpoints';
import { worldCounts, type SimulationHost } from './host';
import { RunRecorder, SIMULATION_FINGERPRINT, sha256Hex } from './recorder';
import { LinearReplay, type Address } from './replay';
import { Comparison } from './comparison';

export type Selected = 'authoring' | 'replay' | 'comparison';

/** The displayed replay: built from the record's root, or restored from a checkpoint by a seek. */
export type ReplayWorld = LinearReplay | RestoredReplay;

/**
 * A seek request (SPEC §14.2). Each has its own ID, and a newer one, a context change or Return to
 * authoring cancels it. Its world is reconstructed out of sight and replaces the displayed replay only
 * once it holds exactly the target.
 */
export interface SeekJob {
  readonly id: number;
  readonly target: Address;
  readonly record: RunRecord;
  /** Where reconstruction began: the closest usable checkpoint, or the root at (0, 0). Null until the first batch. */
  source: { readonly kind: 'checkpoint' | 'root'; readonly address: Address } | null;
  /** The world being reconstructed; null before the first batch and after the job ends. */
  work: ReplayWorld | null;
  batches: number;
  /** Time inside batches, and inside choosing and restoring the source, ms. */
  workMs: number;
  restoreMs: number;
  steps: number;
  /** Checkpoints found corrupt or inconsistent on the way; each discarded its record's cache. */
  readonly rejected: string[];
}

export type SeekStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly job: SeekJob; readonly progress: number }
  | { readonly kind: 'committed'; readonly job: SeekJob }
  | { readonly kind: 'failed'; readonly job: SeekJob; readonly error: unknown };

/** What happened to the checkpoint cache, for diagnostics. */
export type CheckpointEvent =
  | { readonly kind: 'captured'; readonly checkpoint: Checkpoint; readonly evicted: readonly Checkpoint[]; readonly bytes: number; readonly count: number }
  | { readonly kind: 'declined'; readonly checkpoint: Checkpoint }
  | { readonly kind: 'rejected'; readonly reason: string; readonly discarded: number };

/** Recording state as the controls show it. */
export type RecordingState = 'idle' | 'recording' | 'finalizing' | 'recorded';

/** What a replay at its frozen endpoint found when it checked itself against the recorded final state. */
export type FinalCheckResult = { kind: 'match' } | { kind: 'mismatch'; state: boolean; engine: boolean } | { kind: 'unavailable' };

export interface RunCoordinatorOptions {
  readonly controller: DocumentController;
  /** This runtime's qualification identity (SPEC §13.1). */
  readonly identity: () => QualificationIdentity;
  /** A new run identity; random by default. Not simulation state. */
  readonly runId?: () => string;
  /**
   * A recording closed itself at a limit. Called in a microtask, after the coordinator has discarded
   * the queued commands and released the halted world, so the caller can pause and end any gesture
   * at the last applied value.
   */
  readonly onLimit?: (reason: StopReason) => void;
  /** Told of every capture, decline and rejection in the checkpoint cache. */
  readonly onCheckpoint?: (event: CheckpointEvent) => void;
}

/** Commands applied between checks of a replay's work budget. */
const CHUNK = 64;

export class RunCoordinator {
  readonly controller: DocumentController;
  recorder: RunRecorder | null = null;
  private finalizing: Promise<RunRecord> | null = null;
  /** The finalized recording, if any: the one Replay and Save Recording use. */
  record: RunRecord | null = null;
  /** True once that record has been written to a file or came from one. */
  exported = false;
  /** How the last recording ended. */
  stopReason: StopReason | null = null;
  replay: ReplayWorld | null = null;
  selected: Selected = 'authoring';
  comparison: Comparison | null = null;
  private comparisonEntry: 'authoring' | 'replay' = 'authoring';
  /** Checkpoints of the records replayed in this session (SPEC §14.2); never persisted. */
  readonly checkpoints: CheckpointCache;
  /** The seek in progress, if any: only the latest request has one. */
  private job: SeekJob | null = null;
  private jobs = 0;
  /** Each record's history context and prefix identities, assigned when first needed. */
  private readonly scopes = new WeakMap<RunRecord, CheckpointScope>();
  private histories = 0;
  /**
   * The live history context (SPEC §13.3): a new value whenever a recording starts or stops, so a
   * closed record and the live continuation after it never share an identity.
   */
  context = 0;
  /** Import candidates allocated now (at most one: imports are serialized). */
  candidates = 0;
  /** A replay unit whose boundary is still being settled across frames. */
  private unitOpen = false;

  constructor(
    private readonly options: RunCoordinatorOptions,
    cache: CheckpointCache = new CheckpointCache(),
  ) {
    this.controller = options.controller;
    this.checkpoints = cache;
  }

  /** The authoring world: the one the document's commands go to, retained paused during replay. */
  get live(): SimulationHost {
    return this.controller.liveHost;
  }

  /** The world displayed and advanced: the replay's when replay is selected. */
  get shown(): SimulationHost {
    if (this.selected === 'comparison' && this.comparison) return this.comparison.host;
    return this.selected === 'replay' && this.replay ? this.replay.host : this.live;
  }

  /** Paused caller only: refuse recording/seek/partial settlement before allocating either future. */
  enterComparison(): Comparison {
    if (this.comparison || this.selected === 'comparison') throw new Error('Close the current comparison first.');
    if (this.recordingState === 'recording' || this.recordingState === 'finalizing') throw new Error('Stop the recording before comparing.');
    if (this.job || this.replayPartial || this.candidates) throw new Error('Finish seeking or replacing the context before comparing.');
    if (this.shown.pendingCount) throw new Error('Finish the queued edits before comparing.');
    if (this.selected === 'authoring') this.controller.settle();
    const source = this.shown;
    const record = this.selected === 'replay' ? this.replay!.record : null;
    const snapshot = this.controller.snapshot(this.controller.camera);
    const root = record ? cloneFrozen({ ...record.root, presentation: { ...record.root.presentation, laws: [...record.root.presentation.laws, ...record.createdLaws] } }) : createDocument(source.frozenRoot, snapshot.metadata, snapshot.presentation);
    const identity = record ? `${record.runId}:${this.scope(record).prefixes.at(source.lastAppliedSequence)}` : `live-${this.context}-${source.generation}`;
    const comparison = new Comparison(source, root, `${identity}:${compactJson(SIMULATION_FINGERPRINT)}:${compactJson(this.options.identity())}`);
    this.comparisonEntry = this.selected;
    this.comparison = comparison;
    this.selected = 'comparison';
    return comparison;
  }

  closeComparison(): void {
    if (!this.comparison) return;
    this.comparison.dispose();
    this.comparison = null;
    this.selected = this.comparisonEntry;
  }

  get recordingState(): RecordingState {
    if (this.recorder && !this.recorder.closed) return 'recording';
    if (this.recorder || this.finalizing) return 'finalizing';
    return this.record ? 'recorded' : 'idle';
  }

  /** A recording that would be lost by dropping it now: running, being finalized, or never saved. */
  get recordingAtRisk(): boolean {
    return this.recordingState === 'recording' || this.recordingState === 'finalizing' || (this.record !== null && !this.exported);
  }

  /**
   * Starts a new recorded experiment from tick zero (SPEC §13.3): settles the authored edits, freezes a
   * copy of the authored scene as the root, rebuilds the live world from it and attaches the recorder
   * at (0, 0). A previous finalized record is replaced; the caller protects an unexported one first.
   */
  startRecording(): RunRecorder {
    if (this.selected !== 'authoring') throw new Error('Recording starts from authoring.');
    if (this.recordingState === 'recording' || this.recordingState === 'finalizing') throw new Error('A recording is already running.');
    const controller = this.controller;
    controller.settle();
    const semantic = cloneFrozen(controller.scene);
    const root: SceneDocument = deepFreeze(
      createDocument(semantic, { title: controller.metadata.title }, { arrows: controller.arrows, laws: semantic.fields.map((f) => controller.presentationOf(f.id)) }),
    );
    // The size check precedes the reset, so a root too large to record leaves the live world as it was.
    const runId = this.options.runId?.() ?? `run-${crypto.randomUUID()}`;
    const identity = this.options.identity();
    const envelopeBytes = RunRecorder.check(root, identity, runId);
    controller.reset(semantic);
    const recorder = new RunRecorder(this.live, root, identity, runId, undefined, envelopeBytes);
    // Only now is the previous record replaced: a rebuild that failed has left it as it was.
    this.dropRecord();
    recorder.onLimit = (reason) =>
      queueMicrotask(() => {
        this.resolveStop();
        this.options.onLimit?.(reason);
      });
    this.recorder = recorder;
    this.stopReason = null;
    this.context += 1;
    return recorder;
  }

  /**
   * An ordinary stop (SPEC §10.2, §13.3): settle the queued valid edits into the record, then freeze
   * its prefix and final address. After a fault the record ends where the world faulted, without a
   * final check. Later live edits belong to a new live context and never reach the record.
   */
  stopRecording(reason: 'user' | 'fault' = 'user'): Promise<RunRecord> | null {
    if (this.finalizing) return this.finalizing;
    const recorder = this.recorder;
    if (!recorder) return null;
    if (!recorder.closed) {
      if (reason === 'user' && !this.live.fault) this.controller.settle();
      recorder.stop(reason);
    }
    this.resolveStop();
    return this.finalizing;
  }

  /**
   * After the recorder closed, by a stop or at a limit (SPEC §13.3): commands it refused, and any
   * queued after them, are discarded unapplied; a halted world may continue as ordinary unrecorded
   * authoring; and the record is finalized from the captured final address. Idempotent.
   */
  resolveStop(): void {
    if (this.live.halted) {
      this.controller.discardPending();
      this.live.releaseHalt();
    }
    if (this.recorder?.closed && !this.finalizing) this.finish(this.recorder);
  }

  private finish(recorder: RunRecorder): void {
    this.stopReason = recorder.closed!.reason;
    this.context += 1;
    // Presentation is not a command: the laws the recording created keep the names and colors the
    // authored scene gives them now, at the record's end, so a replay can show them (SPEC §13.3).
    const createdLaws = recorder.createdLaws().map((id) => this.controller.presentationOf(id));
    this.finalizing = recorder.record(createdLaws).then(
      (record) => {
        this.record = record;
        this.exported = false;
        this.recorder = null;
        this.finalizing = null;
        return record;
      },
      (error: unknown) => {
        this.recorder = null;
        this.finalizing = null;
        throw error;
      },
    );
  }

  /**
   * Waits for the record being finalized, if any. A recorder that has just closed itself at a limit is
   * resolved here at once, rather than when its scheduled resolution runs, so no caller can see the
   * previous record in between.
   */
  settled(): Promise<RunRecord | null> {
    this.resolveStop();
    return this.finalizing ?? Promise.resolve(this.record);
  }

  /** Forgets the finalized record, its replay and its checkpoints; the caller has protected it if it was unexported. */
  dropRecord(): void {
    this.closeComparison();
    this.disposeReplay();
    this.selected = 'authoring';
    this.forgetCheckpoints(this.record);
    this.record = null;
    this.exported = false;
  }

  private forgetCheckpoints(record: RunRecord | null): void {
    const scope = record && this.scopes.get(record);
    if (scope) this.checkpoints.discardHistory(scope.historyContextId);
  }

  /**
   * Enters replay of the finalized record (SPEC §13.2): the authoring world is settled and retained as
   * it is; a separate world is built from the record's frozen root at (0, 0), paused.
   */
  enterReplay(): LinearReplay {
    if (this.comparison) throw new Error('Close comparison before replaying the source recording.');
    if (!this.record) throw new Error('There is no finished recording to replay.');
    if (this.recordingState !== 'recorded') throw new Error('Stop the recording before replaying it.');
    this.controller.settle();
    this.disposeReplay();
    try {
      this.replay = new LinearReplay(this.record);
    } catch (error) {
      // Nothing to show: the authoring context is selected again, as it was kept.
      this.selected = 'authoring';
      throw error;
    }
    this.selected = 'replay';
    return this.replay;
  }

  /** Replay from Start: the replay world is discarded and rebuilt from the original root; authoring is untouched. */
  restartReplay(): LinearReplay {
    if (this.selected !== 'replay') throw new Error('Not replaying.');
    return this.enterReplay();
  }

  /** Return to authoring: the replay world is freed and the retained authoring context selected again, paused. */
  returnToAuthoring(): void {
    this.closeComparison();
    this.disposeReplay();
    this.selected = 'authoring';
  }

  private disposeReplay(): void {
    this.cancelSeek();
    this.replay?.dispose();
    this.replay = null;
    this.unitOpen = false;
  }

  /**
   * Advances the selected replay by up to `units` forward units (SPEC §13.3): a unit settles the
   * current boundary's recorded commands, or steps once and settles the next boundary. Work stops at
   * `deadline` between chunks of commands; a unit cut short resumes on the next call without stepping,
   * so physics never advances before its boundary is fully settled. `units` may be 0 to finish one.
   * `stepped` runs right after each transition, before the new boundary's commands: an observer of the
   * step (probes, trails) sees the laws that step used, as a live observer does. While a seek is pending
   * nothing advances, not even a unit cut short: the displayed replay stays exactly as it is until the
   * seek is canceled or its world replaces it (SPEC §14.2).
   */
  advanceReplay(units: number, deadline: number, now: () => number, stepped?: () => void): { complete: boolean; partial: boolean } {
    const replay = this.replay;
    if (!replay || this.selected !== 'replay') return { complete: false, partial: false };
    if (this.job) return { complete: replay.complete, partial: this.replayPartial };
    let remaining = units;
    for (;;) {
      if (replay.complete) {
        this.unitOpen = false;
        return { complete: true, partial: false };
      }
      if (!this.unitOpen) {
        if (remaining === 0) return { complete: false, partial: false };
        remaining -= 1;
        this.unitOpen = true;
        if (!replay.hasUnsettled) {
          replay.step();
          this.capture(replay);
          stepped?.();
        }
      }
      do replay.settle(CHUNK);
      while (replay.hasUnsettled && now() < deadline);
      if (replay.hasUnsettled) return { complete: false, partial: true };
      this.unitOpen = false;
    }
  }

  /** True while a replay unit's boundary is only partly settled: its address is not a recorded state to show as final. */
  get replayPartial(): boolean {
    return this.unitOpen && (this.replay?.hasUnsettled ?? false);
  }

  /** At the frozen endpoint: the replay's state and engine digests against the recorded final check. */
  async checkReplay(): Promise<FinalCheckResult> {
    const replay = this.replay;
    if (!replay?.complete) throw new Error('The replay has not reached its final address.');
    const check = replay.record.finalCheck;
    if (!check) return { kind: 'unavailable' };
    const [state, engine] = await Promise.all([sha256Hex(JSON.stringify(replay.host.futureState())), sha256Hex(replay.host.engineSnapshot())]);
    const stateOk = state === check.stateSha256;
    const engineOk = engine === check.engineSha256;
    return stateOk && engineOk ? { kind: 'match' } : { kind: 'mismatch', state: stateOk, engine: engineOk };
  }

  /** Whether the selected replay's record is an exactness claim here: recorded in this identity, in the shipped build. */
  get replayQualified(): boolean {
    return this.replay !== null && qualified(this.replay.record.qualification);
  }

  // ------------------------------------------------------------------ import (SPEC §15.2)

  /**
   * Builds one unstepped candidate replay world for a validated record; throws, allocating nothing, if it
   * cannot. A running recording refuses here, while the import is still transactional, not at commit.
   */
  prepareImport(record: RunRecord): LinearReplay {
    if (this.candidates > 0) throw new Error('An import is already being prepared.');
    if (this.recordingState === 'recording' || this.recordingState === 'finalizing') throw new Error('Finish the running recording before opening another.');
    this.comparison?.cancel();
    const candidate = new LinearReplay(record);
    this.candidates += 1;
    return candidate;
  }

  /** A failed or canceled import: the candidate is freed and nothing else changes. */
  discardImport(candidate: LinearReplay): void {
    candidate.dispose();
    this.candidates -= 1;
  }

  /** Promotes the candidate: it becomes the selected replay of the record it was built from, and the displaced replay is freed. */
  commitImport(candidate: LinearReplay): void {
    if (this.recordingState === 'recording' || this.recordingState === 'finalizing') throw new Error('Finish the running recording before opening another.');
    this.candidates -= 1;
    this.closeComparison();
    this.disposeReplay();
    if (this.record !== candidate.record) this.forgetCheckpoints(this.record);
    this.replay = candidate;
    this.record = candidate.record;
    this.exported = true;
    this.stopReason = candidate.record.stopped;
    this.selected = 'replay';
  }

  /** Resource accounting (SPEC §18.2, T11): worlds allocated now and at peak, the contexts holding them, and the checkpoint cache. */
  counts(): {
    worlds: number;
    peakWorlds: number;
    authoring: number;
    replay: number;
    candidates: number;
    seeking: number;
    checkpoints: number;
    checkpointBytes: number;
    selected: Selected;
    recording: RecordingState;
    comparison: ReturnType<Comparison['counts']> | null;
  } {
    const { allocated, peak } = worldCounts();
    return {
      worlds: allocated,
      peakWorlds: peak,
      authoring: 1,
      replay: this.replay ? 1 : 0,
      candidates: this.candidates,
      seeking: this.job?.work ? 1 : 0,
      checkpoints: this.checkpoints.size,
      checkpointBytes: this.checkpoints.bytes,
      selected: this.selected,
      recording: this.recordingState,
      comparison: this.comparison?.counts() ?? null,
    };
  }

  // ------------------------------------------------------------------ checkpoints and seeking (SPEC §14.2)

  /** The checkpoint key of `record`'s replays: its own history context, its prefixes, this build and this runtime. */
  scope(record: RunRecord): CheckpointScope {
    let scope = this.scopes.get(record);
    if (!scope) {
      scope = Object.freeze({
        record,
        historyContextId: `record-${++this.histories}`,
        prefixes: new PrefixIdentities(record),
        simulationFingerprint: compactJson(SIMULATION_FINGERPRINT),
        qualificationIdentity: compactJson(this.options.identity()),
      });
      this.scopes.set(record, scope);
    }
    return scope;
  }

  /**
   * Right after a replay world's step onto a 240th tick, before that boundary's commands: its complete
   * checkpoint there, unless the cache already holds one. That address serves every target at the tick.
   */
  private capture(world: ReplayWorld): void {
    const { host } = world;
    if (host.tick === 0 || host.tick % CHECKPOINT_TICKS !== 0) return;
    const scope = this.scope(world.record);
    if (this.checkpoints.has(scope, world.address)) return;
    const checkpoint = captureCheckpoint(host, scope);
    const { stored, evicted } = this.checkpoints.put(checkpoint);
    this.options.onCheckpoint?.(stored ? { kind: 'captured', checkpoint, evicted, bytes: this.checkpoints.bytes, count: this.checkpoints.size } : { kind: 'declined', checkpoint });
  }

  /** The seek in progress, if any. */
  get seeking(): SeekJob | null {
    return this.job;
  }

  /**
   * Requests the replay's state at `target`, an address on its record's path (SPEC §14.2). A pending seek
   * is canceled. Null when the displayed replay already holds exactly that settled address: nothing to do.
   */
  seek(target: Address): SeekJob | null {
    const replay = this.replay;
    if (!replay || this.selected !== 'replay') throw new Error('Seeking needs a replay.');
    if (!onPath(replay.record, target)) throw new Error(`(${target.tick}, ${target.cursor}) is not on the recording’s path`);
    this.cancelSeek();
    if (!this.replayPartial && compareAddress(replay.address, target) === 0) return null;
    this.job = { id: ++this.jobs, target: Object.freeze({ tick: target.tick, cursor: target.cursor }), record: replay.record, source: null, work: null, batches: 0, workMs: 0, restoreMs: 0, steps: 0, rejected: [] };
    return this.job;
  }

  /** Cancels the pending seek, freeing its world; the displayed replay is as it was. */
  cancelSeek(): SeekJob | null {
    const job = this.job;
    if (!job) return null;
    this.job = null;
    job.work?.dispose();
    job.work = null;
    return job;
  }

  /**
   * One batch of the pending seek, until `deadline`: choose its source, then replay forward on the record's
   * path, capturing checkpoints as it passes them. On reaching the target exactly, the reconstructed world
   * becomes the displayed replay and the displaced one is freed.
   */
  seekWork(deadline: number, now: () => number): SeekStatus {
    const job = this.job;
    if (!job) return { kind: 'idle' };
    const start = now();
    try {
      if (!job.work) this.beginSeek(job, now);
      const reached = this.seekForward(job, deadline, now);
      job.batches += 1;
      job.workMs += now() - start;
      if (!reached) return { kind: 'working', job, progress: this.seekProgress(job) };
    } catch (error) {
      this.cancelSeek();
      return { kind: 'failed', job, error };
    }
    this.job = null;
    const displaced = this.replay;
    this.replay = job.work;
    job.work = null;
    displaced?.dispose();
    this.unitOpen = false;
    return { kind: 'committed', job };
  }

  /** How far the pending seek has come from its source, 0 to 1, counting both ticks and commands. */
  seekProgress(job: SeekJob): number {
    if (!job.work || !job.source) return 0;
    const from = job.source.address;
    const at = job.work.address;
    const total = job.target.tick - from.tick + (job.target.cursor - from.cursor);
    return total === 0 ? 1 : (at.tick - from.tick + (at.cursor - from.cursor)) / total;
  }

  /**
   * The closest usable checkpoint at or before the target, restored into a new world; a corrupt or
   * inconsistent one discards its record's cache. With none, the record's root, as M6A replays it.
   */
  private beginSeek(job: SeekJob, now: () => number): void {
    const start = now();
    const scope = this.scope(job.record);
    for (let checkpoint = this.checkpoints.nearest(scope, job.target); checkpoint; checkpoint = this.checkpoints.nearest(scope, job.target)) {
      try {
        // The checksum is checked before Rapier reads a byte: corrupt bytes never reach its deserializer.
        if (!intact(checkpoint)) throw new Error('its bytes changed after capture');
        job.work = new RestoredReplay(job.record, checkpoint);
        job.source = { kind: 'checkpoint', address: { tick: checkpoint.tick, cursor: checkpoint.lastAppliedSequence } };
        break;
      } catch (error) {
        const reason = `checkpoint at (${checkpoint.tick}, ${checkpoint.lastAppliedSequence}): ${error instanceof Error ? error.message : String(error)}`;
        job.rejected.push(reason);
        // Discarded whether or not anyone listens: the loop ends only once no checkpoint of this record is left to try.
        const discarded = this.checkpoints.discardHistory(scope.historyContextId);
        this.options.onCheckpoint?.({ kind: 'rejected', reason, discarded });
      }
    }
    if (!job.work) {
      job.work = new LinearReplay(job.record);
      job.source = { kind: 'root', address: { tick: 0, cursor: 0 } };
    }
    job.restoreMs = now() - start;
  }

  /** Forward on the record's path toward the target, until it is reached or `deadline` passes. */
  private seekForward(job: SeekJob, deadline: number, now: () => number): boolean {
    const work = job.work!;
    const { target } = job;
    for (;;) {
      const at = work.address;
      if (at.tick === target.tick && at.cursor === target.cursor) return true;
      if (at.tick === target.tick) work.settle(Math.min(CHUNK, target.cursor - at.cursor));
      else if (work.hasUnsettled) work.settle(CHUNK);
      else {
        work.step();
        job.steps += 1;
        this.capture(work);
      }
      if (now() >= deadline) {
        const end = work.address;
        return end.tick === target.tick && end.cursor === target.cursor;
      }
    }
  }
}
