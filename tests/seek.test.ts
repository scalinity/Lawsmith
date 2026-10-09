// T10 and T11 (M6B), seeking: through the run coordinator, every requested (tick, cursor) on the record's
// path is reconstructed out of sight, from the closest usable checkpoint or from the root, and equals
// the uninterrupted checkpoint-free M6A replay there. Only the latest request in the still-selected
// replay becomes visible; cancellation, Return to authoring and context changes leave nothing behind.
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TrailRecorder } from '../src/observation/trails';
import { compactJson, parseRun, type RunRecord } from '../src/persistence/runFile';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen } from '../src/domain/scene';
import type { Checkpoint } from '../src/simulation/checkpoints';
import { RunCoordinator, type CheckpointEvent, type SeekStatus } from '../src/simulation/contexts';
import { SimulationHost, initSimulation, resetPeakWorlds, worldCounts } from '../src/simulation/host';
import { exportRun } from '../src/simulation/recorder';
import { LinearReplay, firstDivergence, observe, type Address, type Observed } from '../src/simulation/replay';
import { EXPECT, TEST_IDENTITY, interventionRecord, laboratory, moveTo, session, type Session } from './support/run';

let record: RunRecord;
let s: Session;
let runs: RunCoordinator;
/** The oracle's observation at every target any case here seeks to, keyed `tick:cursor`. */
const oracle = new Map<string, Observed>();

const cursors = (n: number) => ({
  before: record.commands.filter((c) => c.atTick < n).length,
  through: record.commands.filter((c) => c.atTick <= n).length,
});
const key = (a: Address) => `${a.tick}:${a.cursor}`;
/** Tick n as the timeline means it: after its included commands (SPEC §13.3). */
const tick = (n: number): Address => ({ tick: n, cursor: cursors(n).through });

