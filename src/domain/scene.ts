// The semantic scene and document model (SPEC §5). No engine handles, no Three.js objects:
// the semantic block is what the simulation consumes; presentation never reaches physics.

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
  readonly initialPose: Pose;
  readonly initialLinearVelocity: Vec3;
  readonly initialAngularVelocity: Vec3;
  readonly collider: ColliderShape;
  readonly material: BodyMaterial;
  readonly collisionMode: CollisionMode;
}

export type BodyDefinition = BodyCommon & ({ readonly type: 'dynamic'; readonly massKg: number } | { readonly type: 'fixed' });

/** The dynamic body an emitter creates (SPEC §5.3); it cannot embed another emitter. */
export interface BodyTemplate {
  readonly collider: ColliderShape;
  readonly massKg: number;
  readonly initialLinearVelocity: Vec3;
  readonly initialAngularVelocity: Vec3;
  readonly material: BodyMaterial;
  readonly collisionMode: CollisionMode;
}

export interface EmitterDefinition {
  readonly id: EntityId;
  /** Spawn origin. Its rotation must be the identity in schema 1 (see `validateEmitter`). */
  readonly pose: Pose;
  readonly template: BodyTemplate;
  /** Nonzero uint32 seed of this emitter's own xorshift32-v1 stream. */
  readonly seed: number;
  readonly startTick: number;
  readonly intervalTicks: number;
  readonly lifetimeTicks: number;
  /** Number of scheduled births; absent means unbounded. */
  readonly emissionCount?: number;
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

/** The semantic block of a scene document: everything that can change the simulation. */
export interface SceneDefinition {
  readonly units: 'm-kg-s';
  readonly seed: number;
  readonly simulation: SimulationSettings;
  readonly bodies: readonly BodyDefinition[];
  readonly emitters: readonly EmitterDefinition[];
  readonly fields: readonly FieldDefinition[];
}

/** Display state of one law, indexed by its ID. `visible` hides geometry, never the effect (SPEC §5.4). */
export interface LawPresentation {
  readonly id: EntityId;
  readonly label: string;
  readonly color: string;
  readonly visible: boolean;
}

export interface ScenePresentation {
  /** Optional camera framing; absent means the default view. */
  readonly camera?: { readonly position: Vec3; readonly target: Vec3 };
  /** Visualization default: draw drive arrows. */
  readonly arrows: boolean;
  readonly laws: readonly LawPresentation[];
}

export interface SceneMetadata {
  readonly title: string;
  readonly description?: string;
}

export const SCENE_FORMAT = 'lawsmith.scene';
export const SCHEMA_VERSION = 1;

/** A complete scene artifact (SPEC §5.1, §15.1). */
export interface SceneDocument {
  readonly format: typeof SCENE_FORMAT;
  readonly schemaVersion: number;
  readonly requiredCapabilities: readonly string[];
  readonly semantic: SceneDefinition;
  readonly presentation: ScenePresentation;
  readonly metadata: SceneMetadata;
}

export const SCENE_SEED = 0x4c415731;
export const SIMULATION_PROFILE_ID = 'lawsmith-m1-rapier-0.21.0';

/** SPEC §15.2 import and work limits. */
export const SCENE_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  dynamicBodies: 512,
  fixedBodies: 64,
  fields: 32,
  primitiveLeaves: 256,
  emitters: 16,
  idLength: 64,
  textLength: 8192,
});

/** Law display palette (presentation only); the first entry is the default. */
export const LAW_COLORS = Object.freeze(['#55aaa4', '#c58ae5', '#d9a35b', '#7aa7d9']);

const SPHERE_MATERIAL: BodyMaterial = { friction: 0.6, restitution: 0.25 };
const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];

/**
 * SPEC §2.2 starting recipe. The floor carries the sphere's material so Rapier's default
 * average combine rule yields exactly the recipe's contact values.
 */
export const STARTING_RECIPE: SceneDefinition = cloneFrozen({
  units: 'm-kg-s',
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
      initialPose: { position: [0, -2.1, 0], rotation: IDENTITY },
      initialLinearVelocity: ZERO,
      initialAngularVelocity: ZERO,
      collider: { kind: 'box', halfExtents: [20, 0.1, 20] },
      material: SPHERE_MATERIAL,
      collisionMode: 'all',
    },
  ],
  emitters: [
    {
      id: 'stream',
      pose: { position: [0, 6, 0], rotation: IDENTITY },
      template: {
        collider: { kind: 'sphere', radius: 0.08 },
        massKg: 1,
        initialLinearVelocity: [0, -0.5, 0],
        initialAngularVelocity: ZERO,
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
      pose: { position: [3, 1, 0], rotation: IDENTITY },
      region: { kind: 'box', halfExtents: [1.5, 2, 1.5] },
      edgeFade: 0.25,
      expression: { kind: 'directional', direction: [1, 0, 0], strength: 12 },
    },
  ],
});

