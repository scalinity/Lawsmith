import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Euler, Quaternion } from 'three/webgpu';
import { DocumentController } from './domain/document';
import { LAW_COLORS, cloneFrozen, type FieldDefinition, type SceneDocument, type Vec3 } from './domain/scene';
import { FIELD_KERNEL_VERSION } from './fields/directional';
import { LawInteraction, type GestureEnd, type TransformMode } from './interaction/lawGesture';
import { EditLatency, percentile, percentiles } from './measurement';
import { defaultDocument } from './persistence/defaultScene';
import { nativeIo } from './persistence/io';
import { createDocument, semanticDigest } from './persistence/sceneFile';
import { DocumentWorkflow, type RecoveryOffer } from './persistence/workflow';
import { identifyBackend, isQualifiedWebGPU, probeRenderedPixels, watchGPUErrors } from './rendering/backend';
import { createRenderer, createViewport, MAX_PIXEL_RATIO } from './rendering/viewport';
import { createWorldView } from './rendering/worldView';
import { compareRuns, runAtCadence, runFixedSteps, runResetFixture, scriptedRecipeEdits } from './simulation/fixtures';
import { SIMULATION_PROFILE, STEP_SECONDS, SimulationFault, SimulationHost, initSimulation } from './simulation/host';
import { FixedStepScheduler } from './simulation/scheduler';

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
  for (const id of ['status', 'tools', 'diagnostics', 'panel', 'transport']) $(id).hidden = true;
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
  halfExtents: f.region.halfExtents,
});

