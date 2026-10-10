import RAPIER from '@dimforge/rapier3d-compat';
import {
  SIMULATION_PROFILE_ID,
  type BodyMaterial,
  type ColliderShape,
  type CollisionMode,
  type EmitterDefinition,
  type FieldDefinition,
  type Quat,
  type SceneDefinition,
  type Vec3,
} from '../domain/scene';
import { compileField, sampleField, type CompiledField } from '../fields/kernel';
import { adaptAcceleration } from './adapter';
import { observeTransition, type TransitionObservation } from './observation';
import type { SimulationSettings } from '../domain/scene';

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
  /**
   * Rapier's linear-speed cap in m/s (its normalized maximum linear velocity × lengthUnit). It
   * is not readable through the JS API, so a test characterizes it against the engine.
   */
  engineSpeedCap: 400,
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

/** Rapier worlds allocated in this process now, and the most at once since the last `resetPeakWorlds` (SPEC §18.2 resource accounting). */
let allocatedWorlds = 0;
let peakWorlds = 0;

export function worldCounts(): { allocated: number; peak: number } {
  return { allocated: allocatedWorlds, peak: peakWorlds };
}

export function resetPeakWorlds(): void {
  peakWorlds = allocatedWorlds;
}

function freeWorld(world: RAPIER.World): void {
  world.free();
  allocatedWorlds -= 1;
}

/** A world under the profile: zero engine gravity (gravity enters through the adapter, SPEC §9.1). */
function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  allocatedWorlds += 1;
  peakWorlds = Math.max(peakWorlds, allocatedWorlds);
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
      freeWorld(world);
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
    freeWorld(world);
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
export interface RemoveField {
  readonly kind: 'removeField';
  readonly id: string;
}
/** Replaces the ambient acceleration (SPEC §10.2): a physics command, validated (finite, at most 200 m/s²) before submission. */
export interface SetAmbient {
  readonly kind: 'setAmbient';
  readonly acceleration: Vec3;
}
/** The command vocabulary (SPEC §10.2): a complete validated field put, removal of a known law, or the ambient acceleration. */
export type CommandPayload = PutField | RemoveField | SetAmbient;

/** The law a command addresses; null for the ambient acceleration. */
export const commandTarget = (payload: CommandPayload): string | null =>
  payload.kind === 'putField' ? payload.field.id : payload.kind === 'removeField' ? payload.id : null;

/** Transaction of a command submitted without one: scripted fixtures, never the document controller. */
export const UNATTRIBUTED = 'unattributed';

/**
 * A command as the host consumed it (SPEC §10.2): applied at boundary `atTick`, before the transition
 * atTick → atTick+1, as the run's `sequence`th command. Its payload is the complete resolved value.
 */
export interface AppliedCommand {
  readonly atTick: number;
  readonly sequence: number;
  readonly transactionId: string;
  readonly payload: CommandPayload;
}

export interface CommandAck {
  readonly tick: number;
  readonly sequence: number;
  readonly documentRevision: number;
  readonly transactionId: string;
  readonly payload: CommandPayload;
}

/**
 * The run recorder's view of command consumption (SPEC §13.3). `admit` is the preflight: it sees a
 * resolved command before it mutates anything and refuses one the record cannot hold, closing the
 * record at the last accepted address. `append` follows a successful application; `stepped` follows
 * every completed transition and may close the record at its duration limit.
 */
export interface CommandRecorder {
  admit(command: AppliedCommand): boolean;
  append(command: AppliedCommand): void;
  stepped(tick: number): void;
}

/**
 * Nonfinite field output, invalid engine state, or a tick or schedule leaving the safe-integer
 * range; the host refuses to step until reset (SPEC §5.3, §9.3, §10.1, §16).
 */
export class SimulationFault extends Error {
  constructor(
    readonly tick: number,
    readonly entity: string,
    readonly reason: string,
  ) {
    super(`${reason}: ${entity} at tick ${tick}`);
  }
}

/**
 * Every future-affecting value the host holds beyond the engine snapshot (SPEC §13.4): the canonical
 * state plus the live simulation settings, which `setAmbient` changes. Body colliders, materials and
 * emitter definitions come from the run root, which a replay shares by construction.
 */
export interface FutureState extends CanonicalState {
  simulation: SimulationSettings;
}

/** A living dynamic body in a checkpointed world (SPEC §14.1): its stable ID, the snapshot's handles and its rendered radius. */
export interface BodyHandleMapping {
  readonly id: string;
  readonly body: number;
  readonly collider: number;
  readonly radius: number;
}

/** When a living dynamic body expires: null for an authored body, which has no implicit lifetime. */
export interface BodyLifetime {
  readonly id: string;
  readonly deathTick: number | null;
}

/** An emitter's runtime state; its schedule follows from its definition in the root, the tick and the ordinal. */
export interface EmitterRuntimeState {
  readonly id: string;
  readonly prngState: number;
  readonly ordinal: number;
}

