// T09 recording limits (AC7, SPEC §13.3): 60 simulated seconds, 50,000 commands and 16 MiB of complete
// UTF-8 run data, whichever comes first. A command that would not fit is refused before it changes
// anything; the record closes intact at its last accepted address; queued edits never spill into it or
// into the paused scene; a gesture cut by the limit keeps one coherent undo entry; the saved record
// reads back within the same limits. Real host, document controller, recorder and coordinator.
import { beforeAll, describe, expect, it } from 'vitest';
import { NOT_APPLIED } from '../src/domain/document';
import { type FieldDefinition, type FieldExpression } from '../src/domain/scene';
import { RUN_LIMITS, commandText, parseRun, utf8Bytes } from '../src/persistence/runFile';
import { RunCoordinator } from '../src/simulation/contexts';
import { initSimulation, type AppliedCommand } from '../src/simulation/host';
import { RecordingTooLarge, exportRun } from '../src/simulation/recorder';
import { LinearReplay, firstDivergence, observe } from '../src/simulation/replay';
import { EXPECT, TEST_IDENTITY, moveTo, session, type Session } from './support/run';

beforeAll(async () => {
  await initSimulation();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A law of 64 nodes (the per-law limit): eight gains over masked primitives under one sum. */
function heavy(id: string, x: number): FieldDefinition {
  const leaf = (k: number): FieldExpression => ({
    kind: 'mask',
    pose: { position: [0.1 * k, 0.2, 0.3], rotation: [0, 0, 0, 1] },
    region: { kind: 'box', halfExtents: [1.25, 1.5, 1.75] },
    edgeFade: 0.125,
    child: { kind: 'mask', pose: { position: [0, 0.05 * k, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 2.5 }, edgeFade: 0.25, child: { kind: 'directional', direction: [1, 0, 0], strength: 1 + k } },
  });
  const terms: FieldExpression[] = Array.from({ length: 15 }, (_, k) => ({ kind: 'gain', gain: { kind: 'triangle', min: 0, max: 2, periodTicks: 30 + k, phaseTicks: k }, child: leaf(k) }));
  return { id, enabled: true, pose: { position: [x, 1, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'box', halfExtents: [2, 2, 2] }, edgeFade: 0.25, expression: { kind: 'sum', terms } };
}

/** The size one put of `field` adds to the file at this boundary and cursor. */
function putSize(s: Session, field: FieldDefinition, transactionId: string): number {
  const validated = s.controller.putField(field, transactionId);
  if (!validated.ok) throw new Error(validated.reason);
  s.controller.discardPending();
  const command: AppliedCommand = { atTick: s.live().tick, sequence: s.live().lastAppliedSequence + 1, transactionId, payload: { kind: 'putField', field: validated.value.field } };
  return utf8Bytes(commandText(command)) + 6;
}

describe('duration: 60 simulated seconds', () => {
  it('closes at exactly tick 7200, steps no further while recording, and leaves unrecorded authoring unlimited', { timeout: 120_000 }, async () => {
    const s = session();
    // Unrecorded authoring first: no 60-second lifetime.
    s.steps(7300);
    expect(s.live().tick).toBe(7300);
    s.controller.reset();
    s.coordinator.startRecording();
    s.steps(3600);
    s.controller.editField('push', 'Move law', moveTo(0));
    s.steps(3599);
    expect(s.coordinator.recordingState).toBe('recording');
    s.step();
    expect(s.live().tick).toBe(7200);
    // Closed at the limit: the world is held at the record's end until the stop is resolved.
    expect(s.coordinator.recordingState).toBe('finalizing');
    expect(s.live().halted).toBe(true);
    s.controller.putField(moveTo(1)(s.controller.lawState('push')!.field));
    s.step();
    expect(s.live().tick).toBe(7200);
    await flush();
    expect(s.limits).toEqual(['duration']);
    expect(s.live().halted).toBe(false);
    const record = (await s.coordinator.settled())!;
    expect([record.stopped, record.finalTick, record.lastAppliedSequence]).toEqual(['duration', 7200, 1]);
    // The queued edit was discarded unapplied; the live world goes on, unrecorded, past 7200.
    expect(s.controller.lawState('push')!.field.pose.position[0]).toBe(0);
    s.steps(10);
    expect(s.live().tick).toBe(7210);
    expect(record.lastAppliedSequence).toBe(1);
    const replay = new LinearReplay(record);
    replay.runToEnd();
    expect(replay.host.tick).toBe(7200);
    expect(replay.complete).toBe(true);
    replay.dispose();
    expect(parseRun(exportRun(record).text, EXPECT).ok).toBe(true);
  });
});

describe('command count: 50,000', () => {
  it('records the 50,000th command, refuses the next before it applies, and keeps undo coherent', { timeout: 120_000 }, async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(3);
    for (let k = 0; k < RUN_LIMITS.commands - 1; k++) expect(s.controller.setAmbient([0, k % 2 ? -9.8 : -9.81, 0]).ok).toBe(true);
    // The 50,000th: an ordinary edit with its undo entry.
    expect(s.controller.editField('push', 'Move law', moveTo(0)).ok).toBe(true);
    expect(s.coordinator.recorder!.count).toBe(RUN_LIMITS.commands);
    const before = observe(s.live());
    const undoDepth = s.controller.canUndo;
    // The 50,001st is refused before it mutates anything: the law, the cursor and the undo history stay.
    const refused = s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
    expect(refused).toEqual({ ok: false, reason: NOT_APPLIED, path: '' });
    expect(firstDivergence(before, observe(s.live()))).toBeNull();
    expect(s.controller.lawState('calm')!.field.enabled).toBe(true);
    await flush();
    expect(s.limits).toEqual(['commands']);
    expect(s.live().pendingCount).toBe(0);
    const record = (await s.coordinator.settled())!;
    expect([record.stopped, record.commands.length, record.lastAppliedSequence, record.finalTick]).toEqual(['commands', 50_000, 50_000, 3]);
    // Undo still holds the 50,000th edit, and nothing for the refused one.
    expect(undoDepth).toBe(true);
    const undone = s.controller.undo();
    expect(undone.ok && undone.value.label).toBe('Move law');
    // Authoring resumes, unrecorded: the refused edit can simply be made again.
    expect(s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false })).ok).toBe(true);
    expect(record.commands.length).toBe(50_000);
    // The capped record reimports within the same limits and replays to its end.
    const { text, bytes } = exportRun(record);
    expect(bytes).toBeLessThanOrEqual(RUN_LIMITS.fileBytes);
    const read = parseRun(text, EXPECT);
    expect(read.ok).toBe(true);
    const replay = new LinearReplay(read.ok ? read.record : record);
    replay.runToEnd();
    expect(firstDivergence(before, observe(replay.host))).toBeNull();
    replay.dispose();
  });
});