const GESTURE_LABEL: Record<TransformMode, string> = { translate: 'Move law', rotate: 'Rotate law', scale: 'Resize law' };
const BUSY_TEXT: Record<string, string> = {
  save: 'Saving…',
  'save-as': 'Saving…',
  open: 'Opening…',
  new: 'Starting a new scene…',
  recover: 'Recovering…',
  'discard-recovery': 'Discarding recovered work…',
  close: 'Closing…',
  quit: 'Quitting…',
};
const DEGREES = 180 / Math.PI;

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

  // Authority: the host owns the world; the document controller owns the authored document. A
  // committed import replaces the host, so everything reads it through this binding.
  const initial = defaultDocument();
  let host = new SimulationHost(cloneFrozen(initial.semantic));
  const authoring = new DocumentController(initial, host);
  const scheduler = new FixedStepScheduler(STEP_MS);
  const appliedLaw = (id: string) => host.appliedFields().find((f) => f.id === id);

  const viewport = createViewport(renderer, report);
  const world = createWorldView(viewport.scene, initial.semantic);

  // Edit latency (SPEC §18): accepted edit → first frame submitted with its applied revision.
  let editLatency = new EditLatency();
  /** Final revisions of gestures and toggles, reported once the host applies them. */
  const awaited = new Set<number>();
  const submit = (candidate: FieldDefinition) => {
    const result = authoring.putField(candidate);
    if (result.ok) editLatency.accept(result.value.revision, performance.now());
    return result;
  };

  /** Edits are frozen while the guard decides, and while launch recovery waits for an answer. */
  let frozen = false;
  let guardFrozen = false;
  let offerPending = false;
  let cameraMoved = false;
  const applyFreeze = () => {
    frozen = guardFrozen || offerPending;
    for (const id of ['panel', 'tools', 'transport']) $(id).inert = frozen;
    viewport.gizmo.enabled = !frozen;
  };

  const interaction = new LawInteraction(
    {
      canvas: renderer.domElement,
      dragRegion: $('drag-region'),
      camera: viewport.camera,
      gizmo: viewport.gizmo,
      orbit: viewport.orbit,
      proxy: viewport.proxy,
      appliedField: (id) => appliedLaw(id),
      pickable: () => host.appliedFields().filter((f) => authoring.presentationOf(f.id).visible),
      submit,
      onGestureEnd: (end) => gestureEnded(end),
      onSelectionChange: () => renderPanel(),
      log: report,
    },
    initial.semantic.fields[0]?.id ?? null,
  );

  /** One completed drag is one author-undo entry; a cancel restored its start and records nothing. */
  const gestureEnded = (end: GestureEnd) => {
    awaitApplied(end.revision);
    if (!end.cancelled && end.latest) {
      const presentation = authoring.presentationOf(end.start.id);
      authoring.record({ label: GESTURE_LABEL[end.mode], id: end.start.id, before: { field: end.start, presentation }, after: { field: end.latest, presentation } });
    }
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
          field: ack.payload.kind === 'putField' ? lawSummary(ack.payload.field) : { removed: ack.payload.id },
        });
      }
    }
  };
  /** Applies queued commands at the current boundary now (SPEC §10.2), as the next step would. */
  const settleNow = () => {
    host.settleBoundary();
    absorb();
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
    if (playing && (host.fault || frozen)) return;
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
    if (interaction.gesture || host.fault || frozen) return;
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
    if (frozen) return;
    if (interaction.gesture) {
      report('sim-control', { action: 'reset-refused', reason: 'gesture active', tick: host.tick });
      return;
    }
    setPlaying(false, 'reset');
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
    if (cameraMoved) {
      const p = viewport.camera.position;
      const t = viewport.orbit.target;
      authoring.setCamera({ position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] });
      cameraMoved = false;
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
    candidate: (document) => new SimulationHost(cloneFrozen(document.semantic)),
    commit: (document, candidate) => {
      setPlaying(false, 'load');
      const displaced = host;
      host = candidate;
      authoring.load(document, candidate);
      displaced.dispose();
      world.setScene(document.semantic);
      applyCamera(document.presentation.camera);
      interaction.select(document.semantic.fields[0]?.id ?? null);
      editLatency = new EditLatency();
      awaited.clear();
      runIndex += 1;
      editsSinceReset = 0;
      if (p0) p0.invalid ??= 'scene replaced during capture';
      $('sim-error').hidden = true;
      report('sim-control', { action: 'load', tick: host.tick, playing: scheduler.playing, run: runIndex, laws: document.semantic.fields.map(lawSummary) });
      reportDigest('load');
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
  const runFile = (action: 'open' | 'save' | 'saveAs' | 'newScene') => {
    if (frozen) return;
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    const t = host.tick;
    void workflow[action]().then((outcome) => {
      report('file-control', { action, outcome, tickBefore: t, tickAfter: host.tick, playing: scheduler.playing });
      if (outcome && action !== 'open' && action !== 'newScene') reportDigest(action);
      renderPanel();
    });
  };

  // ------------------------------------------------------------------ authoring commands

  const selectedLaw = () => (interaction.selectedId === null ? undefined : appliedLaw(interaction.selectedId));
  const blocked = () => frozen || interaction.gesture !== null;

  const undo = (redo: boolean) => {
    if (blocked()) return;
    const result = redo ? authoring.redo() : authoring.undo();
    if (result.ok) {
      settleNow();
      if (appliedLaw(result.value.id)) interaction.select(result.value.id);
      else if (interaction.selectedId === result.value.id) interaction.select(authoring.scene.fields[0]?.id ?? null);
      edited();
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
  const strengthInput = $<HTMLInputElement>('law-strength');
  const fadeInput = $<HTMLInputElement>('law-fade');
  const triples = new Map(
    [...details.querySelectorAll<HTMLFieldSetElement>('fieldset.triple')].map((set) => [set.dataset.property!, [...set.querySelectorAll('input')]] as const),
  );

  const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>';

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
    // The native side answers Dock Quit and logout synchronously, so it keeps the dirty state too.
    if (workflow.dirty !== reportedDirty) {
      reportedDirty = workflow.dirty;
      invoke('guard_state', { dirty: reportedDirty }).catch(() => {});
    }
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
    for (const id of ['file-new', 'file-open', 'file-save', 'file-save-as']) $<HTMLButtonElement>(id).disabled = busy !== null;
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
    $<HTMLButtonElement>('undo').disabled = !authoring.canUndo;
    $<HTMLButtonElement>('redo').disabled = !authoring.canRedo;
    $('arrows-toggle').setAttribute('aria-pressed', String(authoring.arrows));

    // Laws list, rebuilt only when something it shows changed.
    const laws = host.appliedFields();
    const selectedId = interaction.selectedId;
    const signature = JSON.stringify([selectedId, laws.map((f) => [f.id, f.enabled, f.expression.strength, authoring.presentationOf(f.id)])]);
    if (signature !== listSignature) {
      listSignature = signature;
      lawList.replaceChildren(
        ...laws.map((f) => {
          const p = authoring.presentationOf(f.id);
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
          meta.textContent = `directional, ${fmt(f.expression.strength, 2)} m/s²`;
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
    if (!law) return;
    const p = authoring.presentationOf(law.id);
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
    triples.get('extent')!.forEach((input, i) => show(input, fmt(law.region.halfExtents[i]!, 3)));
    show(strengthInput, fmt(law.expression.strength, 3));
    show(fadeInput, fmt(law.edgeFade, 3));
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
  triples.get('extent')!.forEach((input, axis) =>
    input.addEventListener('change', () => editSelected('Resize law', input, (f, v) => ({ ...f, region: { kind: 'box', halfExtents: withAxis(f.region.halfExtents, axis, v) } }))),
  );
  strengthInput.addEventListener('change', () => editSelected('Change strength', strengthInput, (f, v) => ({ ...f, expression: { ...f.expression, strength: v } })));
  fadeInput.addEventListener('change', () => editSelected('Change fade', fadeInput, (f, v) => ({ ...f, edgeFade: v })));
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
    if (law) viewport.frame(law.pose.position, Math.hypot(...law.region.halfExtents));
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
    if (p0 || frozen) return;
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
    const script = root.fields[0] ? scriptedRecipeEdits(root.fields[0]) : [];
    const referenceHost = new SimulationHost(root);
    const reference = runFixedSteps(referenceHost, script);
    referenceHost.dispose();
    const cadence = [30, 60, 144].map((hz) => ({ hz, comparison: compareRuns(reference, runAtCadence(root, hz, script)) }));
    const scriptedReset = runResetFixture(root, script);
    report('fixtures', {
      elapsedMs: Math.round(performance.now() - t0),
      root: root.fields.map(lawSummary),
      reset,
      scriptedReset,
      cadence,
      allEqual: [...reset, ...scriptedReset, ...cadence.flatMap((c) => c.comparison)].every((c) => c.equal),
    });
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
        if (!interaction.cancel('escape')) interaction.select(null);
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
    showSimError('The graphics device was lost. Save your scene, then quit and reopen Lawsmith.', false);
  };

  const drawLaws = () =>
    world.updateLaws(
      host.appliedFields().map((field) => ({ field, compiled: host.compiledField(field.id)!, presentation: authoring.presentationOf(field.id) })),
      {
        selectedId: interaction.selectedId,
        preview: interaction.previewField(),
        throttle: interaction.gesture !== null,
        arrows: authoring.arrows,
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
      drawLaws();
      syncControls();
      if (host.tick !== clockTick) {
        clockTick = host.tick;
        clock.textContent = `tick ${host.tick} · ${(host.tick * STEP_SECONDS).toFixed(3)} s`;
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
      `${backend.backend}${backend.compatibilityMode ? ' (compatibility)' : ''} · ${location.origin} · ${window.isSecureContext ? 'secure' : 'NOT secure'} · ${mode}`,
      `tick ${host.tick} · ${scheduler.playing ? 'playing' : 'paused'} · bodies ${host.count} · laws ${laws.length} (${laws.filter((f) => f.enabled).length} on) · arrows ${world.arrowCount()}`,
      `steps/frame ${frameSteps[frameSteps.length - 1] ?? 0} · sim/wall ${simWall.toFixed(2)} · debt dropped ${Math.round(scheduler.droppedMs)} ms · skipped ${host.skippedEmissions}`,
      `step ${ms(percentile(s, 0.95))} p95 (field ${ms(host.lastFieldMs)} · engine ${ms(host.lastEngineMs)}) · edit ${e.length ? ms(percentile(e, 0.95)) : '—'} p95 ms`,
      `frame ${ms(percentile(i, 0.5))} p50 · ${ms(percentile(i, 0.95))} p95 · work ${ms(percentile(w, 0.95))} p95 · stalls ${stalls}`,
      `document gen ${authoring.generation} rev ${authoring.revision} (applied ${authoring.appliedRevision}, stored ${workflow.stored ?? '—'}) · recovery capture ${captures.length ? `${ms(Math.max(...captures))} ms max` : '—'}`,
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
  for (const id of ['tools', 'panel', 'transport']) $(id).hidden = false;
  overlay.hidden = false;
  renderPanel();
  reportDigest('startup');

  // Launch recovery (SPEC §15.3): offer the newest valid unsaved snapshot, never silently.
  const offer = await workflow.recoveryOffer().catch((error: unknown) => {
    report('recovery', { action: 'launch', error: String(error) });
    return null;
  });
  if (offer) showRecoveryOffer(offer);

  // Close and Quit run the shared guard from here on.
  await listen<string>('lawsmith://guard-request', (event) => {
    report('guard', { request: event.payload, tick: host.tick, revision: authoring.revision, dirty: workflow.dirty });
    void workflow.requestExit(event.payload === 'quit' ? 'quit' : 'close').then(() => renderPanel());
  });
  await invoke('guard_ready');
  report('guard', { action: 'ready' });

  /**
   * The launch offer is modal: until the user recovers or discards it, nothing in this session can
   * edit, save or write recovery, so the earlier work cannot be rotated away or retired unanswered.
   */
  function showRecoveryOffer(offer: RecoveryOffer) {
    const panel = $('recovery-offer');
    offerPending = true;
    applyFreeze();
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
        offerPending = false;
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
