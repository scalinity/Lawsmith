// One coordinator, two contexts (SPEC §13.2; AC5, AC8, AC10, T11): replay builds a separate world from
// the frozen root while the authoring world waits, paused and untouched; Return to authoring reattaches
// that very world; only the selected context advances; an import holds one unstepped candidate at most;
// and repeated replay, restart, return and import cycles return to the same bounded world count.
import { beforeAll, describe, expect, it } from 'vitest';
import { cloneFrozen, deepFreeze } from '../src/domain/scene';
import { parseRun, type RunRecord } from '../src/persistence/runFile';
import { initSimulation, resetPeakWorlds, worldCounts } from '../src/simulation/host';
import { exportRun } from '../src/simulation/recorder';
import { LinearReplay, firstDivergence, observe } from '../src/simulation/replay';
import { FixedStepScheduler } from '../src/simulation/scheduler';
import { ProbeField, MAX_PROBES } from '../src/observation/probes';
import { TrailRecorder } from '../src/observation/trails';
import { EXPECT, drag, moveTo, session, type Session } from './support/run';

beforeAll(async () => {
  await initSimulation();
});

/** A session holding a finished recording, then more live authoring after it: moving bodies, edits, undo, a dirty document. */
async function retained(): Promise<{ s: Session; record: RunRecord }> {
  const s = session();
  s.coordinator.startRecording();
  s.steps(40);
  drag(s, 'push', [moveTo(-1), moveTo(-0.5), moveTo(0)], () => s.step());
  s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
  s.steps(30);
  const record = (await s.coordinator.stopRecording())!;
  // Newer authoring: the world moves on, laws change, undo fills.
  s.steps(55);
  drag(s, 'storm-bottle', [moveTo(2.5, 1.6), moveTo(2, 1.6)], () => s.step());
  s.controller.editField('push', 'Move law', moveTo(1.5));
  s.steps(20);
  return { s, record };
}

/** Everything about the authoring context a replay must not touch. */
function snapshot(s: Session) {
  const { controller } = s;
  return {
    host: s.live(),
    observed: observe(s.live()),
    generation: s.live().generation,
    scene: controller.scene,
    revision: controller.revision,
    appliedRevision: controller.appliedRevision,
    documentGeneration: controller.generation,
    canUndo: controller.canUndo,
    canRedo: controller.canRedo,
  };
}

function expectUnchanged(s: Session, before: ReturnType<typeof snapshot>) {
  const now = snapshot(s);
  expect(now.host).toBe(before.host);
  expect(firstDivergence(before.observed, now.observed)).toBeNull();
  expect(now.generation).toBe(before.generation);
  expect(now.scene).toBe(before.scene);
  expect([now.revision, now.appliedRevision, now.documentGeneration, now.canUndo, now.canRedo]).toEqual([before.revision, before.appliedRevision, before.documentGeneration, before.canUndo, before.canRedo]);
}

