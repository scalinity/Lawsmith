// T10 (M6B), complete checkpoints: a checkpoint restored into a new world, then replayed forward on its
// record's path, equals the uninterrupted checkpoint-free M6A replay at every boundary to the end. The
// oracle is LinearReplay, untouched; the restored side is RestoredReplay with its own forward logic; the
// comparison is M6A's observation (state and engine bytes) plus what the host publishes beyond it.
import { beforeAll, describe, expect, it } from 'vitest';
import { compactJson, type RunRecord } from '../src/persistence/runFile';
import {
  CHECKPOINT_LIMITS,
  CHECKPOINT_TICKS,
  CheckpointCache,
  PrefixIdentities,
  RestoredReplay,
  captureCheckpoint,
  fnv64,
  ineligible,
  intact,
  onPath,
  type Checkpoint,
  type CheckpointScope,
} from '../src/simulation/checkpoints';
import { CheckpointRejected, SimulationHost, initSimulation, worldCounts, type HostCheckpoint } from '../src/simulation/host';
import { SIMULATION_FINGERPRINT, exportRun } from '../src/simulation/recorder';
import { LinearReplay, firstDivergence, observe, type Address, type Divergence } from '../src/simulation/replay';
import { TEST_IDENTITY, interventionRecord, moveTo, session, type Session } from './support/run';

let record: RunRecord;
let fixture: Session;
/** The checkpoints a paced replay of the fixture captured, by tick. */
const captured = new Map<number, Checkpoint>();

beforeAll(async () => {
  await initSimulation();
  ({ record, session: fixture } = await interventionRecord());
  const runs = fixture.coordinator;
  runs.enterReplay();
  while (!runs.replay!.complete) runs.advanceReplay(1000, Infinity, () => 0);
  for (const c of runs.checkpoints.list()) captured.set(c.tick, c);
  runs.returnToAuthoring();
}, 60_000);

const scopeOf = (r: RunRecord, historyContextId = 'record-test'): CheckpointScope => ({
  record: r,
  historyContextId,
  prefixes: new PrefixIdentities(r),
  simulationFingerprint: compactJson(SIMULATION_FINGERPRINT),
  qualificationIdentity: compactJson(TEST_IDENTITY),
});

/** Exact equality, leaf by leaf (Object.is: no tolerance, and −0 is not 0). */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b);
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && same(Array.from(a as Float64Array), Array.from(b as Float64Array));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** What the host publishes beyond M6A's observation: body order, radii and positions as rendered, and the diagnostics a step leaves. */
const published = (host: SimulationHost) => ({
  ids: [...host.ids],
  radii: Array.from(host.radii.subarray(0, host.count)),
  positions: Array.from(host.positions.subarray(0, 3 * host.count)),
  maxSpeed: host.maxSpeed,
  limitedSteps: host.limitedSteps,
});

interface Lockstep {
  /** The first difference in state or engine bytes, by tick, entity and component; or in what is published or explained. */
  readonly divergence: Divergence | { tick: number; cursor: number; entity: 'published' | 'explanation'; component: string } | null;
  readonly units: number;
}

/**
 * Advances the oracle and the restored world together, unit by unit, from the same address to the
 * record's end, comparing everything at every boundary. `explain` names a body both explain, so their
 * retained transitions (contact partners named through the collider identity map) are compared too.
 */
function lockstep(oracle: LinearReplay, restored: RestoredReplay, explain: string | null = null): Lockstep {
  oracle.host.explain(explain);
  restored.host.explain(explain);
  for (let units = 0; ; units++) {
    const a = oracle.host;
    const b = restored.host;
    const d = firstDivergence(observe(a), observe(b));
    if (d) return { divergence: d, units };
    const pa = published(a);
    const pb = published(b);
    for (const key of Object.keys(pa) as (keyof typeof pa)[]) {
      if (!same(pa[key], pb[key])) return { divergence: { tick: a.tick, cursor: a.lastAppliedSequence, entity: 'published', component: key }, units };
    }
    if (!same(a.explanation, b.explanation)) return { divergence: { tick: a.tick, cursor: a.lastAppliedSequence, entity: 'explanation', component: 'transition' }, units };
    if (oracle.complete) {
      expect(restored.complete).toBe(true);
      return { divergence: null, units };
    }
    oracle.advance();
    restored.advance();
  }
}