/** Which body a collider belongs to, fixed ones included: how contact partners are named. */
export interface ColliderIdentity {
  readonly collider: number;
  readonly id: string;
}

/**
 * The host's complete state at a settled boundary (SPEC §14.1): the engine snapshot and every value
 * beyond it that a later step reads. Captured in one synchronous call between steps, with nothing
 * queued, so lifecycle for `tick` has not run yet (`settled-before-lifecycle`). Everything else a
 * step reads is the immutable run root: body and emitter definitions and the other settings.
 */
export interface HostCheckpoint {
  readonly tick: number;
  readonly lastAppliedSequence: number;
  readonly phase: 'settled-before-lifecycle';
  readonly engineBytes: Uint8Array;
  /** Applied laws in stable ID order. */
  readonly activeFields: readonly FieldDefinition[];
  readonly ambientAcceleration: Vec3;
  readonly emitterStates: readonly EmitterRuntimeState[];
  /** Living dynamic bodies in the host's order: authored by ID, then emitted in spawn order. */
  readonly bodyIdentityMap: readonly BodyHandleMapping[];
  /** The same bodies, in the same order. */
  readonly bodyLifetimes: readonly BodyLifetime[];
  readonly colliderIdentity: readonly ColliderIdentity[];
  readonly skippedEmissions: number;
  /** What the last step left for diagnostics: the fastest body's speed, and limited body-steps since the root. */
  readonly maxSpeed: number;
  readonly limitedSteps: number;
}

/** A checkpoint the host cannot restore: inconsistent with its root or with its own engine snapshot. */
export class CheckpointRejected extends Error {}

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

/**
 * Supported-domain runtime stops (SPEC §9.3). The speed stop sits below the engine's cap
 * (`SIMULATION_PROFILE.engineSpeedCap`), so unsupported motion stops before Rapier clamps it.
 */
export const MAX_SUPPORTED_SPEED = 350;
const MAX_POSITION = 10000;

interface LiveBody {
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly radius: number;
  /** Infinity for authored bodies, which have no implicit lifetime. */
  readonly deathTick: number;
}

/** A scheduled birth falls at boundary n: on the emitter's interval, and within its count. */
const due = ({ def, ordinal }: EmitterState, n: number) =>
  n >= def.startTick && (n - def.startTick) % def.intervalTicks === 0 && (def.emissionCount === undefined || ordinal < def.emissionCount);

/**
 * n + ticks is a safe integer (SPEC §5.3), decided exactly: for a safe n ≥ 0 the headroom
 * MAX_SAFE_INTEGER − n is itself a safe integer, so neither it nor the comparison rounds.
 */
const fitsSafe = (n: number, ticks: number) => ticks <= Number.MAX_SAFE_INTEGER - n;

interface EmitterState {
  readonly def: EmitterDefinition;
  prng: number;
  ordinal: number;
}

interface PendingCommand {
  readonly documentRevision: number;
  readonly transactionId: string;
  readonly payload: CommandPayload;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const IDENTITY: Quat = [0, 0, 0, 1];
const finite3 = (x: number, y: number, z: number) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
/** Laws per scene at most (SPEC §15.2), so one body's per-law samples fit a fixed buffer. */
const MAX_LAWS = 32;
/** Worlds built in this process; each reset takes the next, so observers can tell one world from another. */
let worldsBuilt = 0;

/**
 * The only owner of a Rapier world (SPEC §4, C5). UI and rendering submit validated commands
 * and read observations; nothing else creates, steps or mutates the world.
 */
export class SimulationHost {
  private world: RAPIER.World | null = null;
  private root!: SceneDefinition;
  /** The root's settings with the current ambient acceleration, which `setAmbient` replaces. */
  private live!: SimulationSettings;
  tick = 0;
  lastAppliedSequence = 0;
  skippedEmissions = 0;
  fault: SimulationFault | null = null;
  /**
   * The run recorder consuming this world's commands, if a recording is active (SPEC §13.3). Set and
   * cleared by the recorder; a replay world never has one.
   */
  recorder: CommandRecorder | null = null;
  /**
   * Set when the recorder closed at a limit (SPEC §13.3): nothing is consumed and nothing steps until the
   * owner discards the queued commands and calls `releaseHalt`, so neither can spill past the record.
   */
  halted = false;

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
  /** Stable ID of the body at each published index. */
  readonly ids: string[] = [];
  count = 0;
  /**
   * Identity of the world: a new value on every reset, unique in this process, so trails and probes
   * never carry a sample from one world into another. Not simulation state.
   */
  generation = 0;