/** Constructor default for a law with no stored presentation. */
export function defaultLawPresentation(id: EntityId): LawPresentation {
  return { id, label: id, color: LAW_COLORS[0]!, visible: true };
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Checks a camera framing; the reader and the save-time capture share it, so a saved camera always reopens. */
export function checkCamera(camera: { position: Vec3; target: Vec3 }): string | null {
  if (![...camera.position, ...camera.target].every((v) => Number.isFinite(v) && Math.abs(v) <= 10000)) return 'camera components must be within ±10000 m';
  if (camera.position.every((v, i) => v === camera.target[i])) return 'camera position and target must differ';
  return null;
}

/** Checks a law presentation entry; labels are display text, never markup (SPEC §15.2). */
export function checkLawPresentation(p: LawPresentation): string | null {
  if (p.label.length === 0 || p.label.length > SCENE_LIMITS.textLength) return `label must be 1–${SCENE_LIMITS.textLength} characters`;
  if (!COLOR_PATTERN.test(p.color)) return 'color must be #rrggbb in lowercase hex';
  return null;
}

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

/** A rejection names the offending value by a path relative to the validated object. */
export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string; path: string };

const reject = (path: string, reason: string): { ok: false; reason: string; path: string } => ({ ok: false, reason, path });
const at = (prefix: string, path: string) => (path ? `${prefix}.${path}` : prefix);

/** ASCII letters, digits, underscore and hyphen; `:` is reserved for generated body IDs (SPEC §5.3). */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function checkId(id: string): string | null {
  if (!ID_PATTERN.test(id)) return `id ${JSON.stringify(id)} is not ASCII letters, digits, _ or -`;
  if (id.length > SCENE_LIMITS.idLength) return `id is longer than ${SCENE_LIMITS.idLength} characters`;
  return null;
}

const finite = (values: readonly number[]) => values.every(Number.isFinite);
const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
/** Negative zero becomes positive zero, so equal values serialize and compare identically. */
const unsign = (value: number) => (value === 0 ? 0 : value);
const vec = (v: Vec3): Vec3 => [unsign(v[0]), unsign(v[1]), unsign(v[2])];
const isSafeCount = (value: number, min: number) => Number.isSafeInteger(value) && value >= min;
const isSeed = (value: number) => Number.isInteger(value) && value >= 1 && value <= 0xffffffff;

/** A stored unit value is kept as is when its norm is within this of 1 (SPEC §15.1), so save/load never drifts. */
const UNIT_RETAIN = 1e-12;

/**
 * Unit vector by scaled normalization: dividing by the largest magnitude first keeps the length
 * in [1, 2], so no finite nonzero input overflows or underflows. An input already within 1e-12
 * of unit length is retained unchanged. Null for zero or nonfinite input.
 */
function unit(values: readonly number[]): number[] | null {
  if (!finite(values)) return null;
  const scale = Math.max(...values.map(Math.abs));
  if (!(scale > 0)) return null;
  const scaled = values.map((c) => c / scale);
  const length = Math.hypot(...scaled);
  if (Math.abs(scale * length - 1) <= UNIT_RETAIN) return values.map(unsign);
  return scaled.map((c) => unsign(c / length));
}

/**
 * SPEC §15.1 canonical quaternion: a unit quaternion whose first nonzero component in the order
 * w, x, y, z is positive. Null for a zero or nonfinite quaternion.
 */
export function canonicalQuat(q: readonly number[]): Quat | null {
  const u = unit(q);
  if (!u) return null;
  const [x, y, z, w] = u as [number, number, number, number];
  const first = [w, x, y, z].find((c) => c !== 0)!;
  const sign = first < 0 ? -1 : 1;
  return [unsign(sign * x), unsign(sign * y), unsign(sign * z), unsign(sign * w)];
}

/** A canonical unit direction (no sign rule: a direction's sign is meaningful). */
export function canonicalDirection(v: readonly number[]): Vec3 | null {
  const u = unit(v);
  return u ? (u as unknown as Vec3) : null;
}

