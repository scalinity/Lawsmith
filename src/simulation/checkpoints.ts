// Complete checkpoints and their cache (SPEC §14.1–14.2). A checkpoint is the host's complete state at a
// settled boundary, keyed by the record, history context and consumed prefix it belongs to, the
// simulation semantics and runtime it was captured under, and its exact (tick, cursor). The cache is
// session-local and bounded; root plus log stays the durable source, and nothing here can change it.
// RestoredReplay replays forward from a restored checkpoint with its own forward logic, so the
// checkpoint-free LinearReplay stays an independent reference beside it.
import type { RunRecord } from '../persistence/runFile';
import { commandText, compactJson, utf8Bytes } from '../persistence/runFile';
import { SimulationHost, type HostCheckpoint } from './host';
import type { Address } from './replay';

/** Ordinary checkpoints fall on every 240th tick (SPEC §14.2). */
export const CHECKPOINT_TICKS = 240;

const MiB = 1024 * 1024;

/** SPEC §14.2: at most 64 MiB of checkpoints, and 16 MiB in any one. */
export const CHECKPOINT_LIMITS = Object.freeze({ cacheBytes: 64 * MiB, checkpointBytes: 16 * MiB });

// ------------------------------------------------------------------ FNV-1a, 64-bit

// The running state, as two unsigned 32-bit halves; the prime is 2^40 + 0x1b3.
let hi = 0;
let lo = 0;

function begin(): void {
  hi = 0xcbf29ce4;
  lo = 0x84222325;
}

/** One byte into the state: xor, then multiply by the prime modulo 2^64, exactly in doubles. */
function byte(b: number): void {
  lo = (lo ^ b) >>> 0;
  const low = lo * 0x1b3;
  const carry = Math.floor(low / 0x100000000);
  hi = (hi * 0x1b3 + carry + (lo << 8)) >>> 0;
  lo = low >>> 0;
}

function text(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    byte(unit & 0xff);
    byte(unit >>> 8);
  }
}

const digest = (): string => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');

/** FNV-1a 64 of bytes: a checksum, never an exactness test. */
export function fnv64(data: Uint8Array): string {
  begin();
  for (let i = 0; i < data.length; i++) byte(data[i]!);
  return digest();
}

// ------------------------------------------------------------------ identity

/**
 * The consumed-prefix identities of one record (SPEC §14.1): for cursor c, FNV-1a 64 over the canonical
 * text of the run ID, the root and commands 1…c, each on its own line. Two prefixes share an identity
 * only if they hold the same root and the same commands. Computed forward, once, as far as asked.
 */
export class PrefixIdentities {
  private readonly at_: string[] = [];
  private hi = 0;
  private lo = 0;

  constructor(private readonly record: RunRecord) {
    begin();
    text(`${record.runId}\n${compactJson(record.root.semantic)}`);
    this.keep();
  }

  private keep(): void {
    this.hi = hi;
    this.lo = lo;
    this.at_.push(digest());
  }

  /** The identity of commands 1…cursor; null for a cursor beyond the record. */
  at(cursor: number): string | null {
    const { commands } = this.record;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > commands.length) return null;
    if (cursor >= this.at_.length) {
      hi = this.hi;
      lo = this.lo;
      for (let c = this.at_.length; c <= cursor; c++) {
        text(`\n${commandText(commands[c - 1]!)}`);
        this.keep();
      }
    }
    return this.at_[cursor]!;
  }
}

/** Everything that decides whether a checkpoint can serve a record's seek, apart from its address. */
export interface CheckpointScope {
  readonly record: RunRecord;
  /** The record's history context: its replays share it; a live or alternate context never does. */
  readonly historyContextId: string;
  readonly prefixes: PrefixIdentities;
  /** Canonical text of the simulation fingerprint and of the runtime's qualification identity. */
  readonly simulationFingerprint: string;
  readonly qualificationIdentity: string;
}

/** A complete checkpoint and its key (SPEC §14.1). */
export interface Checkpoint extends HostCheckpoint {
  readonly runId: string;
  readonly historyContextId: string;
  readonly commandPrefixIdentity: string;
  readonly simulationFingerprint: string;
  readonly qualificationIdentity: string;
  /** What the cache accounts: the engine bytes and the sidecar's UTF-8 text. */
  readonly bytes: number;
  /** FNV-1a 64 of the engine bytes, then of the sidecar text, at capture. A restore checks both first. */
  readonly checksum: string;
}

/** The sidecar and key as text: everything but the engine bytes and the cache's own accounting. */
const sidecarText = (c: Omit<Checkpoint, 'bytes' | 'checksum'>): string => JSON.stringify({ ...c, engineBytes: null });

const checksumOf = (c: Omit<Checkpoint, 'bytes' | 'checksum'>, sidecar: string): string => {
  const engine = fnv64(c.engineBytes);
  begin();
  text(sidecar);
  return `${engine}${digest()}`;
};

