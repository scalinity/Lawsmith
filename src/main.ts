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
import { createWorldView, type PreparedScene } from './rendering/worldView';
import { checkProbeSettings, ProbeField, type ProbeSettings } from './observation/probes';
import { TrailRecorder, type TrailMode } from './observation/trails';
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
import { SIMULATION_PROFILE, STEP_SECONDS, SimulationFault, SimulationHost, initSimulation, resetPeakWorlds, worldCounts } from './simulation/host';
import { RUN_LIMITS, parseRun, qualified, type QualificationIdentity, type RunRecord, type StopReason } from './persistence/runFile';
import { RunCoordinator, type FinalCheckResult } from './simulation/contexts';
import { SIMULATION_FINGERPRINT, exportRun } from './simulation/recorder';
import { LinearReplay, firstDivergence as replayDivergence, observe } from './simulation/replay';
import type { TransitionObservation } from './simulation/observation';
import { FixedStepScheduler } from './simulation/scheduler';
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
/** A replay frame's work budget: commands apply in chunks between checks, and the rest wait for the next frame. */
const REPLAY_BUDGET_MS = 8;
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

/** The qualification identity from the native runtime record and the bundle: facts observed, never guessed. */
function qualificationIdentity(native: unknown, bundle: string): QualificationIdentity {
  const facts = typeof native === 'object' && native !== null ? (native as Record<string, string>) : {};
  const fact = (key: string) => facts[key] || `unavailable: ${typeof native === 'string' ? native : `no ${key}`}`;
  const family = ['tauri', 'tauriRuntime', 'tauriRuntimeWry', 'wry', 'tao'].map(fact);
  return Object.freeze({
    app: fact('app'),
    build: mode,
    bundle,
    tauri: family.some((v) => v.startsWith('unavailable')) ? `unavailable: ${family.join('; ')}` : `tauri ${family[0]}; tauri-runtime ${family[1]}; tauri-runtime-wry ${family[2]}; wry ${family[3]}; tao ${family[4]}`,
    webkit: fact('webview'),
    os: facts.macos && !facts.macos.startsWith('unavailable') ? `macOS ${facts.macos} (${fact('macosBuild')})` : fact('macos'),
    arch: fact('arch'),
  });
}

