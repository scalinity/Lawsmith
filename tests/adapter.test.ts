// T03 (force adapter, M1's K=0 cases) and SPEC §17.1's collision-free constant-acceleration
// fixture. Expected motion comes from v = v0 + hA and p = p0 + v0·T + ½AT², not from the field code.
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  STARTING_RECIPE,
  cloneFrozen,
  type BodyDefinition,
  type FieldDefinition,
  type SceneDefinition,
  type Vec3,
} from '../src/domain/scene';
import { limitAcceleration } from '../src/simulation/adapter';
import { MAX_SUPPORTED_SPEED, SIMULATION_PROFILE, SimulationHost, initSimulation, type CanonicalState } from '../src/simulation/host';

const H = 1 / 120;
const G: Vec3 = [0, -9.81, 0];
const ONE_STEP_TOL = 2e-5;

beforeAll(async () => {
  await initSimulation();
});

const sphere = (id: string, position: Vec3, linearVelocity: Vec3, massKg = 1): BodyDefinition => ({
  id,
  type: 'dynamic',
  massKg,
  position,
  linearVelocity,
  collider: { kind: 'sphere', radius: 0.08 },
  material: { friction: 0.6, restitution: 0.25 },
  collisionMode: 'fixedOnly',
});

/** A directional law whose full-strength core (d ≤ 0.75) is a 15 m cube around `center`. */
const law = (strength: number, center: Vec3 = [0, 0, 0], enabled = true): FieldDefinition => ({
  id: 'push',
  enabled,
  pose: { position: center, rotation: [0, 0, 0, 1] },
  region: { kind: 'box', halfExtents: [20, 20, 20] },
  edgeFade: 0.25,
  expression: { kind: 'directional', direction: [1, 0, 0], strength },
});

const scene = (bodies: BodyDefinition[], fields: FieldDefinition[]): SceneDefinition =>
  cloneFrozen({ ...STARTING_RECIPE, bodies, emitters: [], fields });

const bodyState = (state: CanonicalState, id: string) => state.bodies.find((b) => b.id === id)!;
const velocity = (host: SimulationHost, id = 'a') => bodyState(host.canonicalState(), id).linvel;

