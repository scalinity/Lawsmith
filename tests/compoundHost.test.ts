// T03 and T08 for compound laws (M5): a compound law is one ordinary law to the host. Its compiled
// (A, K) feeds the same aggregate adapter (one β, one λ, gravity once, one force), and its retained
// transition splits into ingredient shares that add up to the law's share under that same β and λ.
// Expected values are hand-derived from SPEC §6.3 and §9.1, with β by Math.exp, never by the adapter.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, validateField, type BodyDefinition, type FieldDefinition, type FieldExpression, type Gain, type SceneDefinition, type Vec3 } from '../src/domain/scene';
import { explanationFixture } from '../src/simulation/fixtures';
import { SimulationHost, initSimulation, type CanonicalState } from '../src/simulation/host';
import { ingredientBreakdown, type TransitionObservation } from '../src/simulation/observation';

const H = 1 / 120;
const G: Vec3 = [0, -9.81, 0];
const ZERO: Vec3 = [0, 0, 0];
const ONE_STEP_TOL = 2e-5;

beforeAll(async () => {
  await initSimulation();
});

const tol = (expected: number) => 1e-9 + 1e-8 * Math.abs(expected);
function expectClose(actual: readonly number[], expected: readonly number[], what: string, within = tol) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `${what}[${i}]: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(within(e)));
}
const betaOf = (K: number) => (K === 0 ? 1 : (1 - Math.exp(-K * H)) / (K * H));

const dir = (strength: number, direction: Vec3 = [1, 0, 0]): FieldExpression => ({ kind: 'directional', direction, strength });
const drag = (coefficient: number): FieldExpression => ({ kind: 'linearDrag', coefficient });
const sum = (...terms: FieldExpression[]): FieldExpression => ({ kind: 'sum', terms });
const gain = (g: Gain | number, child: FieldExpression): FieldExpression => ({ kind: 'gain', gain: typeof g === 'number' ? { kind: 'constant', value: g } : g, child });
const sphereMask = (position: Vec3, radius: number, edgeFade: number, child: FieldExpression): FieldExpression => ({ kind: 'mask', pose: { position, rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius }, edgeFade, child });
const boxMask = (halfExtents: Vec3, child: FieldExpression): FieldExpression => ({ kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'box', halfExtents }, edgeFade: 0, child });

/** A law at the origin whose full-strength core spans 15 m. */
function law(id: string, expression: FieldExpression, enabled = true): FieldDefinition {
  const result = validateField({ id, enabled, pose: { position: ZERO, rotation: [0, 0, 0, 1] }, region: { kind: 'box', halfExtents: [20, 20, 20] }, edgeFade: 0.25, expression });
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.value;
}
const sphere = (id: string, position: Vec3, linearVelocity: Vec3, massKg = 1, mode: BodyDefinition['collisionMode'] = 'fixedOnly'): BodyDefinition => ({
  id,
  type: 'dynamic',
  massKg,
  initialPose: { position, rotation: [0, 0, 0, 1] },
  initialLinearVelocity: linearVelocity,
  initialAngularVelocity: ZERO,
  collider: { kind: 'sphere', radius: 0.08 },
  material: { friction: 0.6, restitution: 0.25 },
  collisionMode: mode,
});
function scene(bodies: BodyDefinition[], fields: FieldDefinition[], ambient: Vec3 = G): SceneDefinition {
  return cloneFrozen({ ...STARTING_RECIPE, simulation: { ...STARTING_RECIPE.simulation, ambientAcceleration: ambient }, bodies, emitters: [], fields });
}
const bodyOf = (state: CanonicalState, id: string) => state.bodies.find((b) => b.id === id)!;

function explainOne(v0: Vec3, fields: FieldDefinition[], ambient: Vec3 = G): TransitionObservation {
  const host = new SimulationHost(scene([sphere('a', ZERO, v0)], fields, ambient));
  host.explain('a');
  host.step();
  const observation = host.explanation!;
  host.dispose();
  return observation;
}
const shareSum = (o: TransitionObservation) => {
  const total = [...o.gravityApplied];
  for (const c of o.contributions) for (let i = 0; i < 3; i++) total[i]! += c.applied[i]!;
  return total;
};
const ingredientSum = (o: TransitionObservation, law: number) => {
  const total = [0, 0, 0];
  for (const share of ingredientBreakdown(o, law)!.ingredients) for (let i = 0; i < 3; i++) total[i]! += share.applied[i]!;
  return total;
};

/** Two drives, positive drag, a gain and nested masks: A = [2,3,1] and K = 2 + 2·0.5 = 3 at the center. */
const COMPOUND = sum(dir(2), dir(3, [0, 1, 0]), drag(2), gain(2, drag(0.5)), sphereMask([0, 0, 0], 5, 0.25, boxMask([5, 5, 5], dir(1, [0, 0, 1]))));

describe('T03: a compound law feeds the same aggregate adapter', () => {
  it('one step: v₁ = e^{−Kh}v₀ + (1 − e^{−Kh})/K·(g + A) with K = 3, limiter inactive', () => {
    const v0: Vec3 = [1, 2, -3];
    const host = new SimulationHost(scene([sphere('a', ZERO, v0)], [law('c', COMPOUND)]));
    host.explain('a');
    host.step();
    const o = host.explanation!;
    const A = [2, -9.81 + 3, 1];
    const e = Math.exp(-3 * H);
    const expected = A.map((a, i) => e * v0[i]! + ((1 - e) / 3) * a);
    expectClose(bodyOf(host.canonicalState(), 'a').linvel, expected, 'engine v₁', () => ONE_STEP_TOL);
    expect(o.drag).toBe(3);
    expectClose([o.beta], [betaOf(3)], 'β');
    expect(o.lambda).toBe(1);
    // A − Kv = [2 − 3, −6.81 − 6, 1 + 9], submitted β·that.
    expectClose(o.submitted, [-1, -12.81, 10].map((c) => betaOf(3) * c), 'submitted');
    expectClose(shareSum(o), o.submitted, 'shares');
    expectClose(o.force.map((f) => f / o.mass), o.submitted, 'force/mass');
    host.dispose();
  });

  it('shares one β with a separate drag law: K is their total', () => {
    const o = explainOne([1, 2, -3], [law('c', COMPOUND), law('d', drag(2))]);
    expect(o.drag).toBe(5);
    expectClose([o.beta], [betaOf(5)], 'β');
    const b = betaOf(5);
    expectClose(o.contributions[0]!.applied, [2 - 3, 3 - 6, 1 + 9].map((c) => b * c), 'compound share');
    expectClose(o.contributions[1]!.applied, [-2, -4, 6].map((c) => b * c), 'drag share');
    expectClose(shareSum(o), o.submitted, 'shares');
  });

  it('shares one λ when the limiter is active, and the step is v + h·λ·a*', () => {
    const v0: Vec3 = [-40, -3, 2];
    const host = new SimulationHost(scene([sphere('a', ZERO, v0)], [law('c', sum(dir(200), drag(2)))]));
    host.explain('a');
    host.step();
    const o = host.explanation!;
    const b = betaOf(2);
    const aStar = [200 + 80, -9.81 + 6, -4].map((c) => b * c);
    const lambda = 200 / Math.hypot(...aStar);
    expect(o.lambda).toBeLessThan(1);
    expectClose([o.lambda], [lambda], 'λ');
    expectClose(bodyOf(host.canonicalState(), 'a').linvel, v0.map((v, i) => v + H * lambda * aStar[i]!), 'engine v₁', () => ONE_STEP_TOL);
    expectClose(shareSum(o), o.submitted, 'shares');
    host.dispose();
  });

  it('applies gravity once: a pure-drag compound law from rest gives (1 − e^{−Kh})/K·g', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, ZERO)], [law('c', sum(drag(1), gain(2, drag(0.5))))]));
    host.step();
    const e = Math.exp(-2 * H);
    expectClose(bodyOf(host.canonicalState(), 'a').linvel, G.map((g) => ((1 - e) / 2) * g), 'engine v₁', () => ONE_STEP_TOL);
    host.dispose();
  });

  it('is mass-independent: 1 kg and 10 kg reach the same velocity over 120 steps', () => {
    const run = (mass: number) => {
      const host = new SimulationHost(scene([sphere('a', ZERO, [1, 2, -3], mass)], [law('c', COMPOUND)]));
      for (let i = 0; i < 120; i++) host.step();
      const v = bodyOf(host.canonicalState(), 'a').linvel;
      host.dispose();
      return v;
    };
    expectClose(run(10), run(1), '10 kg vs 1 kg', () => 2e-4);
  });

  it('clears the force: after the compound law is removed the next step is free fall', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, [1, 2, -3])], [law('c', COMPOUND)]));
    host.step();
    const v1 = bodyOf(host.canonicalState(), 'a').linvel;
    host.submit({ kind: 'removeField', id: 'c' }, 1);
    host.step();
    expectClose(bodyOf(host.canonicalState(), 'a').linvel, v1.map((v, i) => v + H * G[i]!), 'engine v₂', () => ONE_STEP_TOL);
    host.dispose();
  });

  it('aggregates drag, never updating it term by term: sum(K 2, K 3), two laws and one K 5 law agree bit for bit', () => {
    const run = (fields: FieldDefinition[]) => {
      const host = new SimulationHost(scene([sphere('a', ZERO, [10, -1, 4])], fields));
      for (let i = 0; i < 60; i++) host.step();
      const state = bodyOf(host.canonicalState(), 'a');
      host.dispose();
      return state;
    };
    const one = run([law('d', drag(5))]);
    expect(run([law('c', sum(drag(2), drag(3)))])).toEqual(one);
    expect(run([law('d2', drag(2)), law('d3', drag(3))])).toEqual(one);
  });

  it('never injects energy: compound pure drag up to K = 3200 s⁻¹ never speeds a body up or reverses it beyond f32', () => {
    const tri: Gain = { kind: 'triangle', min: 0, max: 16, periodTicks: 10, phaseTicks: 3 };
    const field = law('c', sum(gain(16, drag(100)), sphereMask([0, 0, 0], 50, 0, gain(tri, drag(100))), gain(0.5, drag(7))));
    const host = new SimulationHost(scene([sphere('a', ZERO, [10, -0.5, 3])], [field], ZERO));
    let previous = bodyOf(host.canonicalState(), 'a').linvel;
    for (let i = 0; i < 240; i++) {
      host.step();
      const v = bodyOf(host.canonicalState(), 'a').linvel;
      expect(Math.hypot(...v)).toBeLessThanOrEqual(Math.hypot(...previous));
      v.forEach((c, k) => {
        const before = previous[k]!;
        if (Math.sign(c) * Math.sign(before) < 0) expect(Math.abs(before) < 2 ** -126 || Math.abs(c) <= 2 ** -22 * Math.abs(before)).toBe(true);
      });
      previous = v;
    }
    host.dispose();
  });
});

describe('T08: a compound law’s share splits into its ingredients', () => {
  it('two drives: [2,0,0] and [0,3,0], adding to the law’s share exactly', () => {
    const o = explainOne([1, 2, -3], [law('c', sum(dir(2), dir(3, [0, 1, 0])))]);
    const b = ingredientBreakdown(o, 0)!;
    expect(b.ingredients.map((i) => i.label)).toEqual(['Push', 'Push 2']);
    expect(b.ingredients.map((i) => i.applied)).toEqual([[2, 0, 0], [0, 3, 0]]);
    expect(b.reconciled).toBe(true);
    expect(ingredientSum(o, 0)).toEqual(o.contributions[0]!.applied);
    expectClose(shareSum(o), o.submitted, 'shares');
  });

  it('two drags: −λβK_i·v each, under the shared β(5h)', () => {
    const v: Vec3 = [10, 0, 0];
    const o = explainOne(v, [law('c', sum(drag(2), drag(3)))], ZERO);
    const b = betaOf(5);
    const [two, three] = ingredientBreakdown(o, 0)!.ingredients;
    expect([two!.drag, three!.drag]).toEqual([2, 3]);
    expectClose(two!.applied, [-2 * 10 * b, 0, 0], 'K 2');
    expectClose(three!.applied, [-3 * 10 * b, 0, 0], 'K 3');
    expectClose(ingredientSum(o, 0), o.contributions[0]!.applied, 'Σ ingredients');
    // A drag share is not a counterfactual: alone, K = 2 would carry β(2h), not β(5h).
    expect(Math.abs(two!.applied[0] - -20 * betaOf(2))).toBeGreaterThan(1e-3);
  });

  it('a gain scales its ingredient, and names its value', () => {
    const o = explainOne(ZERO, [law('c', sum(gain(2, dir(2)), dir(1, [0, 0, 1])))], ZERO);
    const [scaled, plain] = ingredientBreakdown(o, 0)!.ingredients;
    expect(scaled!.applied).toEqual([4, 0, 0]);
    expect(scaled!.factors).toEqual([{ kind: 'gain', value: 2 }]);
    expect(plain!.applied).toEqual([0, 0, 1]);
  });

  it('a masked ingredient at weight 0.5, and nested masks at 0.5 × 0.5', () => {
    // The body is at the law's center; each unit mask sits 0.875 away from it: d = 0.875, weight 0.5.
    const o = explainOne(ZERO, [law('c', sum(sphereMask([0.875, 0, 0], 1, 0.25, dir(4)), sphereMask([0.875, 0, 0], 1, 0.25, sphereMask([-0.875, 0, 0], 1, 0.25, drag(4)))))], ZERO);
    const [masked, nested] = ingredientBreakdown(o, 0)!.ingredients;
    expect(masked!.factors).toEqual([{ kind: 'mask', value: 0.5 }]);
    expect(masked!.drive).toEqual([2, 0, 0]);
    expect(nested!.factors).toEqual([{ kind: 'mask', value: 0.5 }, { kind: 'mask', value: 0.5 }]);
    expect(nested!.drag).toBe(1);
    expect(ingredientBreakdown(o, 0)!.reconciled).toBe(true);
  });

  it('a zero gain eliminates its ingredient’s share exactly', () => {
    const o = explainOne([1, 2, -3], [law('c', sum(gain(0, sum(dir(12), drag(5))), dir(1)))]);
    const [zeroed, kept] = ingredientBreakdown(o, 0)!.ingredients;
    for (const c of [...zeroed!.drive, zeroed!.drag, ...zeroed!.applied]) expect(c).toBe(0);
    expect(zeroed!.factors).toEqual([{ kind: 'gain', value: 0 }]);
    expect(kept!.applied).toEqual([1, 0, 0]);
    expect(o.drag).toBe(0);
  });

  it('a disabled containing law has zero shares for every ingredient', () => {
    const o = explainOne([1, 2, -3], [law('c', COMPOUND, false)]);
    const b = ingredientBreakdown(o, 0)!;
    expect(o.contributions[0]!.applied).toEqual([0, 0, 0]);
    for (const share of b.ingredients) for (const c of [...share.applied, share.drag]) expect(c).toBe(0);
    expect(b.reconciled).toBe(true);
  });

  it('under an active limiter every ingredient carries the shared λβ', () => {
    const o = explainOne([-40, -3, 2], [law('c', sum(dir(200), drag(2)))]);
    expect(o.lambda).toBeLessThan(1);
    const [push, resist] = ingredientBreakdown(o, 0)!.ingredients;
    const f = o.lambda * o.beta;
    expectClose(push!.applied, [f * 200, 0, 0], 'push');
    expectClose(resist!.applied, [-40, -3, 2].map((v) => -f * 2 * v), 'drag');
    expectClose(ingredientSum(o, 0), o.contributions[0]!.applied, 'Σ ingredients');
    expectClose(shareSum(o), o.submitted, 'shares');
  });

  it('a triangle gain’s share follows g(n) at each transition’s own tick', () => {
    const tri: Gain = { kind: 'triangle', min: 0, max: 4, periodTicks: 8, phaseTicks: 0 };
    const host = new SimulationHost(scene([sphere('a', ZERO, ZERO)], [law('c', sum(gain(tri, dir(1)), dir(0.5, [0, 1, 0])))], ZERO));
    host.explain('a');
    const seen: number[] = [];
    for (let n = 0; n <= 8; n++) {
      host.step();
      const o = host.explanation!;
      expect(o.fromTick).toBe(n);
      const b = ingredientBreakdown(o, 0)!;
      expect(b.reconciled).toBe(true);
      expect(b.ingredients[0]!.factors).toEqual([{ kind: 'gain', value: [0, 1, 2, 3, 4, 3, 2, 1, 0][n] }]);
      seen.push(b.ingredients[0]!.applied[0]);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
    host.dispose();
  });

  it('a paused edit leaves the last applied split as it was; the next-step preview shows the edit', () => {
    const storm = sum({ kind: 'softRadial', strength: 10, coreRadius: 0.3 }, { kind: 'vortexY', strength: 14, coreRadius: 0.3 }, drag(1.5));
    const host = new SimulationHost(scene([sphere('a', [0.6, 0.2, 0.3], [1, 0, -1])], [law('bottle', storm)]));
    host.explain('a');
    host.step();
    const last = host.explanation!;
    const before = JSON.stringify(ingredientBreakdown(last, 0));
    expect(ingredientBreakdown(last, 0)!.ingredients.map((i) => i.label)).toEqual(['Pull', 'Swirl', 'Drag']);
    // Paused at boundary 1: Drag is removed from the bottle.
    host.submit({ kind: 'putField', field: law('bottle', sum({ kind: 'softRadial', strength: 10, coreRadius: 0.3 }, { kind: 'vortexY', strength: 14, coreRadius: 0.3 })) }, 1);
    host.settleBoundary();
    expect(host.explanation).toBe(last);
    expect(JSON.stringify(ingredientBreakdown(last, 0))).toBe(before);
    expect(ingredientBreakdown(last, 0)!.ingredients[2]!.drag).toBe(1.5);
    const preview = host.previewTransition()!;
    expect(preview.fromTick).toBe(1);
    expect(ingredientBreakdown(preview, 0)!.ingredients.map((i) => i.label)).toEqual(['Pull', 'Swirl']);
    expect(preview.drag).toBe(0);
    host.step();
    const next = host.explanation!;
    expect(JSON.stringify([next.submitted, next.contributions, next.beta, next.lambda])).toBe(JSON.stringify([preview.submitted, preview.contributions, preview.beta, preview.lambda]));
    expect(JSON.stringify(ingredientBreakdown(next, 0))).toBe(JSON.stringify(ingredientBreakdown(preview, 0)));
    host.dispose();
  });

  it('a one-leaf law has no split: it is its own ingredient', () => {
    expect(ingredientBreakdown(explainOne(ZERO, [law('p', dir(3))]), 0)).toBeNull();
  });

  it('contact-rich: every retained step’s ingredients reconcile under the shared factors', () => {
    // 40 colliding bodies dropped into a compound bottle over a floor; the fixture explains the oldest.
    const bodies: BodyDefinition[] = [
      { ...sphere('floor', [0, -2.1, 0], ZERO), type: 'fixed', collider: { kind: 'box', halfExtents: [20, 0.1, 20] }, collisionMode: 'all' } as BodyDefinition,
      ...Array.from({ length: 40 }, (_, i) => sphere(`b${String(i).padStart(2, '0')}`, [((i % 5) - 2) * 0.3, 0.5 + Math.floor(i / 5) * 0.3, ((i * 7) % 5 - 2) * 0.3], [0, 0, 0], 1, 'all')),
    ];
    const bottle = law('bottle', sum({ kind: 'softRadial', strength: 12, coreRadius: 0.3 }, gain({ kind: 'triangle', min: 0, max: 2, periodTicks: 120, phaseTicks: 0 }, { kind: 'vortexY', strength: 14, coreRadius: 0.3 }), boxMask([3, 1, 3], drag(3))));
    const result = explanationFixture(scene(bodies, [bottle]), [], 600);
    expect(result.pass).toBe(true);
    expect(result.contactSteps).toBeGreaterThan(100);
    expect(result.ingredientChecks).toBe(result.steps);
    expect(result.unreconciled).toBe(0);
    expect(result.worstIngredientRatio).toBeLessThanOrEqual(1);
  });
});