describe('Return to authoring reattaches the retained context (AC5)', () => {
  it('replay, restart and stepping leave the authoring world, document and undo exactly as they were, and its future too', async () => {
    const { s, record } = await retained();
    const twin = await retained();
    const before = snapshot(s);
    expect(firstDivergence(before.observed, observe(twin.s.live()))).toBeNull();
    const acks: unknown[] = [];
    const previous = s.controller.onAcks;
    s.controller.onAcks = (a) => acks.push(...a);

    const replay = s.coordinator.enterReplay();
    expect(s.coordinator.shown).toBe(replay.host);
    expect(replay.host).not.toBe(s.live());
    for (let i = 0; i < 25; i++) replay.advance();
    s.coordinator.restartReplay();
    expect(s.coordinator.replay!.address).toEqual({ tick: 0, cursor: 0 });
    s.coordinator.replay!.runToEnd();
    expect(s.coordinator.replay!.complete).toBe(true);
    // Replay never acknowledges anything to the authored document.
    expect(acks).toEqual([]);
    expectUnchanged(s, before);

    s.coordinator.returnToAuthoring();
    expect(s.coordinator.shown).toBe(s.live());
    expect(s.coordinator.replay).toBeNull();
    expectUnchanged(s, before);
    s.controller.onAcks = previous;

    // Its future is the one it would have had: the same steps and an undo, beside a twin that never replayed.
    for (const t of [s, twin.s]) {
      t.steps(90);
      expect(t.controller.undo().ok).toBe(true);
      t.steps(30);
    }
    expect(firstDivergence(observe(twin.s.live()), observe(s.live()))).toBeNull();
    expect(record.finalTick).toBe(73);
  });

  it('only the selected context advances: replay units never step the authoring world', async () => {
    const { s } = await retained();
    const tick = s.live().tick;
    s.coordinator.enterReplay();
    let clock = 0;
    for (let frame = 0; frame < 50; frame++) s.coordinator.advanceReplay(2, Infinity, () => clock++);
    expect(s.coordinator.replay!.host.tick).toBe(73);
    expect(s.live().tick).toBe(tick);
    s.coordinator.returnToAuthoring();
    expect(s.live().tick).toBe(tick);
  });

  it('replay ends paused at the frozen address and stays read-only there: no extra tick, no command', async () => {
    const { s, record } = await retained();
    s.coordinator.enterReplay();
    let clock = 0;
    let result = { complete: false, partial: false };
    while (!result.complete) result = s.coordinator.advanceReplay(8, Infinity, () => clock++);
    const end = observe(s.coordinator.replay!.host);
    expect(end.address).toEqual({ tick: record.finalTick, cursor: record.lastAppliedSequence });
    for (let frame = 0; frame < 30; frame++) expect(s.coordinator.advanceReplay(8, Infinity, () => clock++).complete).toBe(true);
    expect(firstDivergence(end, observe(s.coordinator.replay!.host))).toBeNull();
    expect(await s.coordinator.checkReplay()).toEqual({ kind: 'match' });
    s.coordinator.returnToAuthoring();
  });
});

describe('presentation cannot change a replay (AC8)', () => {
  it('2,000 probes, 32 trails, a changing explained body and previews leave every replayed boundary exact', async () => {
    const { s, record } = await retained();
    const quiet = new LinearReplay(record);
    const busy = new LinearReplay(record);
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: MAX_PROBES, seed: 7 });
    const trails = new TrailRecorder('all');
    let compared = 0;
    while (!quiet.complete) {
      quiet.advance();
      const host = busy.host;
      host.explain(host.count ? host.ids[host.tick % host.count]! : null);
      const ticked = busy.unsettled === 0 && !busy.complete;
      busy.advance();
      if (ticked) {
        probes.advance(host);
        trails.record(host, host.ids[0] ?? null);
      }
      host.previewTransition();
      expect(firstDivergence(observe(quiet.host), observe(host))).toBeNull();
      compared += 1;
    }
    expect(compared).toBe(record.finalTick);
    expect(probes.live).toBeGreaterThan(0);
    // Trails sample every fourth tick, so a body born in the last ticks has none yet.
    expect(trails.count).toBeGreaterThan(0);
    expect(trails.count).toBeLessThanOrEqual(Math.min(32, busy.host.count));
    quiet.dispose();
    busy.dispose();
    void s;
  });

  it('probes observing the replay through its step observer evolve exactly as the live probes did, through recorded edits', async () => {
    const s = session();
    const live = new ProbeField();
    live.configure({ enabled: true, count: 600, seed: 11 });
    s.coordinator.startRecording();
    live.sync(s.live());
    // As the app's frame does: settle, step, then observe the step, with an edit at every fifth boundary.
    for (let i = 0; i < 90; i++) {
      if (i % 5 === 0) s.controller.putField(moveTo(-1.5 + 0.05 * i)(s.controller.lawState('push')!.field), s.controller.newTransaction());
      s.controller.settle();
      s.live().step();
      live.advance(s.live());
    }
    s.controller.settle();
    await s.coordinator.stopRecording();
    s.coordinator.enterReplay();
    const replayed = new ProbeField();
    replayed.configure({ enabled: true, count: 600, seed: 11 });
    replayed.sync(s.coordinator.shown);
    const cursors: number[] = [];
    let clock = 0;
    while (!s.coordinator.replay!.complete) {
      s.coordinator.advanceReplay(3, Infinity, () => clock++, () => {
        // Right after the step: the new boundary's recorded commands are not applied yet.
        cursors.push(s.coordinator.shown.lastAppliedSequence);
        replayed.advance(s.coordinator.shown);
      });
    }
    expect(cursors).toHaveLength(90);
    expect(cursors.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 2]);
    expect(replayed.position).toEqual(live.position);
    expect(replayed.velocity).toEqual(live.velocity);
    expect(replayed.alive).toEqual(live.alive);
    // Negative control: observing after the whole unit, once the next boundary's edit applied, drifts.
    s.coordinator.restartReplay();
    const late = new ProbeField();
    late.configure({ enabled: true, count: 600, seed: 11 });
    late.sync(s.coordinator.shown);
    while (!s.coordinator.replay!.complete) {
      const tick = s.coordinator.shown.tick;
      s.coordinator.advanceReplay(1, Infinity, () => clock++);
      if (s.coordinator.shown.tick !== tick) late.advance(s.coordinator.shown);
    }
    expect(late.position).not.toEqual(live.position);
    s.coordinator.returnToAuthoring();
  });

  it('30, 60 and 144 Hz presentation reach the identical replayed end', async () => {
    const { record } = await retained();
    const ends = [30, 60, 144].map((hz) => {
      const s = session();
      // A coordinator replaying an imported copy of the record, paced by the live scheduler.
      const read = parseRun(exportRun(record).text, EXPECT);
      if (!read.ok) throw read.error;
      const candidate = s.coordinator.prepareImport(read.record);
      s.coordinator.commitImport(candidate);
      const scheduler = new FixedStepScheduler(1000 / 120);
      scheduler.play();
      let units = 0;
      for (let frame = 0; !s.coordinator.replay!.complete; frame++) {
        const t = (frame * 1000) / hz;
        const { steps } = scheduler.frame(t, t);
        units += steps;
        s.coordinator.advanceReplay(steps, Infinity, () => t);
        expect(frame).toBeLessThan(10_000);
      }
      const end = observe(s.coordinator.replay!.host);
      s.coordinator.returnToAuthoring();
      return { end, units };
    });
    expect(firstDivergence(ends[0]!.end, ends[1]!.end)).toBeNull();
    expect(firstDivergence(ends[0]!.end, ends[2]!.end)).toBeNull();
  });
});

