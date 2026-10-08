// T09 (M6A): record what the live host actually consumed, from a frozen tick-zero root, and replay it
// linearly from that root to exactly the same authoritative state at every settled boundary and at the
// frozen final address. Real host, document controller, recorder, coordinator and replay world; no
// checkpoint is captured or restored anywhere.
import { beforeAll, describe, expect, it } from 'vitest';
import { cloneFrozen, type FieldDefinition, type FieldExpression } from '../src/domain/scene';
import { compactJson, parseRun, serializeRun, type RunRecord } from '../src/persistence/runFile';
import { initSimulation, type AppliedCommand } from '../src/simulation/host';
import { exportRun } from '../src/simulation/recorder';
import { LinearReplay, firstDivergence, observe } from '../src/simulation/replay';
import { EXPECT, Trajectory, drag, laboratory, moveTo, session, type Session } from './support/run';

beforeAll(async () => {
  await initSimulation();
});

/** Plays `n` fixed steps, capturing the live world at every settled boundary before each step. */
function play(s: Session, trajectory: Trajectory, n: number) {
  for (let i = 0; i < n; i++) {
    s.boundary();
    trajectory.capture(s.live());
    s.live().step();
    s.controller.sync();
  }
  s.boundary();
  trajectory.capture(s.live());
}

/** Replays `record` unit by unit, comparing every settled boundary the live run also passed through. */
function replayAgainst(record: RunRecord, trajectory: Trajectory) {
  const replay = new LinearReplay(record);
  const compared: string[] = [];
  try {
    const check = () => {
      const o = observe(replay.host);
      const key = `${o.address.tick}:${o.address.cursor}`;
      const expected = trajectory.at.get(key);
      if (expected) {
        expect(firstDivergence(expected, o)).toBeNull();
        compared.push(key);
      }
    };
    check();
    while (!replay.complete) {
      replay.advance();
      check();
    }
    return { replay: observe(replay.host), compared, steps: replay.host.tick };
  } finally {
    replay.dispose();
  }
}

const withTriangle = (f: FieldDefinition): FieldDefinition => {
  const sum = f.expression as Extract<FieldExpression, { kind: 'sum' }>;
  const terms = sum.terms.map((t, i) => (i === 1 ? { kind: 'gain' as const, gain: { kind: 'triangle' as const, min: 0, max: 2, periodTicks: 60, phaseTicks: 10 }, child: t } : t));
  return { ...f, expression: { kind: 'sum', terms } };
};

