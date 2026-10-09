// Linear replay (SPEC §13.3): a new world built from a run's frozen root, consuming its recorded
// commands once each at their own boundaries and stepping forward only between settled boundaries,
// to the frozen final address and no further. It restores no snapshot and uses no checkpoint: this
// is the checkpoint-free path M6B's restoration is compared against.
import { cloneFrozen } from '../domain/scene';
import type { RunRecord } from '../persistence/runFile';
import { SimulationHost, type FutureState } from './host';

/** An exact state address (SPEC §10.2): completed ticks and the last applied sequence. */
export interface Address {
  readonly tick: number;
  readonly cursor: number;
}

export class LinearReplay {
  readonly host: SimulationHost;
  /** Index of the next recorded command to apply. */
  private next = 0;

  /** Builds the replay world at (0, 0) from the record's frozen root. It is unstepped until `step`. */
  constructor(readonly record: RunRecord) {
    this.host = new SimulationHost(cloneFrozen(record.root.semantic));
  }

  get address(): Address {
    return { tick: this.host.tick, cursor: this.host.lastAppliedSequence };
  }

  /** Whether an included command at the current boundary is not applied yet: one look, whatever the batch's size. */
  get hasUnsettled(): boolean {
    const command = this.record.commands[this.next];
    return command !== undefined && command.atTick === this.host.tick;
  }

  /** How many included commands at the current boundary are not applied yet; it scans them, so it is for reporting. */
  get unsettled(): number {
    const { commands } = this.record;
    let n = 0;
    while (this.next + n < commands.length && commands[this.next + n]!.atTick === this.host.tick) n += 1;
    return n;
  }

  /** At the frozen final address: every command applied, at the final tick. Nothing further is consumed or stepped. */
  get complete(): boolean {
    return this.host.tick === this.record.finalTick && this.next === this.record.commands.length;
  }

  /** Applies at most `limit` included commands at the current boundary, in sequence; true once none remain there. */
  settle(limit = Infinity): boolean {
    const { commands } = this.record;
    for (let applied = 0; applied < limit; applied++) {
      const command = commands[this.next];
      if (!command || command.atTick !== this.host.tick) break;
      this.host.applyRecorded(command);
      this.next += 1;
    }
    return !this.hasUnsettled;
  }

  /** The transition n → n+1: only from a settled boundary, and only below the final tick. */
  step(): void {
    if (this.hasUnsettled) throw new Error(`tick ${this.host.tick} still has ${this.unsettled} recorded commands to apply`);
    if (this.host.tick >= this.record.finalTick) throw new Error(`the recording ends at tick ${this.record.finalTick}`);
    this.host.step();
  }

  /**
   * One forward unit: settle the current boundary if commands remain there; otherwise step and settle
   * the next. At most `limit` commands are applied; the unit is complete when its boundary is settled.
   * True when the unit finished (the boundary is settled).
   */
  advance(limit = Infinity): boolean {
    if (!this.hasUnsettled) {
      if (this.complete) return true;
      this.step();
    }
    return this.settle(limit);
  }

  /**
   * Forward, linearly, to `address` on this record's path: every boundary before its tick fully settled,
   * then commands at its tick up to its cursor. An address behind the current one, beyond the record,
   * or inconsistent with where the record's commands lie is refused; nothing is skipped or reversed.
   */
  runTo(address: Address): void {
    const { commands, finalTick, lastAppliedSequence } = this.record;
    const { tick, cursor } = address;
    if (tick > finalTick || cursor > lastAppliedSequence) throw new Error(`(${tick}, ${cursor}) lies beyond the recording's end (${finalTick}, ${lastAppliedSequence})`);
    const before = commands.filter((c) => c.atTick < tick).length;
    const through = commands.filter((c) => c.atTick <= tick).length;
    if (cursor < before || cursor > through) throw new Error(`cursor ${cursor} is not on the recording's path at tick ${tick} (${before}–${through})`);
    if (tick < this.host.tick || (tick === this.host.tick && cursor < this.host.lastAppliedSequence)) throw new Error('replay moves forward only');
    while (this.host.tick < tick) {
      this.settle();
      this.step();
    }
    this.settle(cursor - this.host.lastAppliedSequence);
  }