describe('world-scoped views follow the selected context (M4 regression gate, AC10)', () => {
  it('trails and probes clear on every switch, before any step, and never carry another world’s bodies', async () => {
    const { s } = await retained();
    const trails = new TrailRecorder('all');
    const probes = new ProbeField();
    probes.configure({ enabled: true, count: 500, seed: 3 });
    // Authoring trails exist.
    for (let i = 0; i < 40; i++) {
      s.step();
      trails.record(s.live(), null);
    }
    expect(trails.count).toBe(Math.min(32, s.live().count));
    expect(trails.count).toBeGreaterThan(10);
    const authoringOwners = new Set(trails.owners.slice(0, trails.count));
    // Enter replay: the first frame syncs to the replay world and clears, before anything steps.
    s.coordinator.enterReplay();
    trails.sync(s.coordinator.shown);
    probes.sync(s.coordinator.shown);
    expect(trails.count).toBe(0);
    for (let i = 0; i < 40; i++) {
      s.coordinator.replay!.advance();
      trails.record(s.coordinator.shown, null);
    }
    expect(trails.count).toBeGreaterThan(0);
    // Return: the replay's trails go too, paused, before any authoring step.
    s.coordinator.returnToAuthoring();
    trails.sync(s.coordinator.shown);
    probes.sync(s.coordinator.shown);
    expect(trails.count).toBe(0);
    s.step();
    s.step();
    s.step();
    s.step();
    trails.record(s.live(), null);
    for (let slot = 0; slot < trails.count; slot++) expect(s.live().ids).toContain(trails.owners[slot]);
    expect(authoringOwners.size).toBeGreaterThan(10);
  });
});