describe('T09 primary intervention fixture (AC1, AC2)', () => {
  it('a multi-boundary drag, an enable change, a triangle gain, live undo and paused terminal edits replay exactly at every boundary', { timeout: 60_000 }, async () => {
    const s = session();
    const { controller, coordinator } = s;
    const authoredBefore = controller.scene;
    coordinator.startRecording();
    const t = new Trajectory();
    t.capture(s.live());
    play(s, t, 60);

    // A multi-boundary drag of `push`: one consumed sample per boundary; every fourth boundary receives
    // two samples, and only the later one is consumed (pointer coalescing, SPEC §10.2).
    const xs = Array.from({ length: 12 }, (_, i) => -1.5 + 0.25 * (i + 1));
    const tx = controller.newTransaction();
    const before = controller.lawState('push')!;
    let submitted = 0;
    for (const [i, x] of xs.entries()) {
      if (i % 4 === 0) {
        expect(controller.putField(moveTo(x - 0.1)(before.field), tx).ok).toBe(true);
        submitted += 1;
      }
      const result = controller.putField(moveTo(x)(before.field), tx);
      expect(result.ok).toBe(true);
      submitted += 1;
      play(s, t, 1);
    }
    controller.record({ label: 'Move law', id: 'push', transactionId: tx, before, after: { field: controller.lawState('push')!.field, presentation: before.presentation } });
    play(s, t, 30);

    // An enable change, a triangle gain on the swirl, then live undo of the triangle.
    expect(controller.editField('storm-bottle', 'Disable law', (f) => ({ ...f, enabled: false })).ok).toBe(true);
    t.capture(s.live());
    play(s, t, 30);
    expect(controller.editField('storm-bottle', 'Enable law', (f) => ({ ...f, enabled: true })).ok).toBe(true);
    expect(controller.editField('storm-bottle', 'Swirl gain', withTriangle).ok).toBe(true);
    t.capture(s.live());
    play(s, t, 45);
    expect(controller.undo().ok).toBe(true);
    t.capture(s.live());
    play(s, t, 20);

    // A paused drag at one tick: several consumed samples at the same boundary.
    drag(s, 'storm-bottle', [moveTo(2.8, 1.6), moveTo(2.4, 1.6), moveTo(2.0, 1.6)], () => {
      s.boundary();
      t.capture(s.live());
    });
    play(s, t, 25);
    // Two paused edits at the final tick, then stop: the record ends after them, with no further step.
    expect(controller.editField('push', 'Strength', (f) => ({ ...f, expression: { kind: 'directional', direction: [1, 0, 0], strength: 20 } })).ok).toBe(true);
    t.capture(s.live());
    expect(controller.editField('storm-bottle', 'Move law', moveTo(1.8, 1.6)).ok).toBe(true);
    t.capture(s.live());
    const final = observe(s.live());
    const record = (await coordinator.stopRecording())!;

    // The log: every consumed command once, in sequence, at its boundary.
    expect(record.finalTick).toBe(final.address.tick);
    expect(record.lastAppliedSequence).toBe(final.address.cursor);
    expect(record.commands.map((c) => c.sequence)).toEqual(record.commands.map((_, i) => i + 1));
    expect(record.commands.every((c, i) => i === 0 || c.atTick >= record.commands[i - 1]!.atTick)).toBe(true);
    const dragCommands = record.commands.filter((c) => c.transactionId === tx);
    expect(submitted).toBe(15);
    expect(dragCommands).toHaveLength(12);
    expect(dragCommands.map((c) => (c.payload as { field: FieldDefinition }).field.pose.position[0])).toEqual(xs);
    expect(new Set(dragCommands.map((c) => c.atTick)).size).toBe(12);
    const pausedDrag = record.commands.filter((c) => c.payload.kind === 'putField' && c.payload.field.id === 'storm-bottle' && c.payload.field.pose.position[0] !== 3.2 && c.payload.field.pose.position[0] !== 1.8);
    expect(pausedDrag).toHaveLength(3);
    expect(new Set(pausedDrag.map((c) => c.atTick)).size).toBe(1);
    expect(new Set(pausedDrag.map((c) => c.transactionId)).size).toBe(1);
    // The undo is a later command of its own transaction; the triangle it undid is still in the log.
    const triangle = record.commands.find((c) => c.payload.kind === 'putField' && JSON.stringify(c.payload.field.expression).includes('triangle'))!;
    const undone = record.commands[triangle.sequence]!;
    expect(undone.payload.kind).toBe('putField');
    expect(undone.transactionId).not.toBe(triangle.transactionId);
    expect(JSON.stringify((undone.payload as { field: FieldDefinition }).field.expression)).not.toContain('triangle');
    const lastTwo = record.commands.slice(-2);
    expect(lastTwo.every((c) => c.atTick === record.finalTick)).toBe(true);

    // The root is the authored scene as it was at the start, not an alias of it.
    expect(compactJson(record.root.semantic)).toBe(compactJson(authoredBefore));
    expect(record.root.semantic).not.toBe(authoredBefore);
    expect(record.root.semantic.fields[0]).not.toBe(authoredBefore.fields[0]);

    // Replay from the frozen root: equal at every settled boundary, and at the end.
    const replayed = replayAgainst(record, t);
    // Every settled boundary, (0, 0) included: no tick-zero commands here, so one unit per step.
    expect(replayed.compared.length).toBe(record.finalTick + 1);
    expect(firstDivergence(final, replayed.replay)).toBeNull();
    expect(replayed.steps).toBe(record.finalTick);
    // And every address the live run passed through, intermediate same-tick cursors included, by the
    // oracle moving forward through them in order.
    const oracle = new LinearReplay(record);
    const addresses = [...t.at.values()].sort((a, b) => a.address.tick - b.address.tick || a.address.cursor - b.address.cursor);
    for (const expected of addresses) {
      oracle.runTo(expected.address);
      expect(firstDivergence(expected, observe(oracle.host))).toBeNull();
    }
    expect(addresses.length).toBeGreaterThan(record.finalTick + 5);
    oracle.dispose();

    // The coordinator's own replay checks itself against the recorded final digests.
    coordinator.enterReplay();
    coordinator.replay!.runToEnd();
    expect(await coordinator.checkReplay()).toEqual({ kind: 'match' });
    coordinator.returnToAuthoring();
  });

  it('the run file carries everything: serialized, read back and replayed, it reaches the same final state', { timeout: 30_000 }, async () => {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    play(s, t, 40);
    drag(s, 'push', [moveTo(-1), moveTo(-0.5), moveTo(0)], () => play(s, t, 1));
    expect(s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false })).ok).toBe(true);
    play(s, t, 10);
    const final = observe(s.live());
    const record = (await s.coordinator.stopRecording())!;
    const { text, bytes } = exportRun(record);
    expect(bytes).toBe(new TextEncoder().encode(text).length);
    const read = parseRun(text, EXPECT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(serializeRun(read.record)).toBe(text);
    const replay = new LinearReplay(read.record);
    replay.runToEnd();
    expect(firstDivergence(final, observe(replay.host))).toBeNull();
    replay.dispose();
  });
});