  /**
   * The body whose transitions are retained for explanation (SPEC §12): UI state handed to the host.
   * Choosing it changes what is recorded about a step, never what the step computes.
   */
  private explainId: string | null = null;
  /** The explained body's last completed transition; null until one completes in this world. */
  explanation: TransitionObservation | null = null;
  private explainSamples = new Float64Array(4 * MAX_LAWS);
  /** Center [0..2] and velocity [3..5] at the boundary, then the adapter's output [6..10]. */
  private readonly explainState = new Float64Array(11);
  /** Stable ID of every live collider's body, fixed ones included, for naming contact partners. */
  private colliderIds = new Map<number, string>();

  /** Diagnostic timing of the last step's field sampling and engine step, in ms. */
  lastFieldMs = 0;
  lastEngineMs = 0;
  /** Fastest live body after the last step, m/s: the one-step travel the narrow-support diagnostic compares (SPEC §7). */
  maxSpeed = 0;
  /** Body-steps since reset whose external acceleration the global limiter scaled (λ < 1, SPEC §9.1, §16). */
  limitedSteps = 0;

  private forces = new Float64Array(0);
  /** A field sample: world drive A in [0..2] and drag rate K in [3]. */
  private readonly sample = [0, 0, 0, 0];
  /** The adapter's result: λ·a* in [0..2], β in [3], λ in [4]. */
  private readonly accel = [0, 0, 0, 0, 0];
  private readonly force = { x: 0, y: 0, z: 0 };

  /** A world built from `root` at tick 0, or, with a checkpoint, restored from it under that same root (SPEC §14.1). */
  constructor(root: SceneDefinition, from?: HostCheckpoint) {
    if (from) this.restore(root, from);
    else this.reset(root);
  }

  /** Rebuilds the world from a frozen run root at tick 0 (SPEC §13.2). Pending commands are dropped. */
  reset(root: SceneDefinition): void {
    // A recording belongs to one world from its root: rebuilding under it would corrupt the record.
    if (this.recorder) throw new Error('A recording is active on this world; stop it before resetting.');
    if (root.simulation.profile !== SIMULATION_PROFILE.id) {
      throw new Error(`Scene requires profile ${root.simulation.profile}; this build provides ${SIMULATION_PROFILE.id}.`);
    }
    const authoredDynamic = root.bodies.filter((b) => b.type === 'dynamic').length;
    if (authoredDynamic > root.simulation.maxLiveBodies) {
      throw new Error(`Scene has ${authoredDynamic} dynamic bodies; its limit is ${root.simulation.maxLiveBodies}.`);
    }
    for (const def of root.bodies) if (def.type === 'dynamic') radiusOf(def.collider);
    for (const def of root.emitters) radiusOf(def.template.collider);
    if (this.world) freeWorld(this.world);
    this.world = null;
    this.world = createWorld();
    this.generation = ++worldsBuilt;
    this.explanation = null;
    this.colliderIds = new Map();
    this.root = root;
    this.live = root.simulation;
    this.halted = false;
    this.tick = 0;
    this.lastAppliedSequence = 0;
    this.skippedEmissions = 0;
    this.fault = null;
    this.maxSpeed = 0;
    this.limitedSteps = 0;
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
      const { position, rotation } = def.initialPose;
      const { body, collider } = this.createBody(def.id, position, rotation, def.initialLinearVelocity, def.initialAngularVelocity, def.collider, def.material, def.collisionMode, mass);
      if (mass !== null) this.bodies.push({ id: def.id, body, collider, radius: radiusOf(def.collider), deathTick: Infinity });
    }
    this.publish();
  }

