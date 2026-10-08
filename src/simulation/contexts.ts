// The run coordinator (SPEC §13.2): the one owner of the authoring context, the recording, the replay
// context and an import's candidate, and of every transition between them. Only the selected context
// advances. In steady replay the retained authoring world stays paused and untouched beside one
// root-built replay world; a serialized import may add one unstepped candidate (a peak of three).
import type { DocumentController } from '../domain/document';
import { cloneFrozen, deepFreeze, type SceneDocument } from '../domain/scene';
import { qualified, type QualificationIdentity, type RunRecord, type StopReason } from '../persistence/runFile';
import { createDocument } from '../persistence/sceneFile';
import { worldCounts, type SimulationHost } from './host';
import { RunRecorder, sha256Hex } from './recorder';
import { LinearReplay } from './replay';

export type Selected = 'authoring' | 'replay';

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
  replay: LinearReplay | null = null;
  selected: Selected = 'authoring';
  /**
   * The live history context (SPEC §13.3): a new value whenever a recording starts or stops, so a
   * closed record and the live continuation after it never share an identity.
   */
  context = 0;
  /** Import candidates allocated now (at most one: imports are serialized). */
  candidates = 0;
  /** A replay unit whose boundary is still being settled across frames. */
  private unitOpen = false;

  constructor(private readonly options: RunCoordinatorOptions) {
    this.controller = options.controller;
  }

  /** The authoring world: the one the document's commands go to, retained paused during replay. */
  get live(): SimulationHost {
    return this.controller.liveHost;
  }

  /** The world displayed and advanced: the replay's when replay is selected. */
  get shown(): SimulationHost {
    return this.selected === 'replay' && this.replay ? this.replay.host : this.live;
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
    RunRecorder.check(root, this.options.identity(), runId);
    this.dropRecord();
    controller.reset(semantic);
    const recorder = new RunRecorder(this.live, root, this.options.identity(), runId);
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
    this.finalizing = recorder.record().then(
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

  /** Forgets the finalized record and its replay; the caller has protected it if it was unexported. */
  dropRecord(): void {
    this.disposeReplay();
    this.selected = 'authoring';
    this.record = null;
    this.exported = false;
  }

  /**
   * Enters replay of the finalized record (SPEC §13.2): the authoring world is settled and retained as
   * it is; a separate world is built from the record's frozen root at (0, 0), paused.
   */
  enterReplay(): LinearReplay {
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
    this.disposeReplay();
    this.selected = 'authoring';
  }

  private disposeReplay(): void {
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
   * step (probes, trails) sees the laws that step used, as a live observer does.
   */
  advanceReplay(units: number, deadline: number, now: () => number, stepped?: () => void): { complete: boolean; partial: boolean } {
    const replay = this.replay;
    if (!replay || this.selected !== 'replay') return { complete: false, partial: false };
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
        if (replay.unsettled === 0) {
          replay.step();
          stepped?.();
        }
      }
      do replay.settle(CHUNK);
      while (replay.unsettled > 0 && now() < deadline);
      if (replay.unsettled > 0) return { complete: false, partial: true };
      this.unitOpen = false;
    }
  }

  /** True while a replay unit's boundary is only partly settled: its address is not a recorded state to show as final. */
  get replayPartial(): boolean {
    return this.unitOpen && (this.replay?.unsettled ?? 0) > 0;
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

  /** Builds one unstepped candidate replay world for a validated record; throws, allocating nothing, if it cannot. */
  prepareImport(record: RunRecord): LinearReplay {
    if (this.candidates > 0) throw new Error('An import is already being prepared.');
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
    this.disposeReplay();
    this.replay = candidate;
    this.record = candidate.record;
    this.exported = true;
    this.stopReason = candidate.record.stopped;
    this.selected = 'replay';
  }

  /** Resource accounting (SPEC §18.2, T11): worlds allocated now and at peak, and the contexts holding them. */
  counts(): { worlds: number; peakWorlds: number; authoring: number; replay: number; candidates: number; selected: Selected; recording: RecordingState } {
    const { allocated, peak } = worldCounts();
    return { worlds: allocated, peakWorlds: peak, authoring: 1, replay: this.replay ? 1 : 0, candidates: this.candidates, selected: this.selected, recording: this.recordingState };
  }
}