describe('negative controls: the comparison fails, and says where', () => {
  /** A recorded drag and its live trajectory, to tamper with. */
  async function recorded() {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    play(s, t, 20);
    const { transactionId } = drag(s, 'push', [moveTo(-1.2), moveTo(-0.9), moveTo(-0.6), moveTo(-0.3)], () => play(s, t, 1));
    play(s, t, 60);
    const record = (await s.coordinator.stopRecording())!;
    return { record, t, transactionId };
  }
  const tampered = (record: RunRecord, change: (r: { -readonly [K in keyof RunRecord]: RunRecord[K] }) => void): RunRecord => {
    const copy = structuredClone(record) as { -readonly [K in keyof RunRecord]: RunRecord[K] };
    change(copy);
    return copy;
  };
  /** The first divergence of a replay of `record` against the live run, comparing each tick's settled boundary. */
  function firstAgainst(record: RunRecord, t: Trajectory) {
    const settled = new Map<number, ReturnType<typeof observe>>();
    for (const o of t.at.values()) if (!settled.has(o.address.tick) || settled.get(o.address.tick)!.address.cursor < o.address.cursor) settled.set(o.address.tick, o);
    const replay = new LinearReplay(record);
    try {
      for (;;) {
        const o = observe(replay.host);
        const expected = settled.get(o.address.tick);
        const found = expected && firstDivergence(expected, o);
        if (found) return found;
        if (replay.complete) return null;
        replay.advance();
      }
    } finally {
      replay.dispose();
    }
  }

  it('one sample one ulp off: the first divergence is that law, at that command’s address', async () => {
    const { record, t, transactionId } = await recorded();
    expect(firstAgainst(record, t)).toBeNull();
    const second = record.commands.filter((c) => c.transactionId === transactionId)[1]!;
    const bad = tampered(record, (r) => {
      const field = (r.commands[second.sequence - 1]!.payload as unknown as { field: { pose: { position: number[] } } }).field;
      field.pose.position[0] = field.pose.position[0]! + Number.EPSILON;
    });
    const found = firstAgainst(bad, t)!;
    expect(found).toMatchObject({ tick: second.atTick, cursor: second.sequence, entity: 'law push', component: 'pose.position.0', expected: -0.9 });
    expect(found.observed).toBe(-0.9 + Number.EPSILON);
  });

  it('a log holding only the drag’s last transform fails at the first sample it lost', async () => {
    const { record, t, transactionId } = await recorded();
    const drags = record.commands.filter((c) => c.transactionId === transactionId);
    const lastOnly = tampered(record, (r) => {
      const kept = r.commands.filter((c) => c.transactionId !== transactionId || c.sequence === drags[drags.length - 1]!.sequence);
      r.commands = kept.map((c, i) => ({ ...c, sequence: i + 1 }));
      r.lastAppliedSequence = kept.length;
    });
    expect(firstAgainst(lastOnly, t)).toMatchObject({ tick: drags[0]!.atTick, entity: 'address', component: 'cursor', expected: 1, observed: 0 });
  });

  it('an untouched root law changed by one ulp diverges at (0, 0), naming the law', async () => {
    const { record, t } = await recorded();
    const bad = tampered(record, (r) => {
      const calm = r.root.semantic.fields.find((f) => f.id === 'calm')!;
      (calm.expression as { coefficient: number }).coefficient = 1.5000000000000002;
    });
    expect(firstAgainst(bad, t)).toMatchObject({ tick: 0, cursor: 0, entity: 'law calm', component: 'expression.coefficient' });
  });

  it('one step too many is caught as the wrong tick, never compared as the end', async () => {
    const { record } = await recorded();
    const right = new LinearReplay(record);
    right.runToEnd();
    const end = observe(right.host);
    right.host.step();
    expect(firstDivergence(end, observe(right.host))).toMatchObject({ entity: 'address', component: 'tick', expected: record.finalTick, observed: record.finalTick + 1 });
    right.dispose();
  });
});