/**
 * Validates a complete field put against SPEC §9.3's supported domain and resolves it: the
 * quaternion and direction take their canonical forms. Invalid input is rejected before any
 * host mutation; nothing is clamped silently.
 */
export function validateField(field: FieldDefinition): Validated<FieldDefinition> {
  const idError = checkId(field.id);
  if (idError) return reject('id', idError);
  if (typeof field.enabled !== 'boolean') return reject('enabled', 'enabled must be a boolean');
  const { position, rotation } = field.pose;
  if (!position.every((c) => within(c, -1000, 1000))) return reject('pose.position', 'position components must be within ±1000 m');
  const q = canonicalQuat(rotation);
  if (!q) return reject('pose.rotation', 'rotation must be a finite nonzero quaternion');
  if (field.region.kind !== 'box') return reject('region.kind', 'only box support exists in this build');
  if (!field.region.halfExtents.every((h) => within(h, 0.01, 100))) return reject('region.halfExtents', 'box half-extents must be within 0.01–100 m');
  if (!within(field.edgeFade, 0, 1)) return reject('edgeFade', 'edge fade must be within 0–1');
  const { expression } = field;
  if (expression.kind !== 'directional') return reject('expression.kind', 'only the directional primitive exists in this build');
  if (!within(expression.strength, 0, 200)) return reject('expression.strength', 'directional strength must be within 0–200 m/s²');
  const d = canonicalDirection(expression.direction);
  if (!d) return reject('expression.direction', 'direction must be finite and nonzero');

  return {
    ok: true,
    value: cloneFrozen({
      id: field.id,
      enabled: field.enabled,
      pose: { position: vec(position), rotation: q },
      region: { kind: 'box', halfExtents: vec(field.region.halfExtents) },
      edgeFade: unsign(field.edgeFade),
      expression: { kind: 'directional', direction: d, strength: unsign(expression.strength) },
    } satisfies FieldDefinition),
  };
}

function validateCollider(collider: ColliderShape, path: string): Validated<ColliderShape> {
  if (collider.kind === 'sphere') {
    if (!within(collider.radius, 0.01, 100)) return reject(at(path, 'radius'), 'radius must be within 0.01–100 m');
    return { ok: true, value: { kind: 'sphere', radius: collider.radius } };
  }
  if (!collider.halfExtents.every((h) => within(h, 0.01, 100))) return reject(at(path, 'halfExtents'), 'half-extents must be within 0.01–100 m');
  return { ok: true, value: { kind: 'box', halfExtents: vec(collider.halfExtents) } };
}

function validateMaterial(material: BodyMaterial, path: string): Validated<BodyMaterial> {
  if (!within(material.friction, 0, 2)) return reject(at(path, 'friction'), 'friction must be within 0–2');
  if (!within(material.restitution, 0, 1)) return reject(at(path, 'restitution'), 'restitution must be within 0–1');
  return { ok: true, value: { friction: unsign(material.friction), restitution: unsign(material.restitution) } };
}

/** Speeds and the dynamic-body constraints shared by authored bodies and emitter templates. */
function validateMotion(linear: Vec3, angular: Vec3, path: { linear: string; angular: string }): string[] | null {
  if (!finite(linear) || Math.hypot(...linear) > 200) return [path.linear, 'initial linear speed must be finite and at most 200 m/s'];
  if (!finite(angular) || Math.hypot(...angular) > 100) return [path.angular, 'initial angular speed must be finite and at most 100 rad/s'];
  return null;
}

/** Dynamic bodies render and simulate as spheres in this build (boxes arrive with M3's collision example). */
const SPHERES_ONLY = 'dynamic bodies must be spheres in this build';

