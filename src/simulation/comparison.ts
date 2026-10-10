// Controlled continuation (SPEC §14.3). One private fork, a sampled CPU baseline, and one editable
// alternate. Source commands beyond the fork are deliberately not an input to either continuation.
import { DocumentController } from '../domain/document';
import { cloneFrozen, type SceneDocument } from '../domain/scene';
import { createDocument } from '../persistence/sceneFile';
import { fnv64 } from './checkpoints';
import { SimulationHost, type AppliedCommand, type HostCheckpoint } from './host';
import type { Address } from './replay';
import { observe, type Observed } from './replay';

const MiB = 1024 * 1024;
export const COMPARISON_LIMITS = Object.freeze({ bytes: 64 * MiB, ticks: 7200, initialTicks: 600, checkpointBytes: 16 * MiB, suffixBytes: 4 * MiB, historyBytes: 2 * MiB, historyEntries: 64 });
/** Typed bytes are exact; variable object graphs receive eight bytes per serialized UTF-16 unit plus overhead. */
export const managedObjectBytes = (value: unknown): number => JSON.stringify(value).length * 8 + 1024;
export const checkpointBytes = (c: HostCheckpoint): number => c.engineBytes.byteLength + managedObjectBytes({ ...c, engineBytes: null });
const copyCheckpoint = (c: HostCheckpoint): HostCheckpoint => Object.freeze({ ...cloneFrozen({ ...c, engineBytes: null }), engineBytes: c.engineBytes.slice() });
export function preflightComparison(bytes: number, limit = COMPARISON_LIMITS.bytes): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) throw new Error(`Comparison needs ${bytes} managed bytes; the limit is ${limit}. Choose a shorter horizon or a smaller scene.`);
}

interface TraceChunk {
  readonly first: number;
  readonly last: number;
  readonly capacity: number;
  readonly offsets: Uint32Array;
  readonly identities: Uint32Array;
  readonly poses: Float32Array;
  used: number;
}
interface Identity { readonly id: string; readonly radius: number }
export interface BaselineJob {
  readonly generation: number;
  readonly target: number;
  readonly startedAt: number;
}
interface OwnedJob extends BaselineJob {
  readonly token: BaselineJob;
  readonly work: SimulationHost;
  readonly chunk: TraceChunk;
  readonly ids: Identity[];
  readonly lookup: Map<string, number>;
  readonly identityBudget: number;
  readonly plannedBytes: number;
  readonly batchMs: number[];
}
export type BaselineResult = 'working' | 'committed' | 'canceled';
export interface BaselineMetrics { readonly ticks: number; readonly elapsedMs: number; readonly batches: readonly number[]; readonly bytes: number; readonly endpoint: Address; readonly endpointIdentity: string }
export interface StoredFrame { readonly tick: number; readonly ids: readonly string[]; readonly poses: Float32Array }

export class Comparison {
  private fork: HostCheckpoint | null;
  private sourceRoot: SceneDocument | null;
  readonly address: Address;
  readonly identity: string;
  private b: SimulationHost;
  controller: DocumentController;
  private commands: AppliedCommand[] = [];
  private commandBytes = 0;
  private chunks: TraceChunk[] = [];
  private ids: Identity[] = [];
  private lookup = new Map<string, number>();
  private endpoint: HostCheckpoint | null = null;
  private job: OwnedJob | null = null;
  private generation = 0;
  private replay: { next: number; end: Address } | null = null;
  private replayStopped = false;
  private disposed = false;
  metrics: BaselineMetrics | null = null;
  message: string | null = null;
  horizon: number;

  constructor(source: SimulationHost, root: SceneDocument, readonly sourceIdentity: string) {
    if (source.fault || source.halted || source.pendingCount) throw new Error('Compare needs a healthy settled boundary.');
    const checkpoint = source.checkpoint();
    if (checkpointBytes(checkpoint) > COMPARISON_LIMITS.checkpointBytes) throw new Error('The fork exceeds the 16 MiB checkpoint limit.');
    // Admission precedes retained copies and world restoration. Reserve live document/history,
    // suffix, restore/export scratch, pose observers, and a maximum-size endpoint capture.
    preflightComparison(checkpointBytes(checkpoint) + managedObjectBytes(root) * 2 + this.fixedReserve(root));
    this.fork = copyCheckpoint(checkpoint);
    this.sourceRoot = cloneFrozen({ ...root, semantic: source.frozenRoot });
    this.address = Object.freeze({ tick: checkpoint.tick, cursor: checkpoint.lastAppliedSequence });
    this.identity = `${sourceIdentity}:${checkpoint.tick}:${checkpoint.lastAppliedSequence}:${fnv64(checkpoint.engineBytes)}`;
    this.horizon = checkpoint.tick;
    this.b = this.restore(this.fork);
    this.controller = this.newController();
    this.attachRecorder();
    const poses = new Float32Array(source.count * 7);
    source.writePoses(poses, 0);
    this.ids = source.ids.map((id, i) => Object.freeze({ id, radius: source.radii[i]! }));
    this.lookup = new Map(this.ids.map((v, i) => [v.id, i]));
    this.chunks = [{ first: source.tick, last: source.tick, capacity: source.count, offsets: new Uint32Array([0, source.count]), identities: Uint32Array.from(source.ids.map((_id, i) => i)), poses, used: source.count }];
  }

