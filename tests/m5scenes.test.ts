// M5 scenes and T04 for compound laws: the Storm Bottle example and the P5 compound workload are
// canonical, run without faults or limiting, and hold one compound law each (the bottle) or eight
// (P5). With a triangle gain, nested gains and masks and tick-addressed edits, resets reproduce the
// exact state at ticks 600 and 1200, presentation cadence and pauses add nothing, and every consumer of
// the evaluator (host, probes, drawn samples, previews) reads the same tick.
import { beforeAll, describe, expect, it } from 'vitest';
import stormBottle from '../examples/storm-bottle.lawsmith.json?raw';
import p5Compound from '../scripts/verify/scenes/p5-compound.lawsmith.json?raw';
import { addIngredient, ingredientsOf, removeIngredient, wrapIngredient } from '../src/domain/ingredients';
import { validateField, type FieldDefinition, type FieldExpression, type SceneDefinition, type SceneDocument } from '../src/domain/scene';
import { expressionStats, nodeAt, replaceAt } from '../src/fields/expression';
import { sampleField } from '../src/fields/kernel';
import { regionDescriptor } from '../src/fields/registry';
import { PROBE_LIFETIME_TICKS, ProbeField } from '../src/observation/probes';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { ARROW_STRIDE, DOT_STRIDE, MAX_SAMPLES, SELECTED_LATTICE, sampleLattice } from '../src/rendering/samples';
import {
  FIXTURE_TICKS,
  compareRuns,
  explanationFixture,
  observedResetFixture,
  runAtCadence,
  runFixedSteps,
  runResetFixture,
  visualizationInvariance,
  type Checkpoint,
  type ScriptedCommand,
} from '../src/simulation/fixtures';
import { SimulationHost, initSimulation } from '../src/simulation/host';

const H = 1 / 120;

beforeAll(async () => {
  await initSimulation();
});

function load(text: string): SceneDocument {
  const result = parseScene(text);
  if (!result.ok) throw result.error;
  return result.document;
}
const resolved = (candidate: FieldDefinition): FieldDefinition => {
  const result = validateField(candidate);
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.value;
};

describe('Storm Bottle example', () => {
  const document = load(stormBottle);
  const bottle = document.semantic.fields[0]!;

  it('is canonical and holds one compound law of pull, swirl and a masked drag', () => {
    expect(serializeScene(document)).toBe(stormBottle);
    expect(document.semantic.fields).toHaveLength(1);
    expect(bottle.id).toBe('storm-bottle');
    expect(ingredientsOf(bottle.expression).map((i) => i.core.node.kind)).toEqual(['softRadial', 'vortexY', 'linearDrag']);
    expect(ingredientsOf(bottle.expression)[2]!.modifiers.map((m) => m.node.kind)).toEqual(['mask']);
    expect(document.presentation.laws).toEqual([{ id: 'storm-bottle', label: 'Storm Bottle', color: '#c58ae5', visible: true }]);
    expect(document.requiredCapabilities).toContain('operator.sum.v1');
    expect(document.requiredCapabilities).toContain('operator.mask.v1');
  });

  it('runs 70 s without a fault or the acceleration limiter, beside the stream and inside it', { timeout: 60_000 }, () => {
    for (const position of [bottle.pose.position, [0, 1.6, 0] as const]) {
      const root: SceneDefinition = { ...document.semantic, fields: [resolved({ ...bottle, pose: { ...bottle.pose, position } })] };
      const host = new SimulationHost(root);
      for (let i = 0; i < 8400; i++) host.step();
      expect(host.fault).toBeNull();
      expect(host.limitedSteps).toBe(0);
      host.dispose();
    }
  });

  /** Bodies inside the bottle's support, sampled every 10 ticks after 5 s, on average. */
  function held(expression: FieldExpression): number {
    const field = resolved({ ...bottle, pose: { ...bottle.pose, position: [0, 1.6, 0] }, expression });
    const host = new SimulationHost({ ...document.semantic, fields: [field] });
    const gauge = regionDescriptor(field.region.kind).compile(field.region);
    let inside = 0;
    let samples = 0;
    for (let t = 1; t <= 2400; t++) {
      host.step();
      if (t <= 600 || t % 10) continue;
      samples += 1;
      for (const b of host.canonicalState().bodies) {
        const [x, y, z] = b.translation as [number, number, number];
        if (gauge(x - 0, y - 1.6, z - 0) < 1) inside += 1;
      }
    }
    host.dispose();
    return inside / samples;
  }

  it('in the stream it holds a storm; without its drag or its pull it lets the stream through', { timeout: 60_000 }, () => {
    const full = held(bottle.expression);
    const withoutDrag = removeIngredient(bottle.expression, [2]);
    const withoutPull = removeIngredient(bottle.expression, [0]);
    if (!withoutDrag.ok || !withoutPull.ok) throw new Error('removal failed');
    expect(full).toBeGreaterThan(40);
    expect(held(withoutDrag.expression)).toBeLessThan(10);
    expect(held(withoutPull.expression)).toBeLessThan(20);
  });
});