/** The oracle at `address`, the restored world from `checkpoint`, both disposed afterwards. */
function fromCheckpoint<T>(checkpoint: HostCheckpoint, run: (oracle: LinearReplay, restored: RestoredReplay) => T): T {
  const oracle = new LinearReplay(record);
  const restored = new RestoredReplay(record, checkpoint);
  try {
    oracle.runTo({ tick: checkpoint.tick, cursor: checkpoint.lastAppliedSequence });
    return run(oracle, restored);
  } finally {
    oracle.dispose();
    restored.dispose();
  }
}

/** The oldest living stream body at the oracle's address: it lies on the floor, among other bodies. */
const settledBody = (host: SimulationHost) => host.ids.find((id) => id.startsWith('stream:')) ?? null;

/** The address of a host. */
const at = (host: SimulationHost): Address => ({ tick: host.tick, cursor: host.lastAppliedSequence });

/** A captured checkpoint of the oracle, positioned at `address` by the oracle itself. */
function checkpointAt(address: Address): Checkpoint {
  const oracle = new LinearReplay(record);
  try {
    oracle.runTo(address);
    return captureCheckpoint(oracle.host, scopeOf(record));
  } finally {
    oracle.dispose();
  }
}

/** First command index at tick n, and one past the last: the cursors before and after n's commands. */
const cursors = (n: number) => ({
  before: record.commands.filter((c) => c.atTick < n).length,
  through: record.commands.filter((c) => c.atTick <= n).length,
});

describe('T10: a restored checkpoint replays forward exactly as the uninterrupted oracle (AC1, AC2)', () => {
  it('the fixture holds what the cases need: births, deaths, contacts, same-tick groups and final-tick commands', () => {
    expect(record.finalTick).toBe(1100);
    expect([...captured.keys()].sort((a, b) => a - b)).toEqual([240, 480, 720, 960]);
    // Each is captured right after its step, before that tick's commands: the earliest address at the tick.
    for (const [tick, c] of captured) expect(c.lastAppliedSequence).toBe(cursors(tick).before);
    const at500 = cursors(500);
    const at720 = cursors(720);
    expect([at500.through - at500.before, at720.through - at720.before, cursors(1100).through - cursors(1100).before]).toEqual([3, 2, 2]);
    expect(record.commands.some((c) => c.payload.kind === 'setAmbient')).toBe(true);
    expect(record.commands.some((c) => c.payload.kind === 'removeField')).toBe(true);
    // At 720 a body dies and another is born at the lifecycle the next step runs.
    const c720 = captured.get(720)!;
    expect(c720.bodyLifetimes.filter((l) => l.deathTick === 720).length).toBe(1);
    expect(c720.emitterStates[0]!.ordinal).toBe(90);
  });

  it('from every 240th tick a replay captured, through births, deaths, contacts and edits, to the frozen end', { timeout: 60_000 }, () => {
    for (const [tick, checkpoint] of [...captured].sort((a, b) => a[0] - b[0])) {
      const result = fromCheckpoint(checkpoint, (oracle, restored) => lockstep(oracle, restored, settledBody(oracle.host)));
      expect(result.divergence, `from ${tick}`).toBeNull();
      expect(result.units).toBeGreaterThanOrEqual(record.finalTick - tick);
    }
  });

  it('at its own birth and death tick, lifecycle runs exactly once after the restore', () => {
    const checkpoint = captured.get(720)!;
    fromCheckpoint(checkpoint, (oracle, restored) => {
      const dying = checkpoint.bodyLifetimes.find((l) => l.deathTick === 720)!.id;
      expect(restored.host.ids).toContain(dying);
      expect(restored.host.ids).not.toContain('stream:90');
      // The two commands at 720 first, then the step whose lifecycle expires one body and spawns one.
      restored.advance();
      oracle.advance();
      expect(at(restored.host)).toEqual({ tick: 720, cursor: cursors(720).through });
      restored.advance();
      oracle.advance();
      expect(restored.host.ids).not.toContain(dying);
      expect(restored.host.ids.filter((id) => id === 'stream:90')).toHaveLength(1);
      expect(restored.host.futureState().emitters[0]!.ordinal).toBe(91);
      expect(lockstep(oracle, restored).divergence).toBeNull();
    });
  });

  it('at addresses no 240th tick reaches: the first step, a death tick, between same-tick commands, the final boundary', { timeout: 60_000 }, () => {
    const death = 512 + 8 * 3;
    const at500 = cursors(500);
    const end = cursors(record.finalTick);
    const addresses: Address[] = [
      { tick: 1, cursor: 0 },
      { tick: death, cursor: cursors(death).before },
      { tick: 500, cursor: at500.before },
      { tick: 500, cursor: at500.before + 1 },
      { tick: 500, cursor: at500.before + 2 },
      { tick: 500, cursor: at500.through },
      { tick: record.finalTick, cursor: end.before },
      { tick: record.finalTick, cursor: end.through },
    ];
    for (const address of addresses) {
      const checkpoint = checkpointAt(address);
      expect(onPath(record, address)).toBe(true);
      const result = fromCheckpoint(checkpoint, (oracle, restored) => lockstep(oracle, restored, settledBody(oracle.host)));
      expect(result.divergence, `from (${address.tick}, ${address.cursor})`).toBeNull();
    }
  });

  it('a zero-duration recording restores at each of its tick-zero cursors and ends with no step', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.controller.editField('push', 'Move law', moveTo(0));
    s.controller.editField('push', 'Move law', moveTo(1));
    s.controller.editField('storm-bottle', 'Disable law', (f) => ({ ...f, enabled: false }));
    const zero = (await s.coordinator.stopRecording())!;
    for (let cursor = 0; cursor <= 3; cursor++) {
      const oracle = new LinearReplay(zero);
      oracle.runTo({ tick: 0, cursor });
      const restored = new RestoredReplay(zero, captureCheckpoint(oracle.host, scopeOf(zero)));
      restored.runToEnd();
      oracle.runToEnd();
      expect(restored.host.tick).toBe(0);
      expect(firstDivergence(observe(oracle.host), observe(restored.host))).toBeNull();
      oracle.dispose();
      restored.dispose();
    }
  });

  it('a restore of a restored world is exact too, and its old world can be freed first', () => {
    const first = new RestoredReplay(record, captured.get(240)!);
    first.runTo({ tick: 600, cursor: cursors(600).before });
    const second = new RestoredReplay(record, captureCheckpoint(first.host, scopeOf(record)));
    first.dispose();
    const oracle = new LinearReplay(record);
    oracle.runTo({ tick: 600, cursor: cursors(600).before });
    expect(lockstep(oracle, second, settledBody(oracle.host)).divergence).toBeNull();
    oracle.dispose();
    second.dispose();
  });
});

