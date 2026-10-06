import RAPIER from '@dimforge/rapier3d-compat';
import {
  SIMULATION_PROFILE_ID,
  type BodyMaterial,
  type ColliderShape,
  type CollisionMode,
  type EmitterDefinition,
  type FieldDefinition,
  type SceneDefinition,
  type Vec3,
} from '../domain/scene';
import { compileField, sampleField, type CompiledField } from '../fields/directional';
import { limitAcceleration } from './adapter';

/** Fixed simulation step h (SPEC §2.2). */
export const STEP_SECONDS = 1 / 120;

/**
 * The shipped simulation profile (SPEC §5.1, §9.3). Every engine parameter is set explicitly
 * and its effective value is checked on each new world, so a changed dependency default fails
 * loudly instead of silently changing the simulation. Effective values are the engine's f32
 * storage, as recorded by M0.
 */
export const SIMULATION_PROFILE = Object.freeze({
  id: SIMULATION_PROFILE_ID,
  rapier: '0.21.0',
  effective: Object.freeze({
    dt: 0.008333333767950535,
    numSolverIterations: 4,
    numInternalPgsIterations: 1,
    maxCcdSubsteps: 1,
    lengthUnit: 1,
    normalizedAllowedLinearError: 0.004999999888241291,
    normalizedPredictionDistance: 0.019999999552965164,
    contactErp: 0.0728205069899559,
  }),
});

export type EffectiveProfile = Record<keyof typeof SIMULATION_PROFILE.effective, number>;

function readProfile(world: RAPIER.World): EffectiveProfile {
  const p = world.integrationParameters;
  return {
    dt: p.dt,
    numSolverIterations: p.numSolverIterations,
    numInternalPgsIterations: p.numInternalPgsIterations,
    maxCcdSubsteps: p.maxCcdSubsteps,
    lengthUnit: p.lengthUnit,
    normalizedAllowedLinearError: p.normalizedAllowedLinearError,
    normalizedPredictionDistance: p.normalizedPredictionDistance,
    contactErp: p.contact_erp,
  };
}

/** A world under the profile: zero engine gravity (gravity enters through the adapter, SPEC §9.1). */
function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = STEP_SECONDS;
  const p = world.integrationParameters;
  p.numSolverIterations = 4;
  p.numInternalPgsIterations = 1;
  p.maxCcdSubsteps = 1;
  p.lengthUnit = 1;
  p.normalizedAllowedLinearError = 0.005;
  p.normalizedPredictionDistance = 0.02;
  const effective = readProfile(world);
  for (const [key, expected] of Object.entries(SIMULATION_PROFILE.effective)) {
    const actual = effective[key as keyof EffectiveProfile];
    if (!Object.is(actual, expected)) {
      world.free();
      throw new Error(`Rapier ${key} is ${actual}, but profile ${SIMULATION_PROFILE.id} requires ${expected}.`);
    }
  }
  return world;
}

export interface SimulationReady {
  rapierVersion: string;
  effectiveProfile: EffectiveProfile;
}

/** Initializes the Rapier WASM module once; no engine object exists before `RAPIER.init()`. */
export async function initSimulation(): Promise<SimulationReady> {
  await RAPIER.init();
  const rapierVersion = RAPIER.version();
  if (rapierVersion !== SIMULATION_PROFILE.rapier) {
    throw new Error(`Rapier ${rapierVersion} is loaded, but profile ${SIMULATION_PROFILE.id} requires ${SIMULATION_PROFILE.rapier}.`);
  }
  const world = createWorld();
  try {
    return { rapierVersion, effectiveProfile: readProfile(world) };
  } finally {
    world.free();
  }
}

/** xorshift32-v1 (SPEC §5.3): one state update with uint32 truncation after each operation. */
export function xorshift32(state: number): number {
  let x = state >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x;
}

export interface PutField {
  readonly kind: 'putField';
  readonly field: FieldDefinition;
}
/** M1's command vocabulary: a complete validated field put (SPEC §10.2). */
export type CommandPayload = PutField;

export interface CommandAck {
  readonly tick: number;
  readonly sequence: number;
  readonly documentRevision: number;
  readonly payload: CommandPayload;
}

/** Nonfinite field output or invalid engine state; the host refuses to step until reset (SPEC §9.3, §16). */
export class SimulationFault extends Error {
  constructor(
    readonly tick: number,
    readonly entity: string,
    readonly reason: string,
  ) {
    super(`${reason}: ${entity} at tick ${tick}`);
  }
}

