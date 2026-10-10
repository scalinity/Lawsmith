import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Euler, Quaternion, Vector3, type Mesh, type Object3D } from 'three/webgpu';
import { DocumentController } from './domain/document';
import { expressionSummary, isCompound, type Edited } from './domain/ingredients';
import { EDGE_FADE, LAW_COLORS, checkCamera, cloneFrozen, defaultLawPresentation, type FieldDefinition, type LawPresentation, type Primitive, type SceneDocument, type Vec3 } from './domain/scene';
import { expressionStats, walk } from './fields/expression';
import { FIELD_KERNEL_VERSION, fadeBand } from './fields/kernel';
import { PRIMITIVES, REGIONS, primitiveDescriptor, regionDescriptor, type PrimitiveKind, type RegionKind, type ScalarControl } from './fields/registry';
import { LawInteraction, type GestureEnd, type TransformMode } from './interaction/lawGesture';
import { EditLatency, percentile, percentiles } from './measurement';
import { defaultDocument } from './persistence/defaultScene';
import { nativeIo } from './persistence/io';
import { createDocument, semanticDigest } from './persistence/sceneFile';
import { DocumentWorkflow, type RecoveryOffer } from './persistence/workflow';
import { identifyBackend, isQualifiedWebGPU, probeRenderedPixels, watchGPUErrors } from './rendering/backend';
import { createRenderer, createViewport, MAX_PIXEL_RATIO } from './rendering/viewport';
import { createComparisonView } from './rendering/comparisonView';
import { comparisonQualification } from './simulation/comparisonFixtures';
import { COMPARISON_LIMITS, type BaselineJob } from './simulation/comparison';
import { createWorldView, type PreparedScene } from './rendering/worldView';
import { checkProbeSettings, ProbeField, type ProbeSettings } from './observation/probes';
import { TrailRecorder, type TrailMode } from './observation/trails';
import { pairedBody } from './observation/comparison';
import { createExplainView, type ExplainLabel } from './rendering/explainView';
import {
  compareRuns,
  explanationFixture,
  observedResetFixture,
  runAtCadence,
  runFixedSteps,
  runResetFixture,
  scriptedEdits,
  trailFidelity,
  visualizationInvariance,
} from './simulation/fixtures';
import { SIMULATION_PROFILE, STEP_SECONDS, SimulationFault, SimulationHost, initSimulation, resetPeakWorlds, worldCounts, xorshift32 } from './simulation/host';
import { RUN_LIMITS, parseRun, qualificationIdentity, qualified, type RunRecord, type StopReason } from './persistence/runFile';
import { canResetScene, RunCoordinator, type CheckpointEvent, type FinalCheckResult, type SeekJob, type SeekStatus } from './simulation/contexts';
import { SIMULATION_FINGERPRINT, exportRun } from './simulation/recorder';
import { LinearReplay, firstDivergence as replayDivergence, observe, type Address, type Observed } from './simulation/replay';
import type { TransitionObservation } from './simulation/observation';
import { driveScheduledFrame, FixedStepScheduler } from './simulation/scheduler';
import { fnv64 } from './simulation/checkpoints';
import { createBodyPanel, type ExplainViewMode } from './ui/bodyPanel';
import { createIngredientPanel } from './ui/ingredientPanel';
import { ingredientBreakdown } from './simulation/observation';

const mode = import.meta.env.DEV ? 'dev' : 'packaged';
// Dev-only fault injection for the controlled-failure check; compiled out of production builds.
const fault: string = import.meta.env.DEV ? (import.meta.env.VITE_LAWSMITH_FAULT ?? '') : '';
const INIT_TIMEOUT_MS = 10_000;
const STEP_MS = STEP_SECONDS * 1000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Facts gathered during startup, shown verbatim if startup fails. */
const facts: Record<string, unknown> = {
  mode,
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  navigatorGpu: 'gpu' in navigator,
};