async function start() {
  const begin = performance.now();
  facts.runtime = await withTimeout(invoke<Record<string, string>>('runtime_identity'), 'Native runtime identity').catch(
    (e: unknown) => `unavailable: ${String(e)}`,
  );
  const timerMs = timerResolutionMs();
  report('runtime', { ...facts, userAgent: navigator.userAgent, timerResolutionMs: timerMs });
  const identity = qualificationIdentity(facts.runtime, await frontendBundle());
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
  const runs = new RunCoordinator({ controller: authoring, identity: () => identity, onLimit: (reason) => recordingLimited(reason) });
  const replaying = () => runs.selected === 'replay';
  const scheduler = new FixedStepScheduler(STEP_MS);
  const appliedLaw = (id: string) => host.appliedFields().find((f) => f.id === id);
  /** A law's names and colors in the displayed context: a replay shows its root's, never the newer authored ones. */
  const lawPresentation = (id: string): LawPresentation =>
    replaying() ? (runs.replay?.record.root.presentation.laws.find((p) => p.id === id) ?? defaultLawPresentation(id)) : authoring.presentationOf(id);

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
    const result = authoring.putField(candidate, transactionId);
    if (result.ok) editLatency.accept(result.value.revision, performance.now());
    return result;
  };

  /**
   * Edits are frozen while the guard decides, and from launch until launch recovery is answered, so
   * nothing can save or write recovery over an earlier session's work before the user chooses.
   */
  let frozen = false;
  let guardFrozen = false;
  let launchPending = true;
  let cameraMoved = false;
  const applyFreeze = () => {
    frozen = guardFrozen || launchPending;
    for (const id of ['panel', 'tools', 'transport', 'overlays', 'run']) $(id).inert = frozen;
    // Replay is read-only (SPEC §13.2): its laws are inspected, never edited; playback and the camera still work.
    const readOnly = replaying();
    document.body.dataset.context = readOnly ? 'replay' : 'authoring';
    for (const id of ['details', 'law-shelf']) $(id).inert = readOnly;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.disabled = readOnly;
    $<HTMLButtonElement>('reset').disabled = readOnly;
    $<HTMLButtonElement>('arrows-toggle').disabled = readOnly;
    $('reset').title = readOnly ? 'Reset restarts your authored scene. Return to authoring to use it.' : '';
    viewport.gizmo.enabled = !frozen && !readOnly;
    viewport.gizmo.getHelper().visible = !readOnly;
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
      transaction: () => authoring.newTransaction(),
      onGestureEnd: (end) => gestureEnded(end),
      onSelectionChange: () => renderPanel(),
      clickBody: (x, y) => {
        const id = bodyAt(x, y);
        if (id === null) return false;
        setExplained(id, 'click');
        return true;
      },
      haltCamera: () => viewport.haltInertia(),
      editable: () => !frozen && !replaying(),
      // The ingredient being edited brings its own handles (M5).
      focus: () => ingredientPanel.focus,
      log: report,
    },
    initial.semantic.fields[0]?.id ?? null,
  );

  /** One completed drag is one author-undo entry, ending at what the host applied; a cancel restored its start and records nothing. */
  const gestureEnded = (end: GestureEnd) => {
    authoring.endGesture(end.label, end.start, end.transactionId);
    awaitApplied(end.revision);
    edited();
  };

  /** Reports a change once the host has applied it; a gesture's last preview may already be applied at release. */
  const awaitApplied = (revision: number | null) => {
    if (revision === null) return;
    if (revision <= authoring.appliedRevision) {
      report('law-applied', { revision, appliedRevision: authoring.appliedRevision, tick: host.tick, sequence: host.lastAppliedSequence });
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
    authoring.sync();
  };
  /** Applies the authoring world's queued commands at its current boundary now (SPEC §10.2), as its next step would. */
  const settleNow = () => {
    authoring.settle();
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
    const snapshot = authoring.snapshot(authoring.camera);
    const generation = authoring.generation;
    semanticDigest(createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation)).then((semantic) =>
      report('digest', { reason, generation, revision: snapshot.revision, semanticSha256: semantic }),
    );
  };

  const showSimError = (message: string, offerReset: boolean) => {
    $('sim-error-text').textContent = message;
    $('sim-error-reset').hidden = !offerReset;
    $('sim-error').hidden = false;
  };

  const setPlaying = (playing: boolean, reason: string) => {
    if (playing === scheduler.playing) return;
    if (playing && (host.fault || frozen || authoring.liveHost.halted)) return;
    // A replay at its frozen end stays there: Replay from Start, not Play, begins it again.
    if (playing && replaying() && runs.replay?.complete) return;
    if (playing) {
      scheduler.play();
      // A next-step preview is a paused view; motion shows each completed step instead.
      explainMode = 'applied';
    } else scheduler.pause();
    notePlaying(playing, reason);
  };
  /** Records a play-state change, including the scheduler's own pause on a gap. */
  const notePlaying = (playing: boolean, reason: string) => {
    if (p0 && !playing) p0.invalid ??= `paused: ${reason}`;
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
    showSimError(`${error.message}. The last valid frame is shown.`, !replaying());
  };

  const stepTimes: number[] = [];
  const timedStep = () => {
    if (runs.recordingState === 'recording' && host.tick > 0 && host.tick % CHECKPOINT_TICKS === 0) runCheckpoint('live', host, runs.recorder!.runId);
    const t0 = performance.now();
    const before = host.tick;
    host.step();
    // Halted at a recording limit: nothing stepped, so nothing is observed (SPEC §13.3).
    if (host.tick === before) return;
    const t1 = performance.now();
    // Observers of the completed step: probes take the same transition, trails sample every fourth tick.
    probes.advance(host);
    const t2 = performance.now();
    trails.record(host, explained);
    const t3 = performance.now();
    const elapsed = t1 - t0;
    pushBounded(stepTimes, elapsed, 480);
    if (p0?.phase === 'measure') {
      p0.steps.push(elapsed);
      if (probes.settings.enabled && probes.settings.count > 0) p0.probes.push(t2 - t1);
      if (trails.mode !== 'off') p0.trails.push(t3 - t2);
      p0.ticks.push(t3 - t0);
    }
    if (host.tick === 600 || host.tick === 1200) captureDigest();
  };

  const stepOnce = () => {
    if (replaying()) {
      if (host.fault || frozen || runs.replay?.complete) return;
      setPlaying(false, 'step');
      driveReplay(1);
      report('sim-control', { action: 'step', context: 'replay', tick: host.tick, cursor: host.lastAppliedSequence, partial: runs.replayPartial });
      return;
    }
    if (interaction.gesture || host.fault || frozen || host.halted) return;
    setPlaying(false, 'step');
    // The boundary settles before the step, as a frame's does, so a checkpoint here sees it settled.
    settleNow();
    try {
      timedStep();
    } catch (error) {
      onFault(error);
    }
    absorb();
    report('sim-control', { action: 'step', tick: host.tick });
  };

  const resetScene = () => {
    if (frozen || replaying()) return;
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
    const kept = replaying() ? authoringCamera : null;
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
        view = world.prepareScene(document.semantic, replaying());
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
      // Replacing the scene context drops the recording and its replay, which the guard has protected.
      if (replaying() && authoringView) world.discardScene(world.swapScene(authoringView));
      authoringView = null;
      authoringCamera = null;
      runs.dropRecord();
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
      if (replaying()) world.discardScene(world.swapScene(candidate.view));
      else {
        authoringView = world.swapScene(candidate.view);
        authoringCamera = stashCamera();
      }
      runs.commitImport(candidate.replay);
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
    workflow.edited();
    renderPanel();
  };

  /** Commits a field being typed in, then runs a file workflow. */
  const runFile = (action: 'open' | 'save' | 'saveAs' | 'newScene' | 'saveRecording' | 'openRecording' | 'record') => {
    if (frozen) return;
    if (replaying() && (action === 'save' || action === 'saveAs')) {
      // SPEC §13.2: ordinary Save Scene is off during replay, so no shortcut can save the replay as the scene.
      workflow.message = { kind: 'info', text: 'Save is off during a replay, so the replay can never be saved over your scene. Return to authoring to save it; closing still offers to.' };
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
  const blocked = () => frozen || interaction.gesture !== null || replaying();

  /** The note a refused undo or redo left, cleared by the next one that applies. */
  let historyRefusal: typeof workflow.message = null;
  const undo = (redo: boolean) => {
    if (blocked()) return;
    const result = redo ? authoring.redo() : authoring.undo();
    if (result.ok) {
      if (workflow.message === historyRefusal) workflow.message = null;
      settleNow();
      if (appliedLaw(result.value.id)) interaction.select(result.value.id);
      else if (interaction.selectedId === result.value.id) interaction.select(authoring.scene.fields[0]?.id ?? null);
      edited();
    } else if (redo ? authoring.canRedo : authoring.canUndo) {
      // The step stays available but cannot apply now (the scene's leaf budget, an ID taken since): say why.
      workflow.message = historyRefusal = { kind: 'error', text: `${redo ? 'Redo' : 'Undo'} was not applied: ${result.reason}. Nothing changed.` };
    }
    report('history', {
      action: redo ? 'redo' : 'undo',
      ok: result.ok,
      label: result.ok ? result.value.label : null,
      law: result.ok ? result.value.id : null,
      reason: result.ok ? null : result.reason,
      revision: authoring.revision,
      tick: host.tick,
      laws: host.appliedFields().map(lawSummary),
    });
    renderPanel();
  };

  const toggleEnabled = (id: string) => {
    if (blocked()) return;
    const law = appliedLaw(id);
    if (!law) return;
    const result = authoring.editField(id, law.enabled ? 'Disable law' : 'Enable law', (f) => ({ ...f, enabled: !f.enabled }));
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
    const visible = !authoring.presentationOf(id).visible;
    const result = authoring.setLawPresentation(id, { visible });
    report('control', { law: id, visible, revision: result.ok ? result.value.revision : null });
    if (result.ok) {
      edited();
      reportDigest('visibility');
    }
  };

  const duplicateSelected = () => {
    const law = selectedLaw();
    if (blocked() || !law) return;
    const result = authoring.duplicate(law.id);
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
    const result = authoring.remove(law.id);
    if (result.ok) {
      settleNow();
      interaction.select(authoring.scene.fields[0]?.id ?? null);
      edited();
    }
    report('control', { delete: law.id, ok: result.ok, laws: host.appliedFields().length });
  };

  /** The tool shelf (SPEC §11.1): a law of one kind at the view's focus point, selected, as one undo entry. */
  const createLaw = (kind: PrimitiveKind) => {
    if (blocked()) return;
    const t = viewport.orbit.target;
    const place = (v: number) => Math.round(Math.min(1000, Math.max(-1000, v)) * 100) / 100;
    const result = authoring.create(kind, [place(t.x), place(t.y), place(t.z)]);
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
    const result = authoring.editField(law.id, 'Change support shape', (f) => ({ ...f, region: REGIONS[kind].fromBounds(regionDescriptor(f.region.kind).bounds(f.region)) }));
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
    authoring.setArrows(!authoring.arrows);
    report('control', { arrows: authoring.arrows, revision: authoring.revision });
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
    // Document.
    const busy = workflow.busy;
    const file = workflow.fileName;
    $('doc-title').textContent = authoring.metadata.title;
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
    for (const id of ['file-save', 'file-save-as']) $<HTMLButtonElement>(id).disabled = busy !== null || replaying();
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
    $<HTMLButtonElement>('undo').disabled = !authoring.canUndo || replaying();
    $<HTMLButtonElement>('redo').disabled = !authoring.canRedo || replaying();
    $('arrows-toggle').setAttribute('aria-pressed', String(authoring.arrows));

    // Laws list, rebuilt only when something it shows changed.
    const laws = host.appliedFields();
    const selectedId = interaction.selectedId;
    const readOnly = replaying();
    const signature = JSON.stringify([readOnly, selectedId, laws.map((f) => [f.id, f.enabled, f.expression, lawPresentation(f.id)])]);
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
          visible.disabled = enabled.disabled = readOnly;
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
    const result = authoring.editField(law.id, label, (f) => change(f, value));
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
    const current = authoring.lawState(law.id)?.field;
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
    const result = authoring.editField(law.id, label, (f) => ({ ...f, expression: next.expression }));
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
    const result = authoring.setLawPresentation(law.id, { label: labelInput.value.trim() });
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
    const result = authoring.setLawPresentation(law.id, { color });
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
    if (scheduler.playing !== shownPlaying) {
      shownPlaying = scheduler.playing;
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
  playButton.addEventListener('click', () => setPlaying(!scheduler.playing, 'control'));
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
  /** The displayed replay's end check, once it reached its frozen address. */
  let replayCheck: FinalCheckResult | null = null;
  let replayEnded = false;
  let replayCheckpoint = -1;

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
   * Displays the coordinator's selected context: its world, laws and readouts, with every view of the
   * previous world cleared. Scheduling debt is discarded and the new context starts paused (SPEC §13.2).
   */
  const showContext = (reason: string) => {
    setPlaying(false, reason);
    scheduler.pause();
    host = runs.shown;
    explained = null;
    host.explain(null);
    ingredientPanel.reset();
    listSignature = '';
    detailsSignature = '';
    clockTick = -1;
    shownRevision = -1;
    previewKey = '';
    replayCheck = null;
    replayEnded = false;
    replayCheckpoint = -1;
    if (interaction.selectedId !== null && !appliedLaw(interaction.selectedId)) interaction.select(null);
    // A fault belongs to its world: shown again when that world is, hidden otherwise.
    if (host.fault) showSimError(`${host.fault.message}. The last valid frame is shown.`, !replaying());
    else $('sim-error').hidden = true;
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
    if (frozen || replaying() || runs.recordingState !== 'recorded') return;
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

  const runParts = { root: $('run'), title: $('run-title'), tag: $('run-tag'), status: $('run-status'), meter: $('run-meter'), fill: $('run-fill'), check: $('run-check') };
  const runButtons = {
    record: $<HTMLButtonElement>('run-record'),
    stop: $<HTMLButtonElement>('run-stop'),
    replay: $<HTMLButtonElement>('run-replay'),
    restart: $<HTMLButtonElement>('run-restart'),
    return: $<HTMLButtonElement>('run-return'),
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
    const state = replaying() ? 'replay' : runs.recordingState;
    const seconds = (ticks: number) => `${(ticks / 120).toFixed(2)} s`;
    const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
    let title = 'Recording';
    let tag = false;
    let status: (string | [string, string])[] = [];
    let meter: number | null = null;
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
      const where = runs.replayPartial
        ? ` Applying the recorded changes at tick ${host.tick}…`
        : replay.complete
          ? ' At the recorded end.'
          : scheduler.playing
            ? ' Playing.'
            : ' Paused.';
      status = ['tick ', ['count', String(host.tick)], ' of ', ['count', String(finalTick)], ', change ', ['count', String(host.lastAppliedSequence)], ' of ', ['count', String(lastAppliedSequence)], `.${where}`];
      meter = replay.complete ? 1 : finalTick > 0 ? host.tick / finalTick : lastAppliedSequence > 0 ? host.lastAppliedSequence / lastAppliedSequence : 0;
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
      shown = ['restart', 'return', 'save', 'open'];
    }
    const busy = workflow.busy !== null;
    const signature = JSON.stringify([runParts.root.hidden, state, title, tag, status, meter === null ? null : Math.round(meter * 1000), check, shown, busy]);
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
  runButtons.save.addEventListener('click', () => runFile('saveRecording'));
  runButtons.open.addEventListener('click', () => runFile('openRecording'));

  // P0 (SPEC §18.2): 10 s warmup, then a 60 s capture with every raw sample kept.
  interface P0Capture {
    run: number;
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
    setPlaying(true, 'p0');
    p0 = { run: ++p0Runs, phase: 'warmup', phaseStart: performance.now(), tickStart: 0, droppedStart: 0, supersededStart: 0, intervals: [], work: [], steps: [], edits: [], probes: [], trails: [], ticks: [], invalid: null };
    report('p0', { phase: 'warmup', run: p0.run });
  };
  const finishP0 = (capture: P0Capture, now: number) => {
    const wallMs = now - capture.phaseStart;
    const canvas = renderer.domElement;
    report('p0-run', {
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
        title: authoring.metadata.title,
        laws: host.appliedFields().length,
        lawKinds: [...new Set(host.appliedFields().flatMap((f) => {
          const kinds: string[] = [f.region.kind];
          walk(f.expression, (node) => kinds.push(node.kind));
          return kinds;
        }))].sort(),
        primitiveLeaves: host.appliedFields().reduce((n, f) => n + expressionStats(f.expression).leaves, 0),
        fixedColliders: authoring.scene.bodies.filter((b) => b.type === 'fixed').length,
        authoredDynamic: authoring.scene.bodies.filter((b) => b.type === 'dynamic').length,
        allBodyContacts: authoring.scene.bodies.some((b) => b.type === 'dynamic' && b.collisionMode === 'all') || authoring.scene.emitters.some((e) => e.template.collisionMode === 'all'),
        limitedSteps: host.limitedSteps,
      },
      // The optional visualization during the capture (M4): P0 runs with all of it off, P2 with it on.
      visualization: visualizationState(),
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
    for (const element of document.querySelectorAll<HTMLElement>('#panel, #tools, #transport, #overlays, #drag-region, #recovery-offer, #details, #motion, #explain, #trail-mode, #run, #diagnostics, button[id], input[id]')) {
      controls[element.id] = box(element);
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) controls[`mode-${button.dataset.mode}`] = box(button);
    const laws = [...lawList.querySelectorAll('.law-row')].map((row) => ({
      id: row.querySelector<HTMLElement>('.law-select')!.dataset.id,
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
      visualization: visualizationState(),
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
        replay: runs.replay ? { address: runs.replay.address, complete: runs.replay.complete, partial: runs.replayPartial, check: replayCheck } : null,
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
    if (frozen || replaying() || !record || runs.recordingState !== 'recorded') {
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

  window.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
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
        return setPlaying(!scheduler.playing, 'keyboard');
      case '.': return stepOnce();
      case 'R': return resetScene();
      case 'Backspace':
      case 'Delete':
        return deleteSelected();
      case 'Escape':
        // A gesture first, then the explained body, then the law selection.
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
      visualization: visualizationState(),
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
        arrows: replaying() ? (runs.replay?.record.root.presentation.arrows ?? true) : authoring.arrows,
        onlySelectedArrows: arrowScope === 'selected',
        handles: (() => {
          if (replaying()) return null;
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
        for (let i = 0; i < advance.steps; i++) {
          // A recording closed at a limit holds the world until the stop is resolved (SPEC §13.3).
          if (host.halted) break;
          try {
            timedStep();
            stepsThisFrame += 1;
            frameMaxStepMs = Math.max(frameMaxStepMs, stepTimes[stepTimes.length - 1]!);
          } catch (error) {
            onFault(error);
            break;
          }
        }
        absorb();
      }
      world.updateBodies(host);
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
      if (authoring.appliedRevision !== shownRevision && !interaction.gesture) {
        shownRevision = authoring.appliedRevision;
        renderPanel();
      }
      frameBeforeMs = performance.now() - beforeStart;
    },
    after(interval, frameWork) {
      const submitted = performance.now();
      for (const latency of editLatency.frameSubmitted(authoring.appliedRevision, submitted)) {
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
        if (!scheduler.playing) p0.invalid ??= 'paused during capture';
        if (p0.phase === 'warmup' && submitted - p0.phaseStart >= 10_000) {
          Object.assign(p0, { phase: 'measure', phaseStart: submitted, tickStart: host.tick, droppedStart: scheduler.droppedMs, supersededStart: editLatency.superseded });
          report('p0', { phase: 'measure', run: p0.run });
        } else if (p0.phase === 'measure') {
          p0.intervals.push(interval);
          p0.work.push(frameWork);
          if (submitted - p0.phaseStart >= 60_000) {
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