describe('P5 compound workload (M5 performance fixture)', () => {
  const document = load(p5Compound);

  it('is 100 colliding spheres and eight compound laws of four primitive leaves each', () => {
    expect(serializeScene(document)).toBe(p5Compound);
    const { semantic } = document;
    expect(semantic.bodies.filter((b) => b.type === 'dynamic')).toHaveLength(100);
    expect(semantic.bodies.filter((b) => b.type === 'dynamic').every((b) => b.collisionMode === 'all')).toBe(true);
    expect(semantic.fields).toHaveLength(8);
    for (const f of semantic.fields) {
      expect(expressionStats(f.expression).leaves).toBe(4);
      expect(f.expression.kind).toBe('sum');
    }
  });

  it('stays busy and bounded through a warmup and a measured minute', { timeout: 120_000 }, () => {
    const host = new SimulationHost(document.semantic);
    for (let i = 0; i < 8400; i++) host.step();
    const bodies = host.canonicalState().bodies;
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    expect(bodies.filter((b) => b.translation[1]! > -2.5)).toHaveLength(100);
    expect(bodies.filter((b) => Math.hypot(...b.linvel) > 0.5).length).toBeGreaterThan(60);
    host.dispose();
  });
});

// ---------------------------------------------------------------- T04

/** The bottle in the stream with a pulsing swirl and a gain nested inside the drag's mask. */
function compoundRoot(): SceneDefinition {
  const document = load(stormBottle);
  const bottle = document.semantic.fields[0]!;
  let expression = bottle.expression;
  // Swirl pulses: 0 → 2 → 0 every 240 ticks from phase 30.
  expression = replaceAt(expression, [1], { kind: 'gain', gain: { kind: 'triangle', min: 0, max: 2, periodTicks: 240, phaseTicks: 30 }, child: nodeAt(expression, [1])! })!;
  // Inside the drag's mask, a constant gain 1.2 on the drag.
  expression = replaceAt(expression, [2, 'child'], { kind: 'gain', gain: { kind: 'constant', value: 1.2 }, child: nodeAt(expression, [2, 'child'])! })!;
  return { ...document.semantic, fields: [resolved({ ...bottle, pose: { ...bottle.pose, position: [0, 1.6, 0] }, expression })] };
}

/** Tick-addressed accepted edits of the bottle: its ingredients, gains, masks, pose and enabled state. */
function compoundEdits(root: SceneDefinition): ScriptedCommand[] {
  const script: ScriptedCommand[] = [];
  let f = root.fields[0]!;
  const put = (atTick: number, change: (field: FieldDefinition) => FieldDefinition) => {
    f = resolved(change(f));
    script.push({ atTick, payload: { kind: 'putField', field: f } });
  };
  const edited = (r: ReturnType<typeof addIngredient>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.expression;
  };
  put(150, (x) => ({ ...x, pose: { ...x.pose, position: [0.3, 1.5, -0.2] } }));
  put(260, (x) => ({ ...x, expression: replaceAt(x.expression, [2], { ...(nodeAt(x.expression, [2]) as Extract<FieldExpression, { kind: 'mask' }>), region: { kind: 'box', halfExtents: [1.6, 1.6, 1.6] } })! }));
  put(330, (x) => ({ ...x, expression: edited(addIngredient(x.expression, null, 'directional')) }));
  put(420, (x) => ({ ...x, expression: edited(wrapIngredient(x.expression, [3], 'mask', x.region)) }));
  put(500, (x) => ({ ...x, expression: edited(removeIngredient(x.expression, [0])) }));
  return script.concat(lateEdits(f));
}

