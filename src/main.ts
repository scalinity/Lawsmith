import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DocumentController } from './domain/document';
import { STARTING_RECIPE, cloneFrozen, type FieldDefinition } from './domain/scene';
import { FIELD_KERNEL_VERSION } from './fields/directional';
import { LawInteraction, type TransformMode } from './interaction/lawGesture';
import { identifyBackend, isQualifiedWebGPU, probeRenderedPixels, watchGPUErrors } from './rendering/backend';
import { createRenderer, createViewport, MAX_PIXEL_RATIO } from './rendering/viewport';
import { createWorldView } from './rendering/worldView';
import { compareRuns, runAtCadence, runFixedSteps, runResetFixture, scriptedRecipeEdits } from './simulation/fixtures';
import { SIMULATION_PROFILE, STEP_SECONDS, SimulationFault, SimulationHost, initSimulation } from './simulation/host';
import { FixedStepScheduler } from './simulation/scheduler';
import { EditLatency, percentile, percentiles } from './measurement';

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

/** Qualification record line: browser console plus the native shell's stderr. */
function report(kind: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ kind, ...data, mode, t: Math.round(performance.now()) });
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
  for (const id of ['status', 'tools', 'diagnostics', 'laws', 'transport']) $(id).hidden = true;
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
  enabled: f.enabled,
  position: f.pose.position,
  rotation: f.pose.rotation,
  halfExtents: f.region.halfExtents,
});