export function validateBody(body: BodyDefinition): Validated<BodyDefinition> {
  const idError = checkId(body.id);
  if (idError) return reject('id', idError);
  const { position, rotation } = body.initialPose;
  if (!position.every((c) => within(c, -1000, 1000))) return reject('initialPose.position', 'position components must be within ±1000 m');
  const q = canonicalQuat(rotation);
  if (!q) return reject('initialPose.rotation', 'rotation must be a finite nonzero quaternion');
  const collider = validateCollider(body.collider, 'collider');
  if (!collider.ok) return collider;
  const material = validateMaterial(body.material, 'material');
  if (!material.ok) return material;
  const common = {
    id: body.id,
    initialPose: { position: vec(position), rotation: q },
    initialLinearVelocity: vec(body.initialLinearVelocity),
    initialAngularVelocity: vec(body.initialAngularVelocity),
    collider: collider.value,
    material: material.value,
    collisionMode: body.collisionMode,
  };
  if (body.type === 'fixed') {
    // Fixed bodies never move: nonzero initial velocities are rejected, not ignored (SPEC §5.2).
    if (!body.initialLinearVelocity.every((c) => c === 0)) return reject('initialLinearVelocity', 'a fixed body must have zero initial linear velocity');
    if (!body.initialAngularVelocity.every((c) => c === 0)) return reject('initialAngularVelocity', 'a fixed body must have zero initial angular velocity');
    return { ok: true, value: { ...common, type: 'fixed' } };
  }
  if (!within(body.massKg, 0.001, 1000)) return reject('massKg', 'mass must be within 0.001–1000 kg');
  if (body.collider.kind !== 'sphere') return reject('collider.kind', SPHERES_ONLY);
  const motion = validateMotion(body.initialLinearVelocity, body.initialAngularVelocity, { linear: 'initialLinearVelocity', angular: 'initialAngularVelocity' });
  if (motion) return reject(motion[0]!, motion[1]!);
  return { ok: true, value: { ...common, type: 'dynamic', massKg: body.massKg } };
}

export function validateEmitter(emitter: EmitterDefinition): Validated<EmitterDefinition> {
  const idError = checkId(emitter.id);
  if (idError) return reject('id', idError);
  const { position, rotation } = emitter.pose;
  if (!position.every((c) => within(c, -1000, 1000))) return reject('pose.position', 'position components must be within ±1000 m');
  const q = canonicalQuat(rotation);
  if (!q) return reject('pose.rotation', 'rotation must be a finite nonzero quaternion');
  // SPEC §5.3 gives emitters a pose but does not define what its rotation does; rather than
  // invent or ignore it, schema 1 accepts only the identity.
  if (!(q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1)) return reject('pose.rotation', 'emitter rotation must be the identity in this build');
  if (!emitter.jitter.every((j) => within(j, 0, 100))) return reject('jitter', 'jitter extents must be within 0–100 m');
  // Resolved spawn positions stay inside the supported ±1000 m.
  if (!position.every((c, i) => Math.abs(c) + emitter.jitter[i]! <= 1000)) return reject('jitter', 'spawn positions after jitter must stay within ±1000 m');
  if (!isSeed(emitter.seed)) return reject('seed', 'seed must be a nonzero uint32');
  if (!isSafeCount(emitter.startTick, 0)) return reject('startTick', 'startTick must be a nonnegative safe integer');
  if (!isSafeCount(emitter.intervalTicks, 1)) return reject('intervalTicks', 'intervalTicks must be a positive safe integer');
  if (!isSafeCount(emitter.lifetimeTicks, 1)) return reject('lifetimeTicks', 'lifetimeTicks must be a positive safe integer');
  if (emitter.emissionCount !== undefined && !isSafeCount(emitter.emissionCount, 0)) return reject('emissionCount', 'emissionCount must be a nonnegative safe integer');
  const t = emitter.template;
  if (!within(t.massKg, 0.001, 1000)) return reject('template.massKg', 'mass must be within 0.001–1000 kg');
  const collider = validateCollider(t.collider, 'template.collider');
  if (!collider.ok) return collider;
  if (t.collider.kind !== 'sphere') return reject('template.collider.kind', SPHERES_ONLY);
  const material = validateMaterial(t.material, 'template.material');
  if (!material.ok) return material;
  const motion = validateMotion(t.initialLinearVelocity, t.initialAngularVelocity, {
    linear: 'template.initialLinearVelocity',
    angular: 'template.initialAngularVelocity',
  });
  if (motion) return reject(motion[0]!, motion[1]!);
  return {
    ok: true,
    value: {
      id: emitter.id,
      pose: { position: vec(position), rotation: q },
      template: {
        collider: collider.value,
        massKg: t.massKg,
        initialLinearVelocity: vec(t.initialLinearVelocity),
        initialAngularVelocity: vec(t.initialAngularVelocity),
        material: material.value,
        collisionMode: t.collisionMode,
      },
      seed: emitter.seed,
      startTick: emitter.startTick,
      intervalTicks: emitter.intervalTicks,
      lifetimeTicks: emitter.lifetimeTicks,
      ...(emitter.emissionCount === undefined ? {} : { emissionCount: emitter.emissionCount }),
      jitter: vec(emitter.jitter),
    },
  };
}