describe('the sidecar audit: every part is load-bearing, and the comparison finds its absence', () => {
  /** The first divergence of a restore from `checkpoint` changed by `change`, against the oracle. */
  const tampered = (change: (c: HostCheckpoint) => HostCheckpoint) => {
    const checkpoint = change(captured.get(720)!);
    return fromCheckpoint(checkpoint, (oracle, restored) => lockstep(oracle, restored, settledBody(oracle.host)).divergence);
  };
  const emitter = (c: HostCheckpoint, patch: Partial<HostCheckpoint['emitterStates'][number]>) => ({ ...c, emitterStates: [{ ...c.emitterStates[0]!, ...patch }] });

  it('the emitter PRNG state', () => {
    expect(tampered((c) => emitter(c, { prngState: 1279350577 }))).toMatchObject({ tick: 720, entity: 'emitter stream', component: 'prngState' });
  });
  it('the spawn ordinal', () => {
    expect(tampered((c) => emitter(c, { ordinal: 89 }))).toMatchObject({ tick: 720, entity: 'emitter stream', component: 'ordinal' });
  });
  it('a body lifetime', () => {
    const id = captured.get(720)!.bodyLifetimes.find((l) => l.deathTick === 720)!.id;
    expect(tampered((c) => ({ ...c, bodyLifetimes: c.bodyLifetimes.map((l) => (l.id === id ? { ...l, deathTick: 728 } : l)) }))).toMatchObject({ tick: 720, entity: `body ${id}`, component: 'deathTick' });
  });
  it('the ambient acceleration', () => {
    expect(tampered((c) => ({ ...c, ambientAcceleration: [0, -9.81, 0] }))).toMatchObject({ entity: 'simulation', component: 'ambientAcceleration.0' });
  });
  it('the active laws', () => {
    expect(tampered((c) => ({ ...c, activeFields: c.activeFields.filter((f) => f.id !== 'calm') }))).toMatchObject({ entity: 'law calm', component: 'presence' });
  });
  it('the skipped-emission count', () => {
    expect(tampered((c) => ({ ...c, skippedEmissions: 1 }))).toMatchObject({ entity: 'emitters', component: 'skippedEmissions' });
  });
  it('the order of living bodies, which the observation sorts away and the published arrays keep', () => {
    const reorder = <T,>(xs: readonly T[]) => [...xs.slice(1), xs[0]!];
    expect(tampered((c) => ({ ...c, bodyIdentityMap: reorder(c.bodyIdentityMap), bodyLifetimes: reorder(c.bodyLifetimes) }))).toMatchObject({ tick: 720, entity: 'published', component: 'ids' });
  });
  it('a body’s rendered radius, which the restore checks against the engine’s own collider', () => {
    expect(() => tampered((c) => ({ ...c, bodyIdentityMap: c.bodyIdentityMap.map((m, i) => (i === 0 ? { ...m, radius: m.radius + 0.01 } : m)) }))).toThrow(/engine snapshot for body/);
  });
  it('the collider names that identify contact partners, checked against the bodies and the root’s fixed colliders', () => {
    expect(() => tampered((c) => ({ ...c, colliderIdentity: c.colliderIdentity.map((x) => (x.id === 'floor' ? { ...x, id: 'stream:999' } : x)) }))).toThrow(/every body and collider/);
    const [a, b] = captured.get(720)!.bodyIdentityMap;
    const swap = (x: { collider: number; id: string }) => (x.id === a!.id ? { ...x, id: b!.id } : x.id === b!.id ? { ...x, id: a!.id } : x);
    expect(() => tampered((c) => ({ ...c, colliderIdentity: c.colliderIdentity.map(swap) }))).toThrow(/names collider/);
  });
  it('the diagnostics the last step left', () => {
    expect(tampered((c) => ({ ...c, maxSpeed: c.maxSpeed + 1 }))).toMatchObject({ tick: 720, entity: 'published', component: 'maxSpeed' });
    expect(tampered((c) => ({ ...c, limitedSteps: c.limitedSteps + 1 }))).toMatchObject({ tick: 720, entity: 'published', component: 'limitedSteps' });
  });
  it('the applied cursor, which places the next recorded command', () => {
    const c720 = captured.get(720)!;
    expect(() => new RestoredReplay(record, { ...c720, lastAppliedSequence: c720.lastAppliedSequence - 1 })).toThrow(/not on the recording’s path/);
  });
});

