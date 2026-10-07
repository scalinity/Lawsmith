// Same-environment determinism fixtures (SPEC §13.4, T04). Shared by the Vitest harness and
// the app's diagnostic run, so the qualified WKWebView runtime executes the same code.
import { STARTING_RECIPE, validateField, type FieldDefinition, type SceneDefinition } from '../domain/scene';
import { sampleField } from '../fields/kernel';
import { primitiveDescriptor, regionDescriptor } from '../fields/registry';
import { MAX_PROBES, ProbeField, type ProbeSettings } from '../observation/probes';
import { TRAIL_INTERVAL_TICKS, TrailRecorder, type TrailMode } from '../observation/trails';
import { ARROW_STRIDE, DOT_STRIDE, MAX_SAMPLES, OTHER_LATTICE, SELECTED_LATTICE, sampleLattice } from '../rendering/samples';
import { SimulationHost, type CanonicalState, type CommandPayload } from './host';
import { FixedStepScheduler } from './scheduler';

export const FIXTURE_TICKS = [600, 1200] as const;

export interface Checkpoint {
  tick: number;
  state: CanonicalState;
  engine: Uint8Array;
}

/** A command addressed to boundary `atTick`, applied before the transition atTick → atTick+1. */
export interface ScriptedCommand {
  atTick: number;
  payload: CommandPayload;
}

export interface Divergence {
  tick: number;
  path: string;
  a: unknown;
  b: unknown;
}

export interface CheckpointComparison {
  tick: number;
  equal: boolean;
  engineBytesEqual: boolean;
  bodies: number;
  divergence: Divergence | null;
}

/** The first differing leaf, compared with Object.is: no tolerance (SPEC §13.4). */
export function firstDivergence(a: CanonicalState, b: CanonicalState): Divergence | null {
  const path = diff(a, b, '');
  if (path === null) return null;
  const read = (root: unknown) => path.split('.').filter(Boolean).reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], root);
  return { tick: a.tick, path, a: read(a), b: read(b) };
}

function diff(a: unknown, b: unknown, path: string): string | null {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? null : path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = diff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    if (found !== null) return found;
  }
  return null;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function compareRuns(first: Checkpoint[], second: Checkpoint[]): CheckpointComparison[] {
  return first.map((a, i) => {
    const b = second[i]!;
    const divergence = a.tick === b.tick ? firstDivergence(a.state, b.state) : { tick: a.tick, path: 'tick', a: a.tick, b: b.tick };
    const engineBytesEqual = bytesEqual(a.engine, b.engine);
    return { tick: a.tick, equal: divergence === null && engineBytesEqual, engineBytesEqual, bodies: a.state.bodies.length, divergence };
  });
}

function deliver(host: SimulationHost, script: readonly ScriptedCommand[], revision: { value: number }) {
  for (const command of script) if (command.atTick === host.tick) host.submit(command.payload, ++revision.value);
}

const capture = (host: SimulationHost): Checkpoint => ({ tick: host.tick, state: host.canonicalState(), engine: host.engineSnapshot() });

/** Steps a host from its current state through each checkpoint tick. */
export function runFixedSteps(host: SimulationHost, script: readonly ScriptedCommand[] = [], ticks: readonly number[] = FIXTURE_TICKS): Checkpoint[] {
  const revision = { value: 0 };
  const captured: Checkpoint[] = [];
  const last = ticks[ticks.length - 1]!;
  while (host.tick < last) {
    deliver(host, script, revision);
    host.step();
    if (ticks.includes(host.tick)) captured.push(capture(host));
  }
  return captured;
}

/** T04 reset: build from the root and run, reset to the same root and run again, compare exactly. */
export function runResetFixture(root: SceneDefinition, script: readonly ScriptedCommand[] = []): CheckpointComparison[] {
  const host = new SimulationHost(root);
  try {
    const first = runFixedSteps(host, script);
    host.reset(root);
    return compareRuns(first, runFixedSteps(host, script));
  } finally {
    host.dispose();
  }
}

/**
 * Drives the live scheduler with scripted presentation timestamps at `hz`. Each frame also does
 * a renderer's reads (body positions and evaluator-backed arrow samples), which must not change state.
 */