async function start() {
  const begin = performance.now();
  facts.runtime = await withTimeout(invoke<Record<string, string>>('runtime_identity'), 'Native runtime identity').catch(
    (e: unknown) => `unavailable: ${String(e)}`,
  );
  const timerMs = timerResolutionMs();
  report('runtime', { ...facts, userAgent: navigator.userAgent, timerResolutionMs: timerMs });

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

  // Authority: the host owns the world; the document controller owns the authored scene.
  const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
  const authoring = new DocumentController(STARTING_RECIPE, host);
  const scheduler = new FixedStepScheduler(STEP_MS);
  const LAW_ID = STARTING_RECIPE.fields[0]!.id;
  const appliedLaw = () => host.appliedFields().find((f) => f.id === LAW_ID)!;

  const viewport = createViewport(renderer, report);
  const world = createWorldView(viewport.scene, STARTING_RECIPE);

  // Edit latency (SPEC §18): accepted edit → first frame submitted with its applied revision.
  const editLatency = new EditLatency();
  /** Final revisions of gestures and toggles, reported once the host applies them. */
  const awaited = new Set<number>();
  const submit = (candidate: FieldDefinition) => {
    const result = authoring.putField(candidate);
    if (result.ok) editLatency.accept(result.value.revision, performance.now());
    return result;
  };

  const interaction = new LawInteraction({
    canvas: renderer.domElement,
    dragRegion: $('drag-region'),
    camera: viewport.camera,
    gizmo: viewport.gizmo,
    orbit: viewport.orbit,
    proxy: viewport.proxy,
    appliedField: appliedLaw,
    submit,
    onGestureEnd: (revision) => awaitApplied(revision),
    onSelectionChange: () => syncControls(),
    log: report,
  });

  /** Reports a change once the host has applied it; a gesture's last preview may already be applied at release. */
  const awaitApplied = (revision: number | null) => {
    if (revision === null) return;
    if (revision <= authoring.appliedRevision) {
      report('law-applied', { revision, appliedRevision: authoring.appliedRevision, tick: host.tick, sequence: host.lastAppliedSequence, field: lawSummary(appliedLaw()) });
    } else {
      awaited.add(revision);
    }
  };

  let runIndex = 0;
  let editsSinceReset = 0;
  /** The P0 capture in progress, if any (see startP0). */
  let p0: P0Capture | null = null;
  let p0Runs = 0;
  /** Adopts acknowledged edits into the authored scene and reports the ones that end a change. */
  const absorb = () => {
    for (const ack of authoring.sync()) {
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
          field: lawSummary(ack.payload.field),
        });
      }
    }
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

  const showSimError = (message: string, offerReset: boolean) => {
    $('sim-error-text').textContent = message;
    $('sim-error-reset').hidden = !offerReset;
    $('sim-error').hidden = false;
  };

  const setPlaying = (playing: boolean, reason: string) => {
    if (playing === scheduler.playing) return;
    if (playing && host.fault) return;
    if (playing) scheduler.play();
    else scheduler.pause();
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
    report('simulation-fault', { tick: error.tick, entity: error.entity, reason: error.reason });
    showSimError(`${error.message}. The last valid frame is shown.`, true);
  };

  const stepTimes: number[] = [];
  const timedStep = () => {
    const t0 = performance.now();
    host.step();
    const elapsed = performance.now() - t0;
    pushBounded(stepTimes, elapsed, 480);
    if (p0?.phase === 'measure') p0.steps.push(elapsed);
    if (host.tick === 600 || host.tick === 1200) captureDigest();
  };

  const stepOnce = () => {
    if (interaction.gesture || host.fault) return;
    setPlaying(false, 'step');
    try {
      timedStep();
    } catch (error) {
      onFault(error);
    }
    absorb();
    report('sim-control', { action: 'step', tick: host.tick });
  };

  const resetScene = () => {
    if (interaction.gesture) {
      report('sim-control', { action: 'reset-refused', reason: 'gesture active', tick: host.tick });
      return;
    }
    setPlaying(false, 'reset');
    host.settleBoundary();
    absorb();
    authoring.reset();
    runIndex += 1;
    editsSinceReset = 0;
    if (p0) p0.invalid ??= 'reset during capture';
    $('sim-error').hidden = true;
    report('sim-control', { action: 'reset', tick: host.tick, run: runIndex, field: lawSummary(appliedLaw()) });
    syncControls();
  };

  // Controls reflect authoritative state, refreshed only when it changes.
  const playButton = $('play');
  const enabledButton = $('law-enabled');
  const modeButtons = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
  let shown = { playing: false, enabled: true, selected: true };
  function syncControls() {
    const next = { playing: scheduler.playing, enabled: appliedLaw().enabled, selected: interaction.selected };
    if (next.playing !== shown.playing) {
      playButton.setAttribute('aria-pressed', String(next.playing));
      playButton.firstChild!.textContent = next.playing ? 'Pause ' : 'Play ';
    }
    if (next.enabled !== shown.enabled) {
      enabledButton.setAttribute('aria-pressed', String(next.enabled));
      enabledButton.textContent = next.enabled ? 'On' : 'Off';
    }
    if (next.selected !== shown.selected) $('law-select').setAttribute('aria-pressed', String(next.selected));
    shown = next;
  }

  const setMode = (next: TransformMode) => {
    if (interaction.gesture) return;
    interaction.setMode(next);
    modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
    report('control', { transformMode: next });
  };
  const frameLaw = () => {
    if (interaction.gesture) return;
    const law = appliedLaw();
    if (interaction.selected) viewport.frame(law.pose.position, Math.hypot(...law.region.halfExtents));
    else viewport.resetView();
    report('control', { frame: interaction.selected ? 'law' : 'default' });
  };
  const toggleEnabled = () => {
    if (interaction.gesture) return;
    const law = appliedLaw();
    const result = submit({ ...law, enabled: !law.enabled });
    if (result.ok) awaitApplied(result.value.revision);
    report('control', { enabled: !law.enabled, revision: result.ok ? result.value.revision : null });
  };

  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as TransformMode)));
  $('frame-view').addEventListener('click', frameLaw);
  $('reset-view').addEventListener('click', () => {
    if (interaction.gesture) return;
    viewport.resetView();
    report('control', { resetView: true });
  });
  $('law-select').addEventListener('click', () => interaction.select(!interaction.selected));
  enabledButton.addEventListener('click', toggleEnabled);
  playButton.addEventListener('click', () => setPlaying(!scheduler.playing, 'control'));
  $('step').addEventListener('click', stepOnce);
  $('reset').addEventListener('click', resetScene);
  $('sim-error-reset').addEventListener('click', resetScene);

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
    invalid: string | null;
  }
  const startP0 = () => {
    if (p0) return;
    setPlaying(true, 'p0');
    p0 = { run: ++p0Runs, phase: 'warmup', phaseStart: performance.now(), tickStart: 0, droppedStart: 0, supersededStart: 0, intervals: [], work: [], steps: [], edits: [], invalid: null };
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
      viewport: { css: [window.innerWidth, window.innerHeight], devicePixelRatio: window.devicePixelRatio, pixelRatio: renderer.getPixelRatio(), canvas: [canvas.width, canvas.height] },
      timerResolutionMs: timerMs,
      percentiles: 'p50, p95, p99, max',
      stepMs: percentiles(capture.steps),
      editMs: percentiles(capture.edits),
      intervalMs: percentiles(capture.intervals),
      workMs: percentiles(capture.work),
      samples: { steps: capture.steps.length, edits: capture.edits.length, frames: capture.intervals.length },
      editsSuperseded: editLatency.superseded - capture.supersededStart,
      raw: {
        stepMs: capture.steps.map(round3),
        editMs: capture.edits.map(round3),
        intervalMs: capture.intervals.map(round3),
        workMs: capture.work.map(round3),
      },
    });
  };

  // Determinism fixtures in this runtime (T04): the same code the Vitest harness runs.
  const runFixtures = async () => {
    setPlaying(false, 'fixtures');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = cloneFrozen(authoring.scene);
    const t0 = performance.now();
    const reset = runResetFixture(root);
    const script = scriptedRecipeEdits(root.fields[0]);
    const referenceHost = new SimulationHost(root);
    const reference = runFixedSteps(referenceHost, script);
    referenceHost.dispose();
    const cadence = [30, 60, 144].map((hz) => ({ hz, comparison: compareRuns(reference, runAtCadence(root, hz, script)) }));
    const scriptedReset = runResetFixture(root, script);
    report('fixtures', {
      elapsedMs: Math.round(performance.now() - t0),
      root: lawSummary(root.fields[0]!),
      reset,
      scriptedReset,
      cadence,
      allEqual: [...reset, ...scriptedReset, ...cadence.flatMap((c) => c.comparison)].every((c) => c.equal),
    });
  };

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) return;
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
      case 'Escape':
        if (!interaction.cancel('escape')) interaction.select(false);
        return;
      case 'P': return startP0();
      case 'D':
        runFixtures().catch((error: unknown) => report('fixtures', { error: String(error) }));
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
    showSimError('The graphics device was lost. Quit and reopen Lawsmith; the scene restarts from its recipe.', false);
  };

  world.updateLaw(appliedLaw(), host.compiledField(LAW_ID)!, { selected: true, preview: null, throttle: false });
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
      host.settleBoundary();
      absorb();
      stepsThisFrame = 0;
      frameMaxStepMs = 0;
      for (let i = 0; i < advance.steps; i++) {
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
      world.updateBodies(host);
      interaction.syncProxy();
      world.updateLaw(appliedLaw(), host.compiledField(LAW_ID)!, {
        selected: interaction.selected,
        preview: interaction.previewField(),
        throttle: interaction.gesture !== null,
      });
      syncControls();
      if (host.tick !== clockTick) {
        clockTick = host.tick;
        clock.textContent = `tick ${host.tick} · ${(host.tick * STEP_SECONDS).toFixed(3)} s`;
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
    const law = appliedLaw();
    const canvas = renderer.domElement;
    overlay.textContent = [
      `${backend.backend}${backend.compatibilityMode ? ' (compatibility)' : ''} · ${location.origin} · ${window.isSecureContext ? 'secure' : 'NOT secure'} · ${mode}`,
      `tick ${host.tick} · ${scheduler.playing ? 'playing' : 'paused'} · bodies ${host.count} · laws 1 (${law.enabled ? '1 on' : 'off'}) · arrows ${world.arrowCount()}`,
      `steps/frame ${frameSteps[frameSteps.length - 1] ?? 0} · sim/wall ${simWall.toFixed(2)} · debt dropped ${Math.round(scheduler.droppedMs)} ms · skipped ${host.skippedEmissions}`,
      `step ${ms(percentile(s, 0.95))} p95 (field ${ms(host.lastFieldMs)} · engine ${ms(host.lastEngineMs)}) · edit ${e.length ? ms(percentile(e, 0.95)) : '—'} p95 ms`,
      `frame ${ms(percentile(i, 0.5))} p50 · ${ms(percentile(i, 0.95))} p95 · work ${ms(percentile(w, 0.95))} p95 · stalls ${stalls}`,
      `DPR ${window.devicePixelRatio} → ${renderer.getPixelRatio()} (cap ${MAX_PIXEL_RATIO}) · ${window.innerWidth}×${window.innerHeight} css · ${canvas.width}×${canvas.height} px · GPU errors ${gpuErrors.length}`,
      p0 ? `P0 run ${p0.run} ${p0.phase} ${Math.floor((performance.now() - p0.phaseStart) / 1000)} s${p0.invalid ? ` · invalid: ${p0.invalid}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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
  for (const id of ['tools', 'laws', 'transport']) $(id).hidden = false;
  overlay.hidden = false;
}

start().catch(showFailure);