  /**
   * Restores a checkpoint under its run root (SPEC §14.1): a new world from the engine snapshot, then
   * every lookup the host keeps rebuilt from the sidecar and checked against that world. Nothing is
   * rebuilt from poses or velocities: contacts, solver state and handles come from the snapshot.
   */
  private restore(root: SceneDefinition, from: HostCheckpoint): void {
    if (root.simulation.profile !== SIMULATION_PROFILE.id) {
      throw new Error(`Scene requires profile ${root.simulation.profile}; this build provides ${SIMULATION_PROFILE.id}.`);
    }
    const reject = (reason: string): never => {
      throw new CheckpointRejected(`The checkpoint at (${from.tick}, ${from.lastAppliedSequence}) ${reason}.`);
    };
    const tick = from.tick;
    if (from.phase !== 'settled-before-lifecycle') reject(`was not captured at a settled boundary (${String(from.phase)})`);
    if (!Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(from.lastAppliedSequence) || from.lastAppliedSequence < 0) reject('has no valid address');
    const emitterDefs = [...root.emitters].sort(byId);
    const states = from.emitterStates;
    if (states.length !== emitterDefs.length || states.some((s, i) => s.id !== emitterDefs[i]!.id || !Number.isInteger(s.prngState) || s.prngState < 0 || s.prngState > 0xffffffff || !Number.isSafeInteger(s.ordinal) || s.ordinal < 0)) {
      reject('does not hold this root’s emitters');
    }
    const fields = from.activeFields;
    if (fields.length > MAX_LAWS || fields.some((f, i) => i > 0 && !(fields[i - 1]!.id < f.id))) reject('does not hold its laws in stable ID order');
    const mappings = from.bodyIdentityMap;
    const lifetimes = from.bodyLifetimes;
    const authored = new Set(root.bodies.filter((b) => b.type === 'dynamic').map((b) => b.id));
    const fixed = root.bodies.filter((b) => b.type === 'fixed').map((b) => b.id);
    if (mappings.length > root.simulation.maxLiveBodies || lifetimes.length !== mappings.length) reject('holds more bodies than its root allows');
    for (let i = 0; i < mappings.length; i++) {
      const { id } = mappings[i]!;
      const death = lifetimes[i]!;
      // Lifecycle for `tick` has not run: a body dying at `tick` is still alive, an earlier death is gone.
      const lives = death.id === id && (death.deathTick === null ? authored.has(id) : Number.isSafeInteger(death.deathTick) && death.deathTick >= tick && !authored.has(id));
      if (!lives) reject(`has an inconsistent lifetime for body ${id}`);
    }
    if (mappings.filter((m) => authored.has(m.id)).length !== authored.size) reject('is missing an authored body');

    const world = RAPIER.World.restoreSnapshot(from.engineBytes);
    if (!world) reject('holds engine bytes that do not deserialize');
    allocatedWorlds += 1;
    peakWorlds = Math.max(peakWorlds, allocatedWorlds);
    try {
      const effective = readProfile(world);
      for (const [key, expected] of Object.entries(SIMULATION_PROFILE.effective)) {
        if (!Object.is(effective[key as keyof EffectiveProfile], expected)) reject(`restores ${key} ${effective[key as keyof EffectiveProfile]}, not the profile’s ${expected}`);
      }
      const g = world.gravity;
      if (g.x !== 0 || g.y !== 0 || g.z !== 0) reject('restores engine gravity');
      const bodies: LiveBody[] = [];
      for (const m of mappings) {
        const body = world.getRigidBody(m.body);
        const collider = world.getCollider(m.collider);
        if (!body || !collider || !body.isDynamic() || body.numColliders() !== 1 || body.collider(0).handle !== m.collider || Math.fround(m.radius) !== collider.radius()) {
          reject(`does not match its engine snapshot for body ${m.id}`);
        }
        const deathTick = lifetimes[bodies.length]!.deathTick;
        bodies.push({ id: m.id, body, collider, radius: m.radius, deathTick: deathTick ?? Infinity });
      }
      const named = new Set(from.colliderIdentity.map((c) => c.id));
      const expectedNames = [...mappings.map((m) => m.id), ...fixed];
      const colliderIds = new Map(from.colliderIdentity.map((c) => [c.collider, c.id] as const));
      const total = mappings.length + fixed.length;
      if (world.bodies.len() !== total || world.colliders.len() !== total || colliderIds.size !== total || named.size !== total || expectedNames.some((id) => !named.has(id))) {
        reject('does not account for every body and collider in its engine snapshot');
      }
      for (const m of mappings) if (colliderIds.get(m.collider) !== m.id) reject(`names collider ${m.collider} differently from body ${m.id}`);
      for (const handle of colliderIds.keys()) if (!world.getCollider(handle)) reject(`names collider ${handle}, which its engine snapshot lacks`);
      const compiled = fields.map(compileField);

      this.world = world;
      this.generation = ++worldsBuilt;
      this.explanation = null;
      this.colliderIds = colliderIds;
      this.root = root;
      this.live = Object.freeze({ ...root.simulation, ambientAcceleration: from.ambientAcceleration });
      this.halted = false;
      this.tick = tick;
      this.lastAppliedSequence = from.lastAppliedSequence;
      this.skippedEmissions = from.skippedEmissions;
      this.fault = null;
      this.maxSpeed = from.maxSpeed;
      this.limitedSteps = from.limitedSteps;
      this.pending = [];
      this.acks = [];
      this.fieldDefs = [...fields];
      this.compiled = compiled;
      this.emitters = emitterDefs.map((def, i) => ({ def, prng: states[i]!.prngState, ordinal: states[i]!.ordinal }));
      const capacity = root.simulation.maxLiveBodies;
      this.positions = new Float32Array(capacity * 3);
      this.radii = new Float32Array(capacity);
      this.forces = new Float64Array(capacity * 3);
      this.bodies = bodies;
    } catch (error) {
      freeWorld(world);
      throw error;
    }
    this.publish();
  }

  /**
   * Queues a validated command for the next boundary. A put replaces an unconsumed put for the same
   * law at the end of the queue (pointer coalescing, SPEC §10.2); structural order is otherwise kept.
   */
  submit(payload: CommandPayload, documentRevision: number, transactionId: string = UNATTRIBUTED): void {
    const last = this.pending[this.pending.length - 1];
    const coalesce = last && payload.kind === 'putField' && last.payload.kind === 'putField' && last.payload.field.id === payload.field.id;
    if (coalesce) this.pending[this.pending.length - 1] = { documentRevision, transactionId, payload };
    else this.pending.push({ documentRevision, transactionId, payload });
  }

