// T03 for M3: the aggregate affine adapter with real drag (SPEC §9.1). Expected velocities come from
// the frozen-coefficient update v_next = e^{−Kh}·v + (1 − e^{−Kh})/K·A, its K → 0 limit and the
// documented limited update v + h·λ·a*, evaluated here with Math.exp, never with the adapter.
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, validateField, type BodyDefinition, type FieldDefinition, type Primitive, type RegionDefinition, type SceneDefinition, type Vec3 } from '../src/domain/scene';
import { adaptAcceleration, dragFactor } from '../src/simulation/adapter';
import { SimulationHost, initSimulation, type CanonicalState } from '../src/simulation/host';

const H = 1 / 120;
const G: Vec3 = [0, -9.81, 0];
const ZERO: Vec3 = [0, 0, 0];
const ONE_STEP_TOL = 2e-5;

beforeAll(async () => {
  await initSimulation();
});

// ---------------------------------------------------------------- independent expectations

/** (1 − e^{−z})/z by Math.exp, or by its series where 1 − e^{−z} would cancel; independent of expm1. */
function oneMinusExpOverZ(z: number): number {
  return z < 1e-4 ? 1 - z / 2 + (z * z) / 6 - (z * z * z) / 24 : (1 - Math.exp(-z)) / z;
}

/** SPEC §9.1 frozen-coefficient free-space update. */
function frozen(v: Vec3, A: Vec3, K: number, h = H): number[] {
  if (K === 0) return v.map((c, i) => c + h * A[i]!);
  const decay = Math.exp(-K * h);
  return v.map((c, i) => decay * c + h * oneMinusExpOverZ(K * h) * A[i]!);
}

/** The documented limited update: v + h·λ·a* with a* = β(A − Kv), β = (1 − e^{−Kh})/(Kh). */
function limited(v: Vec3, A: Vec3, K: number, cap: number, h = H): number[] {
  const beta = K === 0 ? 1 : oneMinusExpOverZ(K * h);
  const a = A.map((c, i) => beta * (c - K * v[i]!));
  const magnitude = Math.hypot(...a);
  const lambda = magnitude === 0 ? 1 : Math.min(1, cap / magnitude);
  return v.map((c, i) => c + h * lambda * a[i]!);
}

/** One adapter step in f64: v + h·(λ·a*). */
function adapterStep(v: Vec3, A: Vec3, K: number, cap: number, h = H): { next: number[]; beta: number; lambda: number } {
  const out = [0, 0, 0, 0, 0];
  adaptAcceleration(A[0], A[1], A[2], K, v[0], v[1], v[2], h, cap, out);
  return { next: v.map((c, i) => c + h * out[i]!), beta: out[3]!, lambda: out[4]! };
}

