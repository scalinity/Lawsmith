// T08 for M4 probes (SPEC §12): collision-free inertial particles under the host's compiled kernel,
// the shared adapter and limiter, and x_next = x + h·v_next; their own seeded stream and arrays.
// Expected motion is hand-derived (β by Math.exp, λ by the documented limit, positions by the
// semi-implicit update); expected births by an inline xorshift32, not the probe code.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, validateField, type BodyDefinition, type FieldDefinition, type Primitive, type RegionDefinition, type SceneDefinition, type Vec3 } from '../src/domain/scene';
import { MAX_PROBES, PROBE_LIFETIME_TICKS, PROBE_MARGIN_M, ProbeField, probePhase } from '../src/observation/probes';
import { SimulationHost, initSimulation } from '../src/simulation/host';

const H = 1 / 120;
const G: Vec3 = [0, -9.81, 0];
const ZERO: Vec3 = [0, 0, 0];

beforeAll(async () => {
  await initSimulation();
});

const tol = (expected: number) => 1e-12 + 1e-12 * Math.abs(expected);
function expectClose(actual: ArrayLike<number>, expected: readonly number[], what: string) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `${what}[${i}]: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(tol(e)));
}

function law(id: string, expression: Primitive, center: Vec3 = ZERO, region: RegionDefinition = { kind: 'box', halfExtents: [20, 20, 20] }, edgeFade = 0.25): FieldDefinition {
  const result = validateField({ id, enabled: true, pose: { position: center, rotation: [0, 0, 0, 1] }, region, edgeFade, expression });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const push = (strength: number, direction: Vec3 = [1, 0, 0], id = 'p') => law(id, { kind: 'directional', direction, strength });
const drag = (coefficient: number, id = 'd') => law(id, { kind: 'linearDrag', coefficient });

function scene(fields: FieldDefinition[], ambient: Vec3 = ZERO, cap = 200, bodies: BodyDefinition[] = []): SceneDefinition {
  return cloneFrozen({ ...STARTING_RECIPE, simulation: { ...STARTING_RECIPE.simulation, ambientAcceleration: ambient, maxAppliedAcceleration: cap }, bodies, emitters: [], fields });
}

/** One probe placed at x with velocity v at the host's tick, then `steps` host and probe steps. */
function single(fields: FieldDefinition[], x: Vec3, v: Vec3, ambient: Vec3 = ZERO, steps = 1, cap = 200) {
  const host = new SimulationHost(scene(fields, ambient, cap));
  const probes = new ProbeField();
  probes.configure({ enabled: true, count: 1, seed: 1 });
  probes.sync(host);
  probes.position.set(x);
  probes.velocity.set(v);
  const states: { x: number[]; v: number[] }[] = [];
  for (let n = 0; n < steps; n++) {
    host.step();
    probes.advance(host);
    expect(probes.live, `probe alive after step ${n + 1}`).toBe(1);
    states.push({ x: [...probes.position.subarray(0, 3)], v: [...probes.velocity.subarray(0, 3)] });
  }
  host.dispose();
  return states;
}

/** v_next = v + h·λ·a*, a* = β(A − Kv); x_next = x + h·v_next. Independent of the adapter. */
function expected(x: Vec3, v: Vec3, A: Vec3, K: number, cap = 200) {
  const beta = K === 0 ? 1 : (1 - Math.exp(-K * H)) / (K * H);
  const a = A.map((c, i) => beta * (c - K * v[i]!));
  const m = Math.hypot(...a);
  const lambda = m === 0 ? 1 : Math.min(1, cap / m);
  const vNext = v.map((c, i) => c + H * lambda * a[i]!);
  return { x: x.map((c, i) => c + H * vNext[i]!), v: vNext, lambda };
}

function xorshift(state: number): number {
  let s = state >>> 0;
  s = (s ^ (s << 13)) >>> 0;
  s = (s ^ (s >>> 17)) >>> 0;
  return (s ^ (s << 5)) >>> 0;
}

describe('T08 probe initialization: its own seeded stream', () => {
  it('draws three values per probe in index order, uniformly in the box around the enabled laws', () => {
    const box = law('b', { kind: 'directional', direction: [1, 0, 0], strength: 12 }, [3, 1, 0], { kind: 'box', halfExtents: [1.5, 2, 1.5] });
    const host = new SimulationHost(scene([box]));
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 5, seed: 0x1234 });
    probes.sync(host);
    const lo = [3 - 1.5 - PROBE_MARGIN_M, 1 - 2 - PROBE_MARGIN_M, -1.5 - PROBE_MARGIN_M];
    const hi = [3 + 1.5 + PROBE_MARGIN_M, 1 + 2 + PROBE_MARGIN_M, 1.5 + PROBE_MARGIN_M];
    let state = 0x1234;
    for (let i = 0; i < 5; i++) {
      for (let c = 0; c < 3; c++) {
        state = xorshift(state);
        expect(probes.position[3 * i + c]).toBe(lo[c]! + (state / 2 ** 32) * (hi[c]! - lo[c]!));
      }
      expect([...probes.velocity.subarray(3 * i, 3 * i + 3)]).toEqual([0, 0, 0]);
    }
    expect(probes.live).toBe(5);
    host.dispose();
  });

  it('the same seed gives the same state, a different seed a different one, every time', () => {
    const run = (seed: number) => {
      const host = new SimulationHost(scene([push(12), drag(2, 'q')], G));
      const probes = new ProbeField();
      probes.configure({ enabled: true, count: MAX_PROBES, seed });
      probes.sync(host);
      for (let n = 0; n < 200; n++) {
        host.step();
        probes.advance(host);
      }
      host.dispose();
      return [...probes.position];
    };
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
  });

  it('count 0 and disabled probes do no work; the default maximum is 2,000 live probes', () => {
    const host = new SimulationHost(scene([push(12)]));
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 0, seed: 1 });
    probes.sync(host);
    host.step();
    probes.advance(host);
    expect([probes.live, probes.version]).toEqual([0, 1]);
    probes.configure({ enabled: false, count: MAX_PROBES, seed: 1 });
    probes.sync(host);
    host.step();
    probes.advance(host);
    expect(probes.live).toBe(0);
    probes.configure({ enabled: true, count: MAX_PROBES, seed: 1 });
    probes.sync(host);
    expect(probes.live).toBe(MAX_PROBES);
    expect(() => probes.configure({ enabled: true, count: MAX_PROBES + 1, seed: 1 })).toThrow();
    expect(() => probes.configure({ enabled: true, count: 10, seed: 0 })).toThrow();
    host.dispose();
  });

  it('no enabled law, nowhere to be born', () => {
    const host = new SimulationHost(scene([{ ...push(12), enabled: false }]));
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 100, seed: 1 });
    probes.sync(host);
    expect(probes.live).toBe(0);
    host.dispose();
  });

  it('each probe is born again on its own schedule: one lifetime, staggered by index', () => {
    const host = new SimulationHost(scene([push(12)]));
    const probes = new ProbeField();
    const count = 400;
    probes.configure({ enabled: true, count, seed: 3 });
    probes.sync(host);
    for (let n = 0; n < 2 * PROBE_LIFETIME_TICKS; n++) {
      host.step();
      probes.advance(host);
    }
    const t = host.tick;
    for (let i = 0; i < count; i++) {
      const phase = probePhase(i, count);
      const last = t - ((((t - phase) % PROBE_LIFETIME_TICKS) + PROBE_LIFETIME_TICKS) % PROBE_LIFETIME_TICKS);
      expect(probes.bornAt[i]).toBe(last);
    }
    host.dispose();
  });
});

describe('T08 probe motion: the shared kernel, adapter and limiter, then x + h·v_next', () => {
  it('pure directional from rest', () => {
    const [s] = single([push(12)], [1, 2, 3], ZERO);
    const e = expected([1, 2, 3], ZERO, [12, 0, 0], 0);
    expectClose(s!.v, e.v, 'v');
    expectClose(s!.x, e.x, 'x');
  });

  it('radial center and vortex axis give exactly zero', () => {
    const radial = law('r', { kind: 'softRadial', strength: 50, coreRadius: 0.25 }, [1, 1, 1], { kind: 'sphere', radius: 5 });
    const [r] = single([radial], [1, 1, 1], ZERO);
    expect(r!.v.map(Math.abs)).toEqual([0, 0, 0]);
    expect(r!.x).toEqual([1, 1, 1]);
    const vortex = law('v', { kind: 'vortexY', strength: 50, coreRadius: 0.25 }, [1, 0, 1], { kind: 'cylinderY', radius: 5, halfHeight: 5 });
    const [w] = single([vortex], [1, 3, 1], ZERO);
    expect(w!.v.map(Math.abs)).toEqual([0, 0, 0]);
  });

  it('soft radial and vortex at r = [1,0,0], ε = 1, s = 2', () => {
    const radial = law('r', { kind: 'softRadial', strength: 2, coreRadius: 1 }, ZERO, { kind: 'sphere', radius: 20 });
    const [r] = single([radial], [1, 0, 0], ZERO);
    expectClose(r!.v, expected([1, 0, 0], ZERO, [-Math.SQRT2, 0, 0], 0).v, 'radial v');
    const vortex = law('v', { kind: 'vortexY', strength: 2, coreRadius: 1 }, ZERO, { kind: 'cylinderY', radius: 20, halfHeight: 20 });
    const [w] = single([vortex], [1, 0, 0], ZERO);
    expectClose(w!.v, expected([1, 0, 0], ZERO, [0, 0, -Math.SQRT2], 0).v, 'vortex v');
  });

  it('pure drag at rest stays exactly at rest: no invented direction', () => {
    const states = single([drag(5)], [0.5, 0.5, 0.5], ZERO, ZERO, 30);
    expect(states).toHaveLength(30);
    for (const s of states) {
      expect(s.v.map(Math.abs)).toEqual([0, 0, 0]);
      expect(s.x).toEqual([0.5, 0.5, 0.5]);
    }
  });

  it('pure drag on a moving probe follows its own velocity: v·e^{−Kh}, two steps', () => {
    const [a, b] = single([drag(2)], ZERO, [10, -4, 1], ZERO, 2);
    const first = expected(ZERO, [10, -4, 1], ZERO, 2);
    expectClose(a!.v, first.v, 'v1');
    expectClose(a!.v, [10, -4, 1].map((c) => c * Math.exp(-2 * H)), 'v1 = v·e^{−Kh}');
    expectClose(a!.x, first.x, 'x1');
    const second = expected(first.x as unknown as Vec3, first.v as unknown as Vec3, ZERO, 2);
    expectClose(b!.v, second.v, 'v2');
    expectClose(b!.x, second.x, 'x2');
  });

  it('overlapping drive, two drags and gravity: the frozen-coefficient update with K = 5', () => {
    const laws = [push(12), drag(2, 'q'), drag(3, 'r')];
    const [rest] = single(laws, ZERO, ZERO, G);
    expectClose(rest!.v, expected(ZERO, ZERO, [12, -9.81, 0], 5).v, 'from rest');
    const v: Vec3 = [1, 2, -3];
    const [moving] = single(laws, ZERO, v, G);
    const e = expected(ZERO, v, [12, -9.81, 0], 5);
    expectClose(moving!.v, e.v, 'moving v');
    expectClose(moving!.x, e.x, 'moving x');
  });

  it('limiter active: a 200 m/s² drive with gravity is scaled to the 200 m/s² cap', () => {
    const [s] = single([push(200)], ZERO, ZERO, G);
    const e = expected(ZERO, ZERO, [200, -9.81, 0], 0);
    expect(e.lambda).toBeLessThan(1);
    expectClose(s!.v, e.v, 'v');
    expect(Math.hypot(...s!.v)).toBeCloseTo(H * 200, 12);
  });

  it('enters and leaves a hard-boundary support: accelerated inside only', () => {
    const slab = law('s', { kind: 'directional', direction: [1, 0, 0], strength: 30 }, ZERO, { kind: 'box', halfExtents: [1, 1, 1] }, 0);
    const states = single([slab], [0.9, 0, 0], [6, 0, 0], ZERO, 6);
    let x: Vec3 = [0.9, 0, 0];
    let v: Vec3 = [6, 0, 0];
    let inside = 0;
    let outside = 0;
    for (const s of states) {
      const within = Math.abs(x[0]) <= 1;
      const e = expected(x, v, within ? [30, 0, 0] : ZERO, 0);
      expectClose(s.v, e.v, `v from x=${x[0]}`);
      expectClose(s.x, e.x, `x from x=${x[0]}`);
      if (within) inside += 1;
      else outside += 1;
      x = s.x as unknown as Vec3;
      v = s.v as unknown as Vec3;
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it('a probe and a body at the same state get the same external acceleration from the host', () => {
    const fields = [push(12), drag(2, 'q'), law('r', { kind: 'softRadial', strength: 8, coreRadius: 0.25 }, [0.5, 0, 0], { kind: 'sphere', radius: 3 })];
    const body: BodyDefinition = {
      id: 'a',
      type: 'dynamic',
      massKg: 1,
      initialPose: { position: [0.25, 0.5, -0.25], rotation: [0, 0, 0, 1] },
      initialLinearVelocity: [3, -1, 0.5],
      initialAngularVelocity: ZERO,
      collider: { kind: 'sphere', radius: 0.08 },
      material: { friction: 0.6, restitution: 0.25 },
      collisionMode: 'fixedOnly',
    };
    const host = new SimulationHost(scene(fields, G, 200, [body]));
    host.explain('a');
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 1, seed: 1 });
    probes.sync(host);
    probes.position.set([0.25, 0.5, -0.25]);
    probes.velocity.set([3, -1, 0.5]);
    host.step();
    probes.advance(host);
    const submitted = host.explanation!.submitted;
    // Exactly: the probe's step is v + h·λa* with the very same λa* the host submitted for the body.
    for (let c = 0; c < 3; c++) expect(probes.velocity[c]).toBe([3, -1, 0.5][c]! + H * submitted[c]!);
    host.dispose();
  });
});