describe('restoring validates the checkpoint against its root and its own snapshot (SPEC §14.1)', () => {
  const root = () => record.root.semantic;
  const rejects = (checkpoint: HostCheckpoint, pattern: RegExp) => {
    const before = worldCounts().allocated;
    expect(() => new SimulationHost(root(), checkpoint)).toThrow(CheckpointRejected);
    expect(() => new SimulationHost(root(), checkpoint)).toThrow(pattern);
    // Nothing is left allocated by a refusal, whether before or after the world was restored.
    expect(worldCounts().allocated).toBe(before);
  };

  it('refuses a sidecar inconsistent with its root or with its engine bytes, allocating nothing', () => {
    const c = captured.get(720)!;
    rejects({ ...c, phase: 'after-lifecycle' as 'settled-before-lifecycle' }, /settled boundary/);
    rejects({ ...c, emitterStates: [] }, /emitters/);
    rejects({ ...c, bodyLifetimes: c.bodyLifetimes.map((l, i) => (i === 0 ? { ...l, deathTick: 719 } : l)) }, /lifetime/);
    rejects({ ...c, bodyIdentityMap: c.bodyIdentityMap.map((m, i) => (i === 0 ? { ...m, collider: c.bodyIdentityMap[1]!.collider } : m)) }, /engine snapshot for body/);
    rejects({ ...c, bodyIdentityMap: c.bodyIdentityMap.slice(1), bodyLifetimes: c.bodyLifetimes.slice(1) }, /every body and collider/);
    // Another tick's engine bytes under this sidecar: bodies born since then are not in that world.
    rejects({ ...c, engineBytes: captured.get(480)!.engineBytes }, /engine snapshot/);
    rejects({ ...c, activeFields: [...c.activeFields].reverse() }, /stable ID order/);
  });

  it('captures only at a settled boundary: never with commands queued, while halted, or after a fault', () => {
    const host = new SimulationHost(root());
    host.submit({ kind: 'setAmbient', acceleration: [0, -1, 0] }, 1);
    expect(() => host.checkpoint()).toThrow(/settled boundary/);
    host.settleBoundary();
    expect(host.checkpoint().lastAppliedSequence).toBe(1);
    host.halted = true;
    expect(() => host.checkpoint()).toThrow(/settled boundary/);
    host.dispose();
  });

  it('a restored world is new: its own generation, and stepping it after the source world is freed stays exact', () => {
    const source = new LinearReplay(record);
    source.runTo({ tick: 300, cursor: cursors(300).through });
    const checkpoint = captureCheckpoint(source.host, scopeOf(record));
    const restored = new RestoredReplay(record, checkpoint);
    expect(restored.host.generation).not.toBe(source.host.generation);
    source.dispose();
    expect(source.host.disposed).toBe(true);
    const oracle = new LinearReplay(record);
    oracle.runTo(restored.address);
    expect(lockstep(oracle, restored).divergence).toBeNull();
    oracle.dispose();
    restored.dispose();
  });
});

