// Inertial field probes (SPEC §12, §18.1 class B): collision-free particles sampled by the host's
// own compiled kernel, accelerated by the same aggregate adapter and limiter as rigid bodies, then
// moved by the specified semi-implicit update x_next = x + h·v_next. They keep their own arrays and
// their own seeded xorshift32 stream, and read the host without writing to it: no Rapier body, no
// emitter draw, no command. They are not rigid bodies and never stand in for one.
import { sampleField } from '../fields/kernel';
import { regionDescriptor } from '../fields/registry';
import { adaptAcceleration } from '../simulation/adapter';
import { STEP_SECONDS, xorshift32, type SimulationHost } from '../simulation/host';

export const MAX_PROBES = 2000;
/** Each probe lives 1.5 s, then is born again elsewhere; births are staggered across the population. */
export const PROBE_LIFETIME_TICKS = 180;
/** Probes are born uniformly in the box around every enabled law's support, widened by this. */
export const PROBE_MARGIN_M = 0.5;
export const DEFAULT_PROBE_SEED = 1;

export interface ProbeSettings {
  readonly enabled: boolean;
  /** 0 … MAX_PROBES. */
  readonly count: number;
  /** A nonzero uint32. */
  readonly seed: number;
}

export function checkProbeSettings(s: ProbeSettings): string | null {
  if (!Number.isInteger(s.count) || s.count < 0 || s.count > MAX_PROBES) return `probe count must be a whole number from 0 to ${MAX_PROBES}`;
  if (!Number.isInteger(s.seed) || s.seed < 1 || s.seed > 0xffffffff) return 'probe seed must be a whole number from 1 to 4294967295';
  return null;
}

/** Probe i is born at every tick t with (t − phase(i)) mod lifetime = 0, so births spread evenly. */
export const probePhase = (i: number, count: number) => Math.floor((i * PROBE_LIFETIME_TICKS) / count);

export class ProbeField {
  readonly position = new Float64Array(MAX_PROBES * 3);
  readonly velocity = new Float64Array(MAX_PROBES * 3);
  /** 1 for a probe that exists now; 0 when no enabled law gave it a birthplace, or its state went nonfinite. */
  readonly alive = new Uint8Array(MAX_PROBES);
  /** The tick of each probe's latest birth. */
  readonly bornAt = new Float64Array(MAX_PROBES);
  /** The tick the stored state belongs to; −1 when none is current. */
  tick = -1;
  /** Probes alive now. */
  live = 0;
  /** Changes whenever the stored state does. */
  version = 0;
  private current: ProbeSettings = { enabled: false, count: MAX_PROBES, seed: DEFAULT_PROBE_SEED };
  private prng = DEFAULT_PROBE_SEED;
  private generation = -1;
  private readonly box = new Float64Array(6);
  private readonly sample = [0, 0, 0, 0];
  private readonly adapted = [0, 0, 0, 0, 0];

  get settings(): ProbeSettings {
    return this.current;
  }

  /** New settings restart the population at the host's current tick, from the seed. */
  configure(settings: ProbeSettings): void {
    const problem = checkProbeSettings(settings);
    if (problem) throw new Error(problem);
    const s = this.current;
    if (s.enabled === settings.enabled && s.count === settings.count && s.seed === settings.seed) return;
    this.current = { ...settings };
    this.tick = -1;
    this.live = 0;
    this.version += 1;
  }

  private get active(): boolean {
    return this.current.enabled && this.current.count > 0;
  }

  /** Brings the probes to the host's world and tick when they are not there, e.g. when enabled while paused. */
  sync(host: SimulationHost): void {
    if (this.active && (this.generation !== host.generation || this.tick !== host.tick)) this.initialize(host);
  }