describe('T11: bounded worlds through replay, restart, return and import cycles (AC10)', () => {
  it('20 replay/return and 20 restart cycles, with valid, invalid, failed and canceled imports, hold the steady counts', async () => {
    const { s, record } = await retained();
    const text = exportRun(record).text;
    const base = worldCounts().allocated;
    resetPeakWorlds();
    const counts: number[] = [];
    // Each cycle: enter, play part of the way, restart, play to the end, return.
    for (let cycle = 0; cycle < 20; cycle++) {
      s.coordinator.enterReplay();
      counts.push(worldCounts().allocated - base);
      for (let i = 0; i < 10 + cycle; i++) s.coordinator.replay!.advance();
      s.coordinator.restartReplay();
      counts.push(worldCounts().allocated - base);
      s.coordinator.replay!.runToEnd();
      s.coordinator.returnToAuthoring();
      counts.push(worldCounts().allocated - base);
    }
    expect(counts).toEqual(Array.from({ length: 20 }, () => [1, 1, 0]).flat());
    expect(worldCounts().peak - base).toBe(1);

    // 20 restart cycles inside one replay.
    s.coordinator.enterReplay();
    for (let cycle = 0; cycle < 20; cycle++) {
      for (let i = 0; i < 30; i++) s.coordinator.replay!.advance();
      s.coordinator.restartReplay();
      expect(worldCounts().allocated - base).toBe(1);
    }

    // Imports from replay: the candidate is the one transient extra world, a peak of three with authoring.
    resetPeakWorlds();
    expect(s.coordinator.counts()).toMatchObject({ authoring: 1, replay: 1, candidates: 0, selected: 'replay' });
    for (let cycle = 0; cycle < 20; cycle++) {
      const read = parseRun(text, EXPECT);
      if (!read.ok) throw read.error;
      const candidate = s.coordinator.prepareImport(read.record);
      expect(s.coordinator.counts()).toMatchObject({ replay: 1, candidates: 1 });
      expect(worldCounts().allocated - base).toBe(2);
      // The candidate is unstepped until it is promoted.
      expect(candidate.address).toEqual({ tick: 0, cursor: 0 });
      if (cycle % 3 === 0) s.coordinator.discardImport(candidate);
      else s.coordinator.commitImport(candidate);
      expect(worldCounts().allocated - base).toBe(1);
      // An invalid file never allocates a candidate.
      expect(parseRun(text.replace('"sequence":1,', '"sequence":9,'), EXPECT).ok).toBe(false);
      expect(worldCounts().allocated - base).toBe(1);
      // A candidate that cannot be built allocates nothing and leaves the counts.
      const unbuildable = deepFreeze({ ...structuredClone(read.record), root: { ...structuredClone(read.record.root), semantic: { ...structuredClone(read.record.root.semantic), simulation: { ...read.record.root.semantic.simulation, profile: 'another-profile' } } } }) as RunRecord;
      expect(() => s.coordinator.prepareImport(unbuildable)).toThrow(/profile/);
      expect(s.coordinator.counts().candidates).toBe(0);
      expect(worldCounts().allocated - base).toBe(1);
    }
    expect(worldCounts().peak - base).toBe(2);
    s.coordinator.returnToAuthoring();
    expect(worldCounts().allocated).toBe(base);
    expect(s.coordinator.counts()).toMatchObject({ authoring: 1, replay: 0, candidates: 0, selected: 'authoring' });
  });

  it('an import from authoring commits into replay; Return frees it; a later recording drops the old record', async () => {
    const { s, record } = await retained();
    const base = worldCounts().allocated;
    const read = parseRun(exportRun(record).text, EXPECT);
    if (!read.ok) throw read.error;
    const candidate = s.coordinator.prepareImport(read.record);
    s.coordinator.commitImport(candidate);
    expect(s.coordinator.exported).toBe(true);
    expect(s.coordinator.record).toBe(read.record);
    expect(worldCounts().allocated - base).toBe(1);
    s.coordinator.returnToAuthoring();
    expect(worldCounts().allocated).toBe(base);
    s.coordinator.startRecording();
    expect(s.coordinator.record).toBeNull();
    expect(worldCounts().allocated).toBe(base);
    // A new recording whose rebuild fails leaves the previous record in place.
    await s.coordinator.stopRecording();
    const previous = s.coordinator.record;
    const reset = s.controller.reset;
    s.controller.reset = () => {
      throw new Error('the world could not be allocated');
    };
    expect(() => s.coordinator.startRecording()).toThrow(/allocated/);
    s.controller.reset = reset;
    expect(s.coordinator.record).toBe(previous);
    s.coordinator.startRecording();
    // A running recording refuses an import before any candidate exists.
    expect(() => s.coordinator.prepareImport(read.record)).toThrow(/running recording/);
    expect([s.coordinator.counts().candidates, worldCounts().allocated]).toEqual([0, base]);
    void cloneFrozen;
  });
});