/** Edits after tick 600: a triangle phase change, disable/enable, a rotation, and the pull put back first. */
function lateEdits(start: FieldDefinition): ScriptedCommand[] {
  const script: ScriptedCommand[] = [];
  let f = start;
  const put = (atTick: number, change: (field: FieldDefinition) => FieldDefinition) => {
    f = resolved(change(f));
    script.push({ atTick, payload: { kind: 'putField', field: f } });
  };
  put(700, (x) => {
    const swirl = nodeAt(x.expression, [0]) as Extract<FieldExpression, { kind: 'gain' }>;
    return { ...x, expression: replaceAt(x.expression, [0], { ...swirl, gain: { kind: 'triangle', min: 0.5, max: 1.5, periodTicks: 97, phaseTicks: 96 } })! };
  });
  put(800, (x) => ({ ...x, enabled: false }));
  put(860, (x) => ({ ...x, enabled: true }));
  put(940, (x) => ({ ...x, pose: { ...x.pose, rotation: [0, 0, Math.sin(Math.PI / 16), Math.cos(Math.PI / 16)] } }));
  put(1020, (x) => ({ ...x, expression: { kind: 'sum', terms: [{ kind: 'softRadial', strength: 14, coreRadius: 0.35 }, ...(x.expression as Extract<FieldExpression, { kind: 'sum' }>).terms] } }));
  return script;
}

describe('T04 exact reset with a compound law (AC4, AC6)', () => {
  const root = compoundRoot();
  const script = compoundEdits(root);

  it('the fixture exercises a triangle, nested gains and masks, and ingredient edits', () => {
    expect(script.length).toBeGreaterThanOrEqual(9);
    const kinds = new Set<string>();
    for (const { payload } of script) if (payload.kind === 'putField') JSON.stringify(payload.field.expression, (k, v) => (k === 'kind' && kinds.add(v), v));
    expect([...kinds].sort()).toEqual(['box', 'constant', 'directional', 'gain', 'linearDrag', 'mask', 'softRadial', 'sphere', 'sum', 'triangle', 'vortexY']);
  });

  it('two runs from the same root and edits agree exactly at ticks 600 and 1200', { timeout: 60_000 }, () => {
    const comparison = runResetFixture(root, script);
    expect(comparison.map((c) => c.tick)).toEqual([...FIXTURE_TICKS]);
    for (const c of comparison) {
      expect(c.divergence).toBeNull();
      expect(c.engineBytesEqual).toBe(true);
      expect(c.bodies).toBeGreaterThan(20);
    }
  });

  it('30, 60 and 144 Hz presentation reach the identical state: the triangle follows ticks, not frames', { timeout: 60_000 }, () => {
    const host = new SimulationHost(root);
    const reference = runFixedSteps(host, script);
    host.dispose();
    for (const hz of [30, 60, 144]) expect(compareRuns(reference, runAtCadence(root, hz, script)).every((c) => c.equal)).toBe(true);
  });

  it('a long pause adds nothing: paused frames settle, preview and sample the same tick, and the run resumes exactly', { timeout: 60_000 }, () => {
    const host = new SimulationHost(root);
    const reference = runFixedSteps(host, script);
    host.dispose();
    const paused = new SimulationHost(root);
    const arrows = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
    const dots = new Float64Array(DOT_STRIDE * MAX_SAMPLES);
    const captured: Checkpoint[] = [];
    let revision = 0;
    while (paused.tick < 1200) {
      for (const c of script) if (c.atTick === paused.tick) paused.submit(c.payload, ++revision);
      if (paused.tick === 300 || paused.tick === 999) {
        // 600 paused frames at one boundary: settle, explain, preview and draw, never step.
        paused.settleBoundary();
        const field = paused.appliedFields()[0]!;
        paused.explain(paused.ids[0] ?? null);
        const first = paused.previewTransition();
        const drawn = sampleLattice(paused.compiledField(field.id)!, regionDescriptor(field.region.kind).bounds(field.region), SELECTED_LATTICE, paused.tick, arrows, dots);
        const snapshot = [...arrows.subarray(0, ARROW_STRIDE * drawn.arrows)];
        const at = paused.tick;
        for (let frame = 0; frame < 600; frame++) {
          paused.settleBoundary();
          expect(paused.tick).toBe(at);
          expect(JSON.stringify(paused.previewTransition())).toBe(JSON.stringify(first));
          sampleLattice(paused.compiledField(field.id)!, regionDescriptor(field.region.kind).bounds(field.region), SELECTED_LATTICE, paused.tick, arrows, dots);
          expect([...arrows.subarray(0, ARROW_STRIDE * drawn.arrows)]).toEqual(snapshot);
        }
        paused.explain(null);
      }
      paused.step();
      if ((FIXTURE_TICKS as readonly number[]).includes(paused.tick)) captured.push({ tick: paused.tick, state: paused.canonicalState(), engine: paused.engineSnapshot() });
    }
    paused.dispose();
    expect(compareRuns(reference, captured).every((c) => c.equal)).toBe(true);
  });

  it('probes, trails, arrows and explained bodies leave the compound world exactly as it is (AC6 of M4)', { timeout: 120_000 }, () => {
    const runs = visualizationInvariance(root, script);
    for (const run of runs) {
      expect(run.activity.probeSteps).toBeGreaterThan(1000);
      expect(run.comparison.every((c) => c.equal)).toBe(true);
    }
    expect(observedResetFixture(root, script).every((c) => c.equal)).toBe(true);
  });

  it('every retained step of the explained body reconciles, ingredients included', { timeout: 60_000 }, () => {
    const result = explanationFixture(root, script, 1200);
    expect(result.pass).toBe(true);
    expect(result.ingredientChecks).toBeGreaterThan(900);
    expect(result.previews).toBeGreaterThan(10);
  });

  it('the P5 workload resets exactly too', { timeout: 60_000 }, () => {
    expect(runResetFixture(load(p5Compound).semantic).every((c) => c.equal)).toBe(true);
  });
});