describe('T09 boundary fixtures (AC3, AC4)', () => {
  it('A: two paused edits at one tick apply once each, in sequence', async () => {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    play(s, t, 30);
    s.controller.editField('push', 'Move law', moveTo(0));
    t.capture(s.live());
    s.controller.editField('push', 'Move law', moveTo(0.5));
    t.capture(s.live());
    play(s, t, 30);
    const record = (await s.coordinator.stopRecording())!;
    const at30 = record.commands.filter((c) => c.atTick === 30);
    expect(at30.map((c) => c.sequence)).toEqual([1, 2]);
    // The oracle stops between them: (30, 1) holds the first edit only.
    const between = new LinearReplay(record);
    between.runTo({ tick: 30, cursor: 1 });
    expect(firstDivergence(t.at.get('30:1')!, observe(between.host))).toBeNull();
    between.runTo({ tick: 30, cursor: 2 });
    expect(firstDivergence(t.at.get('30:2')!, observe(between.host))).toBeNull();
    between.dispose();
    replayAgainst(record, t);
  });

  it('B: commands at the final tick apply before the end, and no further step is taken', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(50);
    s.controller.editField('push', 'Move law', moveTo(0));
    s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
    const final = observe(s.live());
    const record = (await s.coordinator.stopRecording())!;
    expect([record.finalTick, record.lastAppliedSequence]).toEqual([50, 2]);
    const replay = new LinearReplay(record);
    replay.runToEnd();
    expect(replay.complete).toBe(true);
    expect(replay.host.tick).toBe(50);
    expect(firstDivergence(final, observe(replay.host))).toBeNull();
    // Nothing further: the replay refuses another step, and advancing at the end changes nothing.
    expect(() => replay.step()).toThrow(/ends at tick 50/);
    expect(replay.advance()).toBe(true);
    expect(replay.host.tick).toBe(50);
    // Stopping one command short is a different address and a different state.
    const short = new LinearReplay(record);
    short.runTo({ tick: 50, cursor: 1 });
    expect(firstDivergence(final, observe(short.host))?.component).toBe('cursor');
    short.dispose();
    replay.dispose();
  });

  it('C: a zero-duration recording of several tick-zero commands replays with zero steps', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.controller.editField('push', 'Move law', moveTo(0));
    s.controller.editField('push', 'Move law', moveTo(1));
    s.controller.editField('storm-bottle', 'Disable law', (f) => ({ ...f, enabled: false }));
    const final = observe(s.live());
    const record = (await s.coordinator.stopRecording())!;
    expect([record.finalTick, record.lastAppliedSequence, record.commands.length]).toEqual([0, 3, 3]);
    const replay = new LinearReplay(record);
    expect(replay.complete).toBe(false);
    expect(replay.advance()).toBe(true);
    expect(replay.complete).toBe(true);
    expect(replay.host.tick).toBe(0);
    expect(firstDivergence(final, observe(replay.host))).toBeNull();
    replay.dispose();
    // And it survives the file: a zero-duration run is valid.
    expect(parseRun(exportRun(record).text, EXPECT).ok).toBe(true);
  });

  it('D: a third, unrecorded edit at the stopped tick changes the live scene, never the record', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(20);
    s.controller.editField('push', 'Move law', moveTo(0));
    s.controller.editField('push', 'Move law', moveTo(0.5));
    const final = observe(s.live());
    const pending = s.coordinator.stopRecording()!;
    const contextAtStop = s.coordinator.context;
    // Immediately after the stop, before the record is even finalized: the same tick, a third edit.
    expect(s.controller.editField('push', 'Move law', moveTo(1)).ok).toBe(true);
    expect(s.live().tick).toBe(20);
    expect(s.live().lastAppliedSequence).toBe(3);
    const record = await pending;
    expect([record.finalTick, record.lastAppliedSequence, record.commands.length]).toEqual([20, 2, 2]);
    expect(s.coordinator.context).toBe(contextAtStop);
    const text = exportRun(record).text;
    // Later authoring, a reset and more edits leave it exactly as it was.
    s.steps(30);
    s.controller.reset();
    s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
    expect(exportRun(record).text).toBe(text);
    const replay = new LinearReplay(record);
    replay.runToEnd();
    expect(firstDivergence(final, observe(replay.host))).toBeNull();
    expect((replay.host.appliedFields().find((f) => f.id === 'push')!.pose.position[0])).toBe(0.5);
    replay.dispose();
  });

  it('E: undo is a later command; it never removes what was consumed before it', async () => {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    play(s, t, 10);
    const { transactionId } = drag(s, 'push', [moveTo(-1), moveTo(-0.5), moveTo(0), moveTo(0.5)], () => play(s, t, 1));
    play(s, t, 5);
    const undone = s.controller.undo();
    expect(undone.ok && undone.value.transactionId).toBe(transactionId);
    t.capture(s.live());
    play(s, t, 5);
    const redone = s.controller.redo();
    expect(redone.ok).toBe(true);
    t.capture(s.live());
    play(s, t, 5);
    const record = (await s.coordinator.stopRecording())!;
    const samples = record.commands.filter((c) => c.transactionId === transactionId);
    expect(samples).toHaveLength(4);
    const [undoCommand, redoCommand] = record.commands.slice(4);
    expect((undoCommand!.payload as { field: FieldDefinition }).field.pose.position[0]).toBe(-1.5);
    expect((redoCommand!.payload as { field: FieldDefinition }).field.pose.position[0]).toBe(0.5);
    expect(new Set([transactionId, undoCommand!.transactionId, redoCommand!.transactionId]).size).toBe(3);
    replayAgainst(record, t);
  });

  it('F: previews a boundary never consumed are not recorded; consumed ones are, one per boundary', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(5);
    const tx = s.controller.newTransaction();
    const base = s.controller.lawState('push')!.field;
    for (let k = 0; k < 10; k++) s.controller.putField(moveTo(-1 + k * 0.1)(base), tx);
    s.step();
    for (let k = 0; k < 7; k++) s.controller.putField(moveTo(k * 0.1)(base), tx);
    s.step();
    const record = (await s.coordinator.stopRecording())!;
    expect(record.commands.map((c) => [c.atTick, (c.payload as { field: FieldDefinition }).field.pose.position[0]])).toEqual([
      [5, -1 + 9 * 0.1],
      [6, 6 * 0.1],
    ]);
  });

  it('G: a large same-boundary batch replays in yielded chunks without stepping early or changing order', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(12);
    for (let k = 0; k < 400; k++) s.controller.editField('push', 'Move law', moveTo(-2 + k * 0.01));
    s.steps(3);
    const final = observe(s.live());
    const record = (await s.coordinator.stopRecording())!;
    expect(record.commands.filter((c) => c.atTick === 12)).toHaveLength(400);
    s.coordinator.enterReplay();
    const replay = s.coordinator.replay!;
    // A clock that expires after every check: each call applies one chunk and yields.
    let clock = 0;
    const now = () => (clock += 1);
    let calls = 0;
    let partials = 0;
    while (!replay.complete) {
      const deadline = clock;
      const before = replay.address;
      const result = s.coordinator.advanceReplay(1, deadline, now);
      calls += 1;
      if (result.partial) {
        partials += 1;
        // Mid-batch: still at tick 12, never past it, and the boundary is not reported settled.
        expect(replay.host.tick).toBe(12);
        expect(s.coordinator.replayPartial).toBe(true);
        expect(replay.address.cursor).toBeGreaterThan(before.cursor);
      }
      expect(calls).toBeLessThan(1000);
    }
    expect(partials).toBe(Math.ceil(400 / 64) - 1);
    expect(firstDivergence(final, observe(replay.host))).toBeNull();
    s.coordinator.returnToAuthoring();
  });
});