  /** All the way to the frozen final address. */
  runToEnd(): void {
    this.runTo({ tick: this.record.finalTick, cursor: this.record.lastAppliedSequence });
  }

  dispose(): void {
    this.host.dispose();
  }
}

/** Everything compared at an address (SPEC §13.4): the address, the future-affecting state and the engine bytes. */
export interface Observed {
  readonly address: Address;
  readonly state: FutureState;
  readonly engine: Uint8Array;
}

export const observe = (host: SimulationHost): Observed => ({
  address: { tick: host.tick, cursor: host.lastAppliedSequence },
  state: host.futureState(),
  engine: host.engineSnapshot(),
});

/** The first difference between two observations: where, which entity and component, and both values. */
export interface Divergence {
  readonly tick: number;
  readonly cursor: number;
  readonly entity: string;
  readonly component: string;
  readonly expected: unknown;
  readonly observed: unknown;
}

/** The first leaf that differs (Object.is: no tolerance), as a path below `base`. */
function firstLeaf(a: unknown, b: unknown, path: string): { path: string; a: unknown; b: unknown } | null {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? null : { path, a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstLeaf((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

/** Compares a list of entities by stable ID: presence first, then each one's components. */
function byEntity<T extends { id: string }>(kind: string, a: readonly T[], b: readonly T[]): Omit<Divergence, 'tick' | 'cursor'> | null {
  const ids = [...new Set([...a.map((x) => x.id), ...b.map((x) => x.id)])].sort();
  for (const id of ids) {
    const x = a.find((e) => e.id === id);
    const y = b.find((e) => e.id === id);
    if (!x || !y) return { entity: `${kind} ${id}`, component: 'presence', expected: x ? 'present' : 'absent', observed: y ? 'present' : 'absent' };
    const leaf = firstLeaf(x, y, '');
    if (leaf) return { entity: `${kind} ${id}`, component: leaf.path, expected: leaf.a, observed: leaf.b };
  }
  return null;
}

/**
 * The first divergence between an expected and an observed observation (SPEC §13.4): the address, then
 * laws, settings, emitters and bodies by stable ID, then the engine bytes. Null when they are identical.
 */
export function firstDivergence(expected: Observed, observed: Observed): Divergence | null {
  const { tick, cursor } = expected.address;
  const where = (d: Omit<Divergence, 'tick' | 'cursor'>): Divergence => ({ tick, cursor, ...d });
  if (expected.address.tick !== observed.address.tick) return where({ entity: 'address', component: 'tick', expected: expected.address.tick, observed: observed.address.tick });
  if (expected.address.cursor !== observed.address.cursor) return where({ entity: 'address', component: 'cursor', expected: expected.address.cursor, observed: observed.address.cursor });
  const a = expected.state;
  const b = observed.state;
  const laws = byEntity('law', a.fields, b.fields);
  if (laws) return where(laws);
  const settings = firstLeaf(a.simulation, b.simulation, '');
  if (settings) return where({ entity: 'simulation', component: settings.path, expected: settings.a, observed: settings.b });
  if (a.skippedEmissions !== b.skippedEmissions) return where({ entity: 'emitters', component: 'skippedEmissions', expected: a.skippedEmissions, observed: b.skippedEmissions });
  const emitters = byEntity('emitter', a.emitters, b.emitters);
  if (emitters) return where(emitters);
  const bodies = byEntity('body', a.bodies, b.bodies);
  if (bodies) return where(bodies);
  const rest = firstLeaf({ ...a, fields: null, simulation: null, emitters: null, bodies: null }, { ...b, fields: null, simulation: null, emitters: null, bodies: null }, '');
  if (rest) return where({ entity: 'state', component: rest.path, expected: rest.a, observed: rest.b });
  const e = expected.engine;
  const o = observed.engine;
  if (e.length !== o.length) return where({ entity: 'engine', component: 'snapshot length', expected: e.length, observed: o.length });
  for (let i = 0; i < e.length; i++) if (e[i] !== o[i]) return where({ entity: 'engine', component: `snapshot byte ${i}`, expected: e[i], observed: o[i] });
  return null;
}
