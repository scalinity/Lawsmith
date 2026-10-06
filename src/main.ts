import { invoke } from '@tauri-apps/api/core';
import { identifyBackend, isQualifiedWebGPU, probeRenderedPixels, watchGPUErrors } from './rendering/backend';
import { createRenderer, createViewport, MAX_PIXEL_RATIO, type TransformMode } from './rendering/viewport';
import { initSimulation, STEP_SECONDS } from './simulation/host';

const mode = import.meta.env.DEV ? 'dev' : 'packaged';
// Dev-only fault injection for the controlled-failure check; compiled out of production builds.
const fault: string = import.meta.env.DEV ? (import.meta.env.VITE_LAWSMITH_FAULT ?? '') : '';
const INIT_TIMEOUT_MS = 10_000;

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
  $('status').hidden = true;
  $('tools').hidden = true;
  $('diagnostics').hidden = true;
  $('failure-summary').textContent = message;
  $('failure-detail').textContent = JSON.stringify(facts, null, 2);
  $('failure').hidden = false;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const ms = (value: number) => value.toFixed(1);

async function start() {
  const begin = performance.now();
  facts.runtime = await invoke<Record<string, string>>('runtime_identity').catch((e: unknown) => `unavailable: ${String(e)}`);
  report('runtime', { ...facts, userAgent: navigator.userAgent });

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
  report('rapier', { version: simulation.rapierVersion, effectiveProfile: simulation.effectiveProfile });
  const simulationReady = performance.now();

  const viewport = createViewport(renderer, report);
  await renderer.compileAsync(viewport.scene, viewport.camera);
  const distinctColors = await probeRenderedPixels(renderer, viewport.scene, viewport.camera);
  report('render-probe', { distinctColors, gpuErrors: gpuErrors.length });
  if (distinctColors < 4) throw new Error('The WebGPU renderer initialized but produced an empty frame.');

  // Frame pacing: a small rolling window, enough to spot stalls, not a benchmark.
  const intervals: number[] = [];
  const work: number[] = [];
  let stalls = 0;
  let firstFrameAt = 0;
  viewport.start((interval, frameWork) => {
    if (!firstFrameAt) {
      firstFrameAt = performance.now();
      report('ready', {
        rendererInitMs: Math.round(rendererReady - begin),
        rapierInitMs: Math.round(simulationReady - rendererReady),
        firstFrameMs: Math.round(firstFrameAt - begin),
      });
    }
    if (interval > 50) stalls += 1;
    intervals.push(interval);
    work.push(frameWork);
    if (intervals.length > 240) intervals.shift();
    if (work.length > 240) work.shift();
  });

  const overlay = $('diagnostics');
  let lastPacingReport = performance.now();
  setInterval(() => {
    const i = [...intervals].sort((a, b) => a - b);
    const w = [...work].sort((a, b) => a - b);
    const canvas = renderer.domElement;
    overlay.textContent = [
      `${backend.backend}${backend.compatibilityMode ? ' (compatibility)' : ''} · ${location.origin} · ${window.isSecureContext ? 'secure' : 'NOT secure'}`,
      `DPR ${window.devicePixelRatio} → render ${renderer.getPixelRatio()} (cap ${MAX_PIXEL_RATIO}) · ${window.innerWidth}×${window.innerHeight} css · ${canvas.width}×${canvas.height} px`,
      `frame ${ms(percentile(i, 0.5))} ms p50 · ${ms(percentile(i, 0.95))} p95 · work ${ms(percentile(w, 0.95))} p95 · stalls ${stalls}`,
      `Rapier ${simulation.rapierVersion} · h 1/${Math.round(1 / STEP_SECONDS)} · GPU errors ${gpuErrors.length} · ${mode}`,
    ].join('\n');
    if (performance.now() - lastPacingReport > 5000 && i.length) {
      lastPacingReport = performance.now();
      report('pacing', {
        intervalMs: [0.5, 0.95, 0.99].map((p) => Number(ms(percentile(i, p)))),
        maxIntervalMs: Number(ms(i[i.length - 1] ?? 0)),
        workP95Ms: Number(ms(percentile(w, 0.95))),
        stallsOver50ms: stalls,
        devicePixelRatio: window.devicePixelRatio,
        pixelRatio: renderer.getPixelRatio(),
      });
    }
  }, 500);

  const modeButtons = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
  const setMode = (next: TransformMode) => {
    viewport.setMode(next);
    modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
    report('control', { transformMode: next });
  };
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as TransformMode)));
  $('frame-view').addEventListener('click', () => {
    viewport.frameView();
    report('control', { frame: true });
  });
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 't') setMode('translate');
    else if (event.key === 'r') setMode('rotate');
    else if (event.key === 'f') viewport.frameView();
  });

  $('status').hidden = true;
  $('tools').hidden = false;
  overlay.hidden = false;
}

start().catch(showFailure);