/** Captures `host`'s complete checkpoint, keyed for `scope`'s record. The host must be on that record's path. */
export function captureCheckpoint(host: SimulationHost, scope: CheckpointScope): Checkpoint {
  const state = host.checkpoint();
  const commandPrefixIdentity = scope.prefixes.at(state.lastAppliedSequence);
  if (commandPrefixIdentity === null) throw new Error(`cursor ${state.lastAppliedSequence} lies beyond the record`);
  const keyed = {
    ...state,
    runId: scope.record.runId,
    historyContextId: scope.historyContextId,
    commandPrefixIdentity,
    simulationFingerprint: scope.simulationFingerprint,
    qualificationIdentity: scope.qualificationIdentity,
  };
  const sidecar = sidecarText(keyed);
  return Object.freeze({ ...keyed, bytes: state.engineBytes.byteLength + utf8Bytes(sidecar), checksum: checksumOf(keyed, sidecar) });
}

/** Whether a checkpoint still holds what it held when captured: a changed byte anywhere fails. */
export function intact(checkpoint: Checkpoint): boolean {
  const { bytes: _bytes, checksum, ...keyed } = checkpoint;
  return checksumOf(keyed, sidecarText(keyed)) === checksum;
}

/** Whether `address` lies on `record`'s path: within its end, with exactly the commands through that cursor at or before its tick. */
export function onPath(record: RunRecord, address: Address): boolean {
  const { tick, cursor } = address;
  const { commands } = record;
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(cursor) || tick < 0 || cursor < 0) return false;
  if (tick > record.finalTick || cursor > record.lastAppliedSequence) return false;
  if (cursor > 0 && commands[cursor - 1]!.atTick > tick) return false;
  return cursor === commands.length || commands[cursor]!.atTick >= tick;
}

/** Address order: tick first, then cursor. */
export const compareAddress = (a: Address, b: Address): number => a.tick - b.tick || a.cursor - b.cursor;

/**
 * Why a checkpoint cannot serve `target` in `scope` (SPEC §14.2), or null when it can: the same record,
 * history context, consumed prefix, simulation semantics and runtime, and an address on the record's
 * path at or before the target. A later cursor at the same tick is not before it.
 */
export function ineligible(checkpoint: Checkpoint, scope: CheckpointScope, target: Address): string | null {
  const address = { tick: checkpoint.tick, cursor: checkpoint.lastAppliedSequence };
  if (checkpoint.runId !== scope.record.runId) return 'another run';
  if (checkpoint.historyContextId !== scope.historyContextId) return 'another history context';
  if (checkpoint.simulationFingerprint !== scope.simulationFingerprint) return 'another simulation fingerprint';
  if (checkpoint.qualificationIdentity !== scope.qualificationIdentity) return 'another runtime';
  if (!onPath(scope.record, address)) return 'off the record’s path';
  if (checkpoint.commandPrefixIdentity !== scope.prefixes.at(address.cursor)) return 'another command prefix';
  if (compareAddress(address, target) > 0) return 'after the target';
  return null;
}

/** What the cache did with a checkpoint offered to it. */
export interface CacheResult {
  readonly stored: boolean;
  /** Checkpoints evicted to make room, least recently used first. */
  readonly evicted: readonly Checkpoint[];
}

/**
 * The bounded in-memory checkpoint cache (SPEC §14.2): at most `limits.cacheBytes` in all and
 * `limits.checkpointBytes` in one, evicting by least recent use. It holds checkpoints and nothing else,
 * so eviction can never touch a record's root or log.
 */
export class CheckpointCache {
  /** Least recently used first. */
  private entries: Checkpoint[] = [];
  bytes = 0;

  constructor(readonly limits: { readonly cacheBytes: number; readonly checkpointBytes: number } = CHECKPOINT_LIMITS) {}

  get size(): number {
    return this.entries.length;
  }

  /** Every checkpoint held, least recently used first. */
  list(): readonly Checkpoint[] {
    return [...this.entries];
  }

  /** Whether a checkpoint of `scope`'s history is already held at `address`. */
  has(scope: CheckpointScope, address: Address): boolean {
    return this.entries.some((c) => c.historyContextId === scope.historyContextId && c.tick === address.tick && c.lastAppliedSequence === address.cursor);
  }

  /** Adds a checkpoint as the most recently used, evicting the least recent until it fits; one over the individual limit is declined. */
  put(checkpoint: Checkpoint): CacheResult {
    if (checkpoint.bytes > this.limits.checkpointBytes || checkpoint.bytes > this.limits.cacheBytes) return { stored: false, evicted: [] };
    const evicted: Checkpoint[] = [];
    while (this.bytes + checkpoint.bytes > this.limits.cacheBytes) {
      const oldest = this.entries.shift()!;
      this.bytes -= oldest.bytes;
      evicted.push(oldest);
    }
    this.entries.push(checkpoint);
    this.bytes += checkpoint.bytes;
    return { stored: true, evicted };
  }