/** Authoritative body state at a settled boundary, ordered by stable ID (SPEC §13.4). */
export interface CanonicalState {
  tick: number;
  lastAppliedSequence: number;
  skippedEmissions: number;
  emitters: { id: string; prngState: number; ordinal: number }[];
  fields: readonly FieldDefinition[];
  bodies: {
    id: string;
    deathTick: number | null;
    translation: number[];
    rotation: number[];
    linvel: number[];
    angvel: number[];
  }[];
}

// Collision groups are (memberships << 16) | filter. Emitted spheres are `fixedOnly`: they
// meet fixed colliders and never each other (SPEC §2.2).
const FIXED = 0x1;
const ALL = 0x2;
const FIXED_ONLY = 0x4;
const GROUPS = {
  fixed: (FIXED << 16) | ALL | FIXED_ONLY,
  all: (ALL << 16) | FIXED | ALL,
  fixedOnly: (FIXED_ONLY << 16) | FIXED,
} as const;

/** Runtime safety limits (SPEC §9.3): stop instead of letting overflow cascade. */
const MAX_SPEED = 1000;
const MAX_POSITION = 10000;

interface LiveBody {
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly radius: number;
  /** Infinity for authored bodies, which have no implicit lifetime. */
  readonly deathTick: number;
}

interface EmitterState {
  readonly def: EmitterDefinition;
  prng: number;
  ordinal: number;
}

interface PendingCommand {
  readonly documentRevision: number;
  readonly payload: CommandPayload;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const finite3 = (x: number, y: number, z: number) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/**
 * The only owner of a Rapier world (SPEC §4, C5). UI and rendering submit validated commands
 * and read observations; nothing else creates, steps or mutates the world.
 */
export class SimulationHost {
  private world: RAPIER.World | null = null;
  private root!: SceneDefinition;
  tick = 0;
  lastAppliedSequence = 0;
  skippedEmissions = 0;
  fault: SimulationFault | null = null;

  /** Applied laws in ascending stable ID order, independent of UI order (SPEC §6.3). */
  private fieldDefs: FieldDefinition[] = [];
  private compiled: CompiledField[] = [];
  private emitters: EmitterState[] = [];
  /** Live dynamic bodies: authored in ID order, then emitted in spawn order. */
  private bodies: LiveBody[] = [];
  private pending: PendingCommand[] = [];
  private acks: CommandAck[] = [];

  /** Read-only observation of the last completed boundary, for rendering. */
  positions = new Float32Array(0);
  radii = new Float32Array(0);
  count = 0;

  /** Diagnostic timing of the last step's field sampling and engine step, in ms. */
  lastFieldMs = 0;
  lastEngineMs = 0;

  private forces = new Float64Array(0);
  private readonly sample = [0, 0, 0];
  private readonly accel = [0, 0, 0];
  private readonly force = { x: 0, y: 0, z: 0 };

  constructor(root: SceneDefinition) {
    this.reset(root);
  }

  /** Rebuilds the world from a frozen run root at tick 0 (SPEC §13.2). Pending commands are dropped. */
  reset(root: SceneDefinition): void {
    if (root.simulation.profile !== SIMULATION_PROFILE.id) {
      throw new Error(`Scene requires profile ${root.simulation.profile}; this build provides ${SIMULATION_PROFILE.id}.`);
    }
    const authoredDynamic = root.bodies.filter((b) => b.type === 'dynamic').length;
    if (authoredDynamic > root.simulation.maxLiveBodies) {
      throw new Error(`Scene has ${authoredDynamic} dynamic bodies; its limit is ${root.simulation.maxLiveBodies}.`);
    }
    for (const def of root.bodies) if (def.type === 'dynamic') radiusOf(def.collider);
    for (const def of root.emitters) radiusOf(def.template.collider);
    this.world?.free();
    this.world = createWorld();
    this.root = root;
    this.tick = 0;
    this.lastAppliedSequence = 0;
    this.skippedEmissions = 0;
    this.fault = null;
    this.pending = [];
    this.acks = [];
    this.fieldDefs = [...root.fields].sort(byId);
    this.compiled = this.fieldDefs.map(compileField);
    this.emitters = [...root.emitters].sort(byId).map((def) => ({ def, prng: def.seed >>> 0, ordinal: 0 }));
    const capacity = root.simulation.maxLiveBodies;
    this.positions = new Float32Array(capacity * 3);
    this.radii = new Float32Array(capacity);
    this.forces = new Float64Array(capacity * 3);
    this.bodies = [];
    for (const def of [...root.bodies].sort(byId)) {
      const mass = def.type === 'dynamic' ? def.massKg : null;
      const body = this.createBody(def.position, def.linearVelocity, def.collider, def.material, def.collisionMode, mass);
      if (mass !== null) this.bodies.push({ id: def.id, body, radius: radiusOf(def.collider), deathTick: Infinity });
    }
    this.publish();
  }

