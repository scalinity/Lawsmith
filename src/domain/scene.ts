// M1's small typed in-memory scene (SPEC §5.1). M2 formalizes the file schema; this keeps
// the same semantic boundary: no engine handles, no Three.js objects, no presentation state.

export type Vec3 = readonly [number, number, number];
/** Quaternion, component order x, y, z, w. */
export type Quat = readonly [number, number, number, number];
export type EntityId = string;

export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface DirectionalPrimitive {
  readonly kind: 'directional';
  /** Unit vector in the field's local frame; normalized on acceptance. */
  readonly direction: Vec3;
  /** m/s². */
  readonly strength: number;
}

export interface FieldDefinition {
  readonly id: EntityId;
  readonly enabled: boolean;
  readonly pose: Pose;
  readonly region: { readonly kind: 'box'; readonly halfExtents: Vec3 };
  /** Inner fade fraction in [0,1] (SPEC §7). */
  readonly edgeFade: number;
  readonly expression: DirectionalPrimitive;
}

export type ColliderShape =
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'box'; readonly halfExtents: Vec3 };

export interface BodyMaterial {
  readonly friction: number;
  readonly restitution: number;
}

export type CollisionMode = 'all' | 'fixedOnly';

interface BodyCommon {
  readonly id: EntityId;
  readonly position: Vec3;
  readonly linearVelocity: Vec3;
  readonly collider: ColliderShape;
  readonly material: BodyMaterial;
  readonly collisionMode: CollisionMode;
}

export type BodyDefinition = BodyCommon & ({ readonly type: 'dynamic'; readonly massKg: number } | { readonly type: 'fixed' });

export interface EmitterDefinition {
  readonly id: EntityId;
  readonly position: Vec3;
  readonly template: {
    readonly collider: ColliderShape;
    readonly massKg: number;
    readonly linearVelocity: Vec3;
    readonly material: BodyMaterial;
    readonly collisionMode: CollisionMode;
  };
  /** Nonzero uint32 seed of this emitter's own xorshift32-v1 stream. */
  readonly seed: number;
  readonly startTick: number;
  readonly intervalTicks: number;
  readonly lifetimeTicks: number;
  /** Spawn offsets are drawn uniformly from [-jitter, jitter) per axis. */
  readonly jitter: Vec3;
}

export interface SimulationSettings {
  readonly profile: string;
  readonly stepNumerator: 1;
  readonly stepDenominator: 120;
  readonly ambientAcceleration: Vec3;
  readonly maxAppliedAcceleration: number;
  readonly maxLiveBodies: number;
}

export interface SceneDefinition {
  readonly seed: number;
  readonly simulation: SimulationSettings;
  readonly bodies: readonly BodyDefinition[];
  readonly emitters: readonly EmitterDefinition[];
  readonly fields: readonly FieldDefinition[];
}

export const SCENE_SEED = 0x4c415731;
export const SIMULATION_PROFILE_ID = 'lawsmith-m1-rapier-0.21.0';

const SPHERE_MATERIAL: BodyMaterial = { friction: 0.6, restitution: 0.25 };

/**
 * SPEC §2.2 starting recipe. The floor carries the sphere's material so Rapier's default
 * average combine rule yields exactly the recipe's contact values.
 */
export const STARTING_RECIPE: SceneDefinition = cloneFrozen({
  seed: SCENE_SEED,
  simulation: {
    profile: SIMULATION_PROFILE_ID,
    stepNumerator: 1,
    stepDenominator: 120,
    ambientAcceleration: [0, -9.81, 0],
    maxAppliedAcceleration: 200,
    maxLiveBodies: 256,
  },
  bodies: [
    {
      id: 'floor',
      type: 'fixed',
      position: [0, -2.1, 0],
      linearVelocity: [0, 0, 0],
      collider: { kind: 'box', halfExtents: [20, 0.1, 20] },
      material: SPHERE_MATERIAL,
      collisionMode: 'all',
    },
  ],
  emitters: [
    {
      id: 'stream',
      position: [0, 6, 0],
      template: {
        collider: { kind: 'sphere', radius: 0.08 },
        massKg: 1,
        linearVelocity: [0, -0.5, 0],
        material: SPHERE_MATERIAL,
        collisionMode: 'fixedOnly',
      },
      seed: SCENE_SEED,
      startTick: 0,
      intervalTicks: 8,
      lifetimeTicks: 512,
      jitter: [0.25, 0, 0.25],
    },
  ],
  fields: [
    {
      id: 'sideways',
      enabled: true,
      pose: { position: [3, 1, 0], rotation: [0, 0, 0, 1] },
      region: { kind: 'box', halfExtents: [1.5, 2, 1.5] },
      edgeFade: 0.25,
      expression: { kind: 'directional', direction: [1, 0, 0], strength: 12 },
    },
  ],
});

/** A deep, frozen copy: run roots and accepted definitions never alias mutable data. */
export function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const finite = (values: readonly number[]) => values.every(Number.isFinite);
const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

/**
 * Validates a complete field put against SPEC §9.3's supported domain and resolves it:
 * the quaternion and direction are normalized. Invalid input is rejected before any host
 * mutation; nothing is clamped silently.
 */
export function validateField(field: FieldDefinition): Validated<FieldDefinition> {
  if (!ID_PATTERN.test(field.id)) return { ok: false, reason: `field id ${JSON.stringify(field.id)} is not ASCII letters, digits, _ or -` };
  if (typeof field.enabled !== 'boolean') return { ok: false, reason: 'enabled must be a boolean' };
  const { position, rotation } = field.pose;
  if (!position.every((c) => within(c, -1000, 1000))) return { ok: false, reason: 'position components must be within ±1000 m' };
  if (!finite(rotation)) return { ok: false, reason: 'rotation must be finite' };
  const qLength = Math.hypot(...rotation);
  if (!(qLength > 1e-6)) return { ok: false, reason: 'rotation must be a nonzero quaternion' };
  if (field.region.kind !== 'box') return { ok: false, reason: 'only box support exists in M1' };
  if (!field.region.halfExtents.every((h) => within(h, 0.01, 100))) return { ok: false, reason: 'box half-extents must be within 0.01–100 m' };
  if (!within(field.edgeFade, 0, 1)) return { ok: false, reason: 'edge fade must be within 0–1' };
  const { expression } = field;
  if (expression.kind !== 'directional') return { ok: false, reason: 'only the directional primitive exists in M1' };
  if (!within(expression.strength, 0, 200)) return { ok: false, reason: 'directional strength must be within 0–200 m/s²' };
  if (!finite(expression.direction)) return { ok: false, reason: 'direction must be finite' };
  const dLength = Math.hypot(...expression.direction);
  if (!(dLength > 0)) return { ok: false, reason: 'direction must be nonzero' };

  const [qx, qy, qz, qw] = rotation;
  const [dx, dy, dz] = expression.direction;
  return {
    ok: true,
    value: cloneFrozen({
      id: field.id,
      enabled: field.enabled,
      pose: { position: [...position], rotation: [qx / qLength, qy / qLength, qz / qLength, qw / qLength] },
      region: { kind: 'box', halfExtents: [...field.region.halfExtents] },
      edgeFade: field.edgeFade,
      expression: { kind: 'directional', direction: [dx / dLength, dy / dLength, dz / dLength], strength: expression.strength },
    } satisfies FieldDefinition),
  };
}