  /** Commands queued for the next boundary and not yet consumed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Frozen body/emitter definitions of this world, including a replay's original root. */
  get frozenRoot(): SceneDefinition {
    return this.root;
  }

  /** Actual completed poses in published ID order; no prediction or extrapolation. */
  writePoses(target: Float32Array, offset: number): void {
    if (offset < 0 || target.length - offset < this.count * 7) throw new Error('Pose buffer too small.');
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]!.body;
      const p = b.translation();
      const q = b.rotation();
      target.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], offset + i * 7);
    }
  }

  /**
   * Applies queued commands at the current boundary n, in sequence order, without advancing (SPEC §10.2).
   * An active recorder preflights each resolved command before it changes anything; a refusal halts
   * the host with that command and every later one still queued.
   */
  settleBoundary(): void {
    if (this.halted) return;
    let consumed = 0;
    try {
      for (const { documentRevision, transactionId, payload } of this.pending) {
        // Delete requires a known ID (SPEC §10.2); the document controller only removes laws it holds.
        if (payload.kind === 'removeField' && !this.fieldDefs.some((f) => f.id === payload.id)) throw new Error(`removeField: no law ${payload.id}`);
        const command: AppliedCommand = { atTick: this.tick, sequence: this.lastAppliedSequence + 1, transactionId, payload };
        if (this.recorder && !this.recorder.admit(command)) {
          this.halted = true;
          return;
        }
        this.apply(payload);
        this.lastAppliedSequence = command.sequence;
        this.recorder?.append(command);
        this.acks.push({ tick: this.tick, sequence: command.sequence, documentRevision, transactionId, payload });
        consumed += 1;
      }
    } finally {
      this.pending.splice(0, consumed);
    }
  }

  /**
   * Applies one recorded command at its own boundary (SPEC §13.3 linear replay): the same
   * interpretation as a consumed live command, with the recorded sequence and no acknowledgment, since
   * a replay world never feeds the authored document.
   */
  applyRecorded(command: AppliedCommand): void {
    if (this.fault) throw this.fault;
    if (command.atTick !== this.tick || command.sequence !== this.lastAppliedSequence + 1) {
      throw new Error(`recorded command ${command.sequence} at tick ${command.atTick} does not follow (${this.tick}, ${this.lastAppliedSequence})`);
    }
    const { payload } = command;
    if (payload.kind === 'removeField' && !this.fieldDefs.some((f) => f.id === payload.id)) throw new Error(`removeField: no law ${payload.id}`);
    this.apply(payload);
    this.lastAppliedSequence = command.sequence;
  }

  /** The one interpretation of a resolved command (SPEC §10.2), shared by live consumption and replay. */
  private apply(payload: CommandPayload): void {
    if (payload.kind === 'setAmbient') {
      this.live = Object.freeze({ ...this.live, ambientAcceleration: payload.acceleration });
      return;
    }
    const index = this.fieldDefs.findIndex((f) => f.id === commandTarget(payload));
    if (payload.kind === 'removeField') {
      this.fieldDefs.splice(index, 1);
      this.compiled.splice(index, 1);
    } else if (index >= 0) {
      this.fieldDefs[index] = payload.field;
      this.compiled[index] = compileField(payload.field);
    } else {
      this.fieldDefs.push(payload.field);
      this.fieldDefs.sort(byId);
      this.compiled = this.fieldDefs.map(compileField);
    }
  }

  /** Drops every queued command unconsumed: a recording that closed at a limit, or a guard's discard. */
  discardPending(): void {
    this.pending.length = 0;
  }

  /** Lets a host halted at a recording limit consume and step again, once its queue is discarded. */
  releaseHalt(): void {
    if (this.pending.length) throw new Error('queued commands must be discarded before a halted host resumes');
    this.halted = false;
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
    // A recording closed at a limit: the transition waits until its owner has resolved the stop (SPEC §13.3).
    if (this.halted) return;
    // SPEC §10.1: the completed-step count stays a safe integer. At the largest one the transition
    // faults at the settled boundary, before lifecycle, engine or clock change.
    if (!fitsSafe(this.tick, 1)) throw (this.fault = new SimulationFault(this.tick, 'simulation clock', 'Tick leaves the safe-integer range'));
    this.runLifecycle();

    // Every force comes from the same start-of-step state; nothing is applied until all exist.
    // Laws add in stable ID order: A = g + ΣA_i and K = ΣK_i, then one adapter call per body. Each
    // law is sampled at this boundary's tick n, the one input a tick-dependent gain reads.
    const fieldStart = performance.now();
    const { ambientAcceleration: g, maxAppliedAcceleration } = this.live;
    const { bodies, compiled, sample, accel, forces } = this;
    const n = this.tick;
    // The explained body's samples are copied as they are summed (SPEC §12): its explanation is this
    // transition's arithmetic, not a later re-evaluation. Every other body takes the plain path.
    const explained = this.explainId === null ? -1 : bodies.findIndex((b) => b.id === this.explainId);
    if (explained >= 0 && this.explainSamples.length < 4 * compiled.length) this.explainSamples = new Float64Array(4 * compiled.length);
    const record = this.explainSamples;
    for (let i = 0; i < bodies.length; i++) {
      const live = bodies[i]!;
      const p = live.body.translation();
      let ax = g[0];
      let ay = g[1];
      let az = g[2];
      let k = 0;
      for (let f = 0; f < compiled.length; f++) {
        const field = compiled[f]!;
        sampleField(field, p.x, p.y, p.z, n, sample);
        if (!finite3(sample[0]!, sample[1]!, sample[2]!) || !Number.isFinite(sample[3]!)) {
          throw (this.fault = new SimulationFault(this.tick, `${field.id} → ${live.id}`, 'Nonfinite field output'));
        }
        if (i === explained) record.set(sample, 4 * f);
        ax += sample[0]!;
        ay += sample[1]!;
        az += sample[2]!;
        k += sample[3]!;
      }
      // Drag needs the start-of-step velocity; without it the adapter's K = 0 path is the drive total.
      if (k === 0) adaptAcceleration(ax, ay, az, 0, 0, 0, 0, STEP_SECONDS, maxAppliedAcceleration, accel);
      else {
        const v = live.body.linvel();
        adaptAcceleration(ax, ay, az, k, v.x, v.y, v.z, STEP_SECONDS, maxAppliedAcceleration, accel);
      }
      if (accel[4]! < 1) this.limitedSteps += 1;
      // Acceleration → force with the engine-reported mass, so the law is mass-independent.
      const mass = live.body.mass();
      forces[3 * i] = mass * accel[0]!;
      forces[3 * i + 1] = mass * accel[1]!;
      forces[3 * i + 2] = mass * accel[2]!;
      if (i === explained) {
        // The velocity read is a getter; on the K ≠ 0 path it repeats the read the adapter used.
        const v = live.body.linvel();
        this.explainState.set([p.x, p.y, p.z, v.x, v.y, v.z, accel[0]!, accel[1]!, accel[2]!, accel[3]!, accel[4]!]);
      }
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

    let maxSpeed = 0;
    for (const live of bodies) {
      const p = live.body.translation();
      const v = live.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      let reason: string | null = null;
      if (!finite3(p.x, p.y, p.z) || !finite3(v.x, v.y, v.z)) reason = 'Invalid engine state';
      else if (Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) > MAX_POSITION) reason = `Position outside the supported ±${MAX_POSITION} m`;
      else if (speed > MAX_SUPPORTED_SPEED) reason = `Speed above the supported ${MAX_SUPPORTED_SPEED} m/s`;
      if (reason) throw (this.fault = new SimulationFault(this.tick + 1, live.id, reason));
      maxSpeed = Math.max(maxSpeed, speed);
    }
    this.maxSpeed = maxSpeed;
    if (explained >= 0) this.explanation = this.retain(bodies[explained]!, 3 * explained);
    this.tick += 1;
    this.publish();
    this.recorder?.stepped(this.tick);
  }

  /**
   * Chooses the body whose transitions are retained for explanation; null retains none. The current
   * explanation stays as it is: it names its own body, so it never reads as another body's.
   */
  explain(id: string | null): void {
    this.explainId = id;
  }

  /** The explained body's completed transition, from the values the step just used (SPEC §12). */
  private retain(live: LiveBody, at: number): TransitionObservation {
    const world = this.world!;
    const t = live.body.translation();
    const v = live.body.linvel();
    // SPEC §9.2 step 6, after the step and outside the solver: the colliders whose contact carried a
    // normal impulse during it, named by stable ID and sorted. Read-only narrow-phase queries.
    const partners = new Set<string>();
    world.contactPairsWith(live.collider, (other) => {
      let impulse = 0;
      world.contactPair(live.collider, other, (manifold) => {
        for (let c = 0; c < manifold.numContacts(); c++) impulse += manifold.contactImpulse(c);
      });
      if (impulse > 0) partners.add(this.colliderIds.get(other.handle) ?? `collider ${other.handle}`);
    });
    const s = this.explainState;
    return observeTransition({
      kind: 'applied',
      bodyId: live.id,
      fromTick: this.tick,
      cursor: this.lastAppliedSequence,
      laws: [...this.fieldDefs],
      gravity: this.live.ambientAcceleration,
      maxApplied: this.live.maxAppliedAcceleration,
      state: s,
      samples: this.explainSamples,
      adapted: s.subarray(6),
      mass: live.body.mass(),
      force: [this.forces[at]!, this.forces[at + 1]!, this.forces[at + 2]!],
      after: { center: [t.x, t.y, t.z], velocity: [v.x, v.y, v.z] },
      contacts: [...partners].sort(),
    });
  }

  /**
   * SPEC §12's paused "next-step preview": what the next transition would submit for the explained
   * body from its current center and velocity under the applied laws at the current tick, by the same
   * kernel and adapter. It writes nothing: the retained explanation, the world and the clock are untouched.
   */
  previewTransition(): TransitionObservation | null {
    const live = this.explainId === null || this.fault ? undefined : this.bodies.find((b) => b.id === this.explainId);
    if (!live) return null;
    const { ambientAcceleration: g, maxAppliedAcceleration } = this.live;
    const p = live.body.translation();
    const v = live.body.linvel();
    const samples = new Float64Array(4 * this.compiled.length);
    const sample = [0, 0, 0, 0];
    let ax = g[0];
    let ay = g[1];
    let az = g[2];
    let k = 0;
    for (let f = 0; f < this.compiled.length; f++) {
      sampleField(this.compiled[f]!, p.x, p.y, p.z, this.tick, sample);
      samples.set(sample, 4 * f);
      ax += sample[0]!;
      ay += sample[1]!;
      az += sample[2]!;
      k += sample[3]!;
    }
    const adapted = [0, 0, 0, 0, 0];
    if (k === 0) adaptAcceleration(ax, ay, az, 0, 0, 0, 0, STEP_SECONDS, maxAppliedAcceleration, adapted);
    else adaptAcceleration(ax, ay, az, k, v.x, v.y, v.z, STEP_SECONDS, maxAppliedAcceleration, adapted);
    const mass = live.body.mass();
    return observeTransition({
      kind: 'preview',
      bodyId: live.id,
      fromTick: this.tick,
      cursor: this.lastAppliedSequence,
      laws: [...this.fieldDefs],
      gravity: g,
      maxApplied: maxAppliedAcceleration,
      state: [p.x, p.y, p.z, v.x, v.y, v.z],
      samples,
      adapted,
      mass,
      force: [mass * adapted[0]!, mass * adapted[1]!, mass * adapted[2]!],
      after: null,
      contacts: null,
    });
  }

  /** Applied laws, in stable ID order. */
  appliedFields(): readonly FieldDefinition[] {
    return this.fieldDefs;
  }

  /** The compiled form of an applied law: the exact evaluator the simulation samples. */
  compiledField(id: string): CompiledField | undefined {
    return this.compiled.find((f) => f.id === id);
  }

  /** Every applied law's evaluator, in the stable order the step samples them. Read-only. */
  compiledFields(): readonly CompiledField[] {
    return this.compiled;
  }

  /** The simulation settings in force: the run root's, with the current ambient acceleration. */
  get settings(): SimulationSettings {
    return this.live;
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

  /** The canonical state and the live settings: what a replay must reproduce at an address (SPEC §13.4). */
  futureState(): FutureState {
    return { ...this.canonicalState(), simulation: this.live };
  }

  /**
   * Engine snapshot bytes, for same-environment comparison only (SPEC §13.4). Taking one observes the
   * world. These bytes are never restored: a restorable state is a complete `checkpoint()`.
   */
  engineSnapshot(): Uint8Array {
    return this.world!.takeSnapshot();
  }

  /**
   * The complete checkpoint at this boundary (SPEC §14.1): the engine snapshot and the sidecar, taken in
   * one synchronous call between steps. Refused with commands queued, while halted or after a fault, so
   * what it holds is always a settled boundary before its lifecycle.
   */
  checkpoint(): HostCheckpoint {
    if (this.fault) throw new Error(`A faulted world has no checkpoint: ${this.fault.message}.`);
    if (this.halted || this.pending.length > 0) throw new Error('A checkpoint is captured at a settled boundary, with nothing queued.');
    const bodies = this.bodies;
    return Object.freeze({
      tick: this.tick,
      lastAppliedSequence: this.lastAppliedSequence,
      phase: 'settled-before-lifecycle' as const,
      engineBytes: this.world!.takeSnapshot(),
      activeFields: Object.freeze([...this.fieldDefs]),
      ambientAcceleration: Object.freeze([...this.live.ambientAcceleration]) as unknown as Vec3,
      emitterStates: Object.freeze(this.emitters.map((e) => Object.freeze({ id: e.def.id, prngState: e.prng, ordinal: e.ordinal }))),
      bodyIdentityMap: Object.freeze(bodies.map((b) => Object.freeze({ id: b.id, body: b.body.handle, collider: b.collider.handle, radius: b.radius }))),
      bodyLifetimes: Object.freeze(bodies.map((b) => Object.freeze({ id: b.id, deathTick: Number.isFinite(b.deathTick) ? b.deathTick : null }))),
      colliderIdentity: Object.freeze([...this.colliderIds].map(([collider, id]) => Object.freeze({ collider, id }))),
      skippedEmissions: this.skippedEmissions,
      maxSpeed: this.maxSpeed,
      limitedSteps: this.limitedSteps,
    });
  }

  /** True once disposed: the world is freed and the host must not be used again. */
  get disposed(): boolean {
    return this.world === null;
  }

  dispose(): void {
    if (this.world) freeWorld(this.world);
    this.world = null;
  }

  /** Boundary n: expire bodies with deathTick ≤ n in stable ID order, then spawn due bodies by emitter ID (SPEC §5.3). */
  private runLifecycle(): void {
    const n = this.tick;
    // SPEC §5.3: a birth whose death tick, ordinal or next scheduled birth would leave the safe-integer
    // range faults before this boundary changes anything. Import bounds a finite schedule; this guards
    // an unbounded one, whose next birth always exists.
    for (const emitter of this.emitters) {
      if (!due(emitter, n)) continue;
      const { lifetimeTicks, intervalTicks, emissionCount } = emitter.def;
      const another = emissionCount === undefined || emitter.ordinal + 1 < emissionCount;
      if (!fitsSafe(n, lifetimeTicks) || !fitsSafe(emitter.ordinal, 1) || (another && !fitsSafe(n, intervalTicks))) {
        throw (this.fault = new SimulationFault(n, emitter.def.id, 'Emitter schedule leaves the safe-integer range'));
      }
    }
    const expiring = this.bodies.filter((b) => b.deathTick <= n);
    if (expiring.length) {
      for (const live of expiring.sort(byId)) {
        this.colliderIds.delete(live.collider.handle);
        this.world!.removeRigidBody(live.body);
      }
      this.bodies = this.bodies.filter((b) => b.deathTick > n);
    }
    for (const emitter of this.emitters) {
      if (!due(emitter, n)) continue;
      const def = emitter.def;
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
      const origin = def.pose.position;
      const position: Vec3 = [origin[0] + ox, origin[1] + oy, origin[2] + oz];
      const id = `${def.id}:${ordinal}`;
      const { body, collider } = this.createBody(
        id,
        position,
        IDENTITY,
        template.initialLinearVelocity,
        template.initialAngularVelocity,
        template.collider,
        template.material,
        template.collisionMode,
        template.massKg,
      );
      this.bodies.push({ id, body, collider, radius: radiusOf(template.collider), deathTick: n + def.lifetimeTicks });
    }
  }

  private draw(emitter: EmitterState): number {
    emitter.prng = xorshift32(emitter.prng);
    return emitter.prng / 2 ** 32;
  }

  /** Creates one body with one centered collider; a dynamic collider carries the full authored mass (SPEC §5.2). */
  private createBody(
    id: string,
    position: Vec3,
    rotation: Quat,
    velocity: Vec3,
    angularVelocity: Vec3,
    collider: ColliderShape,
    material: BodyMaterial,
    mode: CollisionMode,
    massKg: number | null,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const desc =
      massKg === null
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic()
            .setLinvel(velocity[0], velocity[1], velocity[2])
            .setAngvel({ x: angularVelocity[0], y: angularVelocity[1], z: angularVelocity[2] })
            .setLinearDamping(0)
            .setAngularDamping(0)
            .setCcdEnabled(true)
            .setCanSleep(false);
    desc.setTranslation(position[0], position[1], position[2]);
    desc.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
    const body = this.world!.createRigidBody(desc);
    const shape =
      collider.kind === 'sphere'
        ? RAPIER.ColliderDesc.ball(collider.radius)
        : RAPIER.ColliderDesc.cuboid(collider.halfExtents[0], collider.halfExtents[1], collider.halfExtents[2]);
    const groups = massKg === null ? GROUPS.fixed : GROUPS[mode];
    shape.setFriction(material.friction).setRestitution(material.restitution).setCollisionGroups(groups).setSolverGroups(groups);
    if (massKg !== null) shape.setMass(massKg);
    const created = this.world!.createCollider(shape, body);
    this.colliderIds.set(created.handle, id);
    return { body, collider: created };
  }

  private publish(): void {
    const { bodies, positions, radii, ids } = this;
    for (let i = 0; i < bodies.length; i++) {
      const live = bodies[i]!;
      const p = live.body.translation();
      positions[3 * i] = p.x;
      positions[3 * i + 1] = p.y;
      positions[3 * i + 2] = p.z;
      radii[i] = live.radius;
      ids[i] = live.id;
    }
    ids.length = bodies.length;
    this.count = bodies.length;
  }
}

/** Dynamic bodies render as spheres, so a dynamic body must be one. */
function radiusOf(collider: ColliderShape): number {
  if (collider.kind !== 'sphere') throw new Error('M1 supports only spherical dynamic bodies.');
  return collider.radius;
}