  /**
   * Called after every completed host step n → n+1: one probe step under the laws that transition
   * used, then the births due at n+1. Probes that missed a step start again from the seed instead.
   */
  advance(host: SimulationHost): void {
    if (!this.active) return;
    if (this.generation !== host.generation || this.tick !== host.tick - 1) {
      this.initialize(host);
      return;
    }
    const fields = host.compiledFields();
    const { ambientAcceleration: g, maxAppliedAcceleration } = host.settings;
    const { position: x, velocity: v, alive, sample, adapted } = this;
    const h = STEP_SECONDS;
    const n = this.current.count;
    // The transition the host just completed, tick → tick + 1: the probes sample the laws at its tick.
    const tick = this.tick;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const px = x[3 * i]!;
      const py = x[3 * i + 1]!;
      const pz = x[3 * i + 2]!;
      // A = g + ΣA_i and K = ΣK_i in stable law order, as the host sums them for a body.
      let ax = g[0];
      let ay = g[1];
      let az = g[2];
      let k = 0;
      for (let f = 0; f < fields.length; f++) {
        sampleField(fields[f]!, px, py, pz, tick, sample);
        ax += sample[0]!;
        ay += sample[1]!;
        az += sample[2]!;
        k += sample[3]!;
      }
      adaptAcceleration(ax, ay, az, k, v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!, h, maxAppliedAcceleration, adapted);
      // v_next = v + h·λ·a*, then x_next = x + h·v_next (SPEC §12).
      const vx = v[3 * i]! + h * adapted[0]!;
      const vy = v[3 * i + 1]! + h * adapted[1]!;
      const vz = v[3 * i + 2]! + h * adapted[2]!;
      const nx = px + h * vx;
      const ny = py + h * vy;
      const nz = pz + h * vz;
      if (!(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz) && Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz))) {
        alive[i] = 0;
        continue;
      }
      v[3 * i] = vx;
      v[3 * i + 1] = vy;
      v[3 * i + 2] = vz;
      x[3 * i] = nx;
      x[3 * i + 1] = ny;
      x[3 * i + 2] = nz;
      live += 1;
    }
    this.tick = host.tick;
    this.live = live;
    const hasBox = this.spawnBox(host);
    for (let i = 0; i < n; i++) {
      if ((this.tick - probePhase(i, n)) % PROBE_LIFETIME_TICKS === 0) this.birth(i, hasBox);
    }
    this.version += 1;
  }

  /** Bytes of every array the probes own; all are allocated once, for MAX_PROBES. */
  bytes(): Record<string, number> {
    return {
      probePositions: this.position.byteLength,
      probeVelocities: this.velocity.byteLength,
      probeAlive: this.alive.byteLength,
      probeBirths: this.bornAt.byteLength,
    };
  }

  /** Every probe born now, at rest, in index order from the seed. */
  private initialize(host: SimulationHost): void {
    this.prng = this.current.seed >>> 0;
    this.generation = host.generation;
    this.tick = host.tick;
    this.live = 0;
    this.alive.fill(0);
    const hasBox = this.spawnBox(host);
    for (let i = 0; i < this.current.count; i++) this.birth(i, hasBox);
    this.version += 1;
  }

  /** Three draws per birth, always, so the stream's position depends only on the births scheduled. */
  private birth(i: number, hasBox: boolean): void {
    const b = this.box;
    const wasAlive = this.alive[i] === 1;
    for (let c = 0; c < 3; c++) {
      this.prng = xorshift32(this.prng);
      this.position[3 * i + c] = hasBox ? b[c]! + (this.prng / 2 ** 32) * (b[c + 3]! - b[c]!) : 0;
      this.velocity[3 * i + c] = 0;
    }
    this.bornAt[i] = this.tick;
    this.alive[i] = hasBox ? 1 : 0;
    this.live += (hasBox ? 1 : 0) - (wasAlive ? 1 : 0);
  }

  /**
   * The world-aligned box around every enabled law's support, widened by the margin, into `box` as
   * min [0..2] and max [3..5]. False when no law is enabled: probes then have nowhere to be born.
   */
  private spawnBox(host: SimulationHost): boolean {
    const b = this.box;
    b.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    const fields = host.appliedFields();
    const compiled = host.compiledFields();
    let any = false;
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f]!;
      if (!field.enabled) continue;
      any = true;
      const half = regionDescriptor(field.region.kind).bounds(field.region);
      const { m, px, py, pz } = compiled[f]!;
      const center = [px, py, pz];
      for (let r = 0; r < 3; r++) {
        const reach = Math.abs(m[3 * r]!) * half[0] + Math.abs(m[3 * r + 1]!) * half[1] + Math.abs(m[3 * r + 2]!) * half[2];
        b[r] = Math.min(b[r]!, center[r]! - reach - PROBE_MARGIN_M);
        b[r + 3] = Math.max(b[r + 3]!, center[r]! + reach + PROBE_MARGIN_M);
      }
    }
    return any;
  }
}