export function runAtCadence(root: SceneDefinition, hz: number, script: readonly ScriptedCommand[] = []): Checkpoint[] {
  const host = new SimulationHost(root);
  const scheduler = new FixedStepScheduler(1000 / 120);
  const revision = { value: 0 };
  const captured: Checkpoint[] = [];
  const last = FIXTURE_TICKS[FIXTURE_TICKS.length - 1]!;
  const arrow = [0, 0, 0, 0];
  scheduler.play();
  try {
    for (let frame = 0; host.tick < last; frame++) {
      const t = (frame * 1000) / hz;
      const { steps } = scheduler.frame(t, t);
      for (let s = 0; s < steps && host.tick < last; s++) {
        deliver(host, script, revision);
        host.step();
        if ((FIXTURE_TICKS as readonly number[]).includes(host.tick)) captured.push(capture(host));
      }
      let readback = 0;
      for (let i = 0; i < host.count * 3; i++) readback += host.positions[i]!;
      for (const field of host.appliedFields()) {
        const compiled = host.compiledField(field.id)!;
        for (let k = 0; k < 125; k++) readback += sampleField(compiled, compiled.px + (k % 5) - 2, compiled.py, compiled.pz, arrow);
      }
      if (Number.isNaN(readback)) throw new Error('nonfinite render observation');
    }
    return captured;
  } finally {
    host.dispose();
  }
}

/**
 * Visualization state (SPEC §4 render and UI state): which body is explained, what probes and trails
 * record, which laws draw arrows, whether a preview is taken. None of it may reach the simulation.
 */
export interface ObservedView {
  readonly label: string;
  readonly probes: ProbeSettings;
  readonly trails: TrailMode;
  /** The body explained before the step from the host's current boundary, or null. */
  explain(host: SimulationHost): string | null;
  /** Sparse arrows for this law only, or for every law. */
  readonly arrowsFor: string | 'all';
  /** A next-step preview every this many ticks; 0 for none. */
  readonly previewEvery: number;
}

/** Nothing optional: no probes, no trails, nothing explained, every law's arrows. */
export const QUIET_VIEW: ObservedView = {
  label: 'quiet',
  probes: { enabled: false, count: MAX_PROBES, seed: 1 },
  trails: 'off',
  explain: () => null,
  arrowsFor: 'all',
  previewEvery: 0,
};

/** Everything at once: 2,000 probes, 32 trails, a changing explained body, one law's arrows, previews. */
export function busyView(root: SceneDefinition, seed: number, stride: number): ObservedView {
  return {
    label: `busy seed ${seed}`,
    probes: { enabled: true, count: MAX_PROBES, seed },
    trails: 'all',
    explain: (host) => (host.count ? host.ids[Math.floor(host.tick / stride) % host.count]! : null),
    arrowsFor: root.fields[0]?.id ?? 'all',
    previewEvery: 13,
  };
}

/**
 * Steps a host through the checkpoint ticks while a view observes it the way the app does: probes and
 * trails after every step, arrow samples every fourth tick, previews and explained bodies as the view says.
 */
/** What a view did during a run, so an invariance check can show it was not vacuous. */
export interface ObservedActivity {
  probeSteps: number;
  maxLiveProbes: number;
  maxTrails: number;
  explainedSteps: number;
  previews: number;
  arrowSamples: number;
}

export function runObserved(
  host: SimulationHost,
  script: readonly ScriptedCommand[],
  view: ObservedView,
  ticks: readonly number[] = FIXTURE_TICKS,
  activity: ObservedActivity = { probeSteps: 0, maxLiveProbes: 0, maxTrails: 0, explainedSteps: 0, previews: 0, arrowSamples: 0 },
): Checkpoint[] {
  const probes = new ProbeField();
  probes.configure(view.probes);
  const trails = new TrailRecorder(view.trails);
  const arrows = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
  const dots = new Float64Array(DOT_STRIDE * MAX_SAMPLES);
  const revision = { value: 0 };
  const captured: Checkpoint[] = [];
  const last = ticks[ticks.length - 1]!;
  while (host.tick < last) {
    deliver(host, script, revision);
    const explained = view.explain(host);
    host.explain(explained);
    probes.sync(host);
    if (view.previewEvery && host.tick % view.previewEvery === 0 && host.previewTransition()) activity.previews += 1;
    host.step();
    probes.advance(host);
    trails.record(host, explained);
    if (host.explanation?.toTick === host.tick) activity.explainedSteps += 1;
    if (probes.live) activity.probeSteps += 1;
    activity.maxLiveProbes = Math.max(activity.maxLiveProbes, probes.live);
    activity.maxTrails = Math.max(activity.maxTrails, trails.count);
    if (host.tick % TRAIL_INTERVAL_TICKS === 0) {
      for (const field of host.appliedFields()) {
        if (view.arrowsFor !== 'all' && view.arrowsFor !== field.id) continue;
        const lattice = view.arrowsFor === field.id ? SELECTED_LATTICE : OTHER_LATTICE;
        const drawn = sampleLattice(host.compiledField(field.id)!, regionDescriptor(field.region.kind).bounds(field.region), lattice, arrows, dots);
        activity.arrowSamples += drawn.arrows + drawn.dots;
      }
    }
    if (ticks.includes(host.tick)) captured.push(capture(host));
  }
  host.explain(null);
  return captured;
}