  /** Queues a validated command for the next boundary; a newer put for the same law replaces an unconsumed one. */
  submit(payload: CommandPayload, documentRevision: number): void {
    const last = this.pending[this.pending.length - 1];
    if (last && last.payload.field.id === payload.field.id) this.pending[this.pending.length - 1] = { documentRevision, payload };
    else this.pending.push({ documentRevision, payload });
  }

  /** Applies queued commands at the current boundary n, in sequence order, without advancing (SPEC §10.2). */
  settleBoundary(): void {
    for (const { documentRevision, payload } of this.pending) {
      this.lastAppliedSequence += 1;
      const index = this.fieldDefs.findIndex((f) => f.id === payload.field.id);
      if (index >= 0) {
        this.fieldDefs[index] = payload.field;
        this.compiled[index] = compileField(payload.field);
      } else {
        this.fieldDefs.push(payload.field);
        this.fieldDefs.sort(byId);
        this.compiled = this.fieldDefs.map(compileField);
      }
      this.acks.push({ tick: this.tick, sequence: this.lastAppliedSequence, documentRevision, payload });
    }
    this.pending.length = 0;
  }

  /** Acknowledgments since the last call, in sequence order. */
  takeAcks(): CommandAck[] {
    const acks = this.acks;
    this.acks = [];
    return acks;
  }

  /** One fixed transition n → n+1, in SPEC §9.2 order. */
  step(): void {
    if (this.fault) throw this.fault;
    const world = this.world!;
    this.settleBoundary();
    this.runLifecycle();

    // Every force comes from the same start-of-step state; nothing is applied until all exist.
    const fieldStart = performance.now();
    const { ambientAcceleration: g, maxAppliedAcceleration } = this.root.simulation;
    const { bodies, compiled, sample, accel, forces } = this;
    for (let i = 0; i < bodies.length; i++) {
      const live = bodies[i]!;
      const p = live.body.translation();
      let ax = g[0];
      let ay = g[1];
      let az = g[2];
      for (const field of compiled) {
        sampleField(field, p.x, p.y, p.z, sample);
        if (!finite3(sample[0]!, sample[1]!, sample[2]!)) {
          throw (this.fault = new SimulationFault(this.tick, `${field.id} → ${live.id}`, 'Nonfinite field output'));
        }
        ax += sample[0]!;
        ay += sample[1]!;
        az += sample[2]!;
      }
      limitAcceleration(ax, ay, az, maxAppliedAcceleration, accel);
      // Acceleration → force with the engine-reported mass, so the law is mass-independent.
      const mass = live.body.mass();
      forces[3 * i] = mass * accel[0]!;
      forces[3 * i + 1] = mass * accel[1]!;
      forces[3 * i + 2] = mass * accel[2]!;
    }
    // Rapier keeps added forces until cleared: clear each body's prior total, then add the new one once.
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!.body;
      this.force.x = forces[3 * i]!;
      this.force.y = forces[3 * i + 1]!;
      this.force.z = forces[3 * i + 2]!;
      body.resetForces(true);
      body.addForce(this.force, true);
    }
    const engineStart = performance.now();
    world.step();
    const engineEnd = performance.now();
    this.lastFieldMs = engineStart - fieldStart;
    this.lastEngineMs = engineEnd - engineStart;