function validateSettings(settings: SimulationSettings): Validated<SimulationSettings> {
  if (settings.profile !== SIMULATION_PROFILE_ID) {
    return reject('profile', `profile ${JSON.stringify(settings.profile)} is not available; this build provides ${SIMULATION_PROFILE_ID}`);
  }
  if (settings.stepNumerator !== 1 || settings.stepDenominator !== 120) return reject('stepDenominator', 'the step must be 1/120 s');
  const g = settings.ambientAcceleration;
  if (!finite(g) || Math.hypot(...g) > 200) return reject('ambientAcceleration', 'ambient acceleration must be finite with magnitude at most 200 m/s²');
  if (!within(settings.maxAppliedAcceleration, 1, 200)) return reject('maxAppliedAcceleration', 'maxAppliedAcceleration must be within 1–200 m/s²');
  if (!Number.isInteger(settings.maxLiveBodies) || settings.maxLiveBodies < 1 || settings.maxLiveBodies > SCENE_LIMITS.dynamicBodies) {
    return reject('maxLiveBodies', `maxLiveBodies must be an integer within 1–${SCENE_LIMITS.dynamicBodies}`);
  }
  return {
    ok: true,
    value: {
      profile: settings.profile,
      stepNumerator: 1,
      stepDenominator: 120,
      ambientAcceleration: vec(g),
      maxAppliedAcceleration: settings.maxAppliedAcceleration,
      maxLiveBodies: settings.maxLiveBodies,
    },
  };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Validates and resolves a complete semantic block: every entity, the count limits, and ID
 * uniqueness across bodies, emitters and laws. Entity arrays come back sorted by ID (SPEC §15.1).
 */
export function validateScene(scene: SceneDefinition): Validated<SceneDefinition> {
  if (scene.units !== 'm-kg-s') return reject('units', 'units must be "m-kg-s"');
  if (!isSeed(scene.seed)) return reject('seed', 'seed must be a nonzero uint32');
  const settings = validateSettings(scene.simulation);
  if (!settings.ok) return { ...settings, path: at('simulation', settings.path) };

  const fixed = scene.bodies.filter((b) => b.type === 'fixed').length;
  const dynamic = scene.bodies.length - fixed;
  if (fixed > SCENE_LIMITS.fixedBodies) return reject('bodies', `at most ${SCENE_LIMITS.fixedBodies} fixed bodies are supported`);
  if (dynamic > settings.value.maxLiveBodies) return reject('bodies', `${dynamic} dynamic bodies exceed maxLiveBodies ${settings.value.maxLiveBodies}`);
  if (scene.emitters.length > SCENE_LIMITS.emitters) return reject('emitters', `at most ${SCENE_LIMITS.emitters} emitters are supported`);
  if (scene.fields.length > SCENE_LIMITS.fields) return reject('fields', `at most ${SCENE_LIMITS.fields} laws are supported`);

  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const previous = seen.get(id);
    if (previous) return reject(at(path, 'id'), `id ${JSON.stringify(id)} is already used by ${previous}`);
    seen.set(id, path);
    return null;
  };
  const bodies: BodyDefinition[] = [];
  for (const [i, body] of scene.bodies.entries()) {
    const result = validateBody(body);
    if (!result.ok) return { ...result, path: at(`bodies[${i}]`, result.path) };
    const duplicate = claim(body.id, `bodies[${i}]`);
    if (duplicate) return duplicate;
    bodies.push(result.value);
  }
  const emitters: EmitterDefinition[] = [];
  for (const [i, emitter] of scene.emitters.entries()) {
    const result = validateEmitter(emitter);
    if (!result.ok) return { ...result, path: at(`emitters[${i}]`, result.path) };
    const duplicate = claim(emitter.id, `emitters[${i}]`);
    if (duplicate) return duplicate;
    emitters.push(result.value);
  }
  const fields: FieldDefinition[] = [];
  for (const [i, field] of scene.fields.entries()) {
    const result = validateField(field);
    if (!result.ok) return { ...result, path: at(`fields[${i}]`, result.path) };
    const duplicate = claim(field.id, `fields[${i}]`);
    if (duplicate) return duplicate;
    fields.push(result.value);
  }
  return {
    ok: true,
    value: cloneFrozen({
      units: 'm-kg-s',
      seed: scene.seed,
      simulation: settings.value,
      bodies: bodies.sort(byId),
      emitters: emitters.sort(byId),
      fields: fields.sort(byId),
    } satisfies SceneDefinition),
  };
}