/**
 * AC6 and T11: the same root and commands observed quietly and by two busy views with different probe
 * seeds and explained bodies reach identical authority (state, engine bytes, emitter PRNG) at each checkpoint.
 */
export function visualizationInvariance(root: SceneDefinition, script: readonly ScriptedCommand[] = []): { view: string; activity: ObservedActivity; comparison: CheckpointComparison[] }[] {
  const views = [QUIET_VIEW, busyView(root, 7, 97), busyView(root, 0x9e3779b9, 41)];
  const runs = views.map((view) => {
    const host = new SimulationHost(root);
    const activity: ObservedActivity = { probeSteps: 0, maxLiveProbes: 0, maxTrails: 0, explainedSteps: 0, previews: 0, arrowSamples: 0 };
    try {
      return { checkpoints: runObserved(host, script, view, FIXTURE_TICKS, activity), activity };
    } finally {
      host.dispose();
    }
  });
  return views.slice(1).map((view, i) => ({ view: view.label, activity: runs[i + 1]!.activity, comparison: compareRuns(runs[0]!.checkpoints, runs[i + 1]!.checkpoints) }));
}

/** T04 with the view changed across the reset: quiet before, busy after, the same world both times. */
export function observedResetFixture(root: SceneDefinition, script: readonly ScriptedCommand[] = []): CheckpointComparison[] {
  const host = new SimulationHost(root);
  try {
    const first = runObserved(host, script, QUIET_VIEW);
    host.reset(root);
    return compareRuns(first, runObserved(host, script, busyView(root, 11, 61)));
  } finally {
    host.dispose();
  }
}

/**
 * A tick-addressed edit script for every law of a root, whatever its kinds: each law is moved,
 * rotated, resized through its region controls, retuned through its primitive controls, disabled
 * and enabled; the last law is removed and put back. Values are resolved through validation, as a
 * live edit would be, and laws are staggered by ID order.
 */
export function scriptedEdits(root: SceneDefinition): ScriptedCommand[] {
  const script: ScriptedCommand[] = [];
  const put = (atTick: number, candidate: FieldDefinition): FieldDefinition => {
    const result = validateField(candidate);
    if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
    script.push({ atTick, payload: { kind: 'putField', field: result.value } });
    return result.value;
  };
  const s = Math.sin(Math.PI / 8);
  root.fields.forEach((base, i) => {
    const region = regionDescriptor(base.region.kind);
    const primitive = primitiveDescriptor(base.expression.kind);
    const [x, y, z] = base.pose.position;
    let f = put(120 + i, { ...base, pose: { ...base.pose, position: [x - 0.5, y + 0.2, z + 0.1] } });
    f = put(300 + i, { ...f, pose: { ...f.pose, rotation: [0, 0, s, Math.cos(Math.PI / 8)] } });
    f = put(480 + i, { ...f, region: region.controls.reduce((r, c) => c.set(r, Math.min(c.max, c.get(r) * 1.2)), f.region) });
    f = put(560 + i, { ...f, edgeFade: Math.min(1, f.edgeFade + 0.1), expression: primitive.controls.reduce((p, c) => c.set(p, c.get(p) * 0.75), f.expression) });
    f = put(700 + i, { ...f, enabled: false });
    put(840 + i, { ...f, enabled: true });
  });
  const last = root.fields[root.fields.length - 1];
  if (last) {
    script.push({ atTick: 900, payload: { kind: 'removeField', id: last.id } });
    put(960, last);
  }
  return script.sort((a, b) => a.atTick - b.atTick);
}

/** A scripted law edit sequence on the recipe: move into the stream, rotate, resize, disable, enable. */
export function scriptedRecipeEdits(base: FieldDefinition = STARTING_RECIPE.fields[0]!): ScriptedCommand[] {
  const put = (atTick: number, candidate: FieldDefinition): ScriptedCommand => {
    const result = validateField(candidate);
    if (!result.ok) throw new Error(result.reason);
    return { atTick, payload: { kind: 'putField', field: result.value } };
  };
  const moved = { ...base, pose: { ...base.pose, position: [0.4, 1, 0] as const } };
  const s = Math.sin(Math.PI / 8);
  const rotated = { ...moved, pose: { ...moved.pose, rotation: [0, 0, s, Math.cos(Math.PI / 8)] as const } };
  const resized = { ...rotated, region: { kind: 'box' as const, halfExtents: [1, 2.5, 1] as const } };
  return [
    put(120, moved),
    put(300, rotated),
    put(480, resized),
    put(700, { ...resized, enabled: false }),
    put(840, { ...resized, enabled: true }),
  ];
}
