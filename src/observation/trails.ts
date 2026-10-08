// Recorded body trails (SPEC §12): positions bodies actually occupied, copied from the host's
// published state after every fourth completed tick, each with its tick. Fixed ring buffers bound
// the memory by construction, and a new world clears them. Trails read the host and write nothing
// back; they record the past and never extend it.
import type { SimulationHost } from '../simulation/host';

/** One sample every fourth completed tick: 30 Hz at h = 1/120 s. */
export const TRAIL_INTERVAL_TICKS = 4;
/** Ten seconds of history at 30 Hz. */
export const TRAIL_SAMPLES = 300;
/** Bodies with a trail at once. */
export const MAX_TRAILS = 32;

/** `off` records nothing; `selected` the explained body only; `all` up to MAX_TRAILS bodies. */
export type TrailMode = 'off' | 'selected' | 'all';

export class TrailRecorder {
  /** Sample k of slot s at index s·TRAIL_SAMPLES + k: x, y, z (the host's f32 values, stored exactly). */
  readonly positions = new Float32Array(MAX_TRAILS * TRAIL_SAMPLES * 3);
  /** The completed tick of each sample. */
  readonly ticks = new Float64Array(MAX_TRAILS * TRAIL_SAMPLES);
  /** Stable ID of each slot's body; null for a free slot. */
  readonly owners: (string | null)[] = new Array<string | null>(MAX_TRAILS).fill(null);
  readonly lengths = new Int32Array(MAX_TRAILS);
  private readonly heads = new Int32Array(MAX_TRAILS);
  private readonly slotOf = new Map<string, number>();
  private current: TrailMode;
  private generation = -1;
  private lastTick = -1;
  /** Changes whenever the stored samples do, so a view rebuilds its lines only then. */
  version = 0;

  constructor(mode: TrailMode = 'selected') {
    this.current = mode;
  }

  get mode(): TrailMode {
    return this.current;
  }

  /** A different mode starts its trails afresh; `off` also stops all recording work. */
  set mode(mode: TrailMode) {
    if (mode === this.current) return;
    this.current = mode;
    this.clear();
  }

  clear(): void {
    this.owners.fill(null);
    this.slotOf.clear();
    this.lengths.fill(0);
    this.heads.fill(0);
    this.lastTick = -1;
    this.version += 1;
  }

  /**
   * Called every frame, paused or not: a world rebuilt or replaced since the last call (a reset, an
   * opened or recovered scene) clears every trail at once, so no earlier world's trail is ever drawn
   * over the new one (SPEC §13.2). It never stores a sample; samples come only from completed steps.
   */
  sync(host: SimulationHost): void {
    if (host.generation === this.generation) return;
    this.generation = host.generation;
    if (this.slotOf.size > 0 || this.lastTick !== -1) this.clear();
  }

  /**
   * Called after every completed host step. Samples only at ticks divisible by four, so presentation
   * cadence and dropped frames never decide which positions are stored.
   */
  record(host: SimulationHost, selected: string | null): void {
    if (this.current === 'off') return;
    this.sync(host);
    if (host.tick < this.lastTick) this.clear();
    const tick = host.tick;
    if (tick % TRAIL_INTERVAL_TICKS !== 0 || tick === this.lastTick) return;
    // Nothing explained and nothing held: no work at all.
    if (this.current === 'selected' && selected === null && this.slotOf.size === 0) return;
    this.lastTick = tick;

    const index = new Map<string, number>();
    for (let i = 0; i < host.count; i++) index.set(host.ids[i]!, i);
    // A body that died, or one no longer wanted, gives its slot back with its trail.
    for (let s = 0; s < MAX_TRAILS; s++) {
      const owner = this.owners[s]!;
      if (owner !== null && (!index.has(owner) || (this.current === 'selected' && owner !== selected))) this.free(s);
    }
    if (selected !== null && index.has(selected) && !this.slotOf.has(selected)) this.assign(selected, true);
    if (this.current === 'all') {
      for (let i = 0; i < host.count && this.slotOf.size < MAX_TRAILS; i++) if (!this.slotOf.has(host.ids[i]!)) this.assign(host.ids[i]!, false);
    }

    const { positions } = host;
    for (const [id, s] of this.slotOf) {
      const i = index.get(id)!;
      const at = s * TRAIL_SAMPLES + this.heads[s]!;
      this.positions[3 * at] = positions[3 * i]!;
      this.positions[3 * at + 1] = positions[3 * i + 1]!;
      this.positions[3 * at + 2] = positions[3 * i + 2]!;
      this.ticks[at] = tick;
      this.heads[s] = (this.heads[s]! + 1) % TRAIL_SAMPLES;
      this.lengths[s] = Math.min(TRAIL_SAMPLES, this.lengths[s]! + 1);
    }
    this.version += 1;
  }

  /** The buffer index of sample k of slot s, oldest first. */
  at(s: number, k: number): number {
    return s * TRAIL_SAMPLES + ((this.heads[s]! - this.lengths[s]! + k + TRAIL_SAMPLES) % TRAIL_SAMPLES);
  }

  /** Bodies with a trail now. */
  get count(): number {
    return this.slotOf.size;
  }

  /** The slot holding a body's trail, if it has one. */
  slot(id: string): number | undefined {
    return this.slotOf.get(id);
  }

  /** Bytes of every buffer the recorder owns; all are allocated once, at construction. */
  bytes(): Record<string, number> {
    return {
      trailPositions: this.positions.byteLength,
      trailTicks: this.ticks.byteLength,
      trailRings: this.lengths.byteLength + this.heads.byteLength,
    };
  }

  /** A slot for `id`: a free one, else (for the explained body only) the one with the shortest history. */
  private assign(id: string, evict: boolean): void {
    let s = this.owners.indexOf(null);
    if (s < 0) {
      if (!evict) return;
      s = 0;
      for (let t = 1; t < MAX_TRAILS; t++) if (this.lengths[t]! < this.lengths[s]!) s = t;
      this.free(s);
    }
    this.owners[s] = id;
    this.slotOf.set(id, s);
  }

  private free(s: number): void {
    this.slotOf.delete(this.owners[s]!);
    this.owners[s] = null;
    this.lengths[s] = 0;
    this.heads[s] = 0;
  }
}