/** Qualification record line: browser console plus the native shell's stderr. `kind`, `mode` and `t` are written last, so event data cannot overwrite them. */
function report(kind: string, data: Record<string, unknown>) {
  const line = JSON.stringify(Object.assign({ kind }, data, { kind, mode, t: Math.round(performance.now()) }));
  console.info(line);
  invoke('report', { line }).catch(() => {});
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not finish within ${INIT_TIMEOUT_MS / 1000} s.`)), INIT_TIMEOUT_MS),
    ),
  ]);
}

function showFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  report('failure', { message, facts });
  for (const id of ['status', 'tools', 'diagnostics', 'panel', 'transport', 'overlays', 'run']) $(id).hidden = true;
  $('failure-summary').textContent = message;
  $('failure-detail').textContent = JSON.stringify(facts, null, 2);
  $('failure').hidden = false;
}

const ms = (value: number) => value.toFixed(1);
const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** Keeps the last `limit` values. */
function pushBounded(values: number[], value: number, limit: number) {
  values.push(value);
  if (values.length > limit) values.shift();
}

/** The smallest nonzero step of `performance.now()`, so quantized timings are read correctly. */
function timerResolutionMs(): number {
  let smallest = Infinity;
  let last = performance.now();
  const until = last + 20;
  for (let now = last; now < until; now = performance.now()) {
    if (now > last) {
      smallest = Math.min(smallest, now - last);
      last = now;
    }
  }
  return round3(smallest);
}

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const lawSummary = (f: FieldDefinition) => ({
  id: f.id,
  enabled: f.enabled,
  position: f.pose.position,
  rotation: f.pose.rotation,
  region: f.region,
  edgeFade: f.edgeFade,
  expression: f.expression,
});
const BUSY_TEXT: Record<string, string> = {
  save: 'Saving…',
  'save-as': 'Saving…',
  open: 'Opening…',
  new: 'Starting a new scene…',
  recover: 'Recovering…',
  'save-recording': 'Saving the recording…',
  'open-recording': 'Opening the recording…',
  record: 'Starting a recording…',
  'discard-recovery': 'Discarding recovered work…',
  close: 'Closing…',
  quit: 'Quitting…',
};
const DEGREES = 180 / Math.PI;
/** Run checkpoints for native evidence: the state digests at every 240th settled boundary of a recording and of its replay. */
const CHECKPOINT_TICKS = 240;
/** A replay frame's work budget, and a seek batch's: commands apply in chunks between checks, and the rest wait. */
const REPLAY_BUDGET_MS = 8;
/** A seek shows its progress, and can be canceled, once it has run this long (SPEC §14.2). */
const SEEK_PROGRESS_MS = 100;

/** How a requested seek ended, for whoever asked for it. */
interface SeekOutcome {
  readonly action: 'committed' | 'canceled' | 'superseded' | 'failed';
  /** From the request to its end (for a commit, to the world's swap). */
  readonly elapsedMs: number;
  readonly job: SeekJob;
  /** Each batch's time on the main thread, ms. */
  readonly batches: readonly number[];
  /** When progress and Cancel became visible, ms after the request; null if they never did. */
  readonly progressShownAfter: number | null;
  /** For a commit: ms from the request to the first frame submitted with its world; null if another world was shown first. */
  readonly drawn: Promise<number | null>;
}

/** A committed seek waiting for its first frame (SPEC §18's frame submission), by its world's generation. */
interface DrawWait {
  readonly id: number;
  readonly generation: number;
  readonly requestedAt: number;
  readonly resolve: (ms: number | null) => void;
}

/** A seek the app is waiting on (SPEC §14.2): when it was asked for, and how its batches went. */
interface PendingSeek {
  readonly job: SeekJob;
  readonly reason: string;
  readonly requestedAt: number;
  /** Each batch's time on the main thread, ms. */
  readonly batches: number[];
  /** When progress and Cancel became visible, ms after the request; null before. */
  progressShownAfter: number | null;
  /** Play was pressed while it reconstructed: it plays from its target once it holds it. */
  playOnCommit: boolean;
  readonly done: (outcome: SeekOutcome) => void;
}

/** The address the timeline means by tick n: after the commands the record includes at n (SPEC §13.3). */
function tickAddress(record: RunRecord, n: number): Address {
  // The first command after tick n, by binary search: commands are in tick order.
  let lo = 0;
  let hi = record.commands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (record.commands[mid]!.atTick <= n) lo = mid + 1;
    else hi = mid;
  }
  return { tick: n, cursor: lo };
}
const LIMIT_TEXT: Record<'duration' | 'commands' | 'bytes', string> = {
  duration: 'The recording stopped at its 60-second limit. The scene is paused there; editing goes on unrecorded.',
  commands: 'The recording stopped at its limit of 50,000 recorded changes. Your last change was not applied; make it again to keep editing, unrecorded.',
  bytes: 'The recording stopped at its 16 MiB size limit. Your last change was not applied; make it again to keep editing, unrecorded.',
};

/**
 * The frontend bundle actually executing (SPEC §13.1): its file name and the SHA-256 of its bytes, read
 * back from the packaged app's own asset origin. Nothing is embedded, so nothing hashes itself.
 */
async function frontendBundle(): Promise<string> {
  if (mode !== 'packaged') return 'unbundled: development server';
  try {
    const url = new URL(import.meta.url);
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    return `${url.pathname.split('/').pop()} sha256:${await sha256(bytes)}`;
  } catch (error) {
    return `unavailable: ${String(error)}`;
  }
}

async function start() {
  const begin = performance.now();
  facts.runtime = await withTimeout(invoke<Record<string, string>>('runtime_identity'), 'Native runtime identity').catch(
    (e: unknown) => `unavailable: ${String(e)}`,
  );
  const timerMs = timerResolutionMs();
  report('runtime', { ...facts, userAgent: navigator.userAgent, timerResolutionMs: timerMs });
  const identity = qualificationIdentity(facts.runtime, await frontendBundle(), mode);
  report('qualification', { identity, qualified: qualified(identity), fingerprint: SIMULATION_FINGERPRINT });

  const renderer = await withTimeout(createRenderer($('viewport'), fault === 'webgl'), 'WebGPU renderer initialization');
  const backend = identifyBackend(renderer);
  facts.backend = backend;
  report('backend', { ...backend });
  if (!isQualifiedWebGPU(backend)) {
    renderer.domElement.remove();
    throw new Error(`Lawsmith requires WebGPU, but the renderer selected the ${backend.backend} backend.`);
  }
  const gpuErrors: string[] = [];
  watchGPUErrors(renderer, (message) => {
    gpuErrors.push(message);
    report('gpu-error', { message });
  });
  const rendererReady = performance.now();

  const simulation = await withTimeout(
    fault === 'rapier-hang' ? new Promise<never>(() => {}) : initSimulation(),
    'Rapier WASM initialization',
  );
  facts.rapier = simulation.rapierVersion;
  report('rapier', {
    version: simulation.rapierVersion,
    profile: SIMULATION_PROFILE.id,
    fieldKernel: FIELD_KERNEL_VERSION,
    effectiveProfile: simulation.effectiveProfile,
  });
  const simulationReady = performance.now();

  // Authority: the host owns the world; the document controller owns the authored document. A
  // committed import replaces the host, so everything reads it through this binding.
  const initial = defaultDocument();
  let host = new SimulationHost(cloneFrozen(initial.semantic));
  const authoring = new DocumentController(initial, host);
  // One coordinator owns the authoring context, the recording and the replay context (SPEC §13.2).
  // `host` is the world displayed and advanced: the replay's while replaying, otherwise the live one.
  const runs = new RunCoordinator({ controller: authoring, identity: () => identity, onLimit: (reason) => recordingLimited(reason), onCheckpoint: (event) => reportCheckpoint(event) });
  const replaying = () => runs.selected === 'replay';
  const comparing = () => runs.selected === 'comparison';
  const editor = () => runs.comparison?.controller ?? authoring;
  const readOnly = () => replaying() || !!runs.comparison?.replaying;
  const scheduler = new FixedStepScheduler(STEP_MS);
  const appliedLaw = (id: string) => host.appliedFields().find((f) => f.id === id);
  /**
   * A law's names and colors in the displayed context: a replay shows its root's, and for laws the
   * recording created the ones its record carries, never the newer authored ones.
   */
  const lawPresentation = (id: string): LawPresentation => {
    if (!replaying()) return editor().presentationOf(id);
    const record = runs.replay?.record;
    return record?.root.presentation.laws.find((p) => p.id === id) ?? record?.createdLaws.find((p) => p.id === id) ?? defaultLawPresentation(id);
  };

  const viewport = createViewport(renderer, report);
  const world = createWorldView(viewport.scene, initial.semantic);

  // Explanation (SPEC §12) is visualization state: the explained body, probes, trails and which laws
  // draw arrows. None of it enters the document, the run root or the host's computation.
  const explainView = createExplainView(viewport.scene);
  const probes = new ProbeField();
  const trails = new TrailRecorder('selected');
  let explained: string | null = null;
  let explainMode: ExplainViewMode = 'applied';
  let arrowScope: 'all' | 'selected' = 'all';

  // Edit latency (SPEC §18): accepted edit → first frame submitted with its applied revision.
  let editLatency = new EditLatency();
  /** Final revisions of gestures and toggles, reported once the host applies them. */
  const awaited = new Set<number>();
  const submit = (candidate: FieldDefinition, transactionId: string) => {
    const result = editor().putField(candidate, transactionId);
    if (result.ok) editLatency.accept(result.value.revision, performance.now());
    return result;
  };

  /**
   * Edits are frozen while the guard decides, and from launch until launch recovery is answered, so
   * nothing can save or write recovery over an earlier session's work before the user chooses.
   */
  let frozen = false;
  let guardFrozen = false;
  /** The seek the replay is reconstructing out of sight, if any (SPEC §14.2); see requestSeek. */
  let pendingSeek: PendingSeek | null = null;
  /** The last committed seek, until a frame is submitted with its world. */
  let drawWait: DrawWait | null = null;
  let launchPending = true;
  let cameraMoved = false;
  const applyFreeze = () => {
    frozen = guardFrozen || launchPending;
    for (const id of ['panel', 'tools', 'transport', 'overlays', 'run', 'comparison']) $(id).inert = frozen;
    // Replay is read-only (SPEC §13.2): its laws are inspected, never edited; playback and the camera still work.
    const locked = readOnly();
    document.body.dataset.context = comparing() ? 'comparison' : replaying() ? 'replay' : 'authoring';
    for (const id of ['details', 'law-shelf']) $(id).inert = locked;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.disabled = locked;
    $<HTMLButtonElement>('reset').disabled = locked || comparing();
    $<HTMLButtonElement>('arrows-toggle').disabled = locked;
    $('reset').title = locked ? 'Reset restarts your authored scene. Return to authoring to use it.' : '';
    viewport.gizmo.enabled = !frozen && !locked;
    viewport.gizmo.getHelper().visible = !locked;
  };
  applyFreeze();

  // The selected law's ingredient editor. Its edits run through editExpression, an authoring command
  // defined further down, so the call is deferred to the moment an edit happens.
  const ingredientPanel = createIngredientPanel({
    edit: (label, change, input) => editExpression(label, change, input),
    onFocus: () => report('ingredient-focus', ingredientPanel.state()),
  });

  const interaction = new LawInteraction(
    {
      canvas: renderer.domElement,
      dragRegion: $('drag-region'),
      camera: viewport.camera,
      gizmo: viewport.gizmo,
      orbit: viewport.orbit,
      proxy: viewport.proxy,
      appliedField: (id) => appliedLaw(id),
      pickable: () => host.appliedFields().filter((f) => lawPresentation(f.id).visible),
      submit,
      transaction: () => editor().newTransaction(),
      onGestureEnd: (end) => gestureEnded(end),
      onSelectionChange: () => renderPanel(),
      clickBody: (x, y) => {
        const id = bodyAt(x, y);
        if (id === null) return false;
        setExplained(id, 'click');
        return true;
      },
      haltCamera: () => viewport.haltInertia(),
      editable: () => !frozen && !readOnly(),
      // The ingredient being edited brings its own handles (M5).
      focus: () => ingredientPanel.focus,
      log: report,
    },
    initial.semantic.fields[0]?.id ?? null,
  );

  /** One completed drag is one author-undo entry, ending at what the host applied; a cancel restored its start and records nothing. */
  const gestureEnded = (end: GestureEnd) => {
    editor().endGesture(end.label, end.start, end.transactionId);
    awaitApplied(end.revision);
    edited();
  };

  /** Reports a change once the host has applied it; a gesture's last preview may already be applied at release. */
  const awaitApplied = (revision: number | null) => {
    if (revision === null) return;
    if (revision <= editor().appliedRevision) {
      report('law-applied', { revision, appliedRevision: editor().appliedRevision, tick: host.tick, sequence: host.lastAppliedSequence });
    } else {
      awaited.add(revision);
    }
  };

  let runIndex = 0;
  let editsSinceReset = 0;
  /** The P0 capture in progress, if any (see startP0). */
  let p0: P0Capture | null = null;
  let p0Runs = 0;
  // Every acknowledgment is accounted here, whichever call adopted it: the frame loop, an edit, undo,
  // a digest report or a save all settle, and a revision missed here would read as superseded.
  authoring.onAcks = (acks) => {
    for (const ack of acks) {
      editsSinceReset += 1;
      editLatency.acknowledge(ack.documentRevision);
      for (const revision of awaited) {
        if (revision > ack.documentRevision) continue;
        awaited.delete(revision);
        report('law-applied', {
          revision,
          appliedRevision: ack.documentRevision,
          tick: ack.tick,
          sequence: ack.sequence,
          transactionId: ack.transactionId,
          field: ack.payload.kind === 'putField' ? lawSummary(ack.payload.field) : ack.payload.kind === 'removeField' ? { removed: ack.payload.id } : { ambient: ack.payload.acceleration },
        });
      }
    }
  };
  /** Adopts acknowledged edits into the authored scene; `onAcks` accounts for them. */
  const absorb = () => {
    if (!runs.comparison?.replaying) editor().sync();
  };
  /** Applies the authoring world's queued commands at its current boundary now (SPEC §10.2), as its next step would. */
  const settleNow = () => {
    if (runs.comparison) runs.comparison.settle();
    else authoring.settle();
  };

  /** Digests of a world's future-affecting state at a settled boundary, for comparing a recording with its replay natively. */
  const runCheckpoint = (source: 'live' | 'replay', world: SimulationHost, runId: string) => {
    const { tick, lastAppliedSequence: cursor, count: bodies } = world;
    const state = JSON.stringify(world.futureState());
    const engine = world.engineSnapshot();
    Promise.all([sha256(state), sha256(engine)]).then(([stateSha256, engineSha256]) => report('run-checkpoint', { source, runId, tick, cursor, bodies, stateSha256, engineSha256 }));
  };

  // Exact-run evidence from the live loop: digests at ticks 600 and 1200 of every run.
  const captureDigest = () => {
    const run = runIndex;
    const tick = host.tick;
    const edits = editsSinceReset;
    const bodies = host.count;
    const state = JSON.stringify(host.canonicalState());
    const engine = host.engineSnapshot();
    Promise.all([sha256(state), sha256(engine)]).then(([stateSha256, engineSha256]) =>
      report('run-digest', { run, tick, editsSinceReset: edits, bodies, stateSha256, engineSha256 }),
    );
  };

  /** The semantic digest of the settled document, so the log shows what a presentation edit did not change. */
  const reportDigest = (reason: string) => {
    const snapshot = editor().snapshot(editor().camera);
    const generation = editor().generation;
    semanticDigest(createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation)).then((semantic) =>
      report('digest', { reason, generation, revision: snapshot.revision, semanticSha256: semantic }),
    );
  };

  const showSimError = (message: string, offerReset: boolean) => {
    $('sim-error-text').textContent = message;
    $('sim-error-reset').hidden = !offerReset;
    $('sim-error').hidden = false;
  };

  /** Whether playback is asked for: during a seek, whether it plays from its target once it holds it. */
  const requestedPlaying = () => pendingSeek?.playOnCommit ?? scheduler.playing;

  const setPlaying = (playing: boolean, reason: string) => {
    // The displayed replay stays paused while a seek is pending (SPEC §14.2): Play asks to play from the
    // target once the seek holds it; a pause, or a lifecycle pause, withdraws that.
    if (pendingSeek) {
      if (playing === pendingSeek.playOnCommit) return;
      pendingSeek.playOnCommit = playing;
      report('seek', { action: playing ? 'play-on-commit' : 'pause-on-commit', id: pendingSeek.job.id, reason });
      syncControls();
      renderPanel();
      return;
    }
    if (playing === scheduler.playing) return;
    if (playing && (host.fault || frozen || host.halted || (comparing() && !runs.comparison!.canAdvance))) return;
    // A replay at its frozen end stays there: Replay from Start, not Play, begins it again.
    if (playing && replaying() && runs.replay?.complete) return;
    if (playing) {
      runs.comparison?.resumeAlternate();
      scheduler.play();
      // A next-step preview is a paused view; motion shows each completed step instead.
      explainMode = 'applied';
    } else scheduler.pause();
    notePlaying(playing, reason);
  };
  /** Records a play-state change, including the scheduler's own pause on a gap. */
  const notePlaying = (playing: boolean, reason: string) => {
    if (p0 && !playing && !(p0.comparison && reason === 'comparison-horizon')) p0.invalid ??= `paused: ${reason}`;
    report('sim-control', { action: playing ? 'play' : 'pause', reason, tick: host.tick });
    syncControls();
  };

  /** Lifecycle pause (SPEC §10.1): stop, clear debt, cancel any gesture; Play stays explicit. */
  const pauseFor = (reason: string) => {
    setPlaying(false, reason);
    interaction.cancel(reason);
  };

  const onFault = (error: unknown) => {
    if (!(error instanceof SimulationFault)) throw error;
    setPlaying(false, 'fault');
    // A recording ends where its world faulted, without a final check (that world no longer holds it).
    if (!replaying() && runs.recordingState === 'recording') stopRecording('fault');
    report('simulation-fault', { tick: error.tick, entity: error.entity, reason: error.reason });
    // Reset restarts the authored scene, so a replay's fault does not offer it (as showContext does).
    showSimError(`${error.message}. The last valid frame is shown.`, canResetScene(runs.selected));
  };

  const stepTimes: number[] = [];
  const timedStep = () => {
    if (runs.recordingState === 'recording' && host.tick > 0 && host.tick % CHECKPOINT_TICKS === 0) runCheckpoint('live', host, runs.recorder!.runId);
    const t0 = performance.now();
    const before = host.tick;
    const completed = (steppedHost: SimulationHost) => {
      const t1 = performance.now();
      // Observe n→n+1 while the host still holds the laws used by that transition.
      probes.advance(steppedHost);
      const t2 = performance.now();
      trails.record(steppedHost, explained);
      const t3 = performance.now();
      pushBounded(stepTimes, t1 - t0, 480);
      if (p0?.phase === 'measure') {
        p0.steps.push(t1 - t0);
        if (probes.settings.enabled && probes.settings.count > 0) p0.probes.push(t2 - t1);
        if (trails.mode !== 'off') p0.trails.push(t3 - t2);
        p0.ticks.push(t3 - t0);
      }
    };
    if (comparing()) runs.comparison!.advance(completed);
    else { host.step(); if (host.tick !== before) completed(host); }
    if (comparing() && (runs.comparison!.atHorizon || !runs.comparison!.replaying && alternateWasReplaying)) {
      const replayCompleted = alternateWasReplaying && !runs.comparison!.replaying;
      alternateWasReplaying = false;
      setPlaying(false, runs.comparison!.atHorizon ? 'comparison-horizon' : 'alternate-replayed');
      applyFreeze();
      renderPanel();
      // Full baseline hashing is a paused replay diagnostic; keep it out of P3's horizon frame.
      report('comparison', { action: replayCompleted ? 'alternate-complete' : 'horizon-paused', playing: scheduler.playing, ...runs.comparison!.counts(), ...(replayCompleted ? { receipt: comparisonReceipt() } : {}) });
    }
    if (host.tick === before) return false;
    if (!comparing() && (host.tick === 600 || host.tick === 1200)) captureDigest();
    return true;
  };

  const stepOnce = () => {
    if (comparing() && !runs.comparison!.canAdvance) return;
    if (replaying()) {
      if (host.fault || frozen || runs.replay?.complete) return;
      setPlaying(false, 'step');
      if (pendingSeek) cancelPendingSeek('step');
      driveReplay(1);
      report('sim-control', { action: 'step', context: 'replay', tick: host.tick, cursor: host.lastAppliedSequence, partial: runs.replayPartial });
      return;
    }
    if (interaction.gesture || host.fault || frozen || host.halted) return;
    setPlaying(false, 'step');
    // The boundary settles before the step, as a frame's does, so a checkpoint here sees it settled.
    settleNow();
    runs.comparison?.resumeAlternate();
    try {
      timedStep();
    } catch (error) {
      onFault(error);
    }
    absorb();
    report('sim-control', { action: 'step', tick: host.tick });
  };

  const resetScene = () => {
    if (frozen || !canResetScene(runs.selected)) return;
    if (interaction.gesture) {
      report('sim-control', { action: 'reset-refused', reason: 'gesture active', tick: host.tick });
      return;
    }
    setPlaying(false, 'reset');
    // A reset begins a new configuration run: a recording in progress ends first, at its current address.
    if (runs.recordingState === 'recording') stopRecording('reset');
    settleNow();
    authoring.reset();
    runIndex += 1;
    editsSinceReset = 0;
    if (p0) p0.invalid ??= 'reset during capture';
    $('sim-error').hidden = true;
    report('sim-control', { action: 'reset', tick: host.tick, run: runIndex, laws: authoring.scene.fields.map(lawSummary) });
    syncControls();
  };

  // ------------------------------------------------------------------ document workflows

  /** The camera framing a save records: the live camera once the user has moved it, else the document's. */
  const savedCamera = () => {
    // During a replay the main authored scene's framing is the one kept when the replay began (SPEC §13.2).
    const kept = comparing() ? (authoringCamera ?? comparisonCamera) : replaying() ? authoringCamera : null;
    if (kept ? kept.moved : cameraMoved) {
      const p = viewport.camera.position;
      const t = viewport.orbit.target;
      const camera = kept ? { position: kept.position, target: kept.target } : { position: [p.x, p.y, p.z] as const, target: [t.x, t.y, t.z] as const };
      // A framing the file reader would refuse is never saved; the previous framing is kept.
      const problem = checkCamera(camera);
      if (problem) report('control', { camera: 'not-recorded', reason: problem });
      else authoring.setCamera(camera);
      if (kept) kept.moved = false;
      else cameraMoved = false;
    }
    return authoring.camera;
  };

  const applyCamera = (camera: SceneDocument['presentation']['camera']) => {
    if (camera) viewport.setView(camera.position, camera.target);
    else viewport.resetView();
    cameraMoved = false;
  };

  const workflow = new DocumentWorkflow(nativeIo, {
    controller: authoring,
    quiesce: (reason) => {
      setPlaying(false, reason);
      if (pendingSeek) cancelPendingSeek(reason);
      runs.comparison?.cancel();
      interaction.release(reason);
      settleNow();
    },
    freeze: (value) => {
      guardFrozen = value;
      applyFreeze();
      report('guard', { frozen: value, tick: host.tick });
    },
    gestureActive: () => interaction.gesture !== null,
    camera: savedCamera,
    // The candidate world and its view are both built before anything is replaced, so a failure
    // to prepare either leaves the current scene, undo history and world exactly as they were.
    candidate: (document) => {
      const candidateHost = new SimulationHost(cloneFrozen(document.semantic));
      let view: PreparedScene;
      try {
        // While a replay is shown its view holds the displayed bodies, so the new scene gets its own.
        view = world.prepareScene(document.semantic, replaying() || comparing());
      } catch (error) {
        candidateHost.dispose();
        throw error;
      }
      return {
        host: candidateHost,
        view,
        dispose: () => {
          candidateHost.dispose();
          world.discardScene(view);
        },
      };
    },
    commit: (document, candidate) => {
      setPlaying(false, 'load');
      restoreComparisonView();
      runs.closeComparison();
      // Replacing the scene context drops the recording and its replay, which the guard has protected.
      if (replaying() && authoringView) world.discardScene(world.swapScene(authoringView));
      authoringView = null;
      authoringCamera = null;
      runs.dropRecord();
      if (pendingSeek) endSeek(pendingSeek, 'canceled', { reason: 'load' });
      const displaced = authoring.liveHost;
      host = candidate.host;
      authoring.load(document, candidate.host);
      displaced.dispose();
      world.showScene(candidate.view);
      applyFreeze();
      applyCamera(document.presentation.camera);
      ingredientPanel.reset();
      interaction.select(document.semantic.fields[0]?.id ?? null);
      setExplained(null, 'load');
      editLatency = new EditLatency();
      awaited.clear();
      runIndex += 1;
      editsSinceReset = 0;
      if (p0) p0.invalid ??= 'scene replaced during capture';
      $('sim-error').hidden = true;
      report('sim-control', { action: 'load', tick: host.tick, playing: scheduler.playing, run: runIndex, laws: document.semantic.fields.map(lawSummary) });
      reportDigest('load');
    },
    runs,
    runExpectations: () => ({ fingerprint: SIMULATION_FINGERPRINT, identity }),
    // An imported run's world and its static view, both built before anything is replaced.
    runCandidate: (record) => {
      const replay = runs.prepareImport(record);
      let view: PreparedScene;
      try {
        view = world.prepareScene(record.root.semantic, true);
      } catch (error) {
        runs.discardImport(replay);
        throw error;
      }
      return {
        replay,
        view,
        dispose: () => {
          runs.discardImport(replay);
          world.discardScene(view);
        },
      };
    },
    commitRun: (record, candidate) => {
      setPlaying(false, 'open-recording');
      interaction.release('open-recording');
      // The coordinator commits first: it is the only step that can refuse, and then no view has moved.
      restoreComparisonView();
      runs.closeComparison();
      const fromReplay = replaying();
      runs.commitImport(candidate.replay);
      if (fromReplay) world.discardScene(world.swapScene(candidate.view));
      else {
        authoringView = world.swapScene(candidate.view);
        authoringCamera = stashCamera();
      }
      showContext('open-recording');
      report('recording', { action: 'opened', ...recordSummary(record) });
    },
    startRecording: () => {
      const recorder = runs.startRecording();
      runIndex += 1;
      editsSinceReset = 0;
      if (p0) p0.invalid ??= 'recording started during capture';
      $('sim-error').hidden = true;
      report('recording', { action: 'start', runId: recorder.runId, tick: host.tick, cursor: host.lastAppliedSequence, bytes: recorder.bytes, qualified: qualified(identity), laws: authoring.scene.fields.map(lawSummary) });
    },
    log: report,
    now: () => performance.now(),
    onChange: () => renderPanel(),
  });

  /** After any accepted authored edit: recovery follows after a short debounce, and the panel refreshes. */
  const edited = () => {
    if (!comparing()) workflow.edited();
    renderPanel();
  };

  /** Commits a field being typed in, then runs a file workflow. */
  const runFile = (action: 'open' | 'save' | 'saveAs' | 'newScene' | 'saveRecording' | 'openRecording' | 'record') => {
    if (frozen) return;
    if ((replaying() || comparing()) && (action === 'save' || action === 'saveAs' || action === 'record')) {
      // SPEC §13.2: ordinary Save Scene is off during replay, so no shortcut can save the replay as the scene.
      workflow.message = { kind: 'info', text: 'Return to authoring to save the main scene or start a recording. Export Alternate Setup saves a comparison setup.' };
      report('file-control', { action, outcome: 'refused', reason: 'replay' });
      renderPanel();
      return;
    }
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    const t = host.tick;
    void workflow[action]().then((outcome) => {
      report('file-control', { action, outcome, tickBefore: t, tickAfter: host.tick, playing: scheduler.playing });
      if (outcome && (action === 'save' || action === 'saveAs')) reportDigest(action);
      renderPanel();
    });
  };

  // ------------------------------------------------------------------ authoring commands

  const selectedLaw = () => (interaction.selectedId === null ? undefined : appliedLaw(interaction.selectedId));
  /** Authoring commands wait: edits frozen, a gesture in progress, or a replay displayed (read-only, SPEC §13.2). */
  const blocked = () => frozen || interaction.gesture !== null || readOnly();

  /** The note a refused undo or redo left, cleared by the next one that applies. */
  let historyRefusal: typeof workflow.message = null;
  const undo = (redo: boolean) => {
    if (blocked()) return;
    const result = redo ? editor().redo() : editor().undo();
    if (result.ok) {
      if (workflow.message === historyRefusal) workflow.message = null;
      settleNow();
      if (appliedLaw(result.value.id)) interaction.select(result.value.id);
      else if (interaction.selectedId === result.value.id) interaction.select(editor().scene.fields[0]?.id ?? null);
      edited();
    } else if (redo ? editor().canRedo : editor().canUndo) {
      // The step stays available but cannot apply now (the scene's leaf budget, an ID taken since): say why.
      workflow.message = historyRefusal = { kind: 'error', text: `${redo ? 'Redo' : 'Undo'} was not applied: ${result.reason}. Nothing changed.` };
    }
    report('history', {
      action: redo ? 'redo' : 'undo',
      ok: result.ok,
      label: result.ok ? result.value.label : null,
      law: result.ok ? result.value.id : null,
      reason: result.ok ? null : result.reason,
      revision: editor().revision,
      tick: host.tick,
      laws: host.appliedFields().map(lawSummary),
    });
    renderPanel();
  };

  const toggleEnabled = (id: string) => {
    if (blocked()) return;
    const law = appliedLaw(id);
    if (!law) return;
    const result = editor().editField(id, law.enabled ? 'Disable law' : 'Enable law', (f) => ({ ...f, enabled: !f.enabled }));
    if (result.ok) {
      editLatency.accept(result.value.revision, performance.now());
      awaitApplied(result.value.revision);
      edited();
      reportDigest('enabled');
    }
    report('control', { law: id, enabled: !law.enabled, revision: result.ok ? result.value.revision : null });
  };

  const toggleVisible = (id: string) => {
    if (blocked()) return;
    const visible = !editor().presentationOf(id).visible;
    const result = editor().setLawPresentation(id, { visible });
    report('control', { law: id, visible, revision: result.ok ? result.value.revision : null });
    if (result.ok) {
      edited();
      reportDigest('visibility');
    }
  };

  const duplicateSelected = () => {
    const law = selectedLaw();
    if (blocked() || !law) return;
    const result = editor().duplicate(law.id);
    if (result.ok) {
      settleNow();
      interaction.select(result.value.id);
      edited();
    } else showDetailsError(result.reason);
    report('control', { duplicate: law.id, created: result.ok ? result.value.id : null, reason: result.ok ? null : result.reason, laws: host.appliedFields().length });
  };

  const deleteSelected = () => {
    const law = selectedLaw();
    if (blocked() || !law) return;
    const result = editor().remove(law.id);
    if (result.ok) {
      settleNow();
      interaction.select(editor().scene.fields[0]?.id ?? null);
      edited();
    }
    report('control', { delete: law.id, ok: result.ok, laws: host.appliedFields().length });
  };

  /** The tool shelf (SPEC §11.1): a law of one kind at the view's focus point, selected, as one undo entry. */
  const createLaw = (kind: PrimitiveKind) => {
    if (blocked()) return;
    const t = viewport.orbit.target;
    const place = (v: number) => Math.round(Math.min(1000, Math.max(-1000, v)) * 100) / 100;
    const result = editor().create(kind, [place(t.x), place(t.y), place(t.z)]);
    if (result.ok) {
      editLatency.accept(result.value.revision, performance.now());
      awaitApplied(result.value.revision);
      settleNow();
      interaction.select(result.value.id);
      edited();
      reportDigest('create');
    } else showDetailsError(result.reason);
    report('control', { create: kind, id: result.ok ? result.value.id : null, reason: result.ok ? null : result.reason, laws: host.appliedFields().length });
  };

  /** Changes the selected law's support shape, keeping its bounding size: one validated edit. */
  const setSupport = (kind: RegionKind) => {
    const law = selectedLaw();
    if (!law || blocked() || law.region.kind === kind) return;
    const result = editor().editField(law.id, 'Change support shape', (f) => ({ ...f, region: REGIONS[kind].fromBounds(regionDescriptor(f.region.kind).bounds(f.region)) }));
    if (result.ok) {
      editLatency.accept(result.value.revision, performance.now());
      awaitApplied(result.value.revision);
      settleNow();
      edited();
    }
    report('control', { law: law.id, support: kind, revision: result.ok ? result.value.revision : null, field: result.ok ? lawSummary(result.value.field) : null });
  };

  const setArrows = () => {
    if (blocked()) return;
    editor().setArrows(!editor().arrows);
    report('control', { arrows: editor().arrows, revision: editor().revision });
    edited();
    reportDigest('arrows');
  };

  // ------------------------------------------------------------------ panel

  const lawList = $<HTMLUListElement>('law-list');
  const details = $('details');
  const detailsError = $('details-error');
  const colorGroup = $('law-colors');
  const labelInput = $<HTMLInputElement>('law-label');
  const fadeInput = $<HTMLInputElement>('law-fade');
  const supportGroup = $('law-support');
  const regionParams = $('law-region-params');
  const primitiveParams = $('law-params');
  const samplingNote = $('law-sampling');
  const shelf = $('law-shelf');
  const triples = new Map(
    [...details.querySelectorAll<HTMLFieldSetElement>('fieldset.triple')].map((set) => [set.dataset.property!, [...set.querySelectorAll('input')]] as const),
  );

  const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>';

  for (const [kind, d] of Object.entries(PRIMITIVES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `add-${kind}`;
    button.dataset.kind = kind;
    button.textContent = d.verb;
    button.title = `Add a ${d.title.toLowerCase()} law at the view’s focus point`;
    button.style.setProperty('--law-color', d.color);
    shelf.append(button);
  }
  for (const [kind, d] of Object.entries(REGIONS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `support-${kind}`;
    button.dataset.kind = kind;
    button.setAttribute('role', 'radio');
    button.textContent = d.title;
    supportGroup.append(button);
  }

  /** Numeric equivalents of a registry entry's controls (SPEC §11.3): labeled, bounded, one edit each. */
  function controlInputs(container: HTMLElement, target: 'region' | 'primitive', controls: readonly ScalarControl<never>[]) {
    container.replaceChildren(
      ...controls.map((c) => {
        const label = document.createElement('label');
        label.append(`${c.label} `);
        if (c.unit) {
          const unit = document.createElement('span');
          unit.className = 'unit';
          unit.textContent = c.unit;
          label.append(unit);
        }
        const input = document.createElement('input');
        input.type = 'number';
        input.step = String(c.step);
        input.min = String(c.min);
        input.max = String(c.max);
        input.dataset.control = c.key;
        input.dataset.target = target;
        input.setAttribute('aria-label', c.label);
        label.append(input);
        return label;
      }),
    );
  }

  for (const color of LAW_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', `Color ${color}`);
    swatch.style.setProperty('--swatch', color);
    swatch.dataset.color = color;
    colorGroup.append(swatch);
  }

  let listSignature = '';
  let detailsSignature = '';
  function showDetailsError(text: string | null, input?: HTMLInputElement) {
    detailsError.hidden = text === null;
    detailsError.textContent = text ?? '';
    for (const field of details.querySelectorAll('input')) field.removeAttribute('aria-invalid');
    if (input && text) input.setAttribute('aria-invalid', 'true');
  }

  const fmt = (value: number, digits: number) => String(Math.round(value * 10 ** digits) / 10 ** digits);

  let reportedDirty: boolean | null = null;
  function renderPanel() {
    // The native side answers Dock Quit and logout synchronously, so it keeps the dirty state too: an
    // unsaved scene, or a recording that has not been saved.
    const atRisk = workflow.dirty || runs.recordingAtRisk;
    if (atRisk !== reportedDirty) {
      reportedDirty = atRisk;
      invoke('guard_state', { dirty: reportedDirty }).catch(() => {});
    }
    renderRun();
    renderComparison();
    // Document.
    const busy = workflow.busy;
    const file = workflow.fileName;
    $('doc-title').textContent = editor().metadata.title;
    $('doc-invitation').hidden = editor().metadata.title !== 'Two Futures';
    const state = $('doc-state');
    state.dataset.dirty = String(workflow.dirty);
    state.textContent = busy
      ? (BUSY_TEXT[busy] ?? 'Working…')
      : workflow.dirty
        ? file
          ? `Edited since it was saved to ${file}`
          : workflow.recovered
            ? 'Recovered, not saved to a file yet'
            : 'Edited, not saved to a file'
        : file
          ? `Saved to ${file}`
          : 'Not saved to a file';
    for (const id of ['file-new', 'file-open']) $<HTMLButtonElement>(id).disabled = busy !== null;
    for (const id of ['file-save', 'file-save-as']) $<HTMLButtonElement>(id).disabled = busy !== null || readOnly() || comparing();
    const message = $('doc-message');
    message.hidden = workflow.message === null;
    message.textContent = workflow.message?.text ?? '';
    message.dataset.kind = workflow.message?.kind ?? '';
    const recovery = workflow.recovery.status;
    const recoveryLine = $('doc-recovery');
    recoveryLine.hidden = !(recovery.state === 'failed' || (recovery.state === 'written' && workflow.dirty));
    recoveryLine.textContent =
      recovery.state === 'failed' ? `Recovery is unavailable: ${recovery.reason}. Save and Save As still work.` : recovery.state === 'written' ? `A recovery copy holds revision ${recovery.revision}.` : '';

    // History and visualization default.
    $<HTMLButtonElement>('undo').disabled = !editor().canUndo || readOnly();
    $<HTMLButtonElement>('redo').disabled = !editor().canRedo || readOnly();
    $('arrows-toggle').setAttribute('aria-pressed', String(editor().arrows));

    // Laws list, rebuilt only when something it shows changed.
    const laws = host.appliedFields();
    const selectedId = interaction.selectedId;
    const locked = readOnly();
    const signature = JSON.stringify([locked, selectedId, laws.map((f) => [f.id, f.enabled, f.expression, lawPresentation(f.id)])]);
    if (signature !== listSignature) {
      listSignature = signature;
      lawList.replaceChildren(
        ...laws.map((f) => {
          const p = lawPresentation(f.id);
          const item = document.createElement('li');
          item.className = 'law-row';
          item.style.setProperty('--law-color', p.color);
          const select = document.createElement('button');
          select.type = 'button';
          select.className = 'law-select';
          select.dataset.id = f.id;
          select.dataset.action = 'select';
          select.setAttribute('aria-pressed', String(f.id === selectedId));
          const name = document.createElement('span');
          name.className = 'law-name';
          name.textContent = p.label; // text, never markup (SPEC §15.2)
          const meta = document.createElement('span');
          meta.className = 'law-meta';
          meta.textContent = expressionSummary(f.expression);
          select.append(name, meta);
          const visible = document.createElement('button');
          visible.type = 'button';
          visible.className = 'law-visible';
          visible.dataset.id = f.id;
          visible.dataset.action = 'visible';
          visible.setAttribute('aria-pressed', String(p.visible));
          visible.setAttribute('aria-label', `Show ${p.label} in the viewport`);
          visible.title = p.visible ? 'Shown. Hiding it keeps its effect.' : 'Hidden. Its effect still applies.';
          visible.innerHTML = p.visible ? EYE : EYE_OFF;
          const enabled = document.createElement('button');
          enabled.type = 'button';
          enabled.className = 'law-enabled';
          enabled.dataset.id = f.id;
          enabled.dataset.action = 'enabled';
          enabled.setAttribute('aria-pressed', String(f.enabled));
          enabled.setAttribute('aria-label', `${p.label} enabled`);
          enabled.textContent = f.enabled ? 'On' : 'Off';
          // A replay's laws are the recording's: shown, selectable, never changed from here.
          visible.disabled = enabled.disabled = locked;
          item.append(select, visible, enabled);
          return item;
        }),
      );
    }
    const law = selectedLaw();
    $<HTMLButtonElement>('law-duplicate').disabled = !law;
    $<HTMLButtonElement>('law-delete').disabled = !law;

    // Selected-law details: refreshed from the applied value, never over a field being typed in.
    details.hidden = !law;
    ingredientPanel.render(law, host.tick);
    if (!law) return;
    const p = lawPresentation(law.id);
    const detailSignature = JSON.stringify([law, p]);
    if (detailSignature === detailsSignature) return;
    detailsSignature = detailSignature;
    $('details-title').textContent = p.label;
    const focused = document.activeElement;
    const show = (input: HTMLInputElement, value: string) => {
      if (input !== focused) input.value = value;
    };
    show(labelInput, p.label);
    for (const swatch of colorGroup.querySelectorAll<HTMLButtonElement>('.swatch')) swatch.setAttribute('aria-checked', String(swatch.dataset.color === p.color));
    triples.get('position')!.forEach((input, i) => show(input, fmt(law.pose.position[i]!, 3)));
    const euler = new Euler().setFromQuaternion(new Quaternion(...law.pose.rotation), 'XYZ');
    triples.get('rotation')!.forEach((input, i) => show(input, fmt([euler.x, euler.y, euler.z][i]! * DEGREES, 1)));
    for (const button of supportGroup.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-checked', String(button.dataset.kind === law.region.kind));
    const region = regionDescriptor(law.region.kind);
    if (regionParams.dataset.kind !== law.region.kind) {
      regionParams.dataset.kind = law.region.kind;
      controlInputs(regionParams, 'region', region.controls as readonly ScalarControl<never>[]);
    }
    for (const input of regionParams.querySelectorAll<HTMLInputElement>('input')) show(input, fmt(region.controls.find((c) => c.key === input.dataset.control)!.get(law.region), 3));
    // A one-leaf law keeps M3's inspector: its primitive's own parameters, right here.
    const leaf = isCompound(law.expression) ? null : (law.expression as Primitive);
    $('law-kind').hidden = primitiveParams.hidden = leaf === null;
    if (leaf) {
      const primitive = primitiveDescriptor(leaf.kind);
      if (primitiveParams.dataset.kind !== leaf.kind) {
        primitiveParams.dataset.kind = leaf.kind;
        controlInputs(primitiveParams, 'primitive', primitive.controls as readonly ScalarControl<never>[]);
      }
      $('law-kind').textContent = `${primitive.title} · ${primitive.summary(leaf)}: ${primitive.describe(leaf)}`;
      for (const input of primitiveParams.querySelectorAll<HTMLInputElement>('input')) show(input, fmt(primitive.controls.find((c) => c.key === input.dataset.control)!.get(leaf), 3));
    }
    show(fadeInput, fmt(law.edgeFade, 3));
    renderSampling();
  }

  /**
   * SPEC §7's narrow/fast heuristic for the selected law: fields act on each body's center once per
   * step, so a center moving farther than the fade band in one step can skip it. A heuristic under
   * normalized gauges, not a continuous-crossing guarantee.
   */
  let samplingShown = '';
  function renderSampling() {
    const law = selectedLaw();
    if (!law) return;
    const band = fadeBand(law);
    const travel = host.maxSpeed * STEP_SECONDS;
    const text =
      band === null
        ? `Laws act on each body’s center, once per step. Hard boundary (fade 0): a center can cross the edge between samples. Fastest body ${fmt(travel, 3)} m per step.`
        : `Laws act on each body’s center, once per step. Fade band ${fmt(band, 3)} m; fastest body ${fmt(travel, 3)} m per step${travel > band ? ', so it can skip the band.' : '.'}`;
    if (text === samplingShown) return;
    samplingShown = text;
    samplingNote.textContent = text;
    samplingNote.dataset.skips = String(band !== null && travel > band);
  }

  /** A precise value typed into the details: one complete validated edit and one undo entry. */
  const editSelected = (label: string, input: HTMLInputElement, change: (f: FieldDefinition, value: number) => FieldDefinition) => {
    const law = selectedLaw();
    if (!law || blocked()) return;
    const value = input.value.trim() === '' ? NaN : Number(input.value);
    const result = editor().editField(law.id, label, (f) => change(f, value));
    if (!result.ok) {
      showDetailsError(`${result.reason[0]!.toUpperCase()}${result.reason.slice(1)}. The last valid value is kept.`, input);
      report('control', { law: law.id, precise: label, rejected: result.reason });
      detailsSignature = '';
      return;
    }
    showDetailsError(null);
    awaitApplied(result.value.revision);
    settleNow();
    report('control', { law: law.id, precise: label, revision: result.value.revision, field: lawSummary(result.value.field) });
    edited();
  };

  /**
   * One ingredient edit of the selected law (M5): the change is computed from the settled authored
   * value, validated with the whole law (bounds, node/depth limits, the scene's leaf budget) and
   * applied as one put and one undo entry, exactly like a precise value typed in the details.
   */
  const editExpression = (label: string, change: (law: FieldDefinition) => Edited, input?: HTMLInputElement): Edited | null => {
    const law = selectedLaw();
    if (!law || blocked()) return null;
    settleNow();
    const current = editor().lawState(law.id)?.field;
    if (!current) return null;
    const next = change(current);
    const refuse = (reason: string) => {
      showDetailsError(`${reason[0]!.toUpperCase()}${reason.slice(1)}. The last valid value is kept.`, input);
      report('control', { law: law.id, ingredient: label, rejected: reason });
      detailsSignature = '';
      renderPanel();
      return null;
    };
    if (!next.ok) return refuse(next.reason);
    // An edit that changes nothing (the checked gain kind or mask shape, a value committed unchanged)
    // puts nothing: a put would advance the revision and mark the document edited with no undo entry.
    if (JSON.stringify(next.expression) === JSON.stringify(current.expression)) {
      showDetailsError(null);
      return next;
    }
    const result = editor().editField(law.id, label, (f) => ({ ...f, expression: next.expression }));
    if (!result.ok) return refuse(result.path ? `${result.path}: ${result.reason}` : result.reason);
    showDetailsError(null);
    editLatency.accept(result.value.revision, performance.now());
    awaitApplied(result.value.revision);
    settleNow();
    report('control', { law: law.id, ingredient: label, path: next.path, revision: result.value.revision, field: lawSummary(result.value.field) });
    edited();
    return next;
  };

  const withAxis = (v: Vec3, axis: number, value: number): Vec3 => v.map((c, i) => (i === axis ? value : c)) as unknown as Vec3;
  triples.get('position')!.forEach((input, axis) =>
    input.addEventListener('change', () => editSelected('Move law', input, (f, v) => ({ ...f, pose: { ...f.pose, position: withAxis(f.pose.position, axis, v) } }))),
  );
  triples.get('rotation')!.forEach((input, axis) =>
    input.addEventListener('change', () =>
      editSelected('Rotate law', input, (f, v) => {
        // Only the edited angle changes; the others keep full precision from the applied rotation.
        const euler = new Euler().setFromQuaternion(new Quaternion(...f.pose.rotation), 'XYZ');
        euler[(['x', 'y', 'z'] as const)[axis]!] = v / DEGREES;
        const q = new Quaternion().setFromEuler(euler);
        return { ...f, pose: { ...f.pose, rotation: [q.x, q.y, q.z, q.w] } };
      }),
    ),
  );
  for (const container of [regionParams, primitiveParams]) {
    container.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const law = selectedLaw();
      if (!law || !input.dataset.control) return;
      if (input.dataset.target === 'region') {
        const control = regionDescriptor(law.region.kind).controls.find((c) => c.key === input.dataset.control)!;
        editSelected(control.edit, input, (f, v) => ({ ...f, region: control.set(f.region, v) }));
      } else if (!isCompound(law.expression)) {
        const control = primitiveDescriptor((law.expression as Primitive).kind).controls.find((c) => c.key === input.dataset.control)!;
        editSelected(control.edit, input, (f, v) => ({ ...f, expression: control.set(f.expression as Primitive, v) }));
      }
    });
  }
  fadeInput.addEventListener('change', () => editSelected(EDGE_FADE.edit, fadeInput, (f, v) => ({ ...f, edgeFade: v })));
  shelf.addEventListener('click', (event) => {
    const kind = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]')?.dataset.kind;
    if (kind) createLaw(kind as PrimitiveKind);
  });
  supportGroup.addEventListener('click', (event) => {
    const kind = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]')?.dataset.kind;
    if (kind) setSupport(kind as RegionKind);
  });
  labelInput.addEventListener('change', () => {
    const law = selectedLaw();
    if (!law || blocked()) return;
    const result = editor().setLawPresentation(law.id, { label: labelInput.value.trim() });
    if (!result.ok) {
      showDetailsError(`The name ${result.reason.replace(/^label /, '')}. The last valid name is kept.`, labelInput);
      detailsSignature = '';
      return;
    }
    showDetailsError(null);
    report('control', { law: law.id, label: labelInput.value.trim(), revision: result.value.revision });
    edited();
    reportDigest('label');
  });
  colorGroup.addEventListener('click', (event) => {
    const color = (event.target as HTMLElement).closest<HTMLButtonElement>('.swatch')?.dataset.color;
    const law = selectedLaw();
    if (!color || !law || blocked()) return;
    const result = editor().setLawPresentation(law.id, { color });
    report('control', { law: law.id, color, revision: result.ok ? result.value.revision : null });
    if (result.ok) {
      edited();
      reportDigest('color');
    }
  });
  lawList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const id = button.dataset.id!;
    if (button.dataset.action === 'select') {
      if (!interaction.gesture) interaction.select(interaction.selectedId === id ? null : id);
    } else if (button.dataset.action === 'visible') toggleVisible(id);
    else toggleEnabled(id);
  });
  $('law-duplicate').addEventListener('click', duplicateSelected);
  $('law-delete').addEventListener('click', deleteSelected);
  $('arrows-toggle').addEventListener('click', setArrows);
  $('undo').addEventListener('click', () => undo(false));
  $('redo').addEventListener('click', () => undo(true));
  $('file-new').addEventListener('click', () => runFile('newScene'));
  $('file-open').addEventListener('click', () => runFile('open'));
  $('file-save').addEventListener('click', () => runFile('save'));
  $('file-save-as').addEventListener('click', () => runFile('saveAs'));

  // Controls reflect authoritative state, refreshed only when it changes.
  const playButton = $('play');
  const modeButtons = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
  let shownPlaying = false;
  function syncControls() {
    if (requestedPlaying() !== shownPlaying) {
      shownPlaying = requestedPlaying();
      playButton.setAttribute('aria-pressed', String(shownPlaying));
      playButton.firstChild!.textContent = shownPlaying ? 'Pause ' : 'Play ';
    }
  }

  const setMode = (next: TransformMode) => {
    if (interaction.gesture || frozen) return;
    interaction.setMode(next);
    modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
    report('control', { transformMode: next });
  };
  const frameLaw = () => {
    if (interaction.gesture) return;
    const law = selectedLaw();
    if (law) viewport.frame(law.pose.position, Math.hypot(...regionDescriptor(law.region.kind).bounds(law.region)));
    else viewport.resetView();
    cameraMoved = true;
    report('control', { frame: law ? law.id : 'default' });
  };

  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as TransformMode)));
  $('frame-view').addEventListener('click', frameLaw);
  $('reset-view').addEventListener('click', () => {
    if (interaction.gesture) return;
    viewport.resetView();
    cameraMoved = true;
    report('control', { resetView: true });
  });
  viewport.orbit.addEventListener('start', () => (cameraMoved = true));
  playButton.addEventListener('click', () => setPlaying(!requestedPlaying(), 'control'));
  $('step').addEventListener('click', stepOnce);
  $('reset').addEventListener('click', resetScene);
  $('sim-error-reset').addEventListener('click', resetScene);

  // ------------------------------------------------------------------ recording and replay (M6A)

  /** The authoring context's static view and camera, kept while a replay is displayed (SPEC §13.2). */
  let authoringView: PreparedScene | null = null;
  let authoringCamera: { position: Vec3; target: Vec3; moved: boolean } | null = null;
  const stashCamera = () => {
    const p = viewport.camera.position;
    const t = viewport.orbit.target;
    return { position: [p.x, p.y, p.z] as Vec3, target: [t.x, t.y, t.z] as Vec3, moved: cameraMoved };
  };

  let comparisonView: PreparedScene | null = null;
  let comparisonCamera: ReturnType<typeof stashCamera> | null = null;
  let comparisonSelection: string | null = null;
  let comparisonExplained: string | null = null;
  let ghosts: ReturnType<typeof createComparisonView> | null = null;
  let ghostsShown = true;
  let alternateWasReplaying = false;
  const authorityReceipt = (value: SimulationHost) => {
    const observed = observe(value);
    return { ...observed.address, stateHash: fnv64(new TextEncoder().encode(JSON.stringify(observed.state))), engineHash: fnv64(observed.engine) };
  };
  const comparisonReceipt = () => {
    const c = runs.comparison;
    if (!c) return null;
    const frame = c.frame(c.host.tick), id = explained ?? c.host.ids[0] ?? frame?.ids[0] ?? null;
    return { authority: authorityReceipt(c.host), baselineHash: c.baselineIdentity(),
      pair: id === null ? null : pairedBody(id, frame, c.host),
      framePastHorizon: c.frame(c.horizon + 1) !== null };
  };
  const comparisonChannel = new MessageChannel();
  let calculation: { comparison: NonNullable<typeof runs.comparison>; job: BaselineJob } | null = null;
  const restoreComparisonView = () => {
    calculation = null;
    runShown = '';
    runs.comparison?.cancel();
    ghosts?.dispose();
    ghosts = null;
    if (comparisonView) world.discardScene(world.swapScene(comparisonView));
    comparisonView = null;
    if (comparisonCamera) {
      viewport.setView(comparisonCamera.position, comparisonCamera.target);
      cameraMoved = comparisonCamera.moved;
    }
    comparisonCamera = null;
  };
  const comparisonFailed = (error: unknown) => {
    workflow.message = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    report('comparison', { action: 'failed', error: String(error), ...runs.counts() });
    renderPanel();
  };
  const computeBaseline = (ticks: number) => {
    const comparison = runs.comparison;
    if (!comparison || frozen || workflow.busy) return;
    setPlaying(false, 'baseline');
    interaction.release('baseline');
    try {
      const job = comparison.begin(ticks);
      calculation = { comparison, job };
      report('comparison', { action: 'baseline-start', fork: comparison.address, target: job.target, ...comparison.counts() });
      comparisonChannel.port2.postMessage(null);
      renderPanel();
    } catch (error) { comparisonFailed(error); }
  };
  comparisonChannel.port1.onmessage = () => {
    const active = calculation;
    if (!active || active.comparison !== runs.comparison) return;
    try {
      const result = active.comparison.batch(active.job);
      if (result === 'working') comparisonChannel.port2.postMessage(null);
      else {
        calculation = null;
        const metrics = active.comparison.metrics;
        report('comparison', { action: `baseline-${result}`, ...active.comparison.counts(), metrics: metrics ? { ...metrics, batches: metrics.batches.length, batchMs: percentiles(metrics.batches) } : null });
        renderPanel();
      }
    } catch (error) { calculation = null; comparisonFailed(error); }
  };
  $('compare-from').addEventListener('click', () => {
    if (frozen || scheduler.playing || workflow.busy || interaction.gesture || explainMode === 'preview' || pendingSeek) return;
    try {
      const comparison = runs.enterComparison();
      let view: PreparedScene;
      try { view = world.prepareScene(comparison.root.semantic, true); ghosts = createComparisonView(viewport.scene, comparison.root.semantic.simulation.maxLiveBodies); }
      catch (error) { runs.closeComparison(); throw error; }
      comparisonCamera = stashCamera();
      comparisonSelection = interaction.selectedId;
      comparisonExplained = explained;
      comparisonView = world.swapScene(view);
      comparison.controller.onAcks = authoring.onAcks;
      editLatency = new EditLatency();
      awaited.clear();
      showContext('compare');
      report('comparison', { action: 'fork', identity: comparison.identity, address: comparison.address, ...comparison.counts() });
    } catch (error) { comparisonFailed(error); }
  });
  $('baseline-compute').addEventListener('click', () => computeBaseline(COMPARISON_LIMITS.initialTicks));
  $('baseline-extend').addEventListener('click', () => {
    const c = runs.comparison;
    if (c) computeBaseline(Math.min(COMPARISON_LIMITS.ticks, c.horizon - c.address.tick + COMPARISON_LIMITS.initialTicks));
  });
  $('baseline-cancel').addEventListener('click', () => {
    const start = performance.now();
    calculation = null;
    runs.comparison?.cancel();
    report('comparison', { action: 'baseline-canceled', latencyMs: performance.now() - start, ...runs.counts() });
    renderPanel();
  });
  $('alternate-replay').addEventListener('click', () => {
    const c = runs.comparison;
    if (!c || frozen || workflow.busy || interaction.gesture) return;
    setPlaying(false, 'alternate-replay');
    try {
      const retained = comparisonReceipt();
      c.replayAlternate();
      alternateWasReplaying = c.replaying;
      editLatency = new EditLatency();
      awaited.clear();
      showWorld('alternate-replay');
      applyFreeze();
      report('comparison', { action: 'alternate-replay', ...c.counts(), retained });
      renderPanel();
      if (c.replaying) setPlaying(true, 'alternate-replay');
      else report('comparison', { action: 'alternate-complete', playing: scheduler.playing, ...c.counts(), receipt: comparisonReceipt() });
    } catch (error) { comparisonFailed(error); }
  });
  $('alternate-new').addEventListener('click', () => {
    const c = runs.comparison;
    if (!c || frozen || workflow.busy || interaction.gesture) return;
    setPlaying(false, 'alternate-new');
    try {
      c.newAlternate();
      alternateWasReplaying = false;
      editLatency = new EditLatency();
      awaited.clear();
      showWorld('alternate-new');
      applyFreeze();
      report('comparison', { action: 'alternate-new', ...c.counts() });
      renderPanel();
    } catch (error) { comparisonFailed(error); }
  });
  $('baseline-ghosts').addEventListener('click', () => {
    ghostsShown = !ghostsShown;
    $('baseline-ghosts').setAttribute('aria-pressed', String(ghostsShown));
    report('comparison', { action: 'ghosts', shown: ghostsShown, tick: host.tick, cursor: host.lastAppliedSequence, renderer: ghosts?.counts(), receipt: comparisonReceipt() });
  });
  $('alternate-export').addEventListener('click', () => {
    const c = runs.comparison;
    if (!c || c.replaying || workflow.busy || frozen) return;
    setPlaying(false, 'alternate-export');
    interaction.release('alternate-export');
    try { void workflow.exportAlternate(c.alternateSetup()).then(() => renderPanel()); } catch (error) { comparisonFailed(error); }
  });
  $('comparison-close').addEventListener('click', () => {
    if (frozen || workflow.busy) return;
    setPlaying(false, 'comparison-close');
    interaction.release('comparison-close');
    restoreComparisonView();
    runs.closeComparison();
    editLatency = new EditLatency(); awaited.clear();
    showContext('comparison-close');
    interaction.select(comparisonSelection);
    setExplained(comparisonExplained, 'comparison-close');
    report('comparison', { action: 'closed', ...runs.counts() });
    renderPanel();
  });
  function renderComparison() {
    const c = runs.comparison;
    $('comparison').hidden = !c;
    const enabled = !frozen && !scheduler.playing && !workflow.busy && !interaction.gesture && explainMode !== 'preview' && !pendingSeek && !runs.replayPartial && (runs.recordingState === 'idle' || runs.recordingState === 'recorded');
    $<HTMLButtonElement>('compare-from').disabled = !enabled || !!c;
    if (!c) return;
    const suffix = c.suffixCount ? `${c.suffixCount} recorded changes` : 'No intervention · no-op alternate';
    $('comparison-status').textContent = `Fork tick ${c.address.tick}, change ${c.address.cursor}. Equal tick ${host.tick}. A computed through ${c.horizon} (${((c.horizon - c.address.tick) / 120).toFixed(1)} s). ${suffix}. ${c.working ? 'Computing… B is paused.' : c.replaying ? 'Replaying retained changes; editing resumes at its end.' : c.atHorizon ? 'At the horizon. Extend to play.' : 'Edit B, then Play.'}${c.message ? ` ${c.message}` : ''}`;
    const frame = c.frame(host.tick);
    const id = explained ?? host.ids[0] ?? frame?.ids[0] ?? null;
    const pair = id === null ? null : pairedBody(id, frame, host);
    const pa = pair?.baseline ?? null;
    const pb = pair?.alternate ?? null;
    const shown = (p: readonly number[] | null) => p ? `[${p.map((n) => n.toFixed(3)).join(', ')}] m` : 'absent';
    const separation = pair?.separation != null ? `${pair.separation.toFixed(3)} m` : 'unavailable · counterpart absent';
    $('comparison-inspect').textContent = `${id ?? 'No living body'}\nA ${frame ? shown(pa) : 'not computed at this tick'} · B ${shown(pb)}\nSeparation ${separation}`;
    $<HTMLButtonElement>('baseline-compute').disabled = !!c.working || c.horizon > c.address.tick || !!workflow.busy;
    $<HTMLButtonElement>('baseline-cancel').hidden = !c.working;
    $<HTMLButtonElement>('baseline-extend').disabled = !!c.working || c.horizon === c.address.tick || c.horizon - c.address.tick >= COMPARISON_LIMITS.ticks || !!workflow.busy;
    $<HTMLButtonElement>('alternate-export').disabled = c.replaying || !!workflow.busy;
    for (const id of ['alternate-replay', 'alternate-new', 'comparison-close']) $<HTMLButtonElement>(id).disabled = !!workflow.busy || !!interaction.gesture;
    document.documentElement.style.setProperty('--run-reserve', `${$('comparison').offsetHeight + 8}px`);
  }
  /** The displayed replay's end check, once it reached its frozen address. */
  let replayCheck: FinalCheckResult | null = null;
  let replayEnded = false;
  let replayCheckpoint = -1;
  /** Set when a seek replaced the displayed world, until it steps: its trails start again there (SPEC §14.2). */
  let seekedTrails = false;

  const recordSummary = (record: RunRecord) => ({
    runId: record.runId,
    title: record.root.metadata.title,
    commands: record.commands.length,
    finalTick: record.finalTick,
    lastAppliedSequence: record.lastAppliedSequence,
    stopped: record.stopped,
    finalCheck: record.finalCheck,
    qualified: qualified(record.qualification),
  });

  /**
   * Shows the coordinator's displayed world, paused, with scheduling debt discarded and every view of the
   * previous world cleared: the ingredient focus, the readouts' signatures, the end check, a selection the
   * new world does not hold, and a fault that belonged to another world. The explained body is `keep` if
   * the new world holds a body with that stable ID, otherwise none; its explanation starts with the next step.
   */
  const showWorld = (reason: string, keep: string | null = null) => {
    setPlaying(false, reason);
    scheduler.pause();
    host = runs.shown;
    if (drawWait && drawWait.generation !== host.generation) {
      drawWait.resolve(null);
      drawWait = null;
    }
    explained = keep !== null && host.ids.includes(keep) ? keep : null;
    host.explain(explained);
    ingredientPanel.reset();
    listSignature = '';
    detailsSignature = '';
    clockTick = -1;
    shownRevision = -1;
    previewKey = '';
    replayCheck = null;
    replayEnded = false;
    replayCheckpoint = -1;
    seekedTrails = false;
    if (interaction.selectedId !== null && !appliedLaw(interaction.selectedId)) interaction.select(null);
    // A fault belongs to its world: shown again when that world is, hidden otherwise.
    if (host.fault) showSimError(`${host.fault.message}. The last valid frame is shown.`, canResetScene(runs.selected));
    else $('sim-error').hidden = true;
  };

  /**
   * Displays the coordinator's selected context: its world, laws and readouts, with every view of the
   * previous world cleared. Scheduling debt is discarded and the new context starts paused (SPEC §13.2).
   */
  const showContext = (reason: string) => {
    // A context change cancels a pending seek inside the coordinator; its end is reported here.
    if (pendingSeek && runs.seeking !== pendingSeek.job) endSeek(pendingSeek, 'canceled', { reason });
    showWorld(reason);
    applyFreeze();
    report('context', { reason, ...runs.counts(), tick: host.tick, cursor: host.lastAppliedSequence, runId: runs.replay?.record.runId ?? null, qualified: runs.replayQualified });
    // The retained authoring world's digests at every switch: a replay must leave them exactly as they were.
    const live = authoring.liveHost;
    const { tick, lastAppliedSequence: cursor } = live;
    Promise.all([sha256(JSON.stringify(live.futureState())), sha256(live.engineSnapshot())]).then(([stateSha256, engineSha256]) =>
      report('context-live', { reason, tick, cursor, stateSha256, engineSha256, revision: authoring.revision, generation: authoring.generation, canUndo: authoring.canUndo, canRedo: authoring.canRedo }),
    );
    renderPanel();
  };

  /** Replay: the authoring world is settled and kept paused; a new world is built from the recording's frozen root. */
  const enterReplay = () => {
    if (frozen || replaying() || comparing() || runs.recordingState !== 'recorded') return;
    setPlaying(false, 'replay');
    interaction.release('replay');
    settleNow();
    const replay = runs.enterReplay();
    let view: PreparedScene;
    try {
      view = world.prepareScene(replay.record.root.semantic, true);
    } catch (error) {
      runs.returnToAuthoring();
      workflow.message = { kind: 'error', text: `The replay could not be shown: ${error instanceof Error ? error.message : String(error)}. Your scene is unchanged.` };
      report('recording', { action: 'replay-failed', error: String(error) });
      renderPanel();
      return;
    }
    authoringView = world.swapScene(view);
    authoringCamera = stashCamera();
    showContext('replay');
  };

  /** Shows the kept authoring view and camera again, releasing the replay's view. */
  const restoreAuthoringView = () => {
    if (authoringView) world.discardScene(world.swapScene(authoringView));
    authoringView = null;
    if (authoringCamera) {
      viewport.setView(authoringCamera.position, authoringCamera.target);
      cameraMoved = authoringCamera.moved;
      authoringCamera = null;
    }
  };

  /** Replay from Start: the replay world is rebuilt from the original root; authoring is untouched. */
  const restartReplay = () => {
    if (frozen || !replaying()) return;
    try {
      runs.restartReplay();
    } catch (error) {
      // The coordinator selected authoring again; show its kept view and camera, and say why.
      restoreAuthoringView();
      workflow.message = { kind: 'error', text: `The replay could not start again: ${error instanceof Error ? error.message : String(error)}. Your scene is as you left it.` };
      report('recording', { action: 'replay-failed', error: String(error) });
      showContext('replay-failed');
      return;
    }
    showContext('replay-restart');
  };

  /** Return to authoring: the replay world is freed and the kept authoring world shown again, paused, with its camera. */
  const returnToAuthoring = () => {
    if (frozen || !replaying()) return;
    runs.returnToAuthoring();
    restoreAuthoringView();
    showContext('return');
  };

  /** An ordinary stop: the gesture in progress ends and queued edits settle into the record, which then freezes. */
  const stopRecording = (reason: string) => {
    if (runs.recordingState !== 'recording') return;
    setPlaying(false, `record-${reason}`);
    interaction.release(`record-${reason}`);
    const reservedBytes = runs.recorder!.bytes;
    const pending = runs.stopRecording(reason === 'fault' ? 'fault' : 'user');
    report('recording', { action: 'stop', reason, tick: authoring.liveHost.tick, cursor: authoring.liveHost.lastAppliedSequence, reservedBytes });
    pending?.then(
      (record) => {
        report('recording', { action: 'stopped', ...recordSummary(record) });
        renderPanel();
      },
      (error: unknown) => report('recording', { action: 'stop-failed', error: String(error) }),
    );
    renderPanel();
  };

  /**
   * The recorder closed at a limit (SPEC §13.3); the coordinator has already discarded what it refused.
   * Pause, and end a gesture at the last value the host applied, discarding its unapplied preview.
   */
  const recordingLimited = (reason: StopReason) => {
    setPlaying(false, `recording-${reason}`);
    const gesture = interaction.gesture;
    if (gesture) interaction.release(`recording-${reason}`, authoring.lawState(gesture.start.id)?.field ?? null);
    for (const revision of awaited) if (revision > authoring.appliedRevision) awaited.delete(revision);
    if (reason === 'duration' || reason === 'commands' || reason === 'bytes') workflow.message = { kind: 'info', text: LIMIT_TEXT[reason] };
    report('recording', { action: 'limit', reason, tick: authoring.liveHost.tick, cursor: authoring.liveHost.lastAppliedSequence, gestureEnded: gesture !== null });
    void runs.settled().then((record) => {
      if (record) report('recording', { action: 'stopped', ...recordSummary(record) });
      renderPanel();
    });
    renderPanel();
  };

  /**
   * Advances the displayed replay (SPEC §13.3): a unit cut short last frame is finished first, then up to
   * `units` more, within the frame's work budget. Steps are observed by probes and trails like live ones.
   */
  const driveReplay = (units: number): number => {
    const replay = runs.replay;
    if (!replay) return 0;
    const deadline = performance.now() + REPLAY_BUDGET_MS;
    const now = () => performance.now();
    let steps = 0;
    // Probes and trails observe each transition right after it, under the laws it used, as live ones do.
    const stepped = () => {
      probes.advance(host);
      trails.record(host, explained);
      seekedTrails = false;
      steps += 1;
    };
    const unit = (n: number) => {
      const t0 = performance.now();
      const before = steps;
      let result;
      try {
        result = runs.advanceReplay(n, deadline, now, stepped);
      } catch (error) {
        onFault(error);
        return { complete: false, partial: true };
      }
      if (steps !== before) pushBounded(stepTimes, performance.now() - t0, 480);
      if (!result.partial && host.tick > 0 && host.tick % CHECKPOINT_TICKS === 0 && host.tick !== replayCheckpoint) {
        replayCheckpoint = host.tick;
        runCheckpoint('replay', host, replay.record.runId);
      }
      return result;
    };
    let result = unit(0);
    for (let i = 0; i < units && !result.partial && !result.complete; i++) result = unit(1);
    if (result.complete && !replayEnded) replayReachedEnd();
    return steps;
  };

  /** At the frozen final address: pause there, and check the state against the recorded end. */
  const replayReachedEnd = () => {
    replayEnded = true;
    setPlaying(false, 'replay-end');
    const replay = runs.replay!;
    const state = JSON.stringify(replay.host.futureState());
    const engine = replay.host.engineSnapshot();
    void Promise.all([runs.checkReplay(), sha256(state), sha256(engine)]).then(([check, stateSha256, engineSha256]) => {
      if (runs.replay !== replay) return;
      replayCheck = check;
      report('replay-complete', {
        runId: replay.record.runId,
        tick: replay.host.tick,
        cursor: replay.host.lastAppliedSequence,
        finalTick: replay.record.finalTick,
        lastAppliedSequence: replay.record.lastAppliedSequence,
        check,
        stateSha256,
        engineSha256,
        recorded: replay.record.finalCheck,
        qualified: qualified(replay.record.qualification),
      });
      renderPanel();
    });
    renderPanel();
  };

  // ------------------------------------------------------------------ seeking (M6B)

  /** The checkpoint cache and worlds now, for seek and checkpoint diagnostics. */
  function cacheCounts() {
    const { worlds, checkpoints, checkpointBytes } = runs.counts();
    return { worlds, checkpoints, checkpointBytes };
  }

  function reportCheckpoint(event: CheckpointEvent) {
    if (event.kind === 'rejected') {
      report('checkpoint', { action: 'rejected', reason: event.reason, discarded: event.discarded, ...cacheCounts() });
      return;
    }
    const c = event.checkpoint;
    report('checkpoint', {
      action: event.kind,
      runId: c.runId,
      tick: c.tick,
      cursor: c.lastAppliedSequence,
      bytes: c.bytes,
      engineBytes: c.engineBytes.byteLength,
      bodies: c.bodyIdentityMap.length,
      evicted: event.kind === 'captured' ? event.evicted.map((e) => [e.tick, e.lastAppliedSequence]) : [],
      ...cacheCounts(),
    });
  }

  // Each batch runs as its own task, so frames and input come between batches; a frame-paced batch would
  // leave half of every 60 Hz frame idle.
  const seekChannel = new MessageChannel();
  let seekQueued = false;
  const pumpSeek = () => {
    if (seekQueued || !pendingSeek) return;
    seekQueued = true;
    seekChannel.port2.postMessage(null);
  };
  seekChannel.port1.onmessage = () => {
    seekQueued = false;
    const pending = pendingSeek;
    if (!pending || runs.seeking !== pending.job) return;
    const start = performance.now();
    const status: SeekStatus = runs.seekWork(start + REPLAY_BUDGET_MS, () => performance.now());
    pending.batches.push(performance.now() - start);
    if (status.kind === 'working') pumpSeek();
    else if (status.kind === 'committed') seekCommitted(pending);
    else if (status.kind === 'failed') seekFailed(pending, status.error);
  };

  /**
   * Asks for the replay's state at `target` (SPEC §14.2). Playback pauses, and a seek still pending is
   * superseded. The displayed world stays exactly as it is until the reconstruction holds the target.
   * Resolves when this request ends; null when there was nothing to do.
   */
  const requestSeek = (target: Address, reason: string): Promise<SeekOutcome | null> => {
    // Not while a file workflow runs: its candidate world and a seek's must never coexist.
    if (frozen || workflow.busy !== null || !replaying() || !runs.replay) return Promise.resolve(null);
    setPlaying(false, 'seek');
    const previous = pendingSeek;
    let job: SeekJob | null;
    try {
      job = runs.seek(target);
    } catch (error) {
      report('seek', { action: 'refused', reason, target, error: String(error) });
      return Promise.resolve(null);
    }
    if (previous) endSeek(previous, 'superseded', { by: job?.id ?? null });
    if (!job) {
      report('seek', { action: 'shown', reason, target });
      renderPanel();
      return Promise.resolve(null);
    }
    const requested = job;
    return new Promise((resolve) => {
      pendingSeek = { job: requested, reason, requestedAt: performance.now(), batches: [], progressShownAfter: null, playOnCommit: false, done: resolve };
      report('seek', { action: 'request', id: requested.id, reason, target, shown: runs.replay!.address, ...cacheCounts() });
      pumpSeek();
      renderPanel();
    });
  };

  /** Reports how a pending seek ended and tells its requester; it is no longer pending. */
  function endSeek(pending: PendingSeek, action: SeekOutcome['action'], extra: Record<string, unknown> = {}, drawn: Promise<number | null> = Promise.resolve(null)) {
    if (pendingSeek === pending) pendingSeek = null;
    const elapsedMs = performance.now() - pending.requestedAt;
    const { job } = pending;
    report('seek', {
      action,
      id: job.id,
      reason: pending.reason,
      target: job.target,
      elapsedMs: round3(elapsedMs),
      source: job.source,
      steps: job.steps,
      batches: pending.batches.length,
      maxBatchMs: round3(pending.batches.reduce((a, b) => Math.max(a, b), 0)),
      workMs: round3(job.workMs),
      restoreMs: round3(job.restoreMs),
      progressShownAfterMs: pending.progressShownAfter === null ? null : round3(pending.progressShownAfter),
      rejected: job.rejected,
      ...extra,
      ...cacheCounts(),
    });
    pending.done({ action, elapsedMs, job, batches: pending.batches, progressShownAfter: pending.progressShownAfter, drawn });
  }

  /** Gives up the pending seek: its world is freed and the displayed replay stays exactly as it was. */
  function cancelPendingSeek(reason: string) {
    const pending = pendingSeek;
    if (!pending) return;
    runs.cancelSeek();
    endSeek(pending, 'canceled', { reason });
    renderPanel();
  }

  /**
   * The reconstruction holds the target: it is now the displayed replay, paused at that address, with fresh
   * views. A seek stays in the same replay context, so it takes no context switch's reports or snapshots.
   */
  const seekCommitted = (pending: PendingSeek) => {
    pendingSeek = null;
    // The same experiment at another time: the explained body stays explained if it lives there.
    showWorld('seek', explained);
    seekedTrails = true;
    const drawn = new Promise<number | null>((resolve) => {
      drawWait = { id: pending.job.id, generation: host.generation, requestedAt: pending.requestedAt, resolve };
    });
    endSeek(pending, 'committed', { address: runs.replay!.address, generation: host.generation }, drawn);
    renderPanel();
    if (runs.replay!.complete) replayReachedEnd();
    else if (pending.playOnCommit) setPlaying(true, 'seek');
  };

  const seekFailed = (pending: PendingSeek, error: unknown) => {
    endSeek(pending, 'failed', { error: String(error) });
    workflow.message = { kind: 'error', text: `The seek could not finish: ${error instanceof Error ? error.message : String(error)}. The replay still shows where it was.` };
    renderPanel();
  };

  const runParts = {
    root: $('run'),
    title: $('run-title'),
    tag: $('run-tag'),
    status: $('run-status'),
    meter: $('run-meter'),
    fill: $('run-fill'),
    timeline: $<HTMLInputElement>('run-timeline'),
    check: $('run-check'),
  };
  const runButtons = {
    record: $<HTMLButtonElement>('run-record'),
    stop: $<HTMLButtonElement>('run-stop'),
    replay: $<HTMLButtonElement>('run-replay'),
    restart: $<HTMLButtonElement>('run-restart'),
    return: $<HTMLButtonElement>('run-return'),
    cancel: $<HTMLButtonElement>('run-cancel'),
    save: $<HTMLButtonElement>('run-save'),
    open: $<HTMLButtonElement>('run-open'),
  };
  const STOPPED_TEXT: Partial<Record<StopReason, string>> = {
    duration: ' It stopped at the 60 s limit.',
    commands: ' It stopped at the 50,000-change limit.',
    bytes: ' It stopped at the 16 MiB limit.',
    fault: ' It ended where the simulation faulted.',
  };
  let runShown = '';

  /** The recording controls and read-only progress, per state; rebuilt only when what they show changes. */
  function renderRun() {
    renderComparison();
    runParts.root.hidden = comparing() || launchPending;
    if (comparing()) return;
    const state = replaying() ? 'replay' : runs.recordingState;
    const seconds = (ticks: number) => `${(ticks / 120).toFixed(2)} s`;
    const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
    let title = 'Recording';
    let tag = false;
    let status: (string | [string, string])[] = [];
    let meter: number | null = null;
    let timeline: { value: number; max: number } | null = null;
    let check: { text: string; result: string } | null = null;
    let shown: (keyof typeof runButtons)[] = [];
    const record = runs.record;
    if (state === 'idle') {
      status = ['Resets the motion to tick 0, then records what you change.'];
      shown = ['record', 'open'];
    } else if (state === 'recording') {
      const r = runs.recorder!;
      status = [['dot', ''], 'Recording ', ['count', seconds(r.tick)], ' of 60 s, ', ['count', changes(r.count)]];
      meter = Math.max(r.tick / RUN_LIMITS.ticks, r.count / RUN_LIMITS.commands, r.bytes / RUN_LIMITS.fileBytes);
      shown = ['stop'];
    } else if (state === 'finalizing') {
      status = ['Finishing the recording…'];
    } else if (state === 'recorded' && record) {
      status = ['Recorded ', ['count', seconds(record.finalTick)], ' and ', ['count', changes(record.commands.length)], `. ${runs.exported ? 'Saved.' : 'Not saved yet.'}${STOPPED_TEXT[record.stopped] ?? ''}`];
      shown = ['replay', 'save', 'record', 'open'];
    } else if (state === 'replay' && runs.replay) {
      const replay = runs.replay;
      const { finalTick, lastAppliedSequence } = replay.record;
      title = `Replay of “${replay.record.root.metadata.title}”`;
      tag = true;
      // A pending seek is named as a request: the displayed address stays the one actually shown (SPEC §14.2).
      const seek = pendingSeek;
      const seekShown = seek !== null && performance.now() - seek.requestedAt >= SEEK_PROGRESS_MS;
      if (seek && seekShown && seek.progressShownAfter === null) {
        seek.progressShownAfter = performance.now() - seek.requestedAt;
        report('seek', { action: 'progress-shown', id: seek.job.id, afterMs: round3(seek.progressShownAfter), progress: round3(runs.seekProgress(seek.job)) });
      }
      const where = seek
        ? ` Seeking to tick ${seek.job.target.tick}, change ${seek.job.target.cursor}…${seekShown ? ` ${Math.floor(runs.seekProgress(seek.job) * 100)}%` : ''}${seek.playOnCommit ? ' Then playing.' : ''}`
        : runs.replayPartial
          ? ` Applying the recorded changes at tick ${host.tick}…`
          : replay.complete
            ? ' At the recorded end.'
            : scheduler.playing
              ? ' Playing.'
              : ' Paused.';
      // A seek's world has no trail history: trails start again at its address rather than pretend to reach back.
      const trailNote = seekedTrails && !seek && (trails.mode === 'all' || (trails.mode === 'selected' && explained !== null)) ? ' Trails start again from here.' : '';
      status = ['tick ', ['count', String(host.tick)], ' of ', ['count', String(finalTick)], ', change ', ['count', String(host.lastAppliedSequence)], ' of ', ['count', String(lastAppliedSequence)], `.${where}${trailNote}`];
      timeline = { value: seek ? seek.job.target.tick : host.tick, max: finalTick };
      // While a seek shows its progress, the progressbar carries it for assistive technology and the eye alike.
      meter = seekShown ? runs.seekProgress(seek.job) : null;
      if (replayEnded) {
        const recorded = replay.record.qualification;
        const unknown = Object.entries(recorded).filter(([, v]) => v.startsWith('unavailable')).map(([k]) => k);
        const exactness = runs.replayQualified
          ? ''
          : recorded.build !== 'packaged'
            ? ` It was recorded in a ${recorded.build} build, not the packaged app, so this is not a qualified exact replay.`
            : ` Its recorded identity lacks ${unknown.join(', ')}, so this is not a qualified exact replay.`;
        check = !replayCheck
          ? { text: 'Checking against the recorded end…', result: 'pending' }
          : replayCheck.kind === 'match'
            ? { text: `Reached the recorded end exactly: state and engine match.${exactness}`, result: 'match' }
            : replayCheck.kind === 'mismatch'
              ? { text: `Did not reach the recorded end: the ${[replayCheck.state ? '' : 'state', replayCheck.engine ? '' : 'engine'].filter(Boolean).join(' and ')} differ${!replayCheck.state && !replayCheck.engine ? '' : 's'}.`, result: 'mismatch' }
              : { text: 'This recording ended on a simulation fault, so it has no end state to check.', result: 'unavailable' };
      }
      shown = seekShown ? ['restart', 'return', 'save', 'open', 'cancel'] : ['restart', 'return', 'save', 'open'];
    }
    const busy = workflow.busy !== null;
    const signature = JSON.stringify([runParts.root.hidden, state, title, tag, status, meter === null ? null : Math.round(meter * 1000), timeline, check, shown, busy]);
    if (signature === runShown) return;
    runShown = signature;
    runParts.root.dataset.state = state;
    runParts.title.textContent = title; // text, never markup: titles come from files
    runParts.tag.hidden = !tag;
    runParts.status.replaceChildren(
      ...status.map((part) => {
        if (typeof part === 'string') return document.createTextNode(part);
        const span = document.createElement('span');
        span.className = part[0];
        span.textContent = part[1];
        return span;
      }),
    );
    runParts.meter.hidden = meter === null;
    if (meter !== null) {
      runParts.fill.style.width = `${Math.min(100, meter * 100).toFixed(1)}%`;
      runParts.meter.setAttribute('aria-valuenow', String(Math.round(meter * 100)));
    }
    runParts.timeline.hidden = timeline === null;
    if (timeline) {
      // The maximum first: a value beyond the old maximum would be clamped.
      runParts.timeline.max = String(timeline.max);
      if (runParts.timeline.value !== String(timeline.value)) runParts.timeline.value = String(timeline.value);
      runParts.timeline.setAttribute('aria-valuetext', `tick ${timeline.value} of ${timeline.max}`);
      runParts.timeline.style.setProperty('--timeline-fill', `${timeline.max > 0 ? ((100 * timeline.value) / timeline.max).toFixed(2) : 0}%`);
      runParts.timeline.disabled = busy || timeline.max === 0;
    }
    runParts.check.hidden = check === null;
    runParts.check.textContent = check?.text ?? '';
    runParts.check.dataset.result = check?.result ?? '';
    for (const [key, button] of Object.entries(runButtons)) {
      button.hidden = !shown.includes(key as keyof typeof runButtons);
      button.disabled = busy;
    }
    // The body readout starts below this cluster, however tall its state makes it.
    const reserve = runParts.root.hidden ? 0 : runParts.root.offsetHeight + 8;
    document.documentElement.style.setProperty('--run-reserve', `${reserve}px`);
  }

  runButtons.record.addEventListener('click', () => runFile('record'));
  runButtons.stop.addEventListener('click', () => stopRecording('control'));
  runButtons.replay.addEventListener('click', enterReplay);
  runButtons.restart.addEventListener('click', restartReplay);
  runButtons.return.addEventListener('click', returnToAuthoring);
  runButtons.cancel.addEventListener('click', () => cancelPendingSeek('cancel'));
  // Every movement of the timeline is a request; only the latest one becomes visible (SPEC §14.2).
  runParts.timeline.addEventListener('input', () => {
    const record = runs.replay?.record;
    if (record) void requestSeek(tickAddress(record, Number(runParts.timeline.value)), 'timeline');
  });
  runButtons.save.addEventListener('click', () => runFile('saveRecording'));
  runButtons.open.addEventListener('click', () => runFile('openRecording'));

  // P0 (SPEC §18.2): 10 s warmup, then a 60 s capture with every raw sample kept.
  interface P0Capture {
    run: number;
    comparison: boolean;
    phase: 'warmup' | 'measure';
    phaseStart: number;
    tickStart: number;
    droppedStart: number;
    supersededStart: number;
    intervals: number[];
    work: number[];
    steps: number[];
    edits: number[];
    /** Per completed step: the probe step, the trail sample, and the step with both (observed, not summed percentiles). */
    probes: number[];
    trails: number[];
    ticks: number[];
    invalid: string | null;
  }
  const startP0 = () => {
    if (p0 || frozen) return;
    if (comparing() && (runs.comparison!.horizon - runs.comparison!.address.tick !== 7200 || runs.comparison!.replaying || runs.comparison!.working)) return;
    if (comparing()) { runs.comparison!.newAlternate(); showWorld('p3-warmup'); applyFreeze(); }
    setPlaying(true, 'p0');
    p0 = { comparison: comparing(), run: ++p0Runs, phase: 'warmup', phaseStart: performance.now(), tickStart: 0, droppedStart: 0, supersededStart: 0, intervals: [], work: [], steps: [], edits: [], probes: [], trails: [], ticks: [], invalid: null };
    report('p0', { phase: 'warmup', run: p0.run });
  };
  const finishP0 = (capture: P0Capture, now: number) => {
    const wallMs = now - capture.phaseStart;
    const canvas = renderer.domElement;
    report(capture.comparison ? 'p3-run' : 'p0-run', {
      comparison: runs.comparison?.counts() ?? null,
      run: capture.run,
      invalid: capture.invalid,
      // A gate with no samples was not measured; its percentiles are null, never zero.
      incomplete: capture.edits.length ? null : 'no accepted edits during the capture: edit latency not measured',
      wallMs: round3(wallMs),
      ticks: host.tick - capture.tickStart,
      simWallRatio: round3(((host.tick - capture.tickStart) * STEP_MS) / wallMs),
      droppedMs: round3(scheduler.droppedMs - capture.droppedStart),
      bodies: host.count,
      arrows: world.arrowCount(),
      // The measured workload (SPEC §18.1): the protocol is P0's; the scene decides P0 or P1.
      workload: {
        title: editor().metadata.title,
        laws: host.appliedFields().length,
        lawKinds: [...new Set(host.appliedFields().flatMap((f) => {
          const kinds: string[] = [f.region.kind];
          walk(f.expression, (node) => kinds.push(node.kind));
          return kinds;
        }))].sort(),
        primitiveLeaves: host.appliedFields().reduce((n, f) => n + expressionStats(f.expression).leaves, 0),
        fixedColliders: editor().scene.bodies.filter((b) => b.type === 'fixed').length,
        authoredDynamic: editor().scene.bodies.filter((b) => b.type === 'dynamic').length,
        allBodyContacts: editor().scene.bodies.some((b) => b.type === 'dynamic' && b.collisionMode === 'all') || editor().scene.emitters.some((e) => e.template.collisionMode === 'all'),
        limitedSteps: host.limitedSteps,
      },
      // The optional visualization during the capture (M4): P0 runs with all of it off, P2 with it on.
      visualization: { ...visualizationState(), comparison: ghosts?.counts() ?? null, ghostsShown },
      viewport: { css: [window.innerWidth, window.innerHeight], devicePixelRatio: window.devicePixelRatio, pixelRatio: renderer.getPixelRatio(), canvas: [canvas.width, canvas.height] },
      timerResolutionMs: timerMs,
      percentiles: 'p50, p95, p99, max',
      stepMs: percentiles(capture.steps),
      editMs: percentiles(capture.edits),
      intervalMs: percentiles(capture.intervals),
      workMs: percentiles(capture.work),
      probeMs: percentiles(capture.probes),
      trailMs: percentiles(capture.trails),
      tickMs: percentiles(capture.ticks),
      samples: { steps: capture.steps.length, edits: capture.edits.length, frames: capture.intervals.length, probeSteps: capture.probes.length, trailSteps: capture.trails.length },
      editsSuperseded: editLatency.superseded - capture.supersededStart,
      raw: {
        stepMs: capture.steps.map(round3),
        editMs: capture.edits.map(round3),
        intervalMs: capture.intervals.map(round3),
        workMs: capture.work.map(round3),
        probeMs: capture.probes.map(round3),
        trailMs: capture.trails.map(round3),
        tickMs: capture.ticks.map(round3),
      },
    });
  };

  /**
   * Layout readback (Shift+L): where the controls, laws and gizmo handles are in CSS pixels, so a
   * QA harness can aim its input and assert the structural layout instead of reading screenshots.
   */
  const layoutReport = () => {
    const box = (element: Element | null) => {
      if (!element || (element as HTMLElement).closest('[hidden]')) return null;
      const r = element.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    };
    const controls: Record<string, number[] | null> = {};
    for (const element of document.querySelectorAll<HTMLElement>('#panel, #tools, #transport, #overlays, #drag-region, #recovery-offer, #details, #motion, #explain, #trail-mode, #run, #comparison, #diagnostics, button[id], input[id]')) {
      controls[element.id] = box(element);
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) controls[`mode-${button.dataset.mode}`] = box(button);
    const laws = [...lawList.querySelectorAll('.law-row')].map((row) => ({
      id: row.querySelector<HTMLElement>('.law-select')!.dataset.id,
      label: row.querySelector('.law-name')!.textContent,
      select: box(row.querySelector('.law-select')),
      visible: box(row.querySelector('.law-visible')),
      enabled: box(row.querySelector('.law-enabled')),
    }));
    const inputs = Object.fromEntries([...details.querySelectorAll('input')].map((input) => [input.getAttribute('aria-label') ?? input.id, box(input)]));
    const swatches = Object.fromEntries([...colorGroup.querySelectorAll<HTMLButtonElement>('.swatch')].map((s) => [s.dataset.color, box(s)]));
    const toScreen = (v: Vector3) => {
      v.project(viewport.camera);
      return [Math.round(((v.x + 1) / 2) * window.innerWidth * 10) / 10, Math.round(((1 - v.y) / 2) * window.innerHeight * 10) / 10];
    };
    const law = selectedLaw();
    let support: number[] | null = null;
    if (law) {
      const [hx, hy, hz] = regionDescriptor(law.region.kind).bounds(law.region);
      const q = new Quaternion(...law.pose.rotation);
      const points = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => toScreen(new Vector3(sx * hx, sy * hy, sz * hz).applyQuaternion(q).add(new Vector3(...law.pose.position))))));
      const xs = points.map((p) => p[0]!);
      const ys = points.map((p) => p[1]!);
      support = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    // Pinned three 0.186.1: TransformControlsGizmo keeps its pick meshes in `picker[mode]`.
    let handles: { name: string; points: number[][] }[] | null = null;
    const helper = viewport.gizmo.getHelper();
    helper.updateMatrixWorld(true);
    const gizmo = helper.children.find((c) => 'picker' in c) as (Object3D & { picker?: Record<string, Object3D> }) | undefined;
    const pickers = law && viewport.gizmo.object ? gizmo?.picker?.[viewport.gizmo.mode] : undefined;
    if (pickers) {
      handles = pickers.children
        .filter((mesh) => mesh.scale.x > 1e-6)
        .map((mesh) => {
          // three bakes each handle's offset into its geometry, so project the geometry: the center
          // of an arrow or box handle, and eight samples around a rotation ring.
          const geometry = (mesh as Mesh).geometry;
          let local: Vector3[];
          const torus = (geometry as { parameters?: { radialSegments?: number; tubularSegments?: number } }).parameters;
          if (viewport.gizmo.mode === 'rotate' && torus?.radialSegments && torus.tubularSegments) {
            // Points on the ring's center line, where a press reliably hits the tube: the mean of
            // each tube cross-section (TorusGeometry vertex index j·(tubular+1)+i).
            const position = geometry.getAttribute('position');
            const radial = torus.radialSegments;
            const tubular = torus.tubularSegments;
            local = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
              const i = Math.floor((k * tubular) / 8);
              const mean = new Vector3();
              for (let j = 0; j < radial; j++) mean.add(new Vector3().fromBufferAttribute(position, j * (tubular + 1) + i));
              return mean.divideScalar(radial);
            });
          } else {
            geometry.computeBoundingBox();
            local = [geometry.boundingBox!.getCenter(new Vector3())];
          }
          return { name: mesh.name, points: local.map((p) => toScreen(p.applyMatrix4(mesh.matrixWorld))) };
        });
    }
    // M5: the selected law's ingredient list and the focused ingredient's controls, by role, path and label.
    const nodeOf = (element: Element) => element.closest<HTMLElement>('[data-node]')?.dataset.node ?? null;
    const ingredients = {
      ...ingredientPanel.state(),
      shelf: Object.fromEntries([...document.querySelectorAll<HTMLButtonElement>('#ingredient-shelf button')].map((b) => [b.dataset.add, box(b)])),
      rows: [...document.querySelectorAll('#ingredient-list .ingredient-row')].map((row) => {
        const select = row.querySelector<HTMLButtonElement>('.ingredient-select')!;
        return { path: select.dataset.path, label: select.querySelector('.law-name')!.textContent, meta: select.querySelector('.law-meta')!.textContent, pressed: select.getAttribute('aria-pressed') === 'true', select: box(select), remove: box(row.querySelector('.ingredient-remove')) };
      }),
      buttons: [...document.querySelectorAll<HTMLButtonElement>('#ingredient-detail button')].map((b) => ({ action: b.dataset.action, value: b.dataset.value ?? null, checked: b.getAttribute('aria-checked'), node: nodeOf(b), text: b.textContent, box: box(b) })),
      fields: [...document.querySelectorAll<HTMLInputElement>('#ingredient-detail input')].map((i) => ({ label: i.getAttribute('aria-label'), key: i.dataset.key, node: nodeOf(i), value: i.value, box: box(i) })),
      live: [...document.querySelectorAll('#ingredient-detail [data-live]')].map((p) => p.textContent),
      up: box($('ingredient-up')),
      detail: box($('ingredient-detail')),
      note: $('ingredients-note').textContent,
      box: box($('ingredients')),
    };
    report('layout', {
      playing: scheduler.playing,
      authority: authorityReceipt(host),
      viewport: [window.innerWidth, window.innerHeight],
      devicePixelRatio: window.devicePixelRatio,
      controls,
      laws,
      inputs,
      swatches,
      ingredients,
      selected: law?.id ?? null,
      // The selected law as applied, so a harness can test bodies against its support itself.
      selectedField: law ?? null,
      arrows: world.arrowCount(),
      transformMode: interaction.mode,
      support,
      handles,
      // Spatial handles of the selected law in handle mode, at their projected centers.
      lawHandles: interaction.handlesOnScreen(),
      // The explained body's center now, and the panel's scroll extent (it must not scroll sideways).
      explained: explained === null ? null : { id: explained, point: (() => { const i = host.ids.indexOf(explained); return i < 0 ? null : toScreen(new Vector3(host.positions[3 * i]!, host.positions[3 * i + 1]!, host.positions[3 * i + 2]!)); })() },
      scroll: Object.fromEntries(['panel', 'explain'].map((id) => { const e = $(id); return [id, { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, scrollTop: e.scrollTop }]; })),
      visualization: { ...visualizationState(), comparison: ghosts?.counts() ?? null, ghostsShown },
      comparison: runs.comparison ? { ...runs.comparison.counts(), receipt: comparisonReceipt(), address: runs.comparison.address, tick: host.tick, cursor: host.lastAppliedSequence, replaying: runs.comparison.replaying, working: !!runs.comparison.working, status: $('comparison-status').textContent, inspect: $('comparison-inspect').textContent, box: box($('comparison')) } : null,
      run: {
        state: runParts.root.dataset.state,
        title: runParts.title.textContent,
        status: runParts.status.textContent,
        check: runParts.check.hidden ? null : runParts.check.textContent,
        meter: runParts.meter.hidden ? null : Number(runParts.meter.getAttribute('aria-valuenow')),
        box: box(runParts.root),
        buttons: Object.fromEntries(Object.entries(runButtons).map(([key, b]) => [key, b.hidden ? null : box(b)])),
        recording: runs.recorder ? { runId: runs.recorder.runId, tick: runs.recorder.tick, count: runs.recorder.count, bytes: runs.recorder.bytes } : null,
        record: runs.record ? { ...recordSummary(runs.record), exported: runs.exported } : null,
        replay: runs.replay ? { address: runs.replay.address, complete: runs.replay.complete, partial: runs.replayPartial, check: replayCheck, generation: host.generation } : null,
        timeline: runParts.timeline.hidden ? null : { box: box(runParts.timeline), value: Number(runParts.timeline.value), max: Number(runParts.timeline.max) },
        seeking: pendingSeek ? { id: pendingSeek.job.id, target: pendingSeek.job.target, progress: round3(runs.seekProgress(pendingSeek.job)), elapsedMs: round3(performance.now() - pendingSeek.requestedAt), shown: pendingSeek.progressShownAfter !== null } : null,
        contexts: runs.counts(),
      },
      camera: viewport.camera.position.toArray(),
      // World → clip space, so a harness can find where any world point appears.
      viewProjection: viewport.camera.projectionMatrix.clone().multiply(viewport.camera.matrixWorldInverse).elements,
      // Where bodies are, so a harness can click one it chose by position (up to 128, in host order).
      bodies: Array.from({ length: Math.min(host.count, 128) }, (_, i) => {
        const world = [host.positions[3 * i]!, host.positions[3 * i + 1]!, host.positions[3 * i + 2]!];
        return { id: host.ids[i]!, world, point: toScreen(new Vector3(world[0], world[1], world[2])) };
      }),
    });
  };

  // Determinism fixtures in this runtime (T04): the same code the Vitest harness runs.
  const runFixtures = async () => {
    setPlaying(false, 'fixtures');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = cloneFrozen(authoring.scene);
    const t0 = performance.now();
    const reset = runResetFixture(root);
    const script = scriptedEdits(root);
    const referenceHost = new SimulationHost(root);
    const reference = runFixedSteps(referenceHost, script);
    referenceHost.dispose();
    const cadence = [30, 60, 144].map((hz) => ({ hz, comparison: compareRuns(reference, runAtCadence(root, hz, script)) }));
    const scriptedReset = runResetFixture(root, script);
    // M4: visualization cannot alter authority (AC6), a reset with the view changed (T04), and T08's
    // trail and contribution checks, all in this runtime.
    const visualization = visualizationInvariance(root, script);
    const observedReset = observedResetFixture(root, script);
    const trailCheck = trailFidelity(root);
    const contributions = explanationFixture(root, script);
    report('fixtures', {
      elapsedMs: Math.round(performance.now() - t0),
      root: root.fields.map(lawSummary),
      reset,
      scriptedReset,
      cadence,
      visualization,
      observedReset,
      trails: trailCheck,
      contributions,
      allEqual: [...reset, ...scriptedReset, ...cadence.flatMap((c) => c.comparison), ...visualization.flatMap((v) => v.comparison), ...observedReset].every((c) => c.equal),
      t08: trailCheck.mismatches === 0 && trailCheck.samples > 0 && contributions.pass,
    });
  };

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  /**
   * M6A in this runtime (Shift+M), on the finished recording: the linear oracle run twice from the root
   * and compared at every unit (state and engine bytes) and against the recorded end; then T11's cycles
   * through the same calls the controls make, counting worlds, contexts and render resources.
   */
  const runRunFixtures = async () => {
    const record = runs.record;
    if (frozen || replaying() || comparing() || !record || runs.recordingState !== 'recorded') {
      report('m6a-fixtures', { error: 'Shift+M needs a finished recording, from authoring' });
      return;
    }
    setPlaying(false, 'fixtures');
    await nextFrame();
    const t0 = performance.now();
    // 1. The oracle against itself and against the recorded end.
    const a = new LinearReplay(record);
    const b = new LinearReplay(record);
    let units = 0;
    let divergence = replayDivergence(observe(a.host), observe(b.host));
    while (!divergence && !a.complete) {
      a.advance();
      b.advance();
      units += 1;
      divergence = replayDivergence(observe(a.host), observe(b.host));
    }
    const [stateSha256, engineSha256] = await Promise.all([sha256(JSON.stringify(a.host.futureState())), sha256(a.host.engineSnapshot())]);
    const end = { address: a.address, complete: a.complete, stateSha256, engineSha256, matchesRecord: record.finalCheck !== null && stateSha256 === record.finalCheck.stateSha256 && engineSha256 === record.finalCheck.engineSha256 };
    a.dispose();
    b.dispose();
    const oracleMs = performance.now() - t0;
    // 2. T11: replay/return and restart cycles, and imports, through the control paths.
    const exported = runs.exported;
    const sample = () => ({ ...runs.counts(), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, objects: sceneObjects() });
    const before = sample();
    resetPeakWorlds();
    const cycles: ReturnType<typeof sample>[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      enterReplay();
      driveReplay(30);
      await nextFrame();
      restartReplay();
      driveReplay(30);
      await nextFrame();
      returnToAuthoring();
      await nextFrame();
      cycles.push(sample());
    }
    enterReplay();
    const restarts: ReturnType<typeof sample>[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      driveReplay(40);
      await nextFrame();
      restartReplay();
      await nextFrame();
      restarts.push(sample());
    }
    const text = exportRun(record).text;
    const imports: { kind: string; during: ReturnType<typeof sample>; after: ReturnType<typeof sample> }[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const kind = ['valid', 'invalid', 'canceled', 'unbuildable'][cycle % 4]!;
      const parsed = parseRun(kind === 'invalid' ? text.replace('"sequence":1,', '"sequence":2,') : text, { fingerprint: SIMULATION_FINGERPRINT, identity });
      let during = sample();
      if (parsed.ok && kind !== 'unbuildable') {
        // The same candidate the Open Recording workflow builds: an unstepped world and its view.
        const replay = runs.prepareImport(parsed.record);
        const view = world.prepareScene(parsed.record.root.semantic, true);
        const candidate = { replay, view, dispose: () => (runs.discardImport(replay), world.discardScene(view)) };
        during = sample();
        if (kind === 'valid') {
          world.discardScene(world.swapScene(candidate.view));
          runs.commitImport(candidate.replay);
          showContext('fixture-import');
        } else candidate.dispose();
      } else if (parsed.ok) {
        try {
          runs.prepareImport({ ...parsed.record, root: { ...parsed.record.root, semantic: { ...parsed.record.root.semantic, simulation: { ...parsed.record.root.semantic.simulation, profile: 'unbuildable' } } } });
        } catch {
          // Refused before allocating anything.
        }
      }
      await nextFrame();
      imports.push({ kind, during, after: sample() });
    }
    returnToAuthoring();
    // The imported copy is the same record read from text; it was never written to a file here.
    runs.exported = exported;
    await nextFrame();
    const after = sample();
    report('m6a-fixtures', {
      elapsedMs: Math.round(performance.now() - t0),
      oracle: { runId: record.runId, units, divergence, end, recorded: record.finalCheck, ms: Math.round(oracleMs) },
      lifecycle: { before, cycles, restarts, imports, after, peakWorlds: worldCounts().peak },
      pass: divergence === null && end.matchesRecord && after.worlds === before.worlds && after.geometries === before.geometries && after.objects === before.objects && worldCounts().peak - before.worlds <= 2,
    });
    renderPanel();
  };

  /**
   * M6B in this runtime (Shift+C), on the finished recording, through the controls' own paths: Replay,
   * the timeline's seek request, Cancel, Replay from start and Return to authoring.
   *   1. Every target (special addresses, every same-tick group's inner cursors, seeded random ticks) in a
   *      seeded order against the uninterrupted checkpoint-free oracle, state and engine bytes.
   *   2. Cached seek latency to the first frame drawn with the target: 100 seeded targets with every 240th
   *      tick cached, gated at p95 ≤ 250 ms on a 60-second recording and reported on any other.
   *   3. An uncached seek to the end, gated on ~8 ms batches and progress shown at 100 ms, and a long one
   *      canceled once its progress shows. Play and Space pressed during long seeks only toggle playing
   *      from the target: the displayed replay holds still, stays paused after Cancel, and plays on from
   *      the target after a commit.
   *   4. T11: 20 seek/reset cycles, counting worlds, checkpoint bytes and render resources.
   */
  const runSeekFixtures = async () => {
    const record = runs.record;
    if (frozen || replaying() || comparing() || !record || runs.recordingState !== 'recorded') {
      report('m6b-fixtures', { error: 'Shift+C needs a finished recording, from authoring' });
      return;
    }
    setPlaying(false, 'fixtures');
    await nextFrame();
    const t0 = performance.now();
    const last = record.finalTick;
    const key = (a: Address) => `${a.tick}:${a.cursor}`;
    let seed = 0x5eed1234;
    const random = (n: number) => {
      seed = xorshift32(seed);
      return seed % n;
    };
    const at = (n: number) => tickAddress(record, n);
    // 1. Targets.
    const inner: Address[] = [];
    for (let i = 1; i < record.commands.length && inner.length < 40; i++) {
      if (record.commands[i]!.atTick === record.commands[i - 1]!.atTick) inner.push({ tick: record.commands[i]!.atTick, cursor: i });
    }
    const before = (n: number) => ({ tick: n, cursor: at(n - 1).cursor });
    const special = [{ tick: 0, cursor: 0 }, at(Math.min(1, last)), at(Math.min(239, last)), last >= 240 ? before(240) : at(last), at(Math.min(241, last)), last > 0 ? before(last) : at(last), at(last)];
    const ticks = Array.from({ length: 40 }, () => at(random(last + 1)));
    const targets = [...new Map([...special, ...inner, ...ticks].map((a) => [key(a), a])).values()];
    const expected = new Map<string, Observed>();
    const oracle = new LinearReplay(record);
    for (const a of [...targets].sort((x, y) => x.tick - y.tick || x.cursor - y.cursor)) {
      oracle.runTo(a);
      expected.set(key(a), observe(oracle.host));
    }
    oracle.dispose();
    const oracleMs = performance.now() - t0;
    const sample = () => ({ ...runs.counts(), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, objects: sceneObjects() });
    const outside = sample();
    const scope = runs.scope(record);
    runs.checkpoints.discardHistory(scope.historyContextId);
    enterReplay();
    const compared: { target: Address; action: string; source: string | null; bodies: number; divergence: unknown }[] = [];
    for (let i = targets.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [targets[i], targets[j]] = [targets[j]!, targets[i]!];
    }
    for (const target of targets) {
      const outcome = await requestSeek(target, 'fixture');
      const shownAt = runs.replay!.address;
      const divergence = shownAt.tick === target.tick && shownAt.cursor === target.cursor ? replayDivergence(expected.get(key(target))!, observe(host)) : { entity: 'address', observed: shownAt };
      compared.push({ target, action: outcome?.action ?? 'shown', source: outcome?.job.source?.kind ?? null, bodies: host.count, divergence });
    }
    // 2. Cached latency, with every 240th tick held: from the request to the first frame submitted with the
    // target's world, as edit latency is measured (SPEC §18), and to the swap alone.
    await requestSeek(at(last), 'fixture');
    const cached: { drawnMs: number; committedMs: number; workMs: number; steps: number; source: string | null }[] = [];
    for (let i = 0; i < 100; i++) {
      const outcome = await requestSeek(at(random(last + 1)), 'fixture-cached');
      const drawnMs = outcome?.action === 'committed' ? await outcome.drawn : null;
      if (outcome && drawnMs !== null) cached.push({ drawnMs: round3(drawnMs), committedMs: round3(outcome.elapsedMs), workMs: round3(outcome.job.workMs), steps: outcome.job.steps, source: outcome.job.source?.kind ?? null });
    }
    // 3. Uncached, from the root to the end: its batches and when its progress showed.
    restartReplay();
    runs.checkpoints.discardHistory(scope.historyContextId);
    const full = await requestSeek(at(last), 'fixture-uncached');
    const batchMs = full ? percentiles(full.batches.slice(1)) : null;
    const uncached = full
      ? {
          action: full.action,
          elapsedMs: round3(full.elapsedMs),
          workMs: round3(full.job.workMs),
          steps: full.job.steps,
          batches: full.batches.length,
          firstBatchMs: round3(full.batches[0] ?? 0),
          batchMs,
          progressShownAfterMs: full.progressShownAfter === null ? null : round3(full.progressShownAfter),
        }
      : null;
    // About 8 ms per batch: the 95th percentile within one unit of work over it. Progress within a frame or so of 100 ms.
    const uncachedGate = {
      batches: full !== null && (batchMs === null || batchMs[1]! <= REPLAY_BUDGET_MS + 2),
      progress: full !== null && (full.elapsedMs < SEEK_PROGRESS_MS || (full.progressShownAfter !== null && full.progressShownAfter >= SEEK_PROGRESS_MS && full.progressShownAfter <= SEEK_PROGRESS_MS + 50)),
    };
    // A long one canceled once its progress and Cancel are visible.
    restartReplay();
    runs.checkpoints.discardHistory(scope.historyContextId);
    const shownBefore = observe(host);
    const pending = requestSeek(at(last), 'fixture-cancel');
    for (let frame = 0; frame < 600 && pendingSeek && pendingSeek.progressShownAfter === null; frame++) await nextFrame();
    const exercised = pendingSeek !== null && pendingSeek.progressShownAfter !== null;
    if (exercised) cancelPendingSeek('fixture-cancel');
    const canceled = await pending;
    const cancel = { exercised, action: canceled?.action ?? null, elapsedMs: canceled ? round3(canceled.elapsedMs) : null, shownUnchanged: !exercised || replayDivergence(shownBefore, observe(host)) === null, worlds: runs.counts().worlds };
    // Play and Space during a long seek, through their own handlers: each press toggles the request to play
    // from the target, and the button shows it, while the displayed replay stays paused exactly as it was.
    const space = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    const click = () => playButton.click();
    const pressDuring = async (target: Address, presses: (() => void)[], asks: boolean[]) => {
      restartReplay();
      runs.checkpoints.discardHistory(scope.historyContextId);
      const shown = observe(host);
      const outcome = requestSeek(target, 'fixture-controls');
      const job = pendingSeek?.job ?? null;
      const asked: boolean[] = [];
      let held = true;
      for (const p of presses) {
        p();
        await nextFrame();
        await nextFrame();
        const still = pendingSeek;
        if (!still || still.job !== job) break;
        asked.push(still.playOnCommit);
        held &&= !scheduler.playing && playButton.getAttribute('aria-pressed') === String(still.playOnCommit) && replayDivergence(shown, observe(host)) === null;
      }
      const exercised = job !== null && asked.length === presses.length;
      return { shown, outcome, exercised, asked: exercised && asked.every((a, i) => a === asks[i]), held };
    };
    // Cancel after a deferred Play leaves the replay where it was, paused.
    const toCancel = await pressDuring(at(last), [click, click, space, space, click], [true, false, true, false, true]);
    if (toCancel.exercised) cancelPendingSeek('fixture-controls');
    await toCancel.outcome;
    await nextFrame();
    const canceledPaused = !scheduler.playing && playButton.getAttribute('aria-pressed') === 'false' && replayDivergence(toCancel.shown, observe(host)) === null;
    // A commit after one plays on from the target, and from nowhere else.
    const playTarget = at(Math.floor(last * 0.9));
    const toCommit = await pressDuring(playTarget, [space, click, click], [true, false, true]);
    const played = await toCommit.outcome;
    const atCommit = { address: runs.replay!.address, playing: scheduler.playing };
    for (let frame = 0; frame < 6; frame++) await nextFrame();
    const playedOn = runs.replay!.address.tick > playTarget.tick;
    setPlaying(false, 'fixtures');
    const controls = {
      exercised: toCancel.exercised && toCommit.exercised,
      asked: toCancel.asked && toCommit.asked,
      held: toCancel.held && toCommit.held,
      canceledPaused,
      committed: played?.action ?? null,
      fromTarget: atCommit.address.tick === playTarget.tick && atCommit.address.cursor === playTarget.cursor && atCommit.playing && playedOn,
    };
    // 4. T11 cycles through the controls.
    await requestSeek(at(last), 'fixture');
    resetPeakWorlds();
    const cycles: ReturnType<typeof sample>[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      await requestSeek(at(random(last + 1)), 'fixture-cycle');
      const superseded = requestSeek(at(random(last + 1)), 'fixture-cycle');
      await requestSeek(at(random(last + 1)), 'fixture-cycle');
      await superseded;
      restartReplay();
      void requestSeek(at(random(last + 1)), 'fixture-cycle');
      await nextFrame();
      returnToAuthoring();
      await nextFrame();
      cycles.push(sample());
      enterReplay();
    }
    returnToAuthoring();
    await nextFrame();
    const after = sample();
    const divergent = compared.filter((c) => c.divergence !== null);
    const latency = percentiles(cached.map((c) => c.drawnMs));
    // The gate is for a 60-second recording (SPEC §18.2); on a shorter one the figures are reported, not gated.
    const latencyGate = { recordingSeconds: last / 120, applies: last === RUN_LIMITS.ticks, drawnP95Ms: latency?.[1] ?? null, pass: latency !== null && latency[1]! <= 250 };
    report('m6b-fixtures', {
      elapsedMs: Math.round(performance.now() - t0),
      runId: record.runId,
      finalTick: last,
      commands: record.commands.length,
      oracleMs: Math.round(oracleMs),
      compared: compared.length,
      sources: compared.reduce<Record<string, number>>((n, c) => ((n[c.source ?? 'shown'] = (n[c.source ?? 'shown'] ?? 0) + 1), n), {}),
      divergent,
      targets: compared.map((c) => [c.target.tick, c.target.cursor, c.source, c.bodies]),
      cached: {
        percentiles: 'p50, p95, p99, max',
        drawnMs: latency,
        committedMs: percentiles(cached.map((c) => c.committedMs)),
        workMs: percentiles(cached.map((c) => c.workMs)),
        steps: percentiles(cached.map((c) => c.steps)),
        sources: [...new Set(cached.map((c) => c.source))],
        raw: cached,
      },
      latencyGate,
      uncached,
      uncachedGate,
      cancel,
      controls,
      lifecycle: { outside, cycles, after, peakWorlds: worldCounts().peak },
      pass:
        divergent.length === 0 &&
        cached.length > 0 &&
        (!latencyGate.applies || latencyGate.pass) &&
        uncachedGate.batches &&
        uncachedGate.progress &&
        cancel.exercised &&
        cancel.action === 'canceled' &&
        cancel.shownUnchanged &&
        controls.exercised &&
        controls.asked &&
        controls.held &&
        controls.canceledPaused &&
        controls.committed === 'committed' &&
        controls.fromTarget &&
        after.worlds === outside.worlds &&
        after.geometries === outside.geometries &&
        after.objects === outside.objects &&
        cycles.every((c) => c.worlds === outside.worlds && c.checkpointBytes === cycles[0]!.checkpointBytes) &&
        worldCounts().peak - outside.worlds <= 2,
    });
    renderPanel();
  };

  window.addEventListener('keydown', (event) => {
    // The replay timeline takes no text: Play, Step and the other keys still work while it has focus.
    const typing = (event.target instanceof HTMLInputElement && event.target.type !== 'range') || event.target instanceof HTMLTextAreaElement;
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'o' || key === 's') {
        event.preventDefault();
        runFile(key === 'o' ? 'open' : event.shiftKey ? 'saveAs' : 'save');
      } else if (key === 'z' && !typing) {
        // Author undo outside text editing; a focused text field keeps its own undo (SPEC §11.1).
        event.preventDefault();
        undo(event.shiftKey);
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }
    if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) return;
    // A readback changes nothing, so it also works while edits are frozen.
    if (event.key === 'L') return layoutReport();
    if (frozen) return;
    switch (event.key) {
      case 't': return setMode('translate');
      case 'r': return setMode('rotate');
      case 's': return setMode('scale');
      case 'f': return frameLaw();
      case ' ':
        event.preventDefault();
        return setPlaying(!requestedPlaying(), 'keyboard');
      case '.': return stepOnce();
      case 'R': return resetScene();
      case 'Backspace':
      case 'Delete':
        return deleteSelected();
      case 'Escape':
        // A pending seek first; then the focused timeline lets go; then a gesture, the explained body, the law selection.
        if (pendingSeek) return cancelPendingSeek('escape');
        if (event.target === runParts.timeline) return runParts.timeline.blur();
        if (interaction.cancel('escape')) return;
        if (explained !== null) setExplained(null, 'escape');
        else interaction.select(null);
        return;
      case 'b': return explainNearest();
      case 'E': return reportExplanation();
      case 'V': return report('visual-resources', visualizationState());
      case 'P': return startP0();
      case 'D':
        runFixtures().catch((error: unknown) => report('fixtures', { error: String(error) }));
        return;
      case 'M':
        runRunFixtures().catch((error: unknown) => report('m6a-fixtures', { error: String(error) }));
        return;
      case 'C':
        runSeekFixtures().catch((error: unknown) => report('m6b-fixtures', { error: String(error) }));
        return;
      case 'J':
        if (comparing() || workflow.busy || scheduler.playing || interaction.gesture) return;
        guardFrozen = true; applyFreeze();
        void comparisonQualification(identity, (data) => report('m7-fixtures', data)).then(() => report('m7-fixtures', { complete: true }), (error) => report('m7-fixtures', { error: String(error) })).finally(() => { guardFrozen = false; applyFreeze(); renderPanel(); });
        return;
      case 'K':
        if (comparing()) computeBaseline(COMPARISON_LIMITS.ticks);
        return;
      case 'G':
        // Dev-only: a 1.5 s main-thread stall exercises the long-gap pause in the real WKWebView.
        if (import.meta.env.DEV) {
          report('dev-stall', { ms: 1500, tick: host.tick });
          for (const until = performance.now() + 1500; performance.now() < until; );
        }
        return;
    }
  });

  // Native lifecycle: focus loss, minimize, Hide and suspension all pause (SPEC §10.1).
  const appWindow = getCurrentWindow();
  window.addEventListener('blur', () => {
    report('lifecycle', { signal: 'window-blur', tick: host.tick, playing: scheduler.playing });
    pauseFor('window-blur');
  });
  window.addEventListener('focus', () => report('lifecycle', { signal: 'window-focus', tick: host.tick }));
  document.addEventListener('visibilitychange', () => {
    report('lifecycle', { signal: 'visibility', state: document.visibilityState, tick: host.tick });
    if (document.hidden) pauseFor('hidden');
  });
  window.addEventListener('pagehide', () => pauseFor('pagehide'));
  appWindow
    .onFocusChanged(({ payload: focused }) => {
      if (!focused) pauseFor('native-focus-lost');
      Promise.all([appWindow.isMinimized(), appWindow.isVisible()])
        .then(([minimized, visible]) => report('lifecycle', { signal: 'native-focus', focused, minimized, visible, tick: host.tick }))
        .catch(() => report('lifecycle', { signal: 'native-focus', focused, tick: host.tick }));
    })
    .catch((error: unknown) => report('lifecycle', { signal: 'native-focus-unavailable', error: String(error) }));
  renderer.onDeviceLost = (info) => {
    report('gpu-device-lost', { message: info.message, reason: info.reason });
    pauseFor('device-lost');
    showSimError('The graphics device was lost. Save your scene, then quit and reopen Lawsmith.', false);
  };

  // ------------------------------------------------------------------ explanation, probes and trails

  const bodyPanel = createBodyPanel();
  const labelsHost = $('explain-labels');
  const labelSpans = new Map<string, HTMLSpanElement>();
  const projected = new Vector3();
  const lawLabel = (id: string) => lawPresentation(id).label;
  const lawColor = (id: string) => lawPresentation(id).color;

  /** A click picks the body whose projected center is nearest, within its drawn radius or 10 px. */
  const BODY_PICK_PX = 10;
  const bodyAt = (clientX: number, clientY: number): string | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    const pixelsPerMeterAtUnit = rect.height / 2 / Math.tan((viewport.camera.fov * Math.PI) / 360);
    let best: string | null = null;
    let bestPx = Infinity;
    for (let i = 0; i < host.count; i++) {
      projected.set(host.positions[3 * i]!, host.positions[3 * i + 1]!, host.positions[3 * i + 2]!);
      const distance = projected.distanceTo(viewport.camera.position);
      projected.project(viewport.camera);
      if (projected.z > 1) continue;
      const px = Math.hypot(rect.left + ((projected.x + 1) / 2) * rect.width - clientX, rect.top + ((1 - projected.y) / 2) * rect.height - clientY);
      const reach = Math.max(BODY_PICK_PX, (host.radii[i]! * pixelsPerMeterAtUnit) / distance + 3);
      if (px <= reach && px < bestPx) {
        best = host.ids[i]!;
        bestPx = px;
      }
    }
    return best;
  };

  /** The explained body is UI state handed to the host, which then retains that body's steps. */
  const setExplained = (id: string | null, reason: string) => {
    if (id === explained) return;
    explained = id;
    host.explain(id);
    report('explain-select', { body: id, reason, tick: host.tick, playing: scheduler.playing, trails: trails.mode });
  };

  /** The keyboard route (B): the body nearest the view's focus point. */
  const explainNearest = () => {
    const t = viewport.orbit.target;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < host.count; i++) {
      const d = Math.hypot(host.positions[3 * i]! - t.x, host.positions[3 * i + 1]! - t.y, host.positions[3 * i + 2]! - t.z);
      if (d < bestDistance) {
        best = host.ids[i]!;
        bestDistance = d;
      }
    }
    if (best !== null) setExplained(best, 'nearest');
  };

  let previewKey = '';
  let previewCache: TransitionObservation | null = null;
  /** The retained last step of the explained body, or, while paused, the next-step preview. */
  const shownObservation = (): TransitionObservation | null => {
    if (explained === null) return null;
    if (explainMode === 'preview') {
      if (scheduler.playing) return null;
      // A preview changes only with the world, the tick, the applied laws or the body.
      const key = `${host.generation}:${host.tick}:${host.lastAppliedSequence}:${explained}`;
      if (key !== previewKey) {
        previewKey = key;
        previewCache = host.previewTransition();
      }
      return previewCache;
    }
    const o = host.explanation;
    return o && o.bodyId === explained ? o : null;
  };

  const placeLabels = (labels: readonly ExplainLabel[]) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const shown = new Set<string>();
    for (const label of labels) {
      shown.add(label.key);
      let span = labelSpans.get(label.key);
      if (!span) {
        span = document.createElement('span');
        span.dataset.key = label.key;
        labelsHost.append(span);
        labelSpans.set(label.key, span);
      }
      projected.set(...label.at).project(viewport.camera);
      span.hidden = projected.z > 1;
      if (span.textContent !== label.text) span.textContent = label.text;
      span.style.left = `${rect.left + ((projected.x + 1) / 2) * rect.width}px`;
      span.style.top = `${rect.top + ((1 - projected.y) / 2) * rect.height}px`;
    }
    for (const [key, span] of labelSpans) if (!shown.has(key)) span.hidden = true;
  };

  /**
   * Each frame: probes and trails follow a world that was reset or replaced while paused, then the
   * vectors, labels and readout follow the host.
   */
  const updateExplanation = () => {
    probes.sync(host);
    trails.sync(host);
    const observation = shownObservation();
    const i = explained === null ? -1 : host.ids.indexOf(explained);
    const labels = explainView.update(
      {
        observation,
        body: i < 0 ? null : [host.positions[3 * i]!, host.positions[3 * i + 1]!, host.positions[3 * i + 2]!],
        bodyRadius: i < 0 ? 0.08 : host.radii[i]!,
        lawColor,
        camera: viewport.camera,
      },
      probes,
      trails,
      explained,
    );
    placeLabels(labels);
    bodyPanel.render(explained === null ? null : { explained, view: explainMode, playing: scheduler.playing, present: i >= 0, tick: host.tick, observation, lawLabel, lawColor });
  };

  /** What is drawn and recorded, with the bytes of every buffer it owns (SPEC §18.2 resource accounting). */
  /** Objects in the rendered scene, for the resource readback: a leaked world view would show here. */
  const sceneObjects = () => {
    let count = 0;
    viewport.scene.traverse(() => (count += 1));
    return count;
  };
  const visualizationState = () => {
    const bytes = { ...probes.bytes(), ...trails.bytes(), ...explainView.bytes() };
    return {
      contexts: runs.counts(),
      render: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, objects: sceneObjects() },
      probes: { ...probes.settings, live: probes.live },
      trails: { mode: trails.mode, count: trails.count },
      explained,
      explainMode,
      arrowScope,
      bytes,
      totalBytes: Object.values(bytes).reduce((a, b) => a + b, 0),
      drawn: explainView.drawn(),
    };
  };

  /** Shift+E: the explained body's retained step and, while paused, its preview, for the log. */
  const reportExplanation = () => {
    const retained = host.explanation;
    const slot = explained === null ? undefined : trails.slot(explained);
    const trail = slot === undefined ? null : Array.from({ length: trails.lengths[slot]! }, (_, k) => {
      const at = trails.at(slot, k);
      return [trails.ticks[at]!, trails.positions[3 * at]!, trails.positions[3 * at + 1]!, trails.positions[3 * at + 2]!];
    });
    const i = explained === null ? -1 : host.ids.indexOf(explained);
    const shownRetained = retained && retained.bodyId === explained ? retained : null;
    const preview = scheduler.playing ? null : host.previewTransition();
    // Each compound law's ingredient shares, reconstructed from the transition's own record (M5).
    const split = (o: TransitionObservation | null) => (o ? o.contributions.map((_, l) => ingredientBreakdown(o, l)).filter((b) => b !== null) : null);
    report('explanation', {
      explained,
      tick: host.tick,
      playing: scheduler.playing,
      view: explainMode,
      retained: shownRetained,
      retainedIngredients: split(shownRetained),
      preview,
      previewIngredients: split(preview),
      now: i < 0 ? null : [host.positions[3 * i]!, host.positions[3 * i + 1]!, host.positions[3 * i + 2]!],
      trail: trail?.slice(-8) ?? null,
      trailSamples: trail?.length ?? 0,
      visualization: { ...visualizationState(), comparison: ghosts?.counts() ?? null, ghostsShown },
    });
  };

  // The Motion section: visualization controls, never document edits (no revision, no dirty state).
  const probeCount = $<HTMLInputElement>('probe-count');
  const probeSeed = $<HTMLInputElement>('probe-seed');
  const motionError = $('motion-error');
  const renderMotion = () => {
    const s = probes.settings;
    $('probes-toggle').setAttribute('aria-pressed', String(s.enabled));
    if (document.activeElement !== probeCount) probeCount.value = String(s.count);
    if (document.activeElement !== probeSeed) probeSeed.value = String(s.seed);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#trail-mode button')) b.setAttribute('aria-checked', String(b.dataset.trails === trails.mode));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#arrows-scope button')) b.setAttribute('aria-checked', String(b.dataset.scope === arrowScope));
  };
  const visualizationChanged = (change: string) => {
    renderMotion();
    report('visualization', { change, ...visualizationState(), tick: host.tick, revision: authoring.revision, dirty: workflow.dirty });
  };
  const setProbes = (patch: Partial<ProbeSettings>, input?: HTMLInputElement) => {
    const next = { ...probes.settings, ...patch };
    const problem = checkProbeSettings(next);
    motionError.hidden = problem === null;
    motionError.textContent = problem ? `The ${problem}. The last valid value is kept.` : '';
    input?.toggleAttribute('aria-invalid', problem !== null);
    if (problem) {
      renderMotion();
      return;
    }
    probes.configure(next);
    probes.sync(host);
    visualizationChanged('probes');
  };
  $('probes-toggle').addEventListener('click', () => setProbes({ enabled: !probes.settings.enabled }));
  probeCount.addEventListener('change', () => setProbes({ count: probeCount.value.trim() === '' ? NaN : Number(probeCount.value) }, probeCount));
  probeSeed.addEventListener('change', () => setProbes({ seed: probeSeed.value.trim() === '' ? NaN : Number(probeSeed.value) }, probeSeed));
  $('trail-mode').addEventListener('click', (event) => {
    const mode = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-trails]')?.dataset.trails as TrailMode | undefined;
    if (!mode || mode === trails.mode) return;
    trails.mode = mode;
    visualizationChanged('trails');
  });
  $('arrows-scope').addEventListener('click', (event) => {
    const scope = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-scope]')?.dataset.scope as 'all' | 'selected' | undefined;
    if (!scope || scope === arrowScope) return;
    arrowScope = scope;
    visualizationChanged('arrows');
  });
  $('explain-nearest').addEventListener('click', explainNearest);
  $('explain-close').addEventListener('click', () => setExplained(null, 'close'));
  $('explain-mode').addEventListener('click', (event) => {
    const view = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]')?.dataset.view as ExplainViewMode | undefined;
    if (!view || view === explainMode || (view === 'preview' && scheduler.playing)) return;
    explainMode = view;
    report('explain-view', { view, tick: host.tick, body: explained });
  });
  renderMotion();

  const drawLaws = () =>
    world.updateLaws(
      host.appliedFields().map((field) => ({ field, compiled: host.compiledField(field.id)!, presentation: lawPresentation(field.id) })),
      {
        selectedId: interaction.selectedId,
        preview: interaction.previewField(),
        throttle: interaction.gesture !== null,
        // The arrows default is the displayed document's: a replay shows its root's.
        arrows: replaying() ? (runs.replay?.record.root.presentation.arrows ?? true) : editor().arrows,
        onlySelectedArrows: arrowScope === 'selected',
        handles: (() => {
          if (readOnly()) return null;
          const shown = interaction.handles();
          return shown ? { ...shown, hover: interaction.hoverHandle, active: interaction.activeHandle } : null;
        })(),
        focus: ingredientPanel.focus,
        tick: host.tick,
        camera: viewport.camera.position,
      },
    );

  drawLaws();
  await withTimeout(renderer.compileAsync(viewport.scene, viewport.camera), 'Scene pipeline compilation');
  const distinctColors = await withTimeout(probeRenderedPixels(renderer, viewport.scene, viewport.camera), 'Rendered-frame readback');
  report('render-probe', { distinctColors, gpuErrors: gpuErrors.length });
  if (distinctColors < 4) throw new Error('The WebGPU renderer initialized but produced an empty frame.');

  // Frame pacing: rolling windows for the overlay and the 5 s pacing line.
  const intervals: number[] = [];
  const work: number[] = [];
  const frameSteps: number[] = [];
  const edits: number[] = [];
  let stalls = 0;
  let firstFrameAt = 0;
  let stepsThisFrame = 0;
  /** The previous frame's split (simulation and view preparation vs. rendering), so a stall can say where the time went. */
  let frameBeforeMs = 0;
  let frameMaxStepMs = 0;
  let previous = { workMs: 0, beforeMs: 0, maxStepMs: 0, steps: 0 };
  const clock = $('clock');
  let clockTick = -1;
  let shownRevision = -1;

  viewport.start({
    before(time) {
      const beforeStart = performance.now();
      const advance = scheduler.frame(time, Date.now());
      if (advance.gap) {
        // The scheduler has already paused and discarded the debt, before any step.
        report('lifecycle', { signal: 'gap', tick: host.tick });
        notePlaying(false, 'gap');
        interaction.cancel('gap');
      }
      stepsThisFrame = 0;
      frameMaxStepMs = 0;
      if (replaying()) {
        // Only the selected context advances (SPEC §13.2): the authoring world waits, untouched.
        stepsThisFrame = driveReplay(scheduler.playing ? advance.steps : 0);
      } else {
        settleNow();
        stepsThisFrame = driveScheduledFrame(scheduler, advance.steps, () => {
          // A recording closed at a limit holds the world until the stop is resolved (SPEC §13.3).
          if (host.halted) return false;
          try {
            if (!timedStep()) return false;
            frameMaxStepMs = Math.max(frameMaxStepMs, stepTimes[stepTimes.length - 1]!);
            return true;
          } catch (error) {
            onFault(error);
            return false;
          }
        });
        absorb();
      }
      world.updateBodies(host);
      if (runs.comparison) { ghosts?.update(runs.comparison, ghostsShown); renderComparison(); }
      interaction.syncProxy();
      drawLaws();
      updateExplanation();
      syncControls();
      renderRun();
      if (host.tick !== clockTick) {
        clockTick = host.tick;
        clock.textContent = `tick ${host.tick} · ${(host.tick * STEP_SECONDS).toFixed(3)} s`;
        ingredientPanel.refreshLive(host.tick);
      }
      // The panel follows applied changes without a per-frame rebuild, and not during a drag.
      const panelRevision = replaying() ? host.lastAppliedSequence : editor().appliedRevision;
      if (panelRevision !== shownRevision && !interaction.gesture) {
        shownRevision = panelRevision;
        renderPanel();
      }
      frameBeforeMs = performance.now() - beforeStart;
    },
    after(interval, frameWork) {
      const submitted = performance.now();
      if (drawWait && host.generation === drawWait.generation) {
        const elapsedMs = submitted - drawWait.requestedAt;
        report('seek', { action: 'drawn', id: drawWait.id, elapsedMs: round3(elapsedMs) });
        drawWait.resolve(elapsedMs);
        drawWait = null;
      }
      for (const latency of editLatency.frameSubmitted(editor().appliedRevision, submitted)) {
        pushBounded(edits, latency, 240);
        if (p0?.phase === 'measure') p0.edits.push(latency);
      }
      if (!firstFrameAt) {
        firstFrameAt = submitted;
        report('ready', {
          rendererInitMs: Math.round(rendererReady - begin),
          rapierInitMs: Math.round(simulationReady - rendererReady),
          firstFrameMs: Math.round(firstFrameAt - begin),
        });
      }
      const thisFrame = { workMs: frameWork, beforeMs: frameBeforeMs, maxStepMs: frameMaxStepMs, steps: stepsThisFrame };
      if (interval === undefined) {
        previous = thisFrame;
        return;
      }
      if (interval > 50) {
        stalls += 1;
        report('stall', {
          intervalMs: round3(interval),
          tick: host.tick,
          playing: scheduler.playing,
          previousFrame: { workMs: round3(previous.workMs), prepMs: round3(previous.beforeMs), maxStepMs: round3(previous.maxStepMs), steps: previous.steps },
          thisFrame: { workMs: round3(frameWork), prepMs: round3(frameBeforeMs), maxStepMs: round3(frameMaxStepMs), steps: stepsThisFrame },
        });
      }
      previous = thisFrame;
      pushBounded(intervals, interval, 240);
      pushBounded(work, frameWork, 240);
      pushBounded(frameSteps, stepsThisFrame, 240);
      if (p0) {
        if (!scheduler.playing && !(p0.comparison && runs.comparison?.atHorizon)) p0.invalid ??= 'paused during capture';
        if (p0.phase === 'warmup' && submitted - p0.phaseStart >= 10_000) {
          if (p0.comparison) {
            const capture = p0; p0 = null;
            runs.comparison!.newAlternate(); showWorld('p3-restore-fork'); applyFreeze(); setPlaying(true, 'p3-measure');
            p0 = capture;
            editLatency = new EditLatency();
          }
          Object.assign(p0, { phase: 'measure', phaseStart: submitted, tickStart: host.tick, droppedStart: scheduler.droppedMs, supersededStart: editLatency.superseded });
          report('p0', { phase: 'measure', run: p0.run });
        } else if (p0.phase === 'measure') {
          if (p0.comparison && !runs.comparison!.atHorizon && host.tick % 120 < 2) {
            const law = host.appliedFields()[0]!;
            const strength = Math.floor(host.tick / 120) % 2 ? 0.09 : 0.11;
            const next = { ...law, expression: { kind: 'directional' as const, direction: [0, 1, 0] as const, strength } };
            submit(next, editor().newTransaction());
          }
          p0.intervals.push(interval);
          p0.work.push(frameWork);
          if (submitted - p0.phaseStart >= 60_000 || p0.comparison && runs.comparison!.atHorizon) {
            finishP0(p0, submitted);
            p0 = null;
          }
        }
      }
    },
  });

  const overlay = $('diagnostics');
  let lastPacingReport = performance.now();
  setInterval(() => {
    const i = [...intervals].sort((a, b) => a - b);
    const w = [...work].sort((a, b) => a - b);
    const s = [...stepTimes].sort((a, b) => a - b);
    const e = [...edits].sort((a, b) => a - b);
    const frameMs = intervals.reduce((sum, v) => sum + v, 0);
    const simWall = frameMs > 0 ? (frameSteps.reduce((sum, v) => sum + v, 0) * STEP_MS) / frameMs : 0;
    const laws = host.appliedFields();
    const canvas = renderer.domElement;
    const captures = workflow.recovery.captureMs;
    overlay.textContent = [
      `${backend.backend}${backend.compatibilityMode ? ' (compatibility)' : ''} · ${location.origin} · ${window.isSecureContext ? 'secure' : 'NOT secure'} · ${mode} · kernel ${FIELD_KERNEL_VERSION}`,
      `tick ${host.tick} · ${scheduler.playing ? 'playing' : 'paused'} · bodies ${host.count} · laws ${laws.length} (${laws.filter((f) => f.enabled).length} on) · arrows ${world.arrowCount()} · fastest ${host.maxSpeed.toFixed(1)} m/s`,
      `steps/frame ${frameSteps[frameSteps.length - 1] ?? 0} · sim/wall ${simWall.toFixed(2)} · debt dropped ${Math.round(scheduler.droppedMs)} ms · skipped ${host.skippedEmissions} · limited ${host.limitedSteps}`,
      `step ${ms(percentile(s, 0.95))} p95 (field ${ms(host.lastFieldMs)} · engine ${ms(host.lastEngineMs)}) · edit ${e.length ? ms(percentile(e, 0.95)) : '—'} p95 ms`,
      `frame ${ms(percentile(i, 0.5))} p50 · ${ms(percentile(i, 0.95))} p95 · work ${ms(percentile(w, 0.95))} p95 · stalls ${stalls} · probes ${probes.settings.enabled ? probes.live : 'off'} · trails ${trails.mode === 'off' ? 'off' : trails.count}`,
      `document gen ${authoring.generation} rev ${authoring.revision} (applied ${authoring.appliedRevision}, stored ${workflow.stored ?? '—'}) · recovery capture ${captures.length ? `${ms(Math.max(...captures))} ms max` : '—'}`,
      `context ${runs.selected} · recording ${runs.recordingState} · worlds ${worldCounts().allocated} · cursor ${host.lastAppliedSequence}`,
      `DPR ${window.devicePixelRatio} → ${renderer.getPixelRatio()} (cap ${MAX_PIXEL_RATIO}) · ${window.innerWidth}×${window.innerHeight} css · ${canvas.width}×${canvas.height} px · GPU errors ${gpuErrors.length}`,
      p0 ? `P0 run ${p0.run} ${p0.phase} ${Math.floor((performance.now() - p0.phaseStart) / 1000)} s${p0.invalid ? ` · invalid: ${p0.invalid}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    renderSampling();
    if (performance.now() - lastPacingReport > 5000 && i.length) {
      lastPacingReport = performance.now();
      report('pacing', {
        intervalMs: [0.5, 0.95, 0.99].map((p) => Number(ms(percentile(i, p)))),
        maxIntervalMs: Number(ms(i[i.length - 1] ?? 0)),
        workP95Ms: Number(ms(percentile(w, 0.95))),
        stallsOver50ms: stalls,
        devicePixelRatio: window.devicePixelRatio,
        pixelRatio: renderer.getPixelRatio(),
        tick: host.tick,
        playing: scheduler.playing,
        bodies: host.count,
        stepMs: [0.5, 0.95, 0.99].map((p) => round3(percentile(s, p))),
        editMs: e.length ? [0.5, 0.95, 0.99].map((p) => round3(percentile(e, p))) : null,
        editSamples: e.length,
        simWallRatio: round3(simWall),
        droppedMs: round3(scheduler.droppedMs),
      });
    }
  }, 500);

  $('status').hidden = true;
  for (const id of ['tools', 'panel', 'transport', 'overlays', 'run']) $(id).hidden = false;
  overlay.hidden = false;
  renderPanel();
  reportDigest('startup');

  // Launch recovery (SPEC §15.3): offer the newest valid unsaved snapshot, never silently.
  const offer = await workflow.recoveryOffer();
  if (offer) {
    showRecoveryOffer(offer);
  } else {
    launchPending = false;
    applyFreeze();
  }

  // Close and Quit run the shared guard from here on.
  await listen<string>('lawsmith://guard-request', (event) => {
    report('guard', { request: event.payload, tick: host.tick, revision: authoring.revision, dirty: workflow.dirty });
    void workflow.requestExit(event.payload === 'quit' ? 'quit' : 'close').then(() => renderPanel());
  });
  await invoke('guard_ready');
  report('guard', { action: 'ready' });

  /**
   * The launch offer is modal: until the user recovers or discards it, the launch freeze stays, so
   * the earlier work cannot be rotated away or retired unanswered.
   */
  function showRecoveryOffer(offer: RecoveryOffer) {
    const panel = $('recovery-offer');
    const { envelope } = offer;
    const title = envelope.document.metadata.title;
    $('recovery-text').textContent = offer.older
      ? `The newest recovery copy could not be used (${offer.newestProblem}). An older copy of “${title}” is available: revision ${envelope.revision}. Recovering opens it paused at tick 0, without a file.`
      : `“${title}”, revision ${envelope.revision}, was not saved. Recovering opens it paused at tick 0, without a file; Save then asks where it goes.`;
    panel.hidden = false;
    // Only a completed answer resolves the offer; a refused or failed one leaves it up.
    const done = (outcome: boolean | null) => {
      report('recovery', { action: 'offer-resolved', outcome });
      if (outcome === true) {
        launchPending = false;
        panel.hidden = true;
      }
      applyFreeze();
      renderPanel();
    };
    $('recovery-accept').onclick = () => {
      report('recovery', { action: 'offer-accepted', revision: envelope.revision, older: offer.older });
      void workflow.recover(offer).then(done);
    };
    $('recovery-discard').onclick = () => {
      report('recovery', { action: 'offer-discarded', revision: envelope.revision, older: offer.older });
      void workflow.discardRecovery().then(done);
    };
    $('recovery-accept').focus();
  }
}

start().catch(showFailure);