function expectWithin(actual: readonly number[], expected: readonly number[], tolerance: number | readonly number[]) {
  expected.forEach((e, i) => {
    const t = typeof tolerance === 'number' ? tolerance : tolerance[i]!;
    expect(Math.abs(actual[i]! - e), `component ${i}: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(t);
  });
}

describe('T03 force adapter (K = 0)', () => {
  it('applies ambient gravity exactly once (engine gravity is zero)', () => {
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [0, 0, 0])], []));
    host.step();
    expectWithin(velocity(host), [0, H * G[1], 0], ONE_STEP_TOL); // double gravity would give 2hg
    host.dispose();
  });

  it('K=0 one-step update is v_next = v + h·A', () => {
    const v0: Vec3 = [1, 2, -3];
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], v0)], [law(12)]));
    host.step();
    expectWithin(velocity(host), [v0[0] + H * 12, v0[1] + H * G[1], v0[2]], ONE_STEP_TOL);
    host.dispose();
  });

  it('1 kg and 10 kg bodies gain the same free-space velocity', () => {
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [0, 0, 0], 1), sphere('b', [0, 0, 1], [0, 0, 0], 10)], [law(12)]));
    host.step();
    const expected = [H * 12, H * G[1], 0];
    expectWithin(velocity(host, 'a'), expected, ONE_STEP_TOL);
    expectWithin(velocity(host, 'b'), expected, ONE_STEP_TOL);
    for (let i = 1; i < 120; i++) host.step();
    expectWithin(velocity(host, 'b'), velocity(host, 'a'), 2e-4);
    host.dispose();
  });

  it('a fixed body inside the law is unaffected', () => {
    const fixed: BodyDefinition = {
      id: 'block',
      type: 'fixed',
      position: [0.5, 0, 0],
      linearVelocity: [0, 0, 0],
      collider: { kind: 'box', halfExtents: [0.2, 0.2, 0.2] },
      material: { friction: 0.6, restitution: 0.25 },
      collisionMode: 'all',
    };
    const host = new SimulationHost(scene([fixed], [law(12)]));
    for (let i = 0; i < 60; i++) host.step();
    const world = RAPIER.World.restoreSnapshot(host.engineSnapshot());
    const bodies: RAPIER.RigidBody[] = [];
    world.bodies.forEach((b) => bodies.push(b));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.isFixed()).toBe(true);
    expect(bodies[0]!.translation()).toEqual({ x: 0.5, y: 0, z: 0 });
    expect(bodies[0]!.userForce()).toEqual({ x: 0, y: 0, z: 0 });
    world.free();
    host.dispose();
  });

  it('clears the previous force every step (fails if persistent force is not cleared)', () => {
    // Rapier keeps added forces until reset. Without clearing, step k would apply k forces.
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [0, 0, 0])], [law(12)]));
    host.step();
    host.step();
    expectWithin(velocity(host), [2 * H * 12, 2 * H * G[1], 0], ONE_STEP_TOL);
    // Disable the law at boundary 2: the next step carries gravity only, with no stale drive.
    const before = velocity(host);
    host.submit({ kind: 'putField', field: cloneFrozen(law(12, [0, 0, 0], false)) }, 1);
    host.step();
    const after = velocity(host);
    expectWithin([after[0]! - before[0]!, after[1]! - before[1]!, after[2]! - before[2]!], [0, H * G[1], 0], ONE_STEP_TOL);
    host.dispose();
  });

  it('a body the law leaves keeps its velocity and receives no stale drive', () => {
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [0, 0, 0])], [law(12)]));
    for (let i = 0; i < 30; i++) host.step();
    const acquired = velocity(host);
    expect(acquired[0]!).toBeGreaterThan(2.9); // 30 h · 12 = 3 m/s
    // Move the law far away: the body is now outside its support.
    host.submit({ kind: 'putField', field: cloneFrozen(law(12, [500, 0, 0])) }, 1);
    host.step();
    const after = velocity(host);
    expectWithin(after, [acquired[0]!, acquired[1]! + H * G[1], acquired[2]!], ONE_STEP_TOL);
    host.dispose();
  });

  it('the limiter scales the whole external acceleration, gravity included', () => {
    // a* = [200, −9.81, 0], |a*| = 200.2404…, so λ = 200/|a*| < 1.
    const aStar = [200, G[1], 0];
    const lambda = 200 / Math.hypot(200, G[1]);
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [0, 0, 0])], [law(200)]));
    host.step();
    expectWithin(velocity(host), aStar.map((c) => H * lambda * c), ONE_STEP_TOL);
    host.dispose();
  });

  it('limiter decomposition: gravity and law components sum to the submitted acceleration', () => {
    const out = [0, 0, 0];
    const lambda = limitAcceleration(200, G[1], 0, 200, out);
    const parts = [lambda * 0 + lambda * 200, lambda * G[1] + lambda * 0, 0];
    expectWithin(out, parts, 1e-12);
    expect(limitAcceleration(0, 0, 0, 200, out)).toBe(1);
    expect(out).toEqual([0, 0, 0]);
    expect(limitAcceleration(12, G[1], 0, 200, out)).toBe(1);
    expect(out).toEqual([12, G[1], 0]);
  });
});

describe('SPEC §17.1 constant-acceleration fixture', () => {
  it('one second from v0 = [1,0,0] under A = [2,−9.81,0] matches the analytic motion', () => {
    // A = g + 2 m/s² along +X; the body stays inside the law's full-strength core all second.
    const host = new SimulationHost(scene([sphere('a', [0, 0, 0], [1, 0, 0])], [law(2, [1, -2.5, 0])]));
    for (let i = 0; i < 120; i++) host.step();
    const T = 1;
    const A = [2, G[1], 0];
    const v0 = [1, 0, 0];
    const expectedV = v0.map((c, i) => c + A[i]! * T);
    const expectedP = v0.map((c, i) => c * T + 0.5 * A[i]! * T * T);
    const state = bodyState(host.canonicalState(), 'a');
    const positionTol = A.map((c) => Math.abs(c) * T * H + 1e-4);
    console.info(JSON.stringify({ fixture: 'constant-acceleration', tick: host.tick, v: state.linvel, expectedV, p: state.translation, expectedP, positionTol }));
    expect(host.tick).toBe(120);
    expectWithin(state.linvel, expectedV, 2e-4);
    expectWithin(state.translation, expectedP, positionTol);
    host.dispose();
  });
});

describe('runtime stops (SPEC §9.3, §16)', () => {
  it('stops outside the supported position range, names the body and tick, and refuses to step until reset', () => {
    // Crosses the ±10 000 m position stop during the first transition.
    const root = scene([sphere('far', [9999.5, 0, 0], [100, 0, 0])], []);
    const host = new SimulationHost(root);
    expect(() => host.step()).toThrow(/Position outside the supported ±10000 m: far at tick 1/);
    expect(host.fault).toMatchObject({ tick: 1, entity: 'far' });
    expect(host.tick).toBe(0); // the stopped transition is not published
    expect(() => host.step()).toThrow();
    host.reset(root);
    expect(host.fault).toBeNull();
    host.dispose();
  });

  it('stops a body accelerating past the supported 350 m/s, below the engine cap', () => {
    // 349 m/s plus one limited 200 m/s² step (Δv ≈ 1.66 m/s) crosses 350 m/s, far below 400.
    const host = new SimulationHost(scene([sphere('fast', [0, 0, 0], [349, 0, 0])], [law(200)]));
    expect(() => host.step()).toThrow(/Speed above the supported 350 m\/s: fast at tick 1/);
    host.dispose();
    const steady = new SimulationHost(scene([sphere('steady', [0, 0, 0], [340, 0, 0])], []));
    steady.step();
    expect(steady.fault).toBeNull();
    steady.dispose();
  });

  it('characterizes the pinned engine: Rapier 0.21 caps linear speed at the profile engineSpeedCap', () => {
    // The cap is not readable through the JS API; the supported stop must stay below it.
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    world.timestep = H;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinvel(1500, 0, 0).setCanSleep(false));
    world.createCollider(RAPIER.ColliderDesc.ball(0.08).setMass(1), body);
    world.step();
    expect(body.linvel().x).toBe(SIMULATION_PROFILE.engineSpeedCap);
    world.free();
    expect(MAX_SUPPORTED_SPEED).toBeLessThan(SIMULATION_PROFILE.engineSpeedCap);
  });
});