describe('T04: every consumer samples the tick it explains', () => {
  const pulsing = (): SceneDefinition => {
    const root = compoundRoot();
    return { ...root, fields: [resolved({ ...root.fields[0]!, pose: { ...root.fields[0]!.pose, position: [0.4, 1.4, 0.2] } })] };
  };

  it('a probe and a body at the same state get the same step under a triangle gain, at every tick of a period', () => {
    const root = pulsing();
    const host = new SimulationHost({
      ...root,
      emitters: [],
      bodies: [
        ...root.bodies,
        { id: 'a', type: 'dynamic', massKg: 1, initialPose: { position: [0.7, 1.2, 0.1], rotation: [0, 0, 0, 1] }, initialLinearVelocity: [1, -2, 0.5], initialAngularVelocity: [0, 0, 0], collider: { kind: 'sphere', radius: 0.08 }, material: { friction: 0.6, restitution: 0.25 }, collisionMode: 'fixedOnly' },
      ],
    });
    host.explain('a');
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 1, seed: 1 });
    for (let n = 0; n < 240; n += 1) {
      probes.sync(host);
      const state = host.canonicalState().bodies.find((b) => b.id === 'a')!;
      probes.position.set(state.translation);
      probes.velocity.set(state.linvel);
      const v = [...state.linvel];
      host.step();
      probes.advance(host);
      // A probe is born again every PROBE_LIFETIME_TICKS (M4), at rest, right after that tick's step.
      if (host.tick % PROBE_LIFETIME_TICKS === 0) continue;
      const submitted = host.explanation!.submitted;
      for (let c = 0; c < 3; c++) expect(probes.velocity[c]).toBe(v[c]! + H * submitted[c]!);
    }
    host.dispose();
  });

  it('drawn samples are the evaluator at the host’s tick, and a tick-dependent law’s samples change with it', () => {
    const root = pulsing();
    const host = new SimulationHost(root);
    for (let i = 0; i < 37; i++) host.step();
    const field = host.appliedFields()[0]!;
    const compiled = host.compiledField(field.id)!;
    expect(compiled.timeDependent).toBe(true);
    const bounds = regionDescriptor(field.region.kind).bounds(field.region);
    const arrows = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
    const dots = new Float64Array(DOT_STRIDE * MAX_SAMPLES);
    const drawn = sampleLattice(compiled, bounds, SELECTED_LATTICE, host.tick, arrows, dots);
    const out = [0, 0, 0, 0];
    for (let a = 0; a < drawn.arrows; a++) {
      const [x, y, z, ax, ay, az] = arrows.subarray(ARROW_STRIDE * a, ARROW_STRIDE * a + ARROW_STRIDE);
      sampleField(compiled, x!, y!, z!, host.tick, out);
      expect([ax, ay, az]).toEqual(out.slice(0, 3));
    }
    const next = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
    sampleLattice(compiled, bounds, SELECTED_LATTICE, host.tick + 60, next, dots);
    expect([...next.subarray(0, ARROW_STRIDE * drawn.arrows)]).not.toEqual([...arrows.subarray(0, ARROW_STRIDE * drawn.arrows)]);
    host.dispose();
  });
});