  private fixedReserve(root = this.root): number {
    // 4 MiB bounds suffix; 2 MiB bounds undo. Another 2 MiB covers accepted law copies,
    // presentation maps, command queue/acks and controller bookkeeping. 16 MiB covers a
    // checkpoint capture/restore in flight, with retained endpoints accounted separately.
    // Export serialization and copied observation frames have separately reserved scratch.
    return COMPARISON_LIMITS.suffixBytes + 4 * MiB + COMPARISON_LIMITS.checkpointBytes +
      managedObjectBytes(root) * 2 + root.semantic.simulation.maxLiveBodies * 4096 + 512 * 1024;
  }
  get root(): SceneDocument {
    if (!this.sourceRoot) throw new Error('Comparison is closed.');
    return this.sourceRoot;
  }
  get host(): SimulationHost { return this.b; }
  get working(): BaselineJob | null { return this.job?.token ?? null; }
  get replaying(): boolean { return this.replay !== null; }
  get editable(): boolean { return !this.disposed && !this.replay; }
  get suffixCount(): number { return this.commands.length; }
  get suffix(): readonly AppliedCommand[] { return Object.freeze([...this.commands]); }
  get atHorizon(): boolean { return this.b.tick >= this.horizon; }
  get canAdvance(): boolean { return !this.disposed && !this.job && !this.b.fault && !this.b.halted && !this.atHorizon; }
  /** Only an explicit Play/Step releases a completed replay's boundary hold. */
  resumeAlternate(): void { this.replayStopped = false; }
  /** Consumer bytes never alias the owned fork or endpoint. */
  forkCheckpoint(): HostCheckpoint {
    if (!this.fork) throw new Error('Comparison is closed.');
    return copyCheckpoint(this.fork);
  }
  endpointCheckpoint(): HostCheckpoint | null { return this.endpoint ? copyCheckpoint(this.endpoint) : null; }
  /** Qualification observation; engine bytes are independently captured, never owned trace storage. */
  observeBaselineWork(): Observed | null { return this.job ? observe(this.job.work) : null; }
  private restore(c: HostCheckpoint): SimulationHost { return new SimulationHost(this.root.semantic, copyCheckpoint(c)); }
  private newController(host = this.b): DocumentController {
    return new DocumentController(createDocument({ ...this.root.semantic, fields: host.appliedFields(), simulation: { ...this.root.semantic.simulation, ambientAcceleration: host.settings.ambientAcceleration } }, this.root.metadata, this.root.presentation), host, COMPARISON_LIMITS.historyEntries, COMPARISON_LIMITS.historyBytes);
  }
  private attachRecorder(): void {
    this.b.recorder = {
      admit: (command) => {
        const fits = this.commandBytes + managedObjectBytes(command) <= COMPARISON_LIMITS.suffixBytes && this.commands.length < 50_000;
        if (!fits) this.message = 'Alternate history is full. The change was refused; export its setup or start a New Alternate.';
        return fits;
      },
      append: (command) => {
        const owned = cloneFrozen(command);
        this.commands.push(owned);
        this.commandBytes += managedObjectBytes(owned);
      },
      stepped: () => {},
    };
  }
  settle(): void {
    if (this.replay || this.disposed) return;
    this.controller.settle();
    if (this.b.halted) { this.controller.discardPending(); this.b.releaseHalt(); }
  }
  /** The only alternate scheduler entry; replay consumes exact commands before lifecycle. */
  advance(): boolean {
    if (!this.canAdvance || this.replayStopped) return false;
    if (this.replay) {
      this.settleReplay();
      if (!this.replay) return false;
      this.b.step();
      this.settleReplay();
    } else {
      this.settle();
      this.b.step();
      this.controller.sync();
      if (this.b.halted) {
        this.controller.discardPending();
        this.b.releaseHalt();
      }
    }
    return true;
  }
  private settleReplay(): void {
    const replay = this.replay;
    if (!replay) return;
    while (replay.next < this.commands.length && this.commands[replay.next]!.atTick === this.b.tick) this.b.applyRecorded(this.commands[replay.next++]!);
    if (this.b.tick === replay.end.tick && this.b.lastAppliedSequence === replay.end.cursor) {
      this.replay = null;
      this.replayStopped = true;
      this.controller.reattach(this.b);
      this.attachRecorder();
    }
  }
  replayAlternate(): void {
    if (this.disposed) throw new Error('Comparison is closed.');
    this.cancel();
    if (!this.replay) this.settle();
    const end = this.replay?.end ?? { tick: this.b.tick, cursor: this.b.lastAppliedSequence };
    const replacement = this.restore(this.fork!);
    // Detach only after the refusal path drained accepted acks and dropped unapplied commands.
    // Attach before disposal; a failed attachment frees only the uncommitted replacement.
    try { this.controller.reattach(replacement); }
    catch (error) { replacement.dispose(); throw error; }
    this.b.dispose();
    this.b = replacement;
    this.replayStopped = false;
    this.replay = { next: 0, end };
    this.settleReplay();
  }
  newAlternate(): void {
    if (this.disposed) throw new Error('Comparison is closed.');
    this.cancel();
    this.settle();
    const replacement = this.restore(this.fork!);
    let controller: DocumentController;
    try { controller = this.newController(replacement); }
    catch (error) { replacement.dispose(); throw error; }
    const onAcks = this.controller.onAcks;
    this.b.dispose();
    this.b = replacement;
    this.commands = [];
    this.commandBytes = 0;
    this.replay = null;
    this.replayStopped = false;
    this.controller = controller;
    this.controller.onAcks = onAcks;
    this.message = null;
    this.attachRecorder();
  }