describe('the frozen root (AC2, AC4)', () => {
  it('no later edit, undo, redo, reset or open reaches the root or the consumed prefix', async () => {
    const s = session();
    const { controller, coordinator } = s;
    coordinator.startRecording();
    s.steps(10);
    drag(s, 'push', [moveTo(-1), moveTo(0)], () => s.step());
    const record = (await coordinator.stopRecording())!;
    const root = compactJson(record.root);
    const prefix = record.commands.map((c) => compactJson(c));
    // Deeply frozen: nothing reachable from the record can be changed.
    const frozen = (v: unknown): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(frozen(record)).toBe(true);
    // Every kind of later change to the authored scene.
    controller.editField('push', 'Move law', moveTo(3));
    controller.editField('storm-bottle', 'Gain', withTriangle);
    controller.editField('storm-bottle', 'Mask', (f) => {
      const sum = f.expression as Extract<FieldExpression, { kind: 'sum' }>;
      const mask = sum.terms[2] as Extract<FieldExpression, { kind: 'mask' }>;
      return { ...f, expression: { ...sum, terms: [sum.terms[0]!, sum.terms[1]!, { ...mask, edgeFade: 0.6 }] } };
    });
    controller.editField('storm-bottle', 'Add ingredient', (f) => {
      const sum = f.expression as Extract<FieldExpression, { kind: 'sum' }>;
      return { ...f, expression: { ...sum, terms: [...sum.terms, { kind: 'directional', direction: [0, 1, 0], strength: 3 }] } };
    });
    controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
    controller.remove('push');
    controller.undo();
    controller.redo();
    controller.undo();
    controller.reset();
    s.steps(5);
    controller.create('vortexY', [0, 1, 0]);
    controller.load(laboratory(), s.live());
    expect(compactJson(record.root)).toBe(root);
    expect(record.commands.map((c) => compactJson(c))).toEqual(prefix);
  });

  it('a replay world shows every root law, the untouched ones included, and no later authored value', async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(10);
    s.controller.editField('push', 'Move law', moveTo(0.25));
    s.steps(10);
    const record = (await s.coordinator.stopRecording())!;
    // Newer authoring after the stop: none of it may appear in the replay.
    s.controller.editField('calm', 'Move law', moveTo(5, 0, 0));
    s.controller.editField('storm-bottle', 'Disable law', (f) => ({ ...f, enabled: false }));
    const replay = s.coordinator.enterReplay();
    const ids = (fs: readonly FieldDefinition[]) => fs.map((f) => f.id);
    expect(ids(replay.host.appliedFields())).toEqual(['calm', 'push', 'storm-bottle']);
    expect(compactJson(replay.host.appliedFields())).toBe(compactJson(record.root.semantic.fields));
    replay.runToEnd();
    const after = replay.host.appliedFields();
    expect(after.find((f) => f.id === 'push')!.pose.position[0]).toBe(0.25);
    const rootField = (id: string) => record.root.semantic.fields.find((f) => f.id === id)!;
    expect(compactJson(after.find((f) => f.id === 'calm'))).toBe(compactJson(rootField('calm')));
    expect(compactJson(after.find((f) => f.id === 'storm-bottle'))).toBe(compactJson(rootField('storm-bottle')));
    s.coordinator.returnToAuthoring();
  });
});

