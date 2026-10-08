// A headless measurement at SPEC §15.2's work limits, opt-in because it measures rather than checks:
//
//   VITE_LAWSMITH_MEASURE=1 npx vitest run tests/workLimits.test.ts
//
// For P5 and for a scene at the limits (32 laws, 256 primitive leaves, 57 nodes and depth 8 per law,
// every body inside every law and every mask), it prints each run's p50/p95/p99 of one host step and of
// one 2,000-probe step. This is Node's V8, not WKWebView's JavaScriptCore: a headless figure reported
// separately from packaged measurement (SPEC §18.2), which M9 qualifies. P5 runs beside the limits so
// the two can be compared with P5's packaged figures.
import { beforeAll, describe, expect, it } from 'vitest';
import p5Compound from '../scripts/verify/scenes/p5-compound.lawsmith.json?raw';
import { SCENE_LIMITS, cloneFrozen, validateScene, type FieldDefinition, type FieldExpression, type Primitive, type SceneDefinition } from '../src/domain/scene';
import { EXPRESSION_LIMITS, expressionStats } from '../src/fields/expression';
import { MAX_PROBES, ProbeField } from '../src/observation/probes';
import { parseScene } from '../src/persistence/sceneFile';
import { SimulationHost, initSimulation } from '../src/simulation/host';

const LEAVES: readonly Primitive[] = [
  { kind: 'directional', direction: [0, 1, 0], strength: 0.5 },
  { kind: 'softRadial', strength: -0.5, coreRadius: 0.5 },
  { kind: 'vortexY', strength: 0.5, coreRadius: 0.5 },
  { kind: 'linearDrag', coefficient: 0.25 },
];
const PER_LAW = SCENE_LIMITS.primitiveLeaves / SCENE_LIMITS.fields;
const MASKS = EXPRESSION_LIMITS.depth - 3;

/** Law i of the limit scene: P5's sphere turned about Y, a sum of 8 terms, each gain(mask⁵(leaf)) covering the whole law. */
function limitLaw(template: FieldDefinition, i: number): FieldDefinition {
  const terms = Array.from({ length: PER_LAW }, (_, j) => {
    let node: FieldExpression = LEAVES[j % LEAVES.length]!;
    for (let k = 0; k < MASKS; k++) node = { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 4.6 }, edgeFade: 0.25, child: node };
    return { kind: 'gain', gain: { kind: 'triangle', min: 0.5, max: 1.5, periodTicks: 240, phaseTicks: (i * PER_LAW + j) % 240 }, child: node } as FieldExpression;
  });
  const angle = (i * Math.PI) / SCENE_LIMITS.fields;
  return { ...template, id: `limit-${String(i).padStart(2, '0')}`, pose: { ...template.pose, rotation: [0, Math.sin(angle), 0, Math.cos(angle)] }, expression: { kind: 'sum', terms } };
}

const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
const summary = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: +percentile(s, 0.5).toFixed(3), p95: +percentile(s, 0.95).toFixed(3), p99: +percentile(s, 0.99).toFixed(3) };
};

/** Warms 600 steps, then three runs of 1,200 steps (10 s at 120 Hz each), timing the host step and the probe step apart. */
function measure(name: string, scene: SceneDefinition) {
  const host = new SimulationHost(cloneFrozen(scene));
  const probes = new ProbeField();
  probes.configure({ enabled: true, count: MAX_PROBES, seed: 1 });
  probes.sync(host);
  const step = () => {
    const t0 = performance.now();
    host.step();
    const t1 = performance.now();
    probes.advance(host);
    return [t1 - t0, performance.now() - t1] as const;
  };
  for (let i = 0; i < 600; i++) step();
  for (let run = 1; run <= 3; run++) {
    const hostMs: number[] = [];
    const probeMs: number[] = [];
    for (let i = 0; i < 1200; i++) {
      const [h, p] = step();
      hostMs.push(h);
      probeMs.push(p);
    }
    console.log(JSON.stringify({ workload: name, run, steps: 1200, hostStepMs: summary(hostMs), probeStepMs: summary(probeMs), tick: host.tick }));
  }
  const nodes = scene.fields.reduce((n, f) => n + expressionStats(f.expression).nodes, 0);
  host.dispose();
  return nodes;
}

describe.skipIf(!import.meta.env.VITE_LAWSMITH_MEASURE)('headless step cost at the work limits', () => {
  beforeAll(async () => {
    await initSimulation();
  });

  it('measures P5 and a scene at the limits', () => {
    const parsed = parseScene(p5Compound);
    if (!parsed.ok) throw parsed.error;
    const p5 = parsed.document.semantic;
    const limits = validateScene({ ...p5, fields: Array.from({ length: SCENE_LIMITS.fields }, (_, i) => limitLaw(p5.fields[0]!, i)) });
    if (!limits.ok) throw new Error(`${limits.path}: ${limits.reason}`);
    const stats = limits.value.fields.map((f) => expressionStats(f.expression));
    expect(stats.reduce((n, s) => n + s.leaves, 0)).toBe(SCENE_LIMITS.primitiveLeaves);
    expect(stats.every((s) => s.nodes === 57 && s.depth === EXPRESSION_LIMITS.depth)).toBe(true);
    console.log(JSON.stringify({ environment: navigator.userAgent, bodies: p5.bodies.length, probes: MAX_PROBES }));
    expect(measure('P5', p5)).toBe(72);
    expect(measure('limits', limits.value)).toBe(57 * SCENE_LIMITS.fields);
  }, 600_000);
});