  private chunkBytes(c: TraceChunk): number { return c.offsets.byteLength + c.identities.byteLength + c.poses.byteLength + 256; }
  get bytes(): number {
    if (this.disposed) return 0;
    return this.fixedReserve() + checkpointBytes(this.fork!) + (this.endpoint ? checkpointBytes(this.endpoint) : 0) +
      this.chunks.reduce((n, c) => n + this.chunkBytes(c), 0) + managedObjectBytes(this.ids) * 2 + (this.job ? this.chunkBytes(this.job.chunk) + this.job.identityBudget + 256 * 1024 : 0);
  }
  /** Admission includes all existing chunks; extension never drops earlier frames to make room. */
  begin(ticks: number = COMPARISON_LIMITS.initialTicks, now: () => number = () => performance.now()): BaselineJob {
    if (this.disposed || this.job) throw new Error('Close or cancel the active calculation first.');
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > COMPARISON_LIMITS.ticks || !Number.isSafeInteger(this.address.tick + ticks)) throw new Error('Choose a horizon of 1–7200 ticks from the fork.');
    const target = this.address.tick + ticks;
    if (target <= this.horizon && this.endpoint) throw new Error('That horizon has already been computed.');
    const from = this.endpoint ?? this.fork!;
    const first = from.tick + 1;
    const frames = target - first + 1;
    const dynamic = this.root.semantic.bodies.filter((b) => b.type === 'dynamic').length;
    let possible = Math.max(dynamic, from.bodyIdentityMap.length);
    let births = 0;
    let idUnits = 0;
    for (const e of this.root.semantic.emitters) {
      const remaining = Math.max(0, (e.emissionCount ?? Infinity) - from.emitterStates.find((s) => s.id === e.id)!.ordinal);
      const scheduled = Math.min(remaining, Math.max(0, Math.floor((target - 1 - e.startTick) / e.intervalTicks) + 1 - from.emitterStates.find((s) => s.id === e.id)!.ordinal));
      possible += Math.min(scheduled, Math.ceil(e.lifetimeTicks / e.intervalTicks));
      births += scheduled;
      idUnits += scheduled * (e.id.length + 32);
    }
    const capacity = Math.min(this.root.semantic.simulation.maxLiveBodies, possible);
    // Every possible new stable ID (including skipped emissions) is reserved, not just live count.
    const identityBudget = births * 512 + idUnits * 16 + managedObjectBytes(this.ids) * 2 + 4096;
    const chunkBytes = (frames + 1) * 4 + frames * capacity * 32 + 256;
    const plannedBytes = this.bytes + chunkBytes + identityBudget + 256 * 1024;
    preflightComparison(plannedBytes);
    const work = this.restore(from);
    try {
      const chunk: TraceChunk = { first, last: target, capacity, offsets: new Uint32Array(frames + 1), identities: new Uint32Array(frames * capacity), poses: new Float32Array(frames * capacity * 7), used: 0 };
      const ids = [...this.ids];
      const lookup = new Map(this.lookup);
      const token = Object.freeze({ generation: ++this.generation, target, startedAt: now() });
      this.job = { ...token, token, work, chunk, ids, lookup, identityBudget, plannedBytes, batchMs: [] };
      return token;
    } catch (error) { work.dispose(); throw error; }
  }
  private sample(job: OwnedJob): void {
    const { chunk, work, ids, lookup } = job;
    if (work.count > chunk.capacity) throw new Error('Computed body count exceeds the admitted trace capacity.');
    const frame = work.tick - chunk.first;
    chunk.offsets[frame] = chunk.used;
    work.writePoses(chunk.poses, chunk.used * 7);
    for (let i = 0; i < work.count; i++) {
      const id = work.ids[i]!;
      let index = lookup.get(id);
      if (index === undefined) { index = ids.length; ids.push(Object.freeze({ id, radius: work.radii[i]! })); lookup.set(id, index); }
      chunk.identities[chunk.used++] = index;
    }
    chunk.offsets[frame + 1] = chunk.used;
  }
  /** Yield between batches; a canceled/stale job cannot publish its samples or endpoint. */
  batch(token: BaselineJob, budgetMs = 8, now: () => number = () => performance.now(), stepLimit = 240): BaselineResult {
    const job = this.job;
    if (!job || job.token !== token || job.generation !== this.generation || this.disposed) return 'canceled';
    const start = now();
    try {
      for (let n = 0; n < stepLimit && job.work.tick < job.target; n++) {
        job.work.step();
        this.sample(job);
        if (now() - start >= budgetMs) break;
      }
      job.batchMs.push(now() - start);
      if (job.work.tick < job.target) return 'working';
      const endpoint = job.work.checkpoint();
      if (checkpointBytes(endpoint) > COMPARISON_LIMITS.checkpointBytes) throw new Error('The baseline endpoint exceeds 16 MiB. Earlier samples remain available.');
      if (this.job !== job || job.generation !== this.generation) return 'canceled';
      this.endpoint = endpoint;
      this.chunks.push(job.chunk);
      this.ids = job.ids;
      this.lookup = job.lookup;
      this.horizon = job.target;
      this.job = null;
      job.work.dispose();
      this.metrics = Object.freeze({ ticks: this.horizon - this.address.tick, elapsedMs: now() - job.startedAt, batches: Object.freeze([...job.batchMs]), bytes: this.bytes, endpoint: Object.freeze({ tick: endpoint.tick, cursor: endpoint.lastAppliedSequence }), endpointIdentity: fnv64(endpoint.engineBytes) });
      return 'committed';
    } catch (error) { this.cancel(); throw error; }
  }
  cancel(): void {
    this.generation++;
    this.job?.work.dispose();
    this.job = null;
  }
  /** Read-only equal-tick access. Stable IDs are never paired by array position. */
  visit(tick: number, receive: (id: string, radius: number, poses: Float32Array, offset: number) => void): boolean {
    const chunk = this.chunks.find((c) => tick >= c.first && tick <= c.last);
    if (!chunk) return false;
    const frame = tick - chunk.first;
    for (let i = chunk.offsets[frame]!; i < chunk.offsets[frame + 1]!; i++) {
      const id = this.ids[chunk.identities[i]!]!;
      // Only copied pose values cross the boundary: the callback cannot mutate the trace.
      const pose = chunk.poses.slice(i * 7, i * 7 + 7);
      receive(id.id, id.radius, pose, 0);
    }
    return true;
  }
  frame(tick: number): StoredFrame | null {
    const ids: string[] = [];
    const poses: number[] = [];
    if (!this.visit(tick, (id, _r, p) => { ids.push(id); poses.push(...p); })) return null;
    return Object.freeze({ tick, ids: Object.freeze(ids), poses: new Float32Array(poses) });
  }
  alternateSetup(): SceneDocument {
    if (this.replay) throw new Error('Finish Replay Alternate before exporting its setup.');
    this.controller.settle();
    const snapshot = this.controller.snapshot(this.controller.camera);
    return createDocument({ ...this.root.semantic, fields: snapshot.semantic.fields, simulation: { ...this.root.semantic.simulation, ambientAcceleration: snapshot.semantic.simulation.ambientAcceleration } }, { ...snapshot.metadata, title: `${snapshot.metadata.title} — Alternate` }, snapshot.presentation);
  }
  counts() {
    return { worlds: this.disposed ? 0 : 1 + Number(this.job !== null), generation: this.generation, buffers: this.disposed ? 0 : this.chunks.length * 3 + 1 + Number(this.endpoint !== null) + (this.job ? 3 : 0), frames: this.disposed ? 0 : this.horizon - this.address.tick + Number(this.endpoint !== null), identities: this.ids.length, bytes: this.bytes, suffix: this.commands.length, suffixBytes: this.commandBytes, historyBytes: this.controller.historyBytes, horizon: this.horizon };
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.b.dispose();
    this.b.recorder = null;
    this.controller.onAcks = null;
    this.fork = this.endpoint = null;
    this.sourceRoot = null;
    this.chunks = [];
    this.ids = [];
    this.lookup.clear();
    this.commands = [];
    this.commandBytes = 0;
    this.metrics = null;
    this.disposed = true;
  }
}