function expectWithin(actual: readonly number[], expected: readonly number[], tolerance: number) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `component ${i}: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(tolerance));
}

describe('β(Kh) = −expm1(−Kh)/(Kh)', () => {
  it('is exactly 1 at K = 0 and continuous through tiny positive Kh, without a cut-off', () => {
    expect(dragFactor(0, H)).toBe(1);
    // Series 1 − z/2 + z²/6 − z³/24 + z⁴/120: its next term is below 2e-18 for z ≤ 1e-3.
    for (const z of [5e-324, 1e-300, 1e-20, 1e-16, 1e-12, 1e-8, 1e-6, 1e-4, 1e-3]) {
      const beta = dragFactor(z / H, H);
      const series = 1 - z / 2 + (z * z) / 6 - (z * z * z) / 24 + (z * z * z * z) / 120;
      expect(Math.abs(beta - series), `z = ${z}`).toBeLessThanOrEqual(2e-16);
      expect(beta).toBeLessThanOrEqual(1);
    }
  });

  it('needs expm1: the naive (1 − e^{−z})/z loses about eight digits at z = 1e-11', () => {
    const z = 1e-11;
    const series = 1 - z / 2;
    expect(Math.abs((1 - Math.exp(-z)) / z - series)).toBeGreaterThan(1e-8);
    expect(Math.abs(dragFactor(z / H, H) - series)).toBeLessThanOrEqual(2e-16);
  });

  it('is β·z = 1 − e^{−z} for ordinary and large z, and decreases monotonically', () => {
    let previous = 1;
    for (const z of [0.001, 0.01, 1 / 60, 0.5, 5 / 6, 1, 4, 16, 26.67, 100]) {
      const beta = dragFactor(z / H, H);
      expect(Math.abs(beta * z - (1 - Math.exp(-z)))).toBeLessThanOrEqual(1e-15);
      expect(beta).toBeLessThan(previous);
      previous = beta;
    }
  });
});

describe('T03 adapter algebra (pure)', () => {
  it('K = 0 leaves the drive total exactly: a* = A, β = 1', () => {
    const { next, beta, lambda } = adapterStep([1, 2, -3], [12, -9.81, 0], 0, 200);
    expect(beta).toBe(1);
    expect(lambda).toBe(1);
    expectWithin(next, [1 + H * 12, 2 - H * 9.81, -3], 1e-15);
  });

  it('unlimited K = 2 sends v = 10 to 10·e^{−2h} in one step', () => {
    expectWithin(adapterStep([10, 0, 0], ZERO, 2, 200).next, [10 * Math.exp(-2 * H), 0, 0], 1e-13);
  });

  it('drive with drag follows the frozen-coefficient update', () => {
    const v: Vec3 = [1, 2, -3];
    const A: Vec3 = [12, -9.81, 4];
    for (const K of [1e-9, 0.5, 2, 5, 30]) expectWithin(adapterStep(v, A, K, 200).next, frozen(v, A, K), 1e-12);
  });

  it('K = 100, v = 10, no drive, cap 200 gives 8.333333333333334 m/s, not the unlimited exponential', () => {
    const { next, lambda } = adapterStep([10, 0, 0], ZERO, 100, 200);
    expect(lambda).toBeLessThan(1);
    expectWithin(next, [8.333333333333334, 0, 0], 1e-12);
    expect(Math.abs(next[0]! - 10 * Math.exp(-100 * H))).toBeGreaterThan(1);
  });

  it('pure drag never reverses or speeds up a velocity, over coefficients up to 32 overlapping 100 s⁻¹ laws and every cap', () => {
    const directions: Vec3[] = [[1, 0, 0], [0.6, -0.8, 0], [-0.3, 0.4, -0.866]];
    for (const speed of [1e-9, 1e-3, 0.1, 1, 10, 100, 349]) {
      for (const d of directions) {
        const v = d.map((c) => c * speed) as unknown as Vec3;
        for (const K of [1e-12, 0.1, 2, 10, 100, 500, 1000, 3200]) {
          for (const cap of [1, 50, 200]) {
            const { next } = adapterStep(v, ZERO, K, cap);
            const dot = next[0]! * v[0] + next[1]! * v[1] + next[2]! * v[2];
            expect(dot, `reversal at |v| ${speed}, K ${K}, cap ${cap}`).toBeGreaterThanOrEqual(0);
            next.forEach((c, i) => expect(Math.abs(c)).toBeLessThanOrEqual(Math.abs(v[i]!)));
            expect(Math.hypot(...next)).toBeLessThanOrEqual(Math.hypot(...v));
          }
        }
      }
    }
  });

  it('limited and unlimited cases both match the documented update', () => {
    const cases: [Vec3, Vec3, number, number][] = [
      [[1, 2, -3], [12, -9.81, 0], 2, 200], // inactive
      [[5, 0, 0], [180, -9.81, 0], 2, 200], // drive near the cap
      [[60, -5, 0], [0, -9.81, 0], 10, 200], // drag-dominated, active
      [[0, 0, 0], [300, 0, 0], 3, 50], // drive beyond a low cap
    ];
    for (const [v, A, K, cap] of cases) expectWithin(adapterStep(v, A, K, cap).next, limited(v, A, K, cap), 1e-12);
  });

  it('per-law contributions λβ(A_i − K_i·v) plus λβg sum to the submitted acceleration, limiter active or not', () => {
    const v: Vec3 = [40, -3, 2];
    const laws: { A: Vec3; K: number }[] = [
      { A: [150, 0, 0], K: 0 },
      { A: [0, 0, -30], K: 2 },
      { A: ZERO, K: 3 },
    ];
    for (const cap of [200, 10]) {
      const A = laws.reduce<number[]>((sum, l) => sum.map((c, i) => c + l.A[i]!), [...G]) as unknown as Vec3;
      const K = laws.reduce((sum, l) => sum + l.K, 0);
      const out = [0, 0, 0, 0, 0];
      adaptAcceleration(A[0], A[1], A[2], K, v[0], v[1], v[2], H, cap, out);
      const [beta, lambda] = [out[3]!, out[4]!];
      const parts = laws.map((l) => l.A.map((c, i) => lambda * beta * (c - l.K * v[i]!)));
      parts.push(G.map((c) => lambda * beta * c));
      const total = parts.reduce((sum, p) => sum.map((c, i) => c + p[i]!), [0, 0, 0]);
      expectWithin(total, out.slice(0, 3), 1e-12 * Math.hypot(...out.slice(0, 3)) + 1e-12);
      if (cap === 10) expect(lambda).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------- the host and the pinned engine

const sphere = (id: string, position: Vec3, linearVelocity: Vec3, massKg = 1): BodyDefinition => ({
  id,
  type: 'dynamic',
  massKg,
  initialPose: { position, rotation: [0, 0, 0, 1] },
  initialLinearVelocity: linearVelocity,
  initialAngularVelocity: ZERO,
  collider: { kind: 'sphere', radius: 0.08 },
  material: { friction: 0.6, restitution: 0.25 },
  collisionMode: 'fixedOnly',
});

/** A law whose full-strength core is a 15 m cube around `center`. */
function law(id: string, expression: Primitive, center: Vec3 = ZERO, enabled = true, region: RegionDefinition = { kind: 'box', halfExtents: [20, 20, 20] }): FieldDefinition {
  const result = validateField({ id, enabled, pose: { position: center, rotation: [0, 0, 0, 1] }, region, edgeFade: 0.25, expression });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const drag = (id: string, coefficient: number, center?: Vec3) => law(id, { kind: 'linearDrag', coefficient }, center);
const push = (id: string, strength: number, direction: Vec3 = [1, 0, 0]) => law(id, { kind: 'directional', direction, strength });

function scene(bodies: BodyDefinition[], fields: FieldDefinition[], ambient: Vec3 = G, cap = 200): SceneDefinition {
  return cloneFrozen({ ...STARTING_RECIPE, simulation: { ...STARTING_RECIPE.simulation, ambientAcceleration: ambient, maxAppliedAcceleration: cap }, bodies, emitters: [], fields });
}
const bodyState = (state: CanonicalState, id: string) => state.bodies.find((b) => b.id === id)!;
const velocity = (host: SimulationHost, id = 'a') => bodyState(host.canonicalState(), id).linvel;

function oneStep(bodies: BodyDefinition[], fields: FieldDefinition[], ambient: Vec3 = G, cap = 200) {
  const host = new SimulationHost(scene(bodies, fields, ambient, cap));
  host.step();
  const v = velocity(host);
  host.dispose();
  return v;
}

describe('T03 drag through the host and the engine', () => {
  it('K = 2 alone sends v = 10 to 10·e^{−2h}', () => {
    expectWithin(oneStep([sphere('a', ZERO, [10, 0, 0])], [drag('d', 2)], ZERO), frozen([10, 0, 0], ZERO, 2), ONE_STEP_TOL);
  });

  it('overlapping K = 2 and K = 3 laws agree exactly with one K = 5 law, whatever their IDs', () => {
    const v0: Vec3 = [10, -2, 4];
    const two = oneStep([sphere('a', ZERO, v0)], [drag('a-drag', 2), drag('b-drag', 3)], ZERO);
    const swapped = oneStep([sphere('a', ZERO, v0)], [drag('a-drag', 3), drag('b-drag', 2)], ZERO);
    const five = oneStep([sphere('a', ZERO, v0)], [drag('only', 5)], ZERO);
    expect(two).toEqual(five); // the same K, β and force, bit for bit
    expect(swapped).toEqual(five);
    expectWithin(five, frozen(v0, ZERO, 5), ONE_STEP_TOL);
  });

  it('drive, gravity and two drags combine once: e^{−5h}v + (1 − e^{−5h})/5·(g + A)', () => {
    const v0: Vec3 = [1, 2, -3];
    const fields = [push('p', 12), drag('d1', 2), drag('d2', 3)];
    expectWithin(oneStep([sphere('a', ZERO, v0)], fields), frozen(v0, [12, G[1], 0], 5), ONE_STEP_TOL);
  });

  it('gravity is applied once under drag: from rest, v = (1 − e^{−2h})/2·g', () => {
    expectWithin(oneStep([sphere('a', ZERO, ZERO)], [drag('d', 2)]), frozen(ZERO, G, 2), ONE_STEP_TOL);
  });

  it('opposite drives cancel exactly; only gravity remains', () => {
    const v = oneStep([sphere('a', ZERO, [1, 0, 0])], [push('east', 12, [1, 0, 0]), push('west', 12, [-1, 0, 0])]);
    expectWithin(v, [1, H * G[1], 0], ONE_STEP_TOL);
  });

  it('K = 100, v = 10, no drive, cap 200: the limited update 8.333333333333334 m/s, well inside the engine cap', () => {
    expectWithin(oneStep([sphere('a', ZERO, [10, 0, 0])], [drag('d', 100)], ZERO), [8.333333333333334, 0, 0], ONE_STEP_TOL);
  });

  it('drive plus drag with the limiter active matches v + h·λ·a*', () => {
    const v0: Vec3 = [30, 0, 0];
    const v = oneStep([sphere('a', ZERO, v0)], [push('p', 200), drag('d', 2)]);
    expectWithin(v, limited(v0, [200, G[1], 0], 2, 200), ONE_STEP_TOL);
  });

  it('1 kg and 10 kg bodies gain the same velocity under drag', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, [5, 0, 0], 1), sphere('b', [0, 0, 1], [5, 0, 0], 10)], [drag('d', 2), push('p', 12)]));
    for (let i = 0; i < 120; i++) host.step();
    expectWithin(velocity(host, 'b'), velocity(host, 'a'), 2e-4);
    host.dispose();
  });

  it('removing a drag law clears its contribution at the next step: gravity only', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, [10, 0, 0])], [drag('d', 2)]));
    host.step();
    const before = velocity(host);
    host.submit({ kind: 'removeField', id: 'd' }, 1);
    host.step();
    const after = velocity(host);
    expectWithin(after.map((c, i) => c - before[i]!), [0, H * G[1], 0], ONE_STEP_TOL);
    host.dispose();
  });

  it('pure drag in the engine never reverses or speeds up a body over many steps, including the limited regime', () => {
    // 500 s⁻¹ is five overlapping 100 s⁻¹ laws; one law is bounded at 100.
    for (const [laws, v0] of [[[2], [10, -3, 5]], [[100], [10, -3, 5]], [[100], [300, 0, 0]], [[100, 100, 100, 100, 100], [-40, 20, 0]]] as [number[], Vec3][]) {
      const K = laws.reduce((a, b) => a + b, 0);
      const host = new SimulationHost(scene([sphere('a', ZERO, v0)], laws.map((k, i) => drag(`d${i}`, k)), ZERO));
      let previous = velocity(host);
      for (let i = 0; i < 240; i++) {
        host.step();
        const v = velocity(host);
        expect(Math.hypot(...v), `K ${K} step ${i}`).toBeLessThanOrEqual(Math.hypot(...previous));
        expect(v[0]! * previous[0]! + v[1]! * previous[1]! + v[2]! * previous[2]!).toBeGreaterThanOrEqual(0);
        previous = v;
      }
      host.dispose();
    }
  });

  it('characterizes the f32 engine floor: no reversal through 19 overlapping 100 s⁻¹ laws; beyond, at most one f32 rounding across zero', { timeout: 60_000 }, () => {
    // The adapter's f64 output never reverses (the pure grid above, up to K = 3200). Rapier integrates
    // v + dt·F/m in f32, so once e^{−Kh} falls below f32 precision (~1e-7, Kh ≳ 16) the engine's own
    // rounding can leave a residual about one f32 ulp on the far side of zero. Speed never grows.
    const F32_EPSILON = 2 ** -23;
    for (const n of [1, 5, 10, 16, 19, 21, 24, 32]) {
      const fields = Array.from({ length: n }, (_, i) => law(`d${String(i).padStart(2, '0')}`, { kind: 'linearDrag', coefficient: 100 }, ZERO, true, { kind: 'sphere', radius: 50 }));
      for (const v0 of [[10, 0, 0], [1, 0, 0], [0.5, -0.2, 0.1]] as Vec3[]) {
        const host = new SimulationHost(scene([sphere('a', ZERO, v0)], fields, ZERO));
        let previous: readonly number[] = v0;
        for (let i = 0; i < 12; i++) {
          host.step();
          const v = velocity(host);
          const dot = v[0]! * previous[0]! + v[1]! * previous[1]! + v[2]! * previous[2]!;
          expect(Math.hypot(...v)).toBeLessThanOrEqual(Math.hypot(...previous));
          if (n <= 19) expect(dot, `K ${n * 100} v0 ${v0} step ${i}`).toBeGreaterThanOrEqual(0);
          else v.forEach((c, j) => { if (c * previous[j]! < 0) expect(Math.abs(c)).toBeLessThanOrEqual(F32_EPSILON * Math.hypot(...previous)); });
          previous = v;
        }
        host.dispose();
      }
    }
  });

  it('moving a drag region imparts no velocity: drag is relative to the stationary world, not a moving medium (AC6)', () => {
    // The region sweeps past at 6 m/s (0.05 m per step) with the body inside it; without gravity the body
    // stays exactly at rest, and a moving body's decay does not depend on the region's motion.
    const resting = new SimulationHost(scene([sphere('a', ZERO, ZERO)], [drag('d', 5)], ZERO));
    const moving = new SimulationHost(scene([sphere('a', ZERO, [3, 0, 0])], [drag('d', 5)], ZERO));
    const still = new SimulationHost(scene([sphere('a', ZERO, [3, 0, 0])], [drag('d', 5)], ZERO));
    for (let i = 1; i <= 60; i++) {
      const swept = cloneFrozen(drag('d', 5, [0.05 * i, 0, 0]));
      resting.submit({ kind: 'putField', field: swept }, i);
      moving.submit({ kind: 'putField', field: swept }, i);
      resting.step();
      moving.step();
      still.step();
    }
    expect(velocity(resting)).toEqual([0, 0, 0]);
    expect(velocity(moving)).toEqual(velocity(still)); // the same decay whether the region moves or not
    for (const host of [resting, moving, still]) host.dispose();
  });

  it('engine gravity and built-in damping stay zero; laws add no colliders', () => {
    const host = new SimulationHost(scene([sphere('a', ZERO, [1, 0, 0])], [drag('d', 2), push('p', 12)]));
    host.step();
    const world = RAPIER.World.restoreSnapshot(host.engineSnapshot());
    expect(world.gravity).toEqual({ x: 0, y: 0, z: 0 });
    world.bodies.forEach((b) => {
      expect(b.linearDamping()).toBe(0);
      expect(b.angularDamping()).toBe(0);
    });
    expect(world.colliders.len()).toBe(1); // the one body's collider; the two laws are not colliders
    world.free();
    host.dispose();
  });
});
