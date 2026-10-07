// Center sampling (SPEC §7, §9.1): fields act on each body's center once per fixed step. The
// narrow/fast fixture documents the accepted limitation that a fast center can cross a thin support
// between samples and receive nothing; the collision fixture (AC8) shows contacts staying Rapier's
// while fields stay center-sampled, and support volumes never colliding.
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, validateField, type BodyDefinition, type FieldDefinition, type RegionDefinition, type Vec3 } from '../src/domain/scene';
import { fadeBand } from '../src/fields/kernel';
import { STEP_SECONDS, SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

const ZERO: Vec3 = [0, 0, 0];

function ball(id: string, position: Vec3, velocity: Vec3, radius = 0.08, mode: BodyDefinition['collisionMode'] = 'fixedOnly'): BodyDefinition {
  return {
    id,
    type: 'dynamic',
    massKg: 1,
    initialPose: { position, rotation: [0, 0, 0, 1] },
    initialLinearVelocity: velocity,
    initialAngularVelocity: ZERO,
    collider: { kind: 'sphere', radius },
    material: { friction: 0, restitution: 0.5 },
    collisionMode: mode,
  };
}

function law(region: RegionDefinition, center: Vec3, direction: Vec3, strength: number, edgeFade: number): FieldDefinition {
  const result = validateField({ id: 'law', enabled: true, pose: { position: center, rotation: [0, 0, 0, 1] }, region, edgeFade, expression: { kind: 'directional', direction, strength } });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const host = (bodies: BodyDefinition[], fields: FieldDefinition[]) =>
  new SimulationHost(cloneFrozen({ ...STARTING_RECIPE, simulation: { ...STARTING_RECIPE.simulation, ambientAcceleration: ZERO }, bodies, emitters: [], fields }));
const state = (h: SimulationHost, id: string) => h.canonicalState().bodies.find((b) => b.id === id)!;

describe('narrow/fast support: a documented limitation, not a continuous-crossing solver', () => {
  // A 0.1 m thick hard-boundary slab pushing along +Y, at x ∈ [−0.05, 0.05].
  const slab = law({ kind: 'box', halfExtents: [0.05, 5, 5] }, ZERO, [0, 1, 0], 100, 0);

  it('a center moving 0.25 m per step crosses the slab between samples and receives no contribution', () => {
    const h = host([ball('fast', [-1.1, 0, 0], [30, 0, 0])], [slab]);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(state(h, 'fast').translation[0]!);
      h.step();
    }
    // Center samples …, −0.35, −0.1, 0.15, …: none inside |x| ≤ 0.05.
    expect(samples.some((x) => Math.abs(x) <= 0.05)).toBe(false);
    expect(samples.some((x) => x < -0.05) && samples.some((x) => x > 0.05)).toBe(true);
    expect(state(h, 'fast').linvel[1]).toBe(0); // missed entirely
    h.dispose();
  });

  it('a center moving 0.025 m per step is sampled inside and is pushed', () => {
    const h = host([ball('slow', [-0.2, 0, 0], [3, 0, 0])], [slab]);
    for (let i = 0; i < 16; i++) h.step();
    const { translation, linvel } = state(h, 'slow');
    expect(translation[0]!).toBeGreaterThan(0.05);
    // Four samples in the slab, each adding h·100 m/s.
    expect(linvel[1]!).toBeGreaterThanOrEqual(4 * STEP_SECONDS * 100 * 0.999);
    h.dispose();
  });

  it('the inspector heuristic: f × the narrowest dimension, no band at f = 0 (SPEC §7)', () => {
    const at = (region: RegionDefinition, f: number) => fadeBand(law(region, ZERO, [1, 0, 0], 12, f));
    expect(at({ kind: 'box', halfExtents: [1.5, 2, 1.5] }, 0.25)).toBe(0.375);
    expect(at({ kind: 'sphere', radius: 2 }, 0.25)).toBe(0.5);
    expect(at({ kind: 'cylinderY', radius: 2, halfHeight: 1 }, 0.25)).toBe(0.25);
    expect(at({ kind: 'cylinderY', radius: 0.5, halfHeight: 3 }, 0.5)).toBe(0.25);
    expect(fadeBand(slab)).toBeNull();
    // The slab with a fade: a 0.0125 m band against the fast body's 0.25 m travel per step.
    expect(at({ kind: 'box', halfExtents: [0.05, 5, 5] }, 0.25)).toBe(0.0125);
  });
});

describe('collisions under fields (AC8)', () => {
  // A +X push over x ∈ [−2, 0] with a hard boundary.
  const pushRight = law({ kind: 'box', halfExtents: [1, 1, 1] }, [-1, 0, 0], [1, 0, 0], 20, 0);

  it('a body pushed into another moves it by contact; the struck center never enters the law', () => {
    const h = host([ball('striker', [-1.5, 0, 0], ZERO, 0.3, 'all'), ball('target', [0.6, 0, 0], ZERO, 0.3, 'all')], [pushRight]);
    let contactTick: number | null = null;
    for (let i = 0; i < 240; i++) {
      h.step();
      const target = state(h, 'target');
      expect(target.translation[0]!).toBeGreaterThan(0); // always outside the support
      if (contactTick === null && target.linvel[0]! !== 0) contactTick = h.tick;
      if (contactTick === null) expect(target.linvel).toEqual([0, 0, 0]); // no field reaches it
    }
    expect(contactTick).not.toBeNull();
    const target = state(h, 'target').linvel;
    expect(target[0]!).toBeGreaterThan(1); // momentum came through the contact
    h.dispose();
  });

  it('around the contact the striker’s velocity change is not the law arrow’s h·A', () => {
    // Contact when the striker's center reaches −0.4, inside the support; the target's center stays at x > 0.
    const h = host([ball('striker', [-1.5, 0, 0], ZERO, 0.3, 'all'), ball('target', [0.2, 0, 0], ZERO, 0.3, 'all')], [pushRight]);
    let previous = 0;
    let differs = false;
    for (let i = 0; i < 240 && !differs; i++) {
      h.step();
      const v = state(h, 'striker').linvel[0]!;
      const inside = state(h, 'striker').translation[0]! <= 0;
      if (inside && Math.abs(v - previous - STEP_SECONDS * 20) > 1e-3) differs = true;
      previous = v;
    }
    expect(differs).toBe(true);
    h.dispose();
  });

  it('a body overlapping the support with its surface but not its center receives nothing', () => {
    // Center 0.3 m beyond the law face at x = 0, radius 0.5: its sphere reaches 0.2 m into the support.
    const h = host([ball('overlap', [0.3, 0, 0], ZERO, 0.5)], [pushRight]);
    for (let i = 0; i < 30; i++) h.step();
    expect(state(h, 'overlap').linvel).toEqual([0, 0, 0]);
    h.dispose();
  });

  it('support volumes are not colliders: a body passes through a law boundary freely and the world holds only body colliders', () => {
    const h = host([ball('through', [-3, 0, 0], [2, 0, 0], 0.08, 'all')], [pushRight]);
    for (let i = 0; i < 120; i++) h.step();
    const world = RAPIER.World.restoreSnapshot(h.engineSnapshot());
    expect(world.colliders.len()).toBe(1);
    world.free();
    // Crossed into and out of the support: it entered at x = −2 and left at x = 0, gaining speed from the law only.
    expect(state(h, 'through').translation[0]!).toBeGreaterThan(0);
    expect(state(h, 'through').linvel[0]!).toBeGreaterThan(2);
    h.dispose();
  });
});