describe('complete UTF-8 bytes: 16 MiB', () => {
  it('accepts the command that fills the budget exactly and refuses the first that overflows it', { timeout: 120_000 }, async () => {
    const s = session();
    s.coordinator.startRecording();
    const recorder = s.coordinator.recorder!;
    s.steps(2);
    const left = () => RUN_LIMITS.fileBytes - recorder.bytes;
    // Coarse: 64-node compound puts. Then medium: ambient commands. Then exact: the last few ambient
    // commands padded through their transaction IDs (1–64 characters) to land on the limit itself.
    let k = 0;
    const big = putSize(s, heavy('heavy', 0), 'tx-fill');
    expect(big).toBeGreaterThan(4000);
    while (left() > 2 * big) expect(s.controller.editField('push', 'Fill', () => heavy('push', (k++ % 7) * 0.5)).ok).toBe(true);
    const ambient = (tx: string) => utf8Bytes(commandText({ atTick: s.live().tick, sequence: s.live().lastAppliedSequence + 1, transactionId: tx, payload: { kind: 'setAmbient', acceleration: [0, -9.81, 0] } })) + 6;
    const fill = (tx: string) => {
      const size = ambient(tx);
      const before = recorder.bytes;
      s.controller.settle();
      s.live().submit({ kind: 'setAmbient', acceleration: [0, -9.81, 0] }, s.controller.revision, tx);
      s.controller.settle();
      expect(recorder.bytes - before).toBe(size);
    };
    while (left() > 4 * (ambient('a') + 63)) fill('a');
    const fillers = Math.ceil(left() / (ambient('a') + 63));
    for (let i = 0; i < fillers; i++) {
      const rest = fillers - 1 - i;
      const extra = Math.min(63, Math.max(0, left() - ambient('a') - rest * ambient('a')));
      fill('a'.repeat(1 + extra));
    }
    expect(left()).toBe(0);
    expect(recorder.bytes).toBe(RUN_LIMITS.fileBytes);
    expect(s.coordinator.recordingState).toBe('recording');
    // Full to the byte: the next command, however small, is refused before it applies.
    const cursor = s.live().lastAppliedSequence;
    const overflow = s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
    expect(overflow).toEqual({ ok: false, reason: NOT_APPLIED, path: '' });
    expect(s.live().lastAppliedSequence).toBe(cursor);
    expect(s.controller.lawState('calm')!.field.enabled).toBe(true);
    await flush();
    expect(s.limits).toEqual(['bytes']);
    const record = (await s.coordinator.settled())!;
    expect([record.stopped, record.lastAppliedSequence]).toEqual(['bytes', cursor]);
    // The saved file is within the limit (the endpoint was reserved at its largest) and reads back.
    const { text, bytes } = exportRun(record);
    expect(bytes).toBeLessThanOrEqual(RUN_LIMITS.fileBytes);
    expect(bytes).toBeGreaterThan(RUN_LIMITS.fileBytes - 16);
    expect(bytes).toBe(new TextEncoder().encode(text).length);
    expect(parseRun(text, EXPECT).ok).toBe(true);
  });

  it('refuses to start a recording whose envelope alone cannot fit, leaving the live world as it was', () => {
    const s = session(undefined, ['run-big']);
    s.steps(25);
    const before = observe(s.live());
    const huge = { ...TEST_IDENTITY, app: 'x'.repeat(RUN_LIMITS.fileBytes) };
    const coordinator = new RunCoordinator({ controller: s.controller, identity: () => huge });
    expect(() => coordinator.startRecording()).toThrow(RecordingTooLarge);
    expect(firstDivergence(before, observe(s.live()))).toBeNull();
    expect(s.live().recorder).toBeNull();
  });
});