describe('the triangle gain and pause under replay (AC8)', () => {
  it('a retuned triangle replays tick for tick, and pausing anywhere adds no tick and no phase', async () => {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    s.controller.editField('storm-bottle', 'Swirl gain', withTriangle);
    play(s, t, 70);
    s.controller.editField('storm-bottle', 'Retune', (f) => {
      const sum = f.expression as Extract<FieldExpression, { kind: 'sum' }>;
      const gain = sum.terms[1] as Extract<FieldExpression, { kind: 'gain' }>;
      return { ...f, expression: { ...sum, terms: [sum.terms[0]!, { ...gain, gain: { kind: 'triangle', min: 0.5, max: 3, periodTicks: 24, phaseTicks: 5 } }, sum.terms[2]!] } };
    });
    t.capture(s.live());
    play(s, t, 70);
    const record = (await s.coordinator.stopRecording())!;
    const straight = replayAgainst(record, t);
    // The same replay, paused for many frames at three places: nothing advances while paused.
    s.coordinator.enterReplay();
    const replay = s.coordinator.replay!;
    let clock = 0;
    const now = () => clock;
    while (!replay.complete) {
      if ([20, 70, 100].includes(replay.host.tick)) {
        const before = observe(replay.host);
        for (let frame = 0; frame < 120; frame++) {
          s.coordinator.advanceReplay(0, Infinity, now);
          for (const field of replay.host.compiledFields()) replay.host.previewTransition(), field;
        }
        expect(firstDivergence(before, observe(replay.host))).toBeNull();
      }
      s.coordinator.advanceReplay(1, Infinity, now);
      clock += 1;
    }
    expect(firstDivergence(straight.replay, observe(replay.host))).toBeNull();
    s.coordinator.returnToAuthoring();
  });
});