    for (const live of bodies) {
      const p = live.body.translation();
      const v = live.body.linvel();
      const valid =
        finite3(p.x, p.y, p.z) &&
        finite3(v.x, v.y, v.z) &&
        Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) <= MAX_POSITION &&
        Math.hypot(v.x, v.y, v.z) <= MAX_SPEED;
      if (!valid) throw (this.fault = new SimulationFault(this.tick + 1, live.id, 'Invalid engine state'));
    }
    this.tick += 1;
    this.publish();
  }

  /** Applied laws, in stable ID order. */
  appliedFields(): readonly FieldDefinition[] {
    return this.fieldDefs;
  }

  /** The compiled form of an applied law: the exact evaluator the simulation samples. */
  compiledField(id: string): CompiledField | undefined {
    return this.compiled.find((f) => f.id === id);
  }

  canonicalState(): CanonicalState {
    return {
      tick: this.tick,
      lastAppliedSequence: this.lastAppliedSequence,
      skippedEmissions: this.skippedEmissions,
      emitters: this.emitters.map((e) => ({ id: e.def.id, prngState: e.prng, ordinal: e.ordinal })),
      // A snapshot of the array: settling replaces entries in place, and a checkpoint must keep
      // the laws of its own tick. The entries themselves are frozen.
      fields: [...this.fieldDefs],
      bodies: [...this.bodies].sort(byId).map((live) => {
        const t = live.body.translation();
        const r = live.body.rotation();
        const v = live.body.linvel();
        const w = live.body.angvel();
        return {
          id: live.id,
          deathTick: Number.isFinite(live.deathTick) ? live.deathTick : null,
          translation: [t.x, t.y, t.z],
          rotation: [r.x, r.y, r.z, r.w],
          linvel: [v.x, v.y, v.z],
          angvel: [w.x, w.y, w.z],
        };
      }),
    };
  }

  /** Engine snapshot bytes, for same-environment comparison only (SPEC §13.4). */
  engineSnapshot(): Uint8Array {
    return this.world!.takeSnapshot();
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
  }

  /** Boundary n: expire bodies with deathTick ≤ n in stable ID order, then spawn due bodies by emitter ID (SPEC §5.3). */
  private runLifecycle(): void {
    const n = this.tick;
    const expiring = this.bodies.filter((b) => b.deathTick <= n);
    if (expiring.length) {
      for (const live of expiring.sort(byId)) this.world!.removeRigidBody(live.body);
      this.bodies = this.bodies.filter((b) => b.deathTick > n);
    }
    for (const emitter of this.emitters) {
      const def = emitter.def;
      if (n < def.startTick || (n - def.startTick) % def.intervalTicks !== 0) continue;
      // Exactly three draws per scheduled birth, even for zero jitter or a skipped spawn.
      const ox = (2 * this.draw(emitter) - 1) * def.jitter[0];
      const oy = (2 * this.draw(emitter) - 1) * def.jitter[1];
      const oz = (2 * this.draw(emitter) - 1) * def.jitter[2];
      const ordinal = emitter.ordinal++;
      if (this.bodies.length >= this.root.simulation.maxLiveBodies) {
        this.skippedEmissions += 1;
        continue;
      }
      const { template } = def;
      const position: Vec3 = [def.position[0] + ox, def.position[1] + oy, def.position[2] + oz];
      const body = this.createBody(position, template.linearVelocity, template.collider, template.material, template.collisionMode, template.massKg);
      this.bodies.push({ id: `${def.id}:${ordinal}`, body, radius: radiusOf(template.collider), deathTick: n + def.lifetimeTicks });
    }
  }

  private draw(emitter: EmitterState): number {
    emitter.prng = xorshift32(emitter.prng);
    return emitter.prng / 2 ** 32;
  }

  /** Creates one body with one centered collider; a dynamic collider carries the full authored mass (SPEC §5.2). */
  private createBody(
    position: Vec3,
    velocity: Vec3,
    collider: ColliderShape,
    material: BodyMaterial,
    mode: CollisionMode,
    massKg: number | null,
  ): RAPIER.RigidBody {
    const desc =
      massKg === null
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic()
            .setLinvel(velocity[0], velocity[1], velocity[2])
            .setLinearDamping(0)
            .setAngularDamping(0)
            .setCcdEnabled(true)
            .setCanSleep(false);
    desc.setTranslation(position[0], position[1], position[2]);
    const body = this.world!.createRigidBody(desc);
    const shape =
      collider.kind === 'sphere'
        ? RAPIER.ColliderDesc.ball(collider.radius)
        : RAPIER.ColliderDesc.cuboid(collider.halfExtents[0], collider.halfExtents[1], collider.halfExtents[2]);
    const groups = massKg === null ? GROUPS.fixed : GROUPS[mode];
    shape.setFriction(material.friction).setRestitution(material.restitution).setCollisionGroups(groups).setSolverGroups(groups);
    if (massKg !== null) shape.setMass(massKg);
    this.world!.createCollider(shape, body);
    return body;
  }

  private publish(): void {
    const { bodies, positions, radii } = this;
    for (let i = 0; i < bodies.length; i++) {
      const live = bodies[i]!;
      const p = live.body.translation();
      positions[3 * i] = p.x;
      positions[3 * i + 1] = p.y;
      positions[3 * i + 2] = p.z;
      radii[i] = live.radius;
    }
    this.count = bodies.length;
  }
}

/** M1 renders dynamic bodies as spheres, so a dynamic body must be one (dynamic boxes arrive with M3's collision example). */
function radiusOf(collider: ColliderShape): number {
  if (collider.kind !== 'sphere') throw new Error('M1 supports only spherical dynamic bodies.');
  return collider.radius;
}
