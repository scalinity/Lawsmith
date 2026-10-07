// Same-environment determinism fixtures (SPEC §13.4, T04). Shared by the Vitest harness and
// the app's diagnostic run, so the qualified WKWebView runtime executes the same code.
import { STARTING_RECIPE, validateField, type FieldDefinition, type SceneDefinition } from '../domain/scene';
import { sampleField } from '../fields/kernel';
import { primitiveDescriptor, regionDescriptor } from '../fields/registry';
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