describe('setAmbient: the full command vocabulary records and replays', () => {
  it('an ambient change consumed live is recorded, adopted by the document and replayed exactly', async () => {
    const s = session();
    s.coordinator.startRecording();
    const t = new Trajectory();
    play(s, t, 30);
    expect(s.controller.setAmbient([0.5, -4, 0]).ok).toBe(true);
    t.capture(s.live());
    play(s, t, 30);
    expect(s.controller.setAmbient([0, 0, 500]).ok).toBe(false);
    expect(s.controller.scene.simulation.ambientAcceleration).toEqual([0.5, -4, 0]);
    const record = (await s.coordinator.stopRecording())!;
    const ambient = record.commands.find((c): c is AppliedCommand & { payload: { kind: 'setAmbient' } } => c.payload.kind === 'setAmbient')!;
    expect([ambient.atTick, ambient.payload.acceleration]).toEqual([30, [0.5, -4, 0]]);
    const end = replayAgainst(record, t);
    expect(end.replay.state.simulation.ambientAcceleration).toEqual([0.5, -4, 0]);
    // The root kept the old gravity; a reset from the authored scene now uses the new one.
    expect(record.root.semantic.simulation.ambientAcceleration).toEqual([0, -9.81, 0]);
    s.controller.reset();
    expect(s.live().settings.ambientAcceleration).toEqual([0.5, -4, 0]);
    expect(cloneFrozen(s.live().futureState().simulation).ambientAcceleration).toEqual([0.5, -4, 0]);
  });
});

describe('the native QA scene', () => {
  it('m6a-lab is canonical: the Storm Bottle, an independent push and an untouched drag', async () => {
    const { default: text } = await import('../scripts/verify/scenes/m6a-lab.lawsmith.json?raw');
    const { parseScene: parse, serializeScene: serialize } = await import('../src/persistence/sceneFile');
    const parsed = parse(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serialize(parsed.document)).toBe(text);
    expect(parsed.document.semantic.fields.map((f) => f.id)).toEqual(['calm', 'push', 'storm-bottle']);
  });
});