  /** The closest checkpoint that can serve `target`, made the most recently used; null if none can. */
  nearest(scope: CheckpointScope, target: Address): Checkpoint | null {
    let best: Checkpoint | null = null;
    for (const c of this.entries) {
      if (ineligible(c, scope, target) !== null) continue;
      if (!best || compareAddress({ tick: c.tick, cursor: c.lastAppliedSequence }, { tick: best.tick, cursor: best.lastAppliedSequence }) > 0) best = c;
    }
    if (best) {
      this.entries.splice(this.entries.indexOf(best), 1);
      this.entries.push(best);
    }
    return best;
  }

  /** Drops every checkpoint of one history context; returns how many. */
  discardHistory(historyContextId: string): number {
    const kept = this.entries.filter((c) => c.historyContextId !== historyContextId);
    const dropped = this.entries.length - kept.length;
    this.entries = kept;
    this.bytes = kept.reduce((sum, c) => sum + c.bytes, 0);
    return dropped;
  }
}

// ------------------------------------------------------------------ forward from a checkpoint

/**
 * A replay world restored from a checkpoint (SPEC §14.2): a new world from its engine bytes and sidecar
 * under the record's frozen root, then the record's later commands, each once at its own boundary,
 * stepping only between settled boundaries and never past the frozen end. It shares the host's command
 * interpretation and step with LinearReplay, and none of its own logic.
 */
export class RestoredReplay {
  readonly host: SimulationHost;
  /** Where the restored world started. */
  readonly from: Address;
  /** Index of the next recorded command; sequences run 1, 2, 3, … so it starts at the checkpoint's cursor. */
  private next: number;

  constructor(
    readonly record: RunRecord,
    checkpoint: HostCheckpoint,
  ) {
    this.from = { tick: checkpoint.tick, cursor: checkpoint.lastAppliedSequence };
    if (!onPath(record, this.from)) throw new Error(`(${this.from.tick}, ${this.from.cursor}) is not on the recording’s path`);
    this.host = new SimulationHost(record.root.semantic, checkpoint);
    this.next = checkpoint.lastAppliedSequence;
  }

  get address(): Address {
    return { tick: this.host.tick, cursor: this.host.lastAppliedSequence };
  }

  /** Whether a recorded command at the current boundary is still to apply. */
  get hasUnsettled(): boolean {
    const command = this.record.commands[this.next];
    return command !== undefined && command.atTick === this.host.tick;
  }

  /** How many recorded commands at the current boundary are still to apply. */
  get unsettled(): number {
    const { commands } = this.record;
    let i = this.next;
    while (i < commands.length && commands[i]!.atTick === this.host.tick) i += 1;
    return i - this.next;
  }

  /** At the frozen final address. */
  get complete(): boolean {
    return this.next === this.record.commands.length && this.host.tick === this.record.finalTick;
  }

  /** Applies up to `limit` recorded commands at the current boundary, in sequence; true once none remain there. */
  settle(limit = Infinity): boolean {
    const { commands } = this.record;
    let applied = 0;
    while (applied < limit && this.hasUnsettled) {
      this.host.applyRecorded(commands[this.next]!);
      this.next += 1;
      applied += 1;
    }
    return !this.hasUnsettled;
  }

  /** The transition n → n+1, from a settled boundary below the final tick only. */
  step(): void {
    if (this.hasUnsettled) throw new Error(`tick ${this.host.tick} has recorded commands still to apply`);
    if (this.host.tick >= this.record.finalTick) throw new Error(`the recording ends at tick ${this.record.finalTick}`);
    this.host.step();
  }

  /** One forward unit, as a replay plays: finish the current boundary's commands, or step and settle the next. */
  advance(limit = Infinity): boolean {
    if (this.hasUnsettled) return this.settle(limit);
    if (this.complete) return true;
    this.step();
    return this.settle(limit);
  }

  /** Forward to `address` on the record's path; an address behind this world or off the path is refused. */
  runTo(address: Address): void {
    if (!onPath(this.record, address)) throw new Error(`(${address.tick}, ${address.cursor}) is not on the recording’s path`);
    if (compareAddress(address, this.address) < 0) throw new Error('a replay moves forward only');
    while (this.host.tick < address.tick) {
      this.settle();
      this.step();
    }
    this.settle(address.cursor - this.host.lastAppliedSequence);
  }

  runToEnd(): void {
    this.runTo({ tick: this.record.finalTick, cursor: this.record.lastAppliedSequence });
  }

  dispose(): void {
    this.host.dispose();
  }
}