describe('keys and eligibility (AC3)', () => {
  const scope = () => scopeOf(record);
  const c480 = () => captured.get(480)!;
  const target700 = () => ({ tick: 700, cursor: cursors(700).through });

  it('a checkpoint serves its own record, history, prefix, semantics and runtime, at or before the target', () => {
    // The captured ones carry the coordinator's history ID; rekey for this scope by capturing anew.
    const own = checkpointAt({ tick: 480, cursor: cursors(480).before });
    expect(ineligible(own, scope(), target700())).toBeNull();
    expect(ineligible({ ...own, runId: 'run-other' }, scope(), target700())).toBe('another run');
    expect(ineligible({ ...own, historyContextId: 'live-7' }, scope(), target700())).toBe('another history context');
    expect(ineligible({ ...own, simulationFingerprint: own.simulationFingerprint.replace('affine', 'other') }, scope(), target700())).toBe('another simulation fingerprint');
    expect(ineligible({ ...own, qualificationIdentity: compactJson({ ...TEST_IDENTITY, webkit: '0' }) }, scope(), target700())).toBe('another runtime');
    expect(ineligible({ ...own, commandPrefixIdentity: 'ffffffffffffffff' }, scope(), target700())).toBe('another command prefix');
    expect(ineligible(own, scope(), { tick: 479, cursor: cursors(479).through })).toBe('after the target');
    expect(c480().historyContextId).toMatch(/^record-/);
  });

  it('a later cursor at the same tick never serves an earlier target there; the nearest earlier one does', () => {
    const cache = new CheckpointCache();
    const at500 = cursors(500);
    const before = checkpointAt({ tick: 500, cursor: at500.before });
    const later = checkpointAt({ tick: 500, cursor: at500.before + 2 });
    cache.put(before);
    cache.put(later);
    expect(ineligible(later, scope(), { tick: 500, cursor: at500.before + 1 })).toBe('after the target');
    expect(cache.nearest(scope(), { tick: 500, cursor: at500.before + 1 })).toBe(before);
    expect(cache.nearest(scope(), { tick: 500, cursor: at500.before + 2 })).toBe(later);
    expect(cache.nearest(scope(), { tick: 501, cursor: at500.through })).toBe(later);
    expect(cache.nearest(scope(), { tick: 499, cursor: at500.before })).toBeNull();
  });

  it('a checkpoint off the record’s path is refused, even with a matching prefix', () => {
    const own = checkpointAt({ tick: 500, cursor: cursors(500).before });
    // Tick 499 with the cursor of 500's first command applied: no recorded state has that address.
    expect(ineligible({ ...own, tick: 499, lastAppliedSequence: cursors(500).before + 1, commandPrefixIdentity: scope().prefixes.at(cursors(500).before + 1)! }, scope(), target700())).toBe('off the record’s path');
  });

  it('prefix identities follow content: the same root and commands share one, and a changed command changes it from there on', () => {
    const copy = structuredClone(record) as RunRecord;
    const changed = structuredClone(record) as { -readonly [K in keyof RunRecord]: RunRecord[K] };
    const k = 10;
    (changed.commands[k - 1] as { transactionId: string }).transactionId = 'tx-other';
    const a = new PrefixIdentities(record);
    const b = new PrefixIdentities(copy);
    const c = new PrefixIdentities(changed);
    for (const cursor of [0, 1, k - 1, k, record.commands.length]) expect(b.at(cursor)).toBe(a.at(cursor));
    expect(c.at(k - 1)).toBe(a.at(k - 1));
    expect(c.at(k)).not.toBe(a.at(k));
    expect(c.at(record.commands.length)).not.toBe(a.at(record.commands.length));
    expect(a.at(record.commands.length + 1)).toBeNull();
  });

  it('a newer unrecorded live checkpoint, at the stopped tick or after it, never serves the stopped recording', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(250);
    s.controller.editField('push', 'Move law', moveTo(0));
    const stopped = (await s.coordinator.stopRecording())!;
    const replayScope = s.coordinator.scope(stopped);
    // The live world right after the stop holds the record's final state, in the live context.
    const live = s.live();
    const atStop = live.checkpoint();
    s.controller.editField('push', 'Move law', moveTo(0.5));
    const afterEdit = live.checkpoint();
    const liveKey = (c: HostCheckpoint, cursor: number) => ({
      ...c,
      runId: stopped.runId,
      historyContextId: `live-${s.coordinator.context}`,
      commandPrefixIdentity: replayScope.prefixes.at(cursor) ?? 'none',
      simulationFingerprint: replayScope.simulationFingerprint,
      qualificationIdentity: replayScope.qualificationIdentity,
      bytes: c.engineBytes.byteLength,
      checksum: '',
    });
    const end = { tick: stopped.finalTick, cursor: stopped.lastAppliedSequence };
    expect(ineligible(liveKey(atStop, 1), replayScope, end)).toBe('another history context');
    expect(ineligible(liveKey(afterEdit, 2), replayScope, end)).toBe('another history context');
    // Even rekeyed into the record's own history, the later cursor lies past the record's end.
    expect(ineligible({ ...liveKey(afterEdit, 2), historyContextId: replayScope.historyContextId }, replayScope, end)).toBe('off the record’s path');
  });
});