/** A fixed shuffle (xorshift32), so the order is the same on every run. */
function shuffled<T>(xs: readonly T[], seed = 0x9e3779b9): T[] {
  const out = [...xs];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

let targets: Address[] = [];

beforeAll(async () => {
  await initSimulation();
  ({ record, session: s } = await interventionRecord());
  runs = s.coordinator;
  const at500 = cursors(500);
  const at720 = cursors(720);
  const end = cursors(record.finalTick);
  const special: Address[] = [
    { tick: 0, cursor: 0 },
    tick(1),
    tick(239),
    { tick: 240, cursor: cursors(240).before },
    tick(241),
    { tick: 500, cursor: at500.before },
    { tick: 500, cursor: at500.before + 1 },
    { tick: 500, cursor: at500.before + 2 },
    tick(500),
    tick(512 + 8 * 5),
    { tick: 720, cursor: at720.before },
    { tick: 720, cursor: at720.before + 1 },
    tick(720),
    tick(800),
    tick(900),
    tick(959),
    tick(961),
    { tick: record.finalTick, cursor: end.before },
    { tick: record.finalTick, cursor: end.before + 1 },
    tick(record.finalTick),
  ];
  const random = shuffled(Array.from({ length: record.finalTick }, (_, i) => i)).slice(0, 24).map(tick);
  targets = [...new Map([...special, ...random].map((a) => [key(a), a])).values()];
  const linear = new LinearReplay(record);
  for (const a of [...targets].sort((x, y) => x.tick - y.tick || x.cursor - y.cursor)) {
    linear.runTo(a);
    oracle.set(key(a), observe(linear.host));
  }
  linear.dispose();
}, 60_000);

/** Runs the pending seek to its end in one batch with no deadline. */
function finish(): SeekStatus {
  for (;;) {
    const status = runs.seekWork(Infinity, () => performance.now());
    if (status.kind !== 'working') return status;
  }
}

/** Seeks and waits for the result, which must commit at exactly the target. */
function seekNow(target: Address): SeekStatus {
  const job = runs.seek(target);
  if (!job) return { kind: 'idle' };
  const status = finish();
  expect(status.kind).toBe('committed');
  expect(runs.replay!.address).toEqual(target);
  return status;
}

/** A fresh replay of the fixture with an empty cache. */
function freshReplay(): void {
  if (runs.selected === 'replay') runs.returnToAuthoring();
  runs.checkpoints.discardHistory(runs.scope(record).historyContextId);
  runs.enterReplay();
}

const authoringState = () => {
  const { controller } = s;
  const live = observe(s.live());
  return { scene: controller.scene, revision: controller.revision, applied: controller.appliedRevision, generation: controller.generation, undo: controller.canUndo, redo: controller.canRedo, host: s.live(), live };
};

describe('seeking reaches exactly the uninterrupted state (AC1, AC2)', () => {
  it('every target, in shuffled order, equals the oracle: between checkpoints, between same-tick commands, at births, deaths and the final boundary', { timeout: 60_000 }, () => {
    freshReplay();
    const sources: string[] = [];
    for (const target of shuffled(targets, 7)) {
      const status = seekNow(target);
      if (status.kind === 'committed') {
        sources.push(status.job.source!.kind);
        // A source at or before the target, never a later cursor at the same tick.
        const from = status.job.source!.address;
        expect(from.tick < target.tick || (from.tick === target.tick && from.cursor <= target.cursor)).toBe(true);
      }
      const divergence = firstDivergence(oracle.get(key(target))!, observe(runs.replay!.host));
      expect(divergence, `at (${target.tick}, ${target.cursor})`).toBeNull();
    }
    // The first long seek rebuilt from the root and left checkpoints; most later ones restored one.
    expect(sources[0]).toBe('root');
    expect(sources.filter((k) => k === 'checkpoint').length).toBeGreaterThan(targets.length / 2);
    runs.returnToAuthoring();
  });

  it('a seek passes its 240th ticks and captures them, so the next one is cached', () => {
    freshReplay();
    expect(runs.checkpoints.size).toBe(0);
    seekNow(tick(1000));
    expect(runs.checkpoints.list().map((c) => c.tick)).toEqual([240, 480, 720, 960]);
    const back = seekNow(tick(500));
    expect(back.kind === 'committed' && back.job.source).toEqual({ kind: 'checkpoint', address: { tick: 480, cursor: cursors(480).before } });
    expect(back.kind === 'committed' && back.job.steps).toBe(20);
    runs.returnToAuthoring();
  });

  it('playing on from a seek’s result continues the recorded path exactly to the end, and the end checks itself', async () => {
    freshReplay();
    seekNow(tick(1000));
    seekNow({ tick: 720, cursor: cursors(720).before + 1 });
    while (!runs.replay!.complete) runs.advanceReplay(10, Infinity, () => 0);
    expect(firstDivergence(oracle.get(key(tick(record.finalTick)))!, observe(runs.replay!.host))).toBeNull();
    expect(await runs.checkReplay()).toEqual({ kind: 'match' });
    runs.returnToAuthoring();
  });

  it('a zero-duration recording seeks between its tick-zero commands, with no step', async () => {
    const z = session();
    z.coordinator.startRecording();
    for (const x of [0, 0.5, 1]) z.controller.editField('push', 'Move law', moveTo(x));
    const zero = (await z.coordinator.stopRecording())!;
    z.coordinator.enterReplay();
    for (const cursor of [3, 1, 2, 0]) {
      z.coordinator.seek({ tick: 0, cursor });
      let status: SeekStatus;
      do status = z.coordinator.seekWork(Infinity, () => 0);
      while (status.kind === 'working');
      const reference = new LinearReplay(zero);
      reference.runTo({ tick: 0, cursor });
      expect(z.coordinator.replay!.host.tick).toBe(0);
      expect(firstDivergence(observe(reference.host), observe(z.coordinator.replay!.host))).toBeNull();
      reference.dispose();
    }
    z.coordinator.returnToAuthoring();
  });

  it('refuses a target off the record’s path, and does nothing for the address already shown', () => {
    freshReplay();
    expect(() => runs.seek({ tick: record.finalTick + 1, cursor: record.lastAppliedSequence })).toThrow(/path/);
    expect(() => runs.seek({ tick: 499, cursor: cursors(500).before + 1 })).toThrow(/path/);
    expect(runs.seek({ tick: 0, cursor: 0 })).toBeNull();
    expect(runs.seeking).toBeNull();
    runs.returnToAuthoring();
    expect(() => runs.seek({ tick: 0, cursor: 0 })).toThrow(/replay/);
  });
});

describe('the latest request wins (AC5)', () => {
  /** A clock that advances one unit per reading: a deadline of n readings bounds a batch to about n units of work. */
  const clock = () => {
    let t = 0;
    return { now: () => t++, after: (n: number) => t + n };
  };

  it('a newer request frees the older one’s world; only the newer result becomes visible', () => {
    freshReplay();
    const shown = runs.replay!;
    const c = clock();
    const base = worldCounts().allocated;
    const older = runs.seek(tick(1000))!;
    expect(runs.seekWork(c.after(20), c.now).kind).toBe('working');
    expect(worldCounts().allocated).toBe(base + 1);
    // Still displayed: the replay as it was, never the half-built world.
    expect(runs.replay).toBe(shown);
    expect(runs.replay!.address).toEqual({ tick: 0, cursor: 0 });
    const newer = runs.seek(tick(300))!;
    expect(older.work).toBeNull();
    expect(worldCounts().allocated).toBe(base);
    expect(runs.seeking).toBe(newer);
    const status = finish();
    expect(status.kind === 'committed' && status.job).toBe(newer);
    expect(runs.replay!.address).toEqual(tick(300));
    expect(shown.host.disposed).toBe(true);
    expect(worldCounts().allocated).toBe(base);
    runs.returnToAuthoring();
  });

  it('rapid superseded seeks followed by Return to authoring: nothing commits, the authoring context is intact', () => {
    const before = authoringState();
    freshReplay();
    const base = worldCounts().allocated;
    const c = clock();
    for (const n of [900, 100, 1050, 30, 700, 450]) {
      runs.seek(tick(n));
      runs.seekWork(c.after(15), c.now);
      expect(worldCounts().allocated).toBeLessThanOrEqual(base + 1);
    }
    const pending = runs.seeking!;
    runs.returnToAuthoring();
    expect(pending.work).toBeNull();
    expect(runs.seeking).toBeNull();
    expect(runs.seekWork(Infinity, c.now)).toEqual({ kind: 'idle' });
    expect([runs.selected, runs.replay]).toEqual(['authoring', null]);
    expect(worldCounts().allocated).toBe(base - 1);
    const after = authoringState();
    expect(after.host).toBe(before.host);
    expect(after.scene).toBe(before.scene);
    expect([after.revision, after.applied, after.generation, after.undo, after.redo]).toEqual([before.revision, before.applied, before.generation, before.undo, before.redo]);
    expect(firstDivergence(before.live, after.live)).toBeNull();
  });

  it('Replay from start, an imported recording and dropping the record each cancel a pending seek', () => {
    const c = clock();
    freshReplay();
    const first = runs.seek(tick(1000))!;
    runs.seekWork(c.after(10), c.now);
    runs.restartReplay();
    expect([first.work, runs.seeking, runs.replay!.address]).toEqual([null, null, { tick: 0, cursor: 0 }]);

    const second = runs.seek(tick(1000))!;
    runs.seekWork(c.after(10), c.now);
    const read = parseRun(exportRun(record).text, EXPECT);
    if (!read.ok) throw read.error;
    runs.commitImport(runs.prepareImport(read.record));
    expect([second.work, runs.seeking]).toEqual([null, null]);
    expect(runs.replay!.record).toBe(read.record);

    const third = runs.seek({ tick: 600, cursor: read.record.commands.filter((x) => x.atTick <= 600).length })!;
    runs.seekWork(c.after(10), c.now);
    const base = worldCounts().allocated;
    runs.dropRecord();
    expect([third.work, runs.seeking, runs.replay]).toEqual([null, null, null]);
    expect(worldCounts().allocated).toBe(base - 2);
    // The fixture's record comes back for the cases that follow, as an import would bring it.
    const again = parseRun(exportRun(record).text, EXPECT);
    if (!again.ok) throw again.error;
    runs.commitImport(runs.prepareImport(again.record));
    record = again.record;
    runs.returnToAuthoring();
  });

  it('cancel frees the reconstruction and leaves the displayed replay exactly as it was', () => {
    freshReplay();
    seekNow(tick(600));
    const shown = runs.replay!;
    const before = observe(shown.host);
    const base = worldCounts().allocated;
    const c = clock();
    runs.seek(tick(100));
    runs.seekWork(c.after(5), c.now);
    expect(worldCounts().allocated).toBe(base + 1);
    const canceled = runs.cancelSeek()!;
    expect(canceled.work).toBeNull();
    expect(runs.replay).toBe(shown);
    expect(worldCounts().allocated).toBe(base);
    expect(firstDivergence(before, observe(shown.host))).toBeNull();
    runs.returnToAuthoring();
  });

  it('an uncached seek works in bounded batches and reports progress; nothing partial is displayed', () => {
    freshReplay();
    const shown = runs.replay!;
    const c = clock();
    const job = runs.seek(tick(1100))!;
    const progress: number[] = [];
    let status: SeekStatus;
    let batches = 0;
    do {
      const start = c.after(0);
      status = runs.seekWork(c.after(8), c.now);
      batches += 1;
      // A batch stops at its deadline: a few readings past it at most (the source, the batch's own bookkeeping).
      expect(c.after(0) - start).toBeLessThanOrEqual(8 + 4);
      if (status.kind === 'working') {
        progress.push(status.progress);
        expect(runs.replay).toBe(shown);
      }
    } while (status.kind === 'working');
    expect(status.kind).toBe('committed');
    expect(job.source!.kind).toBe('root');
    expect(batches).toBeGreaterThan(100);
    expect(progress.every((p, i) => p >= 0 && p < 1 && (i === 0 || p >= progress[i - 1]!))).toBe(true);
    expect(job.batches).toBe(batches);
    runs.returnToAuthoring();
  });
});

describe('cache corruption, other runtimes and resources (AC6, AC7)', () => {
  it('a corrupt checkpoint is caught before restoring; its record’s cache is discarded and the seek rebuilds from the root, exactly', () => {
    freshReplay();
    seekNow(tick(1000));
    const c720 = runs.checkpoints.list().find((c) => c.tick === 720)!;
    c720.engineBytes[c720.engineBytes.length >> 1] = c720.engineBytes[c720.engineBytes.length >> 1]! ^ 0x10;
    const restore = vi.spyOn(RAPIER.World, 'restoreSnapshot');
    try {
      runs.returnToAuthoring();
      runs.enterReplay();
      const status = seekNow(tick(800));
      expect(status.kind === 'committed' && status.job.source!.kind).toBe('root');
      expect(status.kind === 'committed' && status.job.rejected).toEqual([expect.stringMatching(/^checkpoint at \(720, \d+\): its bytes changed after capture$/)]);
      // The corrupt bytes never reached Rapier.
      expect(restore).not.toHaveBeenCalled();
      expect(firstDivergence(oracle.get(key(tick(800)))!, observe(runs.replay!.host))).toBeNull();
      // Rebuilt from the root, the seek captured fresh checkpoints on its way.
      expect(runs.checkpoints.list().map((c) => c.tick)).toEqual([240, 480, 720]);
      expect(runs.checkpoints.list().every((c) => c !== c720)).toBe(true);
    } finally {
      restore.mockRestore();
    }
    runs.returnToAuthoring();
  });

  it('a checkpoint from another runtime or build is never used: the seek rebuilds from the root and claims no more than before', () => {
    freshReplay();
    seekNow(tick(1000));
    const held = runs.checkpoints.list();
    runs.checkpoints.discardHistory(runs.scope(record).historyContextId);
    for (const c of held) runs.checkpoints.put({ ...c, qualificationIdentity: compactJson({ ...JSON.parse(c.qualificationIdentity), webkit: 'another' }) } as Checkpoint);
    const qualifiedBefore = runs.replayQualified;
    const status = seekNow(tick(900));
    expect(status.kind === 'committed' && status.job.source!.kind).toBe('root');
    expect(runs.replayQualified).toBe(qualifiedBefore);
    expect(firstDivergence(oracle.get(key(tick(900)))!, observe(runs.replay!.host))).toBeNull();
    runs.returnToAuthoring();
  });

  it('a cached seek restores an engine snapshot, which none of M6A’s checkpoint-free paths does', () => {
    freshReplay();
    seekNow(tick(1000));
    const restore = vi.spyOn(RAPIER.World, 'restoreSnapshot');
    try {
      seekNow(tick(250));
      expect(restore).toHaveBeenCalledTimes(1);
      runs.restartReplay();
      while (!runs.replay!.complete) runs.advanceReplay(1000, Infinity, () => 0);
      expect(restore).toHaveBeenCalledTimes(1);
    } finally {
      restore.mockRestore();
    }
    runs.returnToAuthoring();
  });

  it('views of the replaced world do not survive: trails start again, and the displaced world is freed', () => {
    freshReplay();
    const trails = new TrailRecorder('all');
    for (let i = 0; i < 200; i++) runs.advanceReplay(1, Infinity, () => 0, () => trails.record(runs.replay!.host, null));
    expect(trails.lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const displaced = runs.replay!.host;
    seekNow(tick(150));
    const shown = runs.replay!.host;
    expect(displaced.disposed).toBe(true);
    expect(shown.generation).not.toBe(displaced.generation);
    trails.sync(shown);
    expect(trails.lengths.reduce((a, b) => a + b, 0)).toBe(0);
    expect(trails.owners.every((o) => o === null)).toBe(true);
    runs.returnToAuthoring();
  });

  it('T11: 20 seek/reset cycles hold the worlds and the cache bytes steady', { timeout: 60_000 }, () => {
    const before = authoringState();
    freshReplay();
    seekNow(tick(record.finalTick));
    runs.returnToAuthoring();
    const base = worldCounts().allocated;
    const bytes = runs.checkpoints.bytes;
    const count = runs.checkpoints.size;
    resetPeakWorlds();
    const cycles: { worlds: number; bytes: number; count: number }[] = [];
    const c = { t: 0 };
    const now = () => c.t++;
    for (let cycle = 0; cycle < 20; cycle++) {
      runs.enterReplay();
      seekNow(tick(1 + ((cycle * 389) % record.finalTick)));
      runs.seek(tick(1 + ((cycle * 211) % record.finalTick)));
      runs.seekWork(c.t + 6, now);
      runs.cancelSeek();
      seekNow(tick(record.finalTick - cycle));
      runs.restartReplay();
      runs.seek(tick(700 + cycle));
      runs.seekWork(c.t + 6, now);
      runs.returnToAuthoring();
      cycles.push({ worlds: worldCounts().allocated, bytes: runs.checkpoints.bytes, count: runs.checkpoints.size });
    }
    expect(cycles.every((x) => x.worlds === base && x.bytes === bytes && x.count === count)).toBe(true);
    expect(count).toBe(4);
    // Authoring, the displayed replay and one reconstruction: three at most, never more.
    expect(worldCounts().peak - base).toBeLessThanOrEqual(2);
    const after = authoringState();
    expect(after.host).toBe(before.host);
    expect(firstDivergence(before.live, after.live)).toBeNull();
  });

  it('the cache reports what it captured and rejected, and a dropped record takes its checkpoints with it', async () => {
    const seen: CheckpointEvent[] = [];
    const document = laboratory();
    const controller = new DocumentController(document, new SimulationHost(cloneFrozen(document.semantic)));
    const coordinator = new RunCoordinator({ controller, identity: () => TEST_IDENTITY, runId: () => 'run-events', onCheckpoint: (e) => seen.push(e) });
    coordinator.startRecording();
    for (let i = 0; i < 500; i++) {
      controller.liveHost.step();
      controller.sync();
    }
    await coordinator.stopRecording();
    coordinator.enterReplay();
    while (!coordinator.replay!.complete) coordinator.advanceReplay(100, Infinity, () => 0);
    expect(seen.map((e) => [e.kind, e.kind === 'captured' ? e.checkpoint.tick : null])).toEqual([['captured', 240], ['captured', 480]]);
    const [first] = coordinator.checkpoints.list();
    first!.engineBytes[0] = first!.engineBytes[0]! ^ 1;
    coordinator.seek({ tick: 300, cursor: 0 });
    while (coordinator.seekWork(Infinity, () => 0).kind === 'working');
    expect(seen.find((e) => e.kind === 'rejected')).toMatchObject({ kind: 'rejected', discarded: 2 });
    expect(coordinator.checkpoints.list().map((c) => c.tick)).toEqual([240]);
    coordinator.dropRecord();
    expect([coordinator.checkpoints.size, coordinator.checkpoints.bytes]).toEqual([0, 0]);
    controller.liveHost.dispose();
  });
});

describe('seeking never touches the authored document (AC9)', () => {
  it('the draft, undo, revision and the retained authoring world are identical after seeks, cancels and Return', () => {
    const before = authoringState();
    freshReplay();
    const selected = runs.selected;
    const exported = runs.exported;
    for (const target of shuffled(targets, 3).slice(0, 10)) seekNow(target);
    runs.seek(tick(5));
    runs.cancelSeek();
    expect([selected, runs.selected, runs.record, runs.exported, runs.recordingState]).toEqual(['replay', 'replay', record, exported, 'recorded']);
    runs.returnToAuthoring();
    const after = authoringState();
    expect(after.scene).toBe(before.scene);
    expect([after.revision, after.applied, after.generation, after.undo, after.redo]).toEqual([before.revision, before.applied, before.generation, before.undo, before.redo]);
    expect(firstDivergence(before.live, after.live)).toBeNull();
  });
});