describe('a limit halfway through a live gesture', () => {
  /** Drags `push` one sample per frame until the recorder closes; returns the samples submitted and consumed. */
  async function dragIntoLimit(s: Session) {
    const { controller } = s;
    controller.settle();
    const start = controller.lawState('push')!;
    const tx = controller.newTransaction();
    const submitted: number[] = [];
    let latest = start.field;
    for (let i = 0; s.coordinator.recordingState === 'recording'; i++) {
      const x = -1.5 + 0.05 * (i + 1);
      const result = controller.putField(moveTo(x)(start.field), tx);
      if (!result.ok) throw new Error(result.reason);
      latest = result.value.field;
      submitted.push(x);
      const tick = s.live().tick;
      s.step();
      if (s.coordinator.recordingState !== 'recording') {
        // The refused sample's step did not happen, and the world waits for the stop to resolve.
        expect(s.live().tick).toBe(tick);
        expect(s.live().halted).toBe(true);
      }
    }
    // The UI's limit handler (main.ts): the gesture ends at the last value the host applied.
    await flush();
    const applied = controller.lawState('push')!.field;
    controller.record({ label: 'Move law', id: 'push', transactionId: tx, before: start, after: { field: applied, presentation: start.presentation } });
    return { start: start.field, tx, submitted, latest, applied };
  }

  async function check(s: Session, reason: 'commands' | 'bytes') {
    const { start, tx, submitted, latest, applied } = await dragIntoLimit(s);
    expect(s.limits).toEqual([reason]);
    const record = (await s.coordinator.settled())!;
    const consumed = record.commands.filter((c) => c.transactionId === tx);
    // Consumed samples retained, in order, one per boundary; the refused preview never applied.
    expect(consumed.length).toBeGreaterThan(1);
    expect(consumed.length).toBe(submitted.length - 1);
    expect(consumed.map((c) => (c.payload as { field: FieldDefinition }).field.pose.position[0])).toEqual(submitted.slice(0, -1));
    expect(applied.pose.position[0]).toBe(submitted[submitted.length - 2]);
    expect(applied).not.toEqual(latest);
    expect(record.stopped).toBe(reason);
    expect(record.lastAppliedSequence).toBe(consumed[consumed.length - 1]!.sequence);
    // No leakage: nothing queued survives, the host runs again, and the next boundary consumes nothing.
    expect(s.live().pendingCount).toBe(0);
    expect(s.live().halted).toBe(false);
    const cursor = s.live().lastAppliedSequence;
    s.boundary();
    expect(s.live().lastAppliedSequence).toBe(cursor);
    expect(s.controller.lawState('push')!.field).toEqual(applied);
    // One coherent undo entry: undo goes back to the drag's start, redo to its last applied value.
    const undone = s.controller.undo();
    expect(undone.ok && undone.value.transactionId).toBe(tx);
    expect(s.controller.lawState('push')!.field.pose.position).toEqual(start.pose.position);
    expect(s.controller.redo().ok).toBe(true);
    expect(s.controller.lawState('push')!.field).toEqual(applied);
    // The record replays to exactly its accepted prefix and checks itself.
    s.coordinator.enterReplay();
    s.coordinator.replay!.runToEnd();
    expect(await s.coordinator.checkReplay()).toEqual({ kind: 'match' });
    s.coordinator.returnToAuthoring();
    expect(parseRun(exportRun(record).text, EXPECT).ok).toBe(true);
  }

  it('the count limit: consumed samples kept, the unconsumed preview discarded, one undo entry', { timeout: 120_000 }, async () => {
    const s = session();
    s.coordinator.startRecording();
    s.steps(4);
    for (let k = 0; k < RUN_LIMITS.commands - 6; k++) s.controller.setAmbient([0, k % 2 ? -9.8 : -9.81, 0]);
    await check(s, 'commands');
  });

  it('the byte limit: the same, with the budget filled by large compound laws', { timeout: 120_000 }, async () => {
    const s = session();
    s.coordinator.startRecording();
    const recorder = s.coordinator.recorder!;
    s.steps(4);
    let k = 0;
    const big = putSize(s, heavy('calm', 0), 'tx-fill');
    const sample = putSize(s, moveTo(-1)(s.controller.lawState('push')!.field), 'tx-99999');
    // Fill until about five drag samples remain.
    while (RUN_LIMITS.fileBytes - recorder.bytes > big + 5 * sample) s.controller.editField('calm', 'Fill', () => heavy('calm', (k++ % 5) * 0.5));
    while (RUN_LIMITS.fileBytes - recorder.bytes > 5 * sample) s.controller.setAmbient([0, k++ % 2 ? -9.8 : -9.81, 0]);
    await check(s, 'bytes');
  });
});