describe('the bounded cache (AC7)', () => {
  it('holds at most 64 MiB, 16 MiB in any one checkpoint, accounting engine bytes and sidecar text', () => {
    expect(CHECKPOINT_LIMITS).toEqual({ cacheBytes: 64 * 1024 * 1024, checkpointBytes: 16 * 1024 * 1024 });
    expect(CHECKPOINT_TICKS).toBe(240);
    for (const c of captured.values()) {
      expect(c.bytes).toBeGreaterThan(c.engineBytes.byteLength);
      expect(c.bytes - c.engineBytes.byteLength).toBeLessThan(64 * 1024);
      expect(intact(c)).toBe(true);
    }
  });

  it('evicts the least recently used, declines one over the individual limit, and never touches the record', () => {
    const before = exportRun(record).text;
    const sizes = [...captured.values()].map((c) => c.bytes);
    const cache = new CheckpointCache({ cacheBytes: Math.max(...sizes) * 2 + 1, checkpointBytes: Math.max(...sizes) });
    const [c240, c480, c720, c960] = [240, 480, 720, 960].map((t) => captured.get(t)!);
    const scope = fixture.coordinator.scope(record);
    expect(cache.put(c240!).stored).toBe(true);
    expect(cache.put(c480!).stored).toBe(true);
    // Using 240 makes 480 the least recent, so 480 is evicted first.
    expect(cache.nearest(scope, { tick: 300, cursor: cursors(300).before })).toBe(c240);
    expect(cache.put(c720!).evicted).toEqual([c480]);
    expect(cache.put(c960!).evicted).toEqual([c240]);
    expect(cache.list()).toEqual([c720, c960]);
    expect(cache.bytes).toBe(c720!.bytes + c960!.bytes);
    expect(cache.bytes).toBeLessThanOrEqual(cache.limits.cacheBytes);
    const tight = new CheckpointCache({ cacheBytes: 64 * 1024 * 1024, checkpointBytes: c720!.bytes - 1 });
    expect(tight.put(c720!)).toEqual({ stored: false, evicted: [] });
    expect(tight.size).toBe(0);
    expect(cache.discardHistory(scope.historyContextId)).toBe(2);
    expect([cache.size, cache.bytes]).toEqual([0, 0]);
    expect(exportRun(record).text).toBe(before);
  });

  it('a changed byte anywhere fails the checksum', () => {
    const c = captured.get(480)!;
    const bytes = new Uint8Array(c.engineBytes);
    bytes[bytes.length >> 1] ^= 1;
    expect(intact({ ...c, engineBytes: bytes })).toBe(false);
    expect(intact({ ...c, emitterStates: [{ ...c.emitterStates[0]!, prngState: c.emitterStates[0]!.prngState ^ 1 }] })).toBe(false);
    expect(intact({ ...c, lastAppliedSequence: c.lastAppliedSequence + 1 })).toBe(false);
    expect(fnv64(new Uint8Array([]))).toBe('cbf29ce484222325');
    expect(fnv64(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
  });
});
