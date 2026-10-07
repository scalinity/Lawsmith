// T08 for M4, the selected-body explanation (SPEC §9.1, §12): a retained transition holds the
// center, velocity and per-law samples the step actually used, and its contributions λβ(A_i − K_i·v)
// plus λβg sum to the submitted force/mass. Expected values are hand-derived from SPEC §6.2 and §9.1,
// with β by Math.exp, never from the observation code.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, validateField, type BodyDefinition, type FieldDefinition, type Primitive, type RegionDefinition, type SceneDefinition, type Vec3 } from '../src/domain/scene';
import { SimulationHost, initSimulation, type CanonicalState } from '../src/simulation/host';
import type { TransitionObservation } from '../src/simulation/observation';

const H = 1 / 120;
const G: Vec3 = [0, -9.81, 0];
const ZERO: Vec3 = [0, 0, 0];
const ONE_STEP_TOL = 2e-5;

beforeAll(async () => {
  await initSimulation();
});

/** SPEC §17.1 / T03 component tolerance. */
const tol = (expected: number) => 1e-9 + 1e-8 * Math.abs(expected);
function expectClose(actual: readonly number[], expected: readonly number[], what: string) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `${what}[${i}]: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(tol(e)));
}

/** β = (1 − e^{−Kh})/(Kh) by Math.exp, independent of the adapter's expm1. */
const betaOf = (K: number) => (K === 0 ? 1 : (1 - Math.exp(-K * H)) / (K * H));
const lambdaOf = (a: readonly number[], cap = 200) => {
  const m = Math.hypot(...a);
  return m === 0 ? 1 : Math.min(1, cap / m);
};

const sphere = (id: string, position: Vec3, linearVelocity: Vec3, mode: BodyDefinition['collisionMode'] = 'fixedOnly', massKg = 1): BodyDefinition => ({
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
const wall = (id: string, position: Vec3, halfExtents: Vec3): BodyDefinition => ({
  id,
  type: 'fixed',
  initialPose: { position, rotation: [0, 0, 0, 1] },
  initialLinearVelocity: ZERO,
  initialAngularVelocity: ZERO,
  collider: { kind: 'box', halfExtents },
  material: { friction: 0.6, restitution: 0.25 },
  collisionMode: 'all',
});

/** A law whose full-strength core spans 15 m around `center`. */
function law(id: string, expression: Primitive, center: Vec3 = ZERO, region: RegionDefinition = { kind: 'box', halfExtents: [20, 20, 20] }): FieldDefinition {
  const result = validateField({ id, enabled: true, pose: { position: center, rotation: [0, 0, 0, 1] }, region, edgeFade: 0.25, expression });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const push = (id: string, strength: number, direction: Vec3 = [1, 0, 0]) => law(id, { kind: 'directional', direction, strength });
const drag = (id: string, coefficient: number) => law(id, { kind: 'linearDrag', coefficient });

function scene(bodies: BodyDefinition[], fields: FieldDefinition[], ambient: Vec3 = G, cap = 200): SceneDefinition {
  return cloneFrozen({ ...STARTING_RECIPE, simulation: { ...STARTING_RECIPE.simulation, ambientAcceleration: ambient, maxAppliedAcceleration: cap }, bodies, emitters: [], fields });
}
const bodyOf = (state: CanonicalState, id: string) => state.bodies.find((b) => b.id === id)!;

/** One explained step of body `a` from tick 0. */
function explainOne(body: BodyDefinition, fields: FieldDefinition[], ambient: Vec3 = G, cap = 200): TransitionObservation {
  const host = new SimulationHost(scene([body], fields, ambient, cap));
  host.explain('a');
  host.step();
  const observation = host.explanation!;
  host.dispose();
  return observation;
}

function sumOf(o: TransitionObservation): number[] {
  const sum = [...o.gravityApplied];
  for (const c of o.contributions) for (let i = 0; i < 3; i++) sum[i]! += c.applied[i]!;
  return sum;
}

/** Every retained-transition invariant that does not depend on the case. */
function expectConsistent(o: TransitionObservation) {
  expect(o.kind).toBe('applied');
  expect(o.toTick).toBe(o.fromTick + 1);
  // Contributions plus gravity are the submitted acceleration, and that is the submitted force / mass.
  expectClose(sumOf(o), o.submitted, 'Σ contributions + gravity');
  expectClose(o.force.map((f) => f / o.mass), o.submitted, 'force / mass');
}

describe('T08 retained transition: contributions sum to the submitted force/mass (T03 tolerance)', () => {
  it('directional: λβ = 1, the law contributes its drive and gravity its own', () => {
    const o = explainOne(sphere('a', ZERO, [1, 2, -3]), [push('p', 12)]);
    expectConsistent(o);
    expect([o.fromTick, o.toTick, o.cursor]).toEqual([0, 1, 0]);
    expect(o.center).toEqual([0, 0, 0]);
    expect(o.velocity).toEqual([1, 2, -3]);
    expect(o.contributions.map((c) => c.id)).toEqual(['p']);
    expect([o.beta, o.lambda]).toEqual([1, 1]);
    expectClose(o.contributions[0]!.applied, [12, 0, 0], 'push');
    expectClose(o.gravityApplied, G, 'gravity');
    expectClose(o.submitted, [12, -9.81, 0], 'submitted');
  });

  it('soft radial at r = [1,0,0], ε = 1, s = 2 contributes [−√2, 0, 0]', () => {
    const radial = law('r', { kind: 'softRadial', strength: 2, coreRadius: 1 }, ZERO, { kind: 'sphere', radius: 20 });
    const o = explainOne(sphere('a', [1, 0, 0], ZERO), [radial], ZERO);
    expectConsistent(o);
    expectClose(o.contributions[0]!.drive, [-Math.SQRT2, 0, 0], 'A_r');
    expectClose(o.contributions[0]!.applied, [-Math.SQRT2, 0, 0], 'radial');
  });

  it('vortex at r = [1,0,0], ε = 1, s = 2 contributes [0, 0, −√2]', () => {
    const vortex = law('v', { kind: 'vortexY', strength: 2, coreRadius: 1 }, ZERO, { kind: 'cylinderY', radius: 20, halfHeight: 20 });
    const o = explainOne(sphere('a', [1, 0, 0], ZERO), [vortex], ZERO);
    expectConsistent(o);
    expectClose(o.contributions[0]!.applied, [0, 0, -Math.SQRT2], 'vortex');
  });

  it('drag K = 2 at v = [10,0,0]: β(2h)·(−2v), the velocity it used named beside it', () => {
    const o = explainOne(sphere('a', ZERO, [10, 0, 0]), [drag('d', 2)], ZERO);
    expectConsistent(o);
    expect(o.velocity).toEqual([10, 0, 0]);
    expect(o.contributions[0]!.drag).toBe(2);
    expect(o.contributions[0]!.drive).toEqual([0, 0, 0]);
    expectClose([o.beta], [betaOf(2)], 'β');
    expectClose(o.contributions[0]!.applied, [-20 * betaOf(2), 0, 0], 'drag');
  });

  it('overlapping drag K = 2 and K = 3 share β(5h): each share differs from that law acting alone', () => {
    const v: Vec3 = [10, 0, 0];
    const o = explainOne(sphere('a', ZERO, v), [drag('d2', 2), drag('d3', 3)], ZERO);
    expectConsistent(o);
    expect(o.drag).toBe(5);
    expectClose([o.beta], [betaOf(5)], 'β');
    expectClose(o.contributions[0]!.applied, [-20 * betaOf(5), 0, 0], 'd2');
    expectClose(o.contributions[1]!.applied, [-30 * betaOf(5), 0, 0], 'd3');
    // Not a counterfactual: d2's share under the total β is not what d2 alone would apply.
    const alone = explainOne(sphere('a', ZERO, v), [drag('d2', 2)], ZERO);
    expect(Math.abs(alone.contributions[0]!.applied[0] - o.contributions[0]!.applied[0])).toBeGreaterThan(1e-3);
  });

  it('drive with drag and gravity: every share carries the same β(Kh)', () => {
    const v: Vec3 = [1, 2, -3];
    const o = explainOne(sphere('a', ZERO, v), [push('p', 12), drag('q', 2)]);
    expectConsistent(o);
    const b = betaOf(2);
    expectClose(o.contributions[0]!.applied, [12 * b, 0, 0], 'push');
    expectClose(o.contributions[1]!.applied, v.map((c) => -2 * c * b), 'drag');
    expectClose(o.gravityApplied, G.map((c) => c * b), 'gravity');
    expectClose(o.instantaneous, [12 - 2 * 1, -9.81 - 2 * 2, 0 - 2 * -3], 'A − Kv');
  });

  it('limiter active, K = 100 at v = 10 with cap 200: λ < 1 scales every share, and the total is 200 m/s²', () => {
    const o = explainOne(sphere('a', ZERO, [10, 0, 0]), [drag('d', 100)], ZERO, 200);
    expectConsistent(o);
    const b = betaOf(100);
    const lambda = lambdaOf([-1000 * b, 0, 0]);
    expect(lambda).toBeLessThan(1);
    expectClose([o.lambda], [lambda], 'λ');
    expectClose(o.submitted, [-200, 0, 0], 'submitted');
    expectClose(o.contributions[0]!.applied, [-1000 * b * lambda, 0, 0], 'drag');
  });

  it('limiter active with a drive, a drag and gravity: the shares use the same λβ as the total', () => {
    // Moving against the push, so the drag adds to it: |a*| ≈ 280 m/s² against the 200 cap.
    const v: Vec3 = [-40, -3, 2];
    const o = explainOne(sphere('a', ZERO, v), [push('p', 200), drag('q', 2)]);
    expectConsistent(o);
    const b = betaOf(2);
    const unlimited = [200 + 2 * 40, -9.81 + 6, -4].map((c) => c * b);
    const lambda = lambdaOf(unlimited);
    expect(lambda).toBeLessThan(0.75);
    expectClose([o.lambda], [lambda], 'λ');
    expectClose(o.contributions[0]!.applied, [200 * b * lambda, 0, 0], 'push');
    expectClose(o.contributions[1]!.applied, v.map((c) => -2 * c * b * lambda), 'drag');
    expectClose(o.gravityApplied, G.map((c) => c * b * lambda), 'gravity');
  });

  it('pure drag on a body at rest contributes exactly zero: no direction is invented', () => {
    const o = explainOne(sphere('a', ZERO, ZERO), [drag('d', 2)], ZERO);
    expectConsistent(o);
    expect(o.velocity).toEqual([0, 0, 0]);
    for (const c of o.contributions[0]!.applied) expect(Math.abs(c)).toBe(0);
    for (const c of o.submitted) expect(Math.abs(c)).toBe(0);
    // With gravity the drag still shares nothing at rest, yet its K lowers β for gravity's share.
    const g = explainOne(sphere('a', ZERO, ZERO), [drag('d', 2)]);
    for (const c of g.contributions[0]!.applied) expect(Math.abs(c)).toBe(0);
    expectClose(g.gravityApplied, G.map((c) => c * betaOf(2)), 'gravity under drag');
  });
});

describe('T08 retained transition: each quantity comes from its own state', () => {
  it('center and velocity are the boundary state at fromTick; `after` is the state at toTick', () => {
    const host = new SimulationHost(scene([sphere('a', [-1, 0, 0], [3, 1, 0])], [push('p', 12), drag('q', 1.5)]));
    host.explain('a');
    for (let n = 0; n < 40; n++) {
      const before = bodyOf(host.canonicalState(), 'a');
      host.step();
      const after = bodyOf(host.canonicalState(), 'a');
      const o = host.explanation!;
      expect([o.fromTick, o.toTick]).toEqual([n, n + 1]);
      expect(o.center).toEqual(before.translation);
      expect(o.velocity).toEqual(before.linvel);
      expect(o.after!.center).toEqual(after.translation);
      expect(o.after!.velocity).toEqual(after.linvel);
      // Velocity is m/s and the submitted acceleration m/s²: free of contact, one step relates them.
      after.linvel.forEach((c, i) => expect(Math.abs(c - (before.linvel[i]! + H * o.submitted[i]!))).toBeLessThanOrEqual(ONE_STEP_TOL));
      expect(o.contacts).toEqual([]);
    }
    host.dispose();
  });

  it('records the cursor and the exact law values applied at that boundary', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, ZERO)], [push('p', 12)]));
    host.explain('a');
    host.step();
    const stronger = push('p', 30);
    host.submit({ kind: 'putField', field: stronger }, 1);
    host.step();
    const o = host.explanation!;
    expect([o.fromTick, o.cursor]).toEqual([1, 1]);
    expect(o.laws).toEqual([stronger]);
    expectClose(o.contributions[0]!.applied, [30, 0, 0], 'push after the edit');
    host.dispose();
  });

  it('selecting another body keeps the old observation under its own body until that body completes a step', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, ZERO), sphere('b', [2, 0, 0], ZERO)], [push('p', 12)]));
    host.explain('a');
    host.step();
    const first = host.explanation!;
    host.explain('b');
    expect(host.explanation).toBe(first);
    expect(first.bodyId).toBe('a');
    host.step();
    expect(host.explanation!.bodyId).toBe('b');
    expect(host.explanation!.fromTick).toBe(1);
    host.explain(null);
    host.step();
    expect(host.explanation!.fromTick).toBe(1);
    host.dispose();
  });

  it('a reset clears the observation of the previous world', () => {
    const root = scene([sphere('a', ZERO, ZERO)], [push('p', 12)]);
    const host = new SimulationHost(root);
    host.explain('a');
    host.step();
    const generation = host.generation;
    host.reset(root);
    expect(host.explanation).toBeNull();
    expect(host.generation).not.toBe(generation);
    host.dispose();
  });
});

describe('T08 paused next-step preview', () => {
  it('a paused edit changes the preview but never the last-applied observation', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, [1, 0, 0])], [push('p', 12), drag('q', 2)]));
    host.explain('a');
    for (let n = 0; n < 10; n++) host.step();
    const applied = host.explanation!;
    const frozenJson = JSON.stringify(applied);
    const before = JSON.stringify(host.canonicalState());
    const engine = host.engineSnapshot();

    const preview = host.previewTransition()!;
    expect(preview.kind).toBe('preview');
    expect([preview.fromTick, preview.toTick]).toEqual([10, 11]);
    expect(preview.after).toBeNull();
    expect(preview.contacts).toBeNull();
    expectClose(sumOf(preview), preview.submitted, 'preview Σ');

    // A paused edit settles at boundary 10 without advancing.
    host.submit({ kind: 'putField', field: push('p', 40) }, 1);
    host.settleBoundary();
    const edited = host.previewTransition()!;
    expect(edited.cursor).toBe(1);
    expect(Math.abs(edited.contributions[0]!.applied[0] - preview.contributions[0]!.applied[0])).toBeGreaterThan(1);
    expect(host.explanation).toBe(applied);
    expect(JSON.stringify(host.explanation)).toBe(frozenJson);
    // Previewing writes nothing: same tick, same bodies, same engine bytes.
    expect(host.tick).toBe(10);
    const after = JSON.parse(JSON.stringify(host.canonicalState())) as CanonicalState;
    expect(after.bodies).toEqual((JSON.parse(before) as CanonicalState).bodies);
    expect(host.engineSnapshot()).toEqual(engine);

    // The next step submits exactly what the preview showed.
    host.step();
    const next = host.explanation!;
    expect(next.fromTick).toBe(10);
    expect(next.submitted).toEqual(edited.submitted);
    expect(next.contributions).toEqual(edited.contributions);
    expect(next.gravityApplied).toEqual(edited.gravityApplied);
    expect([next.beta, next.lambda]).toEqual([edited.beta, edited.lambda]);
    host.dispose();
  });

  it('has no preview without an explained living body', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, ZERO)], []));
    expect(host.previewTransition()).toBeNull();
    host.explain('nobody');
    expect(host.previewTransition()).toBeNull();
    host.dispose();
  });
});

describe('T08 contacts stay separate from the external law acceleration', () => {
  it('a bounce on the floor: the submitted acceleration is gravity alone, the contact is named, and it cannot predict the outcome', () => {
    const host = new SimulationHost(scene([STARTING_RECIPE.bodies[0]!, sphere('a', [0, -1.5, 0], [0, -0.5, 0])], []));
    host.explain('a');
    let contact: TransitionObservation | null = null;
    let free = 0;
    for (let n = 0; n < 60 && !contact; n++) {
      host.step();
      const o = host.explanation!;
      expectConsistent(o);
      expectClose(o.submitted, G, 'submitted');
      if (o.contacts!.length) contact = o;
      else {
        free += 1;
        o.after!.velocity.forEach((c, i) => expect(Math.abs(c - (o.velocity[i]! + H * o.submitted[i]!))).toBeLessThanOrEqual(ONE_STEP_TOL));
      }
    }
    expect(free).toBeGreaterThan(10);
    expect(contact!.contacts).toEqual(['floor']);
    // The external acceleration is unchanged by the contact, and alone it predicts the wrong velocity.
    expectClose(contact!.submitted, G, 'submitted at contact');
    const predicted = contact!.velocity[1] + H * contact!.submitted[1];
    expect(contact!.after!.velocity[1] - predicted).toBeGreaterThan(0.5);
    host.dispose();
  });

  it('a law pushing a body into a wall: its share is the law value while the contact turns the body back', () => {
    const host = new SimulationHost(scene([wall('wall', [1, 0, 0], [0.1, 2, 2]), sphere('a', [0, 0, 0], [6, 0, 0])], [push('p', 20)], ZERO));
    host.explain('a');
    let contact: TransitionObservation | null = null;
    for (let n = 0; n < 60 && !contact; n++) {
      host.step();
      if (host.explanation!.contacts!.length) contact = host.explanation!;
    }
    expect(contact!.contacts).toEqual(['wall']);
    expectConsistent(contact!);
    expectClose(contact!.contributions[0]!.applied, [20, 0, 0], 'push at contact');
    expect(contact!.after!.velocity[0]).toBeLessThan(contact!.velocity[0] + H * contact!.submitted[0]);
    host.dispose();
  });

  it('body against body: the partner is named by its stable ID', () => {
    const host = new SimulationHost(scene([sphere('a', [-0.3, 0, 0], [3, 0, 0], 'all'), sphere('b', [0.3, 0, 0], [-3, 0, 0], 'all')], [], ZERO));
    host.explain('a');
    let partners: readonly string[] = [];
    for (let n = 0; n < 30 && !partners.length; n++) {
      host.step();
      partners = host.explanation!.contacts!;
    }
    expect(partners).toEqual(['b']);
    host.dispose();
  });

  it('explaining a body, its contacts included, leaves the engine bytes and state of an unexplained run', () => {
    const root = scene([STARTING_RECIPE.bodies[0]!, sphere('a', [0, -1.5, 0], [0, -0.5, 0]), sphere('b', [0.05, -1.2, 0], [0, 0, 0], 'all')], [push('p', 3)]);
    const plain = new SimulationHost(root);
    const watched = new SimulationHost(root);
    watched.explain('a');
    for (let n = 0; n < 240; n++) {
      plain.step();
      watched.step();
      if (n % 17 === 0) watched.previewTransition();
    }
    expect(watched.canonicalState()).toEqual(plain.canonicalState());
    expect(watched.engineSnapshot()).toEqual(plain.engineSnapshot());
    plain.dispose();
    watched.dispose();
  });
});
