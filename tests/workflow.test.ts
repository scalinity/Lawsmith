// T06 (persistence), workflow half: the frontend boundary of Open, Save, Save As, recovery and the
// shared close/quit/replace guard, against an in-memory native I/O whose recovery store follows the
// same ordering rules as the Rust store. Real document controller and real candidate worlds. A
// browser-free fake proves only this boundary; native dialogs and files are qualified in the app.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { type SceneDocument } from '../src/domain/scene';
import { DEFAULT_SCENE_TEXT, defaultDocument } from '../src/persistence/defaultScene';
import type { ChooseOutcome, DocumentIo, IoFailure, OpenOutcome, RecoverySlot } from '../src/persistence/io';
import { parseRecovery } from '../src/persistence/recovery';
import { parseScene } from '../src/persistence/sceneFile';
import { DocumentWorkflow, suggestedName, type WorkflowApp } from '../src/persistence/workflow';
import stormBottle from '../examples/storm-bottle.lawsmith.json?raw';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

const failure = (kind: string, stage = 'write'): IoFailure => ({ kind, stage, message: kind });

interface Deferred {
  resolve(): void;
  reject(f: IoFailure): void;
}

/** In-memory native I/O: scripted dialogs, a disk of named files, and the recovery store's rules. */
class FakeIo implements DocumentIo {
  disk = new Map<string, string>();
  tokens = new Map<number, string>();
  nextToken = 1;
  openQueue: OpenOutcome[] = [];
  chooseQueue: (string | null)[] = [];
  askQueue: ('save' | 'discard' | 'cancel')[] = [];
  asked: string[] = [];
  writes: { name: string; text: string }[] = [];
  failWrite: IoFailure | null = null;
  holdWrites = false;
  held: Deferred[] = [];
  exited = 0;
  recovery = { current: null as null | { g: number; r: number; text: string }, previous: null as null | { g: number; r: number; text: string } };
  /** A current left by an earlier session counts as valid only once launch validation says so; this session's writes always do. */
  currentValid = false;
  lastWrite: [number, number] | null = null;
  retired = new Map<number, number>();
  failRecovery: IoFailure | null = null;
  failDiscard: IoFailure | null = null;
  failRetire: IoFailure | null = null;
  holdRecovery = false;
  heldRecovery: Deferred[] = [];
  /** The recovery store as it was when the app exited: what the next launch would find. */
  recoveryAtExit: unknown = null;

  async openScene(): Promise<OpenOutcome> {
    return this.openQueue.shift() ?? { outcome: 'canceled' };
  }
  async readScene(token: number) {
    return { text: this.disk.get(this.tokens.get(token)!)!, readMs: 0.1 };
  }
  async chooseDestination(): Promise<ChooseOutcome> {
    const name = this.chooseQueue.shift();
    if (!name) return { outcome: 'canceled' };
    if (!name.endsWith('.lawsmith.json')) return { outcome: 'refused', name };
    const token = this.nextToken++;
    this.tokens.set(token, name);
    return { outcome: 'chosen', token, name };
  }
  issue(name: string): number {
    const token = this.nextToken++;
    this.tokens.set(token, name);
    return token;
  }
  async writeScene(token: number, text: string): Promise<{ writeMs: number }> {
    const name = this.tokens.get(token)!;
    if (this.holdWrites) await new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
    if (this.failWrite) throw this.failWrite;
    this.disk.set(name, text);
    this.writes.push({ name, text });
    return { writeMs: 1 };
  }
  async recoveryLoad() {
    const slot = (s: typeof this.recovery.current): RecoverySlot => (s ? { state: 'present', text: s.text } : { state: 'absent' });
    return { current: slot(this.recovery.current), previous: slot(this.recovery.previous) };
  }
  async recoveryWrite(g: number, r: number, text: string) {
    if (this.holdRecovery) await new Promise<void>((resolve, reject) => this.heldRecovery.push({ resolve, reject }));
    if (this.lastWrite && (g < this.lastWrite[0] || (g === this.lastWrite[0] && r <= this.lastWrite[1]))) throw failure('stale', 'recovery');
    if (r <= (this.retired.get(g) ?? -1)) throw failure('stale', 'recovery');
    if (this.failRecovery) throw this.failRecovery;
    if (this.recovery.current && this.currentValid) this.recovery.previous = this.recovery.current;
    this.recovery.current = { g, r, text };
    this.currentValid = true;
    this.lastWrite = [g, r];
  }
  async recoveryRetire(g: number, through: number) {
    if (this.failRetire) throw this.failRetire;
    this.retired.set(g, Math.max(this.retired.get(g) ?? -1, through));
    for (const slot of ['current', 'previous'] as const) {
      const s = this.recovery[slot];
      if (s && (s.g < g || (s.g === g && s.r <= through))) this.recovery[slot] = null;
    }
  }
  async recoveryCurrentValid() {
    this.currentValid = true;
  }
  async recoveryDiscard(g: number) {
    if (this.failDiscard) throw this.failDiscard;
    await this.recoveryRetire(g, Number.MAX_SAFE_INTEGER);
  }
  /** Snapshots present before this fake session began; only these does the launch Discard remove. */
  earlier = new Set<'current' | 'previous'>();
  async recoveryDiscardEarlier() {
    for (const slot of this.earlier) this.recovery[slot] = null;
    this.earlier.clear();
  }
  async askUnsaved(title: string) {
    this.asked.push(title);
    return this.askQueue.shift() ?? 'cancel';
  }
  async exit() {
    this.exited += 1;
    this.recoveryAtExit = structuredClone(this.recovery);
  }
}

/** One app session over the recovery store an earlier session left; launch recovery is not looked up yet. */
function session(earlier: FakeIo['recovery'] | null = null) {
  const document = defaultDocument();
  const io = new FakeIo();
  if (earlier) {
    io.recovery = earlier;
    for (const slot of ['current', 'previous'] as const) if (earlier[slot]) io.earlier.add(slot);
  }
  let host = new SimulationHost(document.semantic);
  const controller = new DocumentController(document, host);
  const disposed: SimulationHost[] = [];
  const quiesced: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let frozen = false;
  let gesture = false;
  const app: WorkflowApp = {
    controller,
    quiesce: (reason) => quiesced.push(reason),
    freeze: (value) => (frozen = value),
    gestureActive: () => gesture,
    camera: () => controller.camera,
    candidate: (doc) => {
      const candidate = new SimulationHost(doc.semantic);
      const dispose = candidate.dispose.bind(candidate);
      candidate.dispose = () => {
        disposed.push(candidate);
        dispose();
      };
      return candidate;
    },
    commit: (doc, candidate) => {
      host.dispose();
      host = candidate;
      controller.load(doc, candidate);
    },
    log: (kind, data) => logs.push({ kind, ...data }),
    now: () => performance.now(),
    onChange: () => {},
  };
  const workflow = new DocumentWorkflow(io, app);
  const edit = () => {
    const result = controller.editField('sideways', 'Toggle', (f) => ({ ...f, enabled: !f.enabled }));
    if (!result.ok) throw new Error(result.reason);
    workflow.edited();
  };
  return { io, controller, workflow, disposed, quiesced, logs, edit, host: () => host, frozen: () => frozen, setGesture: (v: boolean) => (gesture = v) };
}

/** A launched session: launch recovery has been looked up, as main.ts does before enabling edits. */
async function setup(earlier: FakeIo['recovery'] | null = null) {
  const t = session(earlier);
  return { ...t, offer: await t.workflow.recoveryOffer() };
}

const opened = (io: FakeIo, name: string, text: string): OpenOutcome => ({ outcome: 'opened', token: io.issue(name), name, text, readMs: 0.2 });
const savedText = (io: FakeIo, name: string) => parseScene(io.disk.get(name)!);

describe('Save and Save As', () => {
  it('Save without a destination is Save As; the destination binds only after the write succeeds', async () => {
    const t = await setup();
    t.edit();
    t.io.chooseQueue.push('a.lawsmith.json');
    expect(await t.workflow.save()).toBe(true);
    expect(t.workflow.fileName).toBe('a.lawsmith.json');
    expect(t.workflow.dirty).toBe(false);
    expect(t.quiesced[0]).toBe('save-as');
    // Save then writes to the bound destination without a dialog.
    t.edit();
    expect(await t.workflow.save()).toBe(true);
    expect(t.io.writes.map((w) => w.name)).toEqual(['a.lawsmith.json', 'a.lawsmith.json']);
    expect(savedText(t.io, 'a.lawsmith.json').ok).toBe(true);
  });

  it('a canceled Save As keeps the prior binding, the scene, the dirty state and writes nothing', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.saveAs();
    t.edit();
    t.io.chooseQueue.push(null);
    expect(await t.workflow.saveAs()).toBe(false);
    expect(t.workflow.fileName).toBe('a.lawsmith.json');
    expect(t.workflow.dirty).toBe(true);
    expect(t.io.writes).toHaveLength(1);
  });

  it('a failed Save As keeps the prior binding and the existing file; Save As elsewhere still works', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.saveAs();
    const original = t.io.disk.get('a.lawsmith.json');
    t.edit();
    t.io.failWrite = failure('permission');
    t.io.chooseQueue.push('denied.lawsmith.json');
    expect(await t.workflow.saveAs()).toBe(false);
    expect(t.workflow.fileName).toBe('a.lawsmith.json');
    expect(t.workflow.dirty).toBe(true);
    expect(t.io.disk.get('a.lawsmith.json')).toBe(original);
    expect(t.workflow.message?.text).toContain('permission was denied');
    t.io.failWrite = null;
    t.io.chooseQueue.push('b.lawsmith.json');
    expect(await t.workflow.saveAs()).toBe(true);
    expect(t.workflow.fileName).toBe('b.lawsmith.json');
  });

  it('a failed Save to the bound file keeps it dirty and bound; disk-full is named', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.save();
    t.edit();
    t.io.failWrite = failure('disk-full');
    expect(await t.workflow.save()).toBe(false);
    expect(t.workflow.dirty).toBe(true);
    expect(t.workflow.fileName).toBe('a.lawsmith.json');
    expect(t.workflow.message?.text).toContain('the disk is full');
  });

  it('overlapping Save As requests cannot reorder binding: the second is refused while the first runs', async () => {
    const t = await setup();
    t.edit();
    t.io.holdWrites = true;
    t.io.chooseQueue.push('first.lawsmith.json', 'second.lawsmith.json');
    const first = t.workflow.saveAs();
    const second = await t.workflow.saveAs();
    expect(second).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    t.io.held.shift()!.resolve();
    expect(await first).toBe(true);
    expect(t.workflow.fileName).toBe('first.lawsmith.json');
    expect(t.io.chooseQueue).toEqual(['second.lawsmith.json']);
  });

  it('an edit made while a save is in flight stays dirty after that older save completes', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    t.io.holdWrites = true;
    const saving = t.workflow.save();
    await new Promise((r) => setTimeout(r, 0));
    const captured = t.controller.revision;
    t.edit();
    t.io.held.shift()!.resolve();
    expect(await saving).toBe(true);
    expect(t.workflow.stored).toBe(captured);
    expect(t.workflow.dirty).toBe(true);
    // The file holds the captured revision, not the later edit.
    expect((savedText(t.io, 'a.lawsmith.json') as { document: SceneDocument }).document.semantic.fields[0]!.enabled).toBe(false);
    t.controller.settle();
    expect(t.controller.scene.fields[0]!.enabled).toBe(true);
  });

  it('a reply for an older document generation neither binds nor cleans the current document', async () => {
    const t = await setup();
    t.edit();
    t.io.holdWrites = true;
    t.io.chooseQueue.push('old.lawsmith.json');
    const saving = t.workflow.saveAs();
    await new Promise((r) => setTimeout(r, 0));
    // A new generation arrives while the old reply is outstanding.
    const next = defaultDocument();
    t.controller.load(next, new SimulationHost(next.semantic));
    t.edit();
    t.io.held.shift()!.resolve();
    expect(await saving).toBe(false);
    expect(t.workflow.fileName).toBeNull();
    expect(t.workflow.dirty).toBe(true);
  });

  it('a destination without the .lawsmith.json suffix is refused: nothing is bound or written', async () => {
    const t = await setup();
    t.edit();
    t.io.chooseQueue.push('foo.json');
    expect(await t.workflow.saveAs()).toBe(false);
    expect(t.workflow.fileName).toBeNull();
    expect(t.io.writes).toEqual([]);
    expect(t.workflow.message?.text).toContain('.lawsmith.json');
  });

  it('suggests the title with an explicit .lawsmith.json suffix', () => {
    expect(suggestedName('Falling stream')).toBe('Falling stream.lawsmith.json');
    expect(suggestedName(' a/b:c ')).toBe('a-b-c.lawsmith.json');
    expect(suggestedName('')).toBe('Untitled.lawsmith.json');
  });
});

describe('transactional Open (SPEC §15.2)', () => {
  it('commits a valid file paused at a new generation, bound to its file and clean', async () => {
    const t = await setup();
    const generation = t.controller.generation;
    t.io.openQueue.push(opened(t.io, 'scene.lawsmith.json', DEFAULT_SCENE_TEXT));
    expect(await t.workflow.open()).toBe(true);
    expect(t.controller.generation).toBe(generation + 1);
    expect(t.workflow.fileName).toBe('scene.lawsmith.json');
    expect(t.workflow.dirty).toBe(false);
    expect(t.host().tick).toBe(0);
    expect(t.logs.find((l) => l.kind === 'document' && l.outcome === 'committed')).toMatchObject({ readMs: 0.2 });
  });

  it('an invalid file leaves the current scene, its world and undo history untouched', async () => {
    const t = await setup();
    t.edit();
    const before = { generation: t.controller.generation, scene: t.controller.scene, host: t.host() };
    const bad = DEFAULT_SCENE_TEXT.replace('"strength": 12', '"strength": 500');
    t.io.openQueue.push(opened(t.io, 'bad.lawsmith.json', bad));
    expect(await t.workflow.open()).toBe(false);
    expect(t.controller.generation).toBe(before.generation);
    expect(t.controller.scene).toBe(before.scene);
    expect(t.host()).toBe(before.host);
    expect(t.controller.canUndo).toBe(true);
    expect(t.workflow.message?.text).toContain('semantic.fields[0].expression.strength');
    expect(t.io.asked).toEqual([]);
  });

  it('canceling the replacement guard disposes the unstepped candidate and keeps everything', async () => {
    const t = await setup();
    t.edit();
    t.io.openQueue.push(opened(t.io, 'scene.lawsmith.json', DEFAULT_SCENE_TEXT));
    t.io.askQueue.push('cancel');
    const host = t.host();
    expect(await t.workflow.open()).toBe(false);
    expect(t.disposed).toHaveLength(1);
    expect(t.disposed[0]!.tick).toBe(0);
    expect(t.host()).toBe(host);
    expect(t.workflow.dirty).toBe(true);
    expect(t.frozen()).toBe(false);
  });

  it('a Discard in the replacement guard retires the old generation’s recovery, then commits', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery.current).not.toBeNull();
    t.io.openQueue.push(opened(t.io, 'scene.lawsmith.json', DEFAULT_SCENE_TEXT));
    t.io.askQueue.push('discard');
    expect(await t.workflow.open()).toBe(true);
    expect(t.io.recovery.current).toBeNull();
  });

  it('opening the bound file with Save in the guard commits what the save wrote, not the bytes read before it', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    await t.workflow.saveAs();
    t.edit();
    // The Open dialog reads a.lawsmith.json as it was, then the guard saves the edit into it.
    const token = [...t.io.tokens].find(([, name]) => name === 'a.lawsmith.json')![0];
    t.io.openQueue.push({ outcome: 'opened', token, name: 'a.lawsmith.json', text: t.io.disk.get('a.lawsmith.json')!, readMs: 0.1 });
    t.io.askQueue.push('save');
    expect(await t.workflow.open()).toBe(true);
    expect(t.controller.scene.fields[0]!.enabled).toBe(false);
    expect(t.workflow.dirty).toBe(false);
    expect(t.disposed).toHaveLength(1);
  });

  it('New replaces through the same guard and starts an unbound clean document', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.save();
    t.edit();
    t.io.askQueue.push('cancel');
    expect(await t.workflow.newScene()).toBe(false);
    expect(t.io.asked).toHaveLength(1);
    t.io.askQueue.push('discard');
    expect(await t.workflow.newScene()).toBe(true);
    expect(t.workflow.fileName).toBeNull();
    expect(t.workflow.dirty).toBe(false);
  });
});

describe('transactional Open of compound laws (M5, SPEC §15.2)', () => {
  /** The Storm Bottle with its bottle's expression changed by `edit`. */
  const bottleWith = (edit: (expression: Record<string, any>) => void) => {
    const value = JSON.parse(stormBottle);
    edit(value.semantic.fields[0].expression);
    return JSON.stringify(value);
  };
  const deep = (depth: number): Record<string, any> => (depth === 1 ? { kind: 'linearDrag', coefficient: 1 } : { kind: 'gain', gain: { kind: 'constant', value: 1 }, child: deep(depth - 1) });
  const invalid: [string, string, string][] = [
    ['an invalid triangle phase', bottleWith((e) => (e.terms[1] = { kind: 'gain', gain: { kind: 'triangle', min: 0, max: 2, periodTicks: 240, phaseTicks: 240 }, child: e.terms[1] })), 'semantic.fields[0].expression.terms[1].gain.phaseTicks'],
    ['a negative gain', bottleWith((e) => (e.terms[2].child = { kind: 'gain', gain: { kind: 'constant', value: -1 }, child: e.terms[2].child })), 'semantic.fields[0].expression.terms[2].child.gain.value'],
    ['an expression nine deep', bottleWith((e) => (e.terms[2] = deep(9))), 'semantic.fields[0].expression.terms[2]'],
    ['an unknown operator', bottleWith((e) => (e.terms[0] = { kind: 'priority', child: e.terms[0] })), 'semantic.fields[0].expression.terms[0].kind'],
    ['an empty sum', bottleWith((e) => (e.terms = [])), 'semantic.fields[0].expression.terms'],
  ];
  for (const [name, text, path] of invalid) {
    it(`a file with ${name} leaves the scene, revision, undo, world, recovery and file binding untouched`, async () => {
      const t = await setup();
      t.io.chooseQueue.push('mine.lawsmith.json');
      expect(await t.workflow.saveAs()).toBe(true);
      t.edit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = {
        generation: t.controller.generation,
        revision: t.controller.revision,
        scene: t.controller.scene,
        host: t.host(),
        tick: t.host().tick,
        recovery: structuredClone(t.io.recovery),
        writes: t.io.writes.length,
      };
      t.io.openQueue.push(opened(t.io, 'bad.lawsmith.json', text));
      expect(await t.workflow.open()).toBe(false);
      expect(t.controller.generation).toBe(before.generation);
      expect(t.controller.revision).toBe(before.revision);
      expect(t.controller.scene).toBe(before.scene);
      expect(t.host()).toBe(before.host);
      expect(t.host().tick).toBe(before.tick);
      expect(t.controller.canUndo).toBe(true);
      expect(t.workflow.fileName).toBe('mine.lawsmith.json');
      expect(t.workflow.dirty).toBe(true);
      expect(t.io.recovery).toEqual(before.recovery);
      expect(t.io.writes).toHaveLength(before.writes);
      expect(t.disposed).toHaveLength(0); // rejected before any candidate world was built
      expect(t.workflow.message?.text).toContain(path);
      expect(t.io.asked).toEqual([]);
    });
  }

  it('a valid compound file commits paused at tick 0 with the whole expression and its capabilities', async () => {
    const t = await setup();
    t.io.openQueue.push(opened(t.io, 'storm-bottle.lawsmith.json', stormBottle));
    expect(await t.workflow.open()).toBe(true);
    expect(t.host().tick).toBe(0);
    const expected = parseScene(stormBottle);
    expect(expected.ok && t.host().appliedFields()).toEqual(expected.ok && expected.document.semantic.fields);
    expect(t.workflow.fileName).toBe('storm-bottle.lawsmith.json');
    expect(t.workflow.dirty).toBe(false);
  });
});

describe('recovery (SPEC §15.3)', () => {
  it('keeps current and previous, and the previous is offered, marked older, when the current is corrupt', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.edit();
    await t.workflow.recovery.writeNow();
    expect([t.io.recovery.previous!.r, t.io.recovery.current!.r]).toEqual([1, 2]);
    const restart = await setup({ current: { g: 1, r: 2, text: '{"truncated": ' }, previous: t.io.recovery.previous });
    const offer = restart.offer;
    expect(offer).toMatchObject({ older: true });
    expect(offer!.envelope.revision).toBe(1);
    expect(offer!.newestProblem).toContain('JSON');
  });

  it('recovering the previous copy over a corrupt current keeps that copy as the fallback', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    const valid = t.io.recovery.current!;
    const restart = await setup({ current: { g: 1, r: 2, text: '{"truncated": ' }, previous: valid });
    const offer = restart.offer;
    expect(offer).toMatchObject({ older: true });
    expect(await restart.workflow.recover(offer!)).toBe(true);
    await restart.workflow.recovery.writeNow();
    // The recovered work is this session's current; the valid copy it came from is still the previous.
    expect(restart.io.recovery.current!.g).toBe(restart.controller.generation);
    expect(restart.io.recovery.previous).toEqual(valid);
  });

  it('nothing saves, replaces or writes recovery until launch recovery is looked up and answered', async () => {
    const crashed = await setup();
    crashed.edit();
    await crashed.workflow.recovery.writeNow();
    const earlier = structuredClone(crashed.io.recovery);
    const t = session(structuredClone(earlier));
    let finishLookup!: () => void;
    const load = t.io.recoveryLoad.bind(t.io);
    t.io.recoveryLoad = () => new Promise((resolve) => (finishLookup = () => resolve(load())));
    const lookup = t.workflow.recoveryOffer();
    // The UI is frozen from launch; even an edit that got through could not reach the earlier snapshots.
    t.edit();
    t.io.chooseQueue.push('early.lawsmith.json');
    t.io.openQueue.push(opened(t.io, 'other.lawsmith.json', DEFAULT_SCENE_TEXT));
    expect(await t.workflow.save()).toBeNull();
    expect(await t.workflow.open()).toBeNull();
    expect(await t.workflow.newScene()).toBeNull();
    await t.workflow.recovery.writeNow();
    expect(t.io.writes).toEqual([]);
    expect(t.io.recovery).toEqual(earlier);
    finishLookup();
    const offer = await lookup;
    expect(offer!.envelope.revision).toBe(1);
    // An offer not yet answered keeps the same protection.
    expect(await t.workflow.saveAs()).toBeNull();
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery).toEqual(earlier);
    expect(t.logs.filter((l) => l.outcome === 'refused' && l.reason === 'launch recovery unanswered')).toHaveLength(4);
    expect(await t.workflow.discardRecovery()).toBe(true);
    expect(await t.workflow.save()).toBe(true);
    expect(t.io.writes.map((w) => w.name)).toEqual(['early.lawsmith.json']);
  });

  it('a stale queued write is rejected and never replaces newer work', async () => {
    const t = await setup();
    t.edit();
    t.edit();
    await t.workflow.recovery.writeNow();
    await expect(t.io.recoveryWrite(1, 1, 'stale')).rejects.toMatchObject({ kind: 'stale' });
    expect(t.io.recovery.current!.r).toBe(2);
  });

  it('never writes a gesture in progress; the completed gesture is written afterwards', async () => {
    const t = await setup();
    t.edit();
    t.setGesture(true);
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery.current).toBeNull();
    t.setGesture(false);
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery.current!.r).toBe(t.controller.revision);
  });

  it('an explicit save retires only through its captured revision; a later dirty revision stays eligible', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.io.holdWrites = true;
    const saving = t.workflow.save();
    await new Promise((r) => setTimeout(r, 0));
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.held.shift()!.resolve();
    await saving;
    await t.workflow.recovery.settled();
    expect(t.io.recovery.current!.r).toBe(2);
    expect(t.io.recovery.previous).toBeNull();
    // After a restart the later dirty revision is offered; the saved one is not.
    const restart = await setup(t.io.recovery);
    expect(restart.offer!.envelope.revision).toBe(2);
  });

  it('saved work is not offered after restart', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.chooseQueue.push('a.lawsmith.json');
    await t.workflow.save();
    await t.workflow.recovery.settled();
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery).toEqual({ current: null, previous: null });
  });

  it('an accepted Discard prevents resurrection by a queued write', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.askQueue.push('discard');
    const generation = t.controller.generation;
    const closing = t.workflow.requestExit('close');
    const late = t.workflow.recovery.writeNow();
    expect(await closing).toBe(true);
    await late;
    expect(t.io.recovery).toEqual({ current: null, previous: null });
    await expect(t.io.recoveryWrite(generation, 99, 'late')).rejects.toMatchObject({ kind: 'stale' });
  });

  it('a failed recovery write leaves editing and explicit Save working', async () => {
    const t = await setup();
    t.io.failRecovery = failure('permission', 'create-temp');
    t.edit();
    await t.workflow.recovery.writeNow();
    expect(t.workflow.recovery.status).toEqual({ state: 'failed', reason: 'permission was denied' });
    t.edit();
    t.io.chooseQueue.push('elsewhere.lawsmith.json');
    expect(await t.workflow.save()).toBe(true);
  });

  it('recovered work opens unbound and dirty, and chooses its destination again on Save', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    const restart = await setup(t.io.recovery);
    const offer = restart.offer;
    expect(await restart.workflow.recover(offer!)).toBe(true);
    expect(restart.workflow.fileName).toBeNull();
    expect(restart.workflow.dirty).toBe(true);
    expect(restart.controller.scene.fields[0]!.enabled).toBe(false);
    expect(restart.host().tick).toBe(0);
    restart.io.chooseQueue.push('recovered.lawsmith.json');
    expect(await restart.workflow.save()).toBe(true);
    expect(restart.io.writes[0]!.name).toBe('recovered.lawsmith.json');
  });

  it('the launch Discard removes only the earlier session’s snapshots', async () => {
    const t = await setup({ current: null, previous: { g: 9, r: 4, text: 'earlier session' } });
    t.edit();
    await t.workflow.recovery.writeNow();
    expect(await t.workflow.discardRecovery()).toBe(true);
    expect(t.io.recovery.previous).toBeNull();
    expect(t.io.recovery.current!.g).toBe(t.controller.generation);
  });

  it('recovered work is written as a snapshot of this session soon after recovery', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    const restart = await setup(structuredClone(t.io.recovery));
    const offer = restart.offer;
    expect(await restart.workflow.recover(offer!)).toBe(true);
    await new Promise((r) => setTimeout(r, 650));
    await restart.workflow.recovery.settled();
    expect(restart.io.recovery.current!.g).toBe(restart.controller.generation);
    expect(restart.io.recovery.previous!.text).toBe(t.io.recovery.current!.text);
  });

  it('the envelope is validated like an imported scene', async () => {
    const t = await setup();
    t.edit();
    const capture = JSON.parse(JSON.stringify({ format: 'lawsmith.recovery', version: 1, generation: 1, revision: 1, scene: JSON.parse(DEFAULT_SCENE_TEXT) }));
    expect(parseRecovery(JSON.stringify(capture)).ok).toBe(true);
    capture.scene.semantic.fields[0].pose.rotation = [0, 0, 0, 0];
    const bad = parseRecovery(JSON.stringify(capture));
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.reason).toContain('scene.semantic.fields[0].pose.rotation');
  });
});

describe('unexpected failures', () => {
  it('an exception while committing an Open unfreezes the app and reports it', async () => {
    const t = await setup();
    t.io.openQueue.push(opened(t.io, 'scene.lawsmith.json', DEFAULT_SCENE_TEXT));
    const commit = (t.workflow as unknown as { app: WorkflowApp }).app.commit;
    (t.workflow as unknown as { app: { commit: WorkflowApp['commit'] } }).app.commit = () => {
      throw new Error('renderer refused the scene');
    };
    expect(await t.workflow.open()).toBeNull();
    expect(t.frozen()).toBe(false);
    expect(t.workflow.busy).toBeNull();
    expect(t.workflow.message?.text).toContain('renderer refused the scene');
    (t.workflow as unknown as { app: { commit: WorkflowApp['commit'] } }).app.commit = commit;
  });

  it('an exception inside the guard leaves the app open, unfrozen, and able to quit later', async () => {
    const t = await setup();
    t.edit();
    const app = (t.workflow as unknown as { app: { camera: WorkflowApp['camera'] } }).app;
    const camera = app.camera;
    app.camera = () => {
      throw new Error('camera unavailable');
    };
    t.io.askQueue.push('save');
    t.io.chooseQueue.push('a.lawsmith.json');
    expect(await t.workflow.requestExit('quit')).toBe(false);
    expect(t.frozen()).toBe(false);
    expect(t.io.exited).toBe(0);
    app.camera = camera;
    t.io.askQueue.push('discard');
    expect(await t.workflow.requestExit('quit')).toBe(true);
  });

  it('a view that fails to prepare after its world was built replaces nothing', async () => {
    const t = await setup();
    t.edit();
    t.io.chooseQueue.push('kept.lawsmith.json');
    await t.workflow.save();
    t.edit();
    await t.workflow.recovery.writeNow();
    const before = { scene: t.controller.scene, generation: t.controller.generation, revision: t.controller.revision, host: t.host(), recovery: structuredClone(t.io.recovery) };
    const app = (t.workflow as unknown as { app: WorkflowApp }).app;
    app.candidate = (doc) => {
      // As main.ts builds a candidate: the world exists, then its view cannot be prepared.
      new SimulationHost(doc.semantic).dispose();
      throw new Error('view preparation failed');
    };
    t.io.openQueue.push(opened(t.io, 'other.lawsmith.json', DEFAULT_SCENE_TEXT));
    expect(await t.workflow.open()).toBe(false);
    expect(t.workflow.message?.text).toContain('view preparation failed');
    expect(t.io.asked).toEqual([]);
    expect(t.controller.scene).toBe(before.scene);
    expect([t.controller.generation, t.controller.revision]).toEqual([before.generation, before.revision]);
    expect(t.controller.canUndo).toBe(true);
    expect(t.host()).toBe(before.host);
    t.host().step();
    expect(t.workflow.fileName).toBe('kept.lawsmith.json');
    expect(t.workflow.dirty).toBe(true);
    expect(t.io.recovery).toEqual(before.recovery);
    expect(t.frozen()).toBe(false);
  });

  it('a candidate that fails before commit is disposed', async () => {
    const t = await setup();
    t.edit();
    t.io.openQueue.push(opened(t.io, 'scene.lawsmith.json', DEFAULT_SCENE_TEXT));
    t.io.askUnsaved = async () => {
      throw new Error('alert failed');
    };
    // A failing alert is a Cancel: the candidate is disposed and nothing changes.
    expect(await t.workflow.open()).toBe(false);
    expect(t.disposed).toHaveLength(1);
    expect(t.frozen()).toBe(false);
  });
});

describe('close/quit guard (AC10)', () => {
  it('a clean document closes without asking', async () => {
    const t = await setup();
    expect(await t.workflow.requestExit('quit')).toBe(true);
    expect(t.io.asked).toEqual([]);
    expect(t.io.exited).toBe(1);
  });

  it('Cancel keeps the scene, undo, recovery eligibility and an open, paused, unfrozen app', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.askQueue.push('cancel');
    expect(await t.workflow.requestExit('close')).toBe(false);
    expect(t.io.exited).toBe(0);
    expect(t.frozen()).toBe(false);
    expect(t.controller.canUndo).toBe(true);
    expect(t.io.recovery.current).not.toBeNull();
    expect(t.quiesced).toContain('guard-close');
  });

  it('Save in the guard saves through Save As when unbound, then exits', async () => {
    const t = await setup();
    t.edit();
    t.io.askQueue.push('save');
    t.io.chooseQueue.push('kept.lawsmith.json');
    expect(await t.workflow.requestExit('quit')).toBe(true);
    expect(t.io.disk.has('kept.lawsmith.json')).toBe(true);
    expect(t.io.exited).toBe(1);
  });

  it('Save in the guard retires recovery before exiting, even with a recovery write in flight', async () => {
    const t = await setup();
    t.edit();
    t.io.holdRecovery = true;
    const writing = t.workflow.recovery.writeNow();
    t.io.askQueue.push('save');
    t.io.chooseQueue.push('kept.lawsmith.json');
    const quitting = t.workflow.requestExit('quit');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.io.exited).toBe(0);
    t.io.holdRecovery = false;
    t.io.heldRecovery.shift()!.resolve();
    await writing;
    expect(await quitting).toBe(true);
    // The next launch would find nothing: the saved revision is not offered as unsaved.
    expect(t.io.recoveryAtExit).toEqual({ current: null, previous: null });
  });

  it('a recovery copy that cannot be retired keeps the app open after Save, and a later quit retries', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.failRetire = failure('permission', 'recovery-retire');
    t.io.askQueue.push('save');
    t.io.chooseQueue.push('kept.lawsmith.json');
    expect(await t.workflow.requestExit('quit')).toBe(false);
    expect(t.io.exited).toBe(0);
    expect(t.frozen()).toBe(false);
    expect(t.workflow.dirty).toBe(false);
    // Clean now, but the saved revision's copy is still on disk: quitting retries and refuses.
    expect(await t.workflow.requestExit('quit')).toBe(false);
    expect(t.io.asked).toHaveLength(1);
    t.io.failRetire = null;
    expect(await t.workflow.requestExit('quit')).toBe(true);
    expect(t.io.recoveryAtExit).toEqual({ current: null, previous: null });
  });

  it('Command+S then an immediate quit exits only after the save’s retirement', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.recovery.writeNow();
    const saving = t.workflow.save();
    const quitting = t.workflow.requestExit('quit');
    await saving;
    expect(await quitting).toBe(true);
    expect(t.io.asked).toEqual([]);
    expect(t.io.recoveryAtExit).toEqual({ current: null, previous: null });
  });

  it('a canceled Save As inside the guard aborts the quit and keeps recovery eligible', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.askQueue.push('save');
    t.io.chooseQueue.push(null);
    expect(await t.workflow.requestExit('quit')).toBe(false);
    expect(t.io.exited).toBe(0);
    expect(t.workflow.dirty).toBe(true);
    expect(t.io.recovery.current).not.toBeNull();
    expect(t.frozen()).toBe(false);
  });

  it('a failed save inside the guard keeps the work open', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    await t.workflow.save();
    t.edit();
    t.io.failWrite = failure('disk-full');
    t.io.askQueue.push('save');
    expect(await t.workflow.requestExit('close')).toBe(false);
    expect(t.io.exited).toBe(0);
    expect(t.workflow.dirty).toBe(true);
  });

  it('a Discard whose recovery cannot be retired aborts the close, and recovery keeps working', async () => {
    const t = await setup();
    t.edit();
    await t.workflow.recovery.writeNow();
    t.io.failDiscard = failure('permission', 'recovery-retire');
    t.io.askQueue.push('discard');
    expect(await t.workflow.requestExit('close')).toBe(false);
    expect(t.io.exited).toBe(0);
    expect(t.io.recovery.current).not.toBeNull();
    expect(t.frozen()).toBe(false);
    t.io.failDiscard = null;
    t.edit();
    await t.workflow.recovery.writeNow();
    expect(t.io.recovery.current!.r).toBe(t.controller.revision);
    expect(t.workflow.recovery.status).toMatchObject({ state: 'written', revision: t.controller.revision });
  });

  it('a stale reply for an eligible write is reported, not ignored', async () => {
    const t = await setup();
    t.edit();
    t.io.lastWrite = [t.controller.generation, 99];
    await t.workflow.recovery.writeNow();
    expect(t.workflow.recovery.status).toEqual({ state: 'failed', reason: 'the recovery store refused this revision as out of date' });
  });

  it('simultaneous Close and Quit coalesce into one guard', async () => {
    const t = await setup();
    t.edit();
    t.io.askQueue.push('discard');
    const [close, quit] = await Promise.all([t.workflow.requestExit('close'), t.workflow.requestExit('quit')]);
    expect([close, quit]).toEqual([true, false]);
    expect(t.io.asked).toHaveLength(1);
    expect(t.io.exited).toBe(1);
  });

  it('a pending save settles first; the guard then evaluates the latest revision', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    t.io.holdWrites = true;
    const saving = t.workflow.save();
    await new Promise((r) => setTimeout(r, 0));
    const quitting = t.workflow.requestExit('quit');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.io.asked).toEqual([]);
    t.io.held.shift()!.resolve();
    await saving;
    expect(await quitting).toBe(true);
    // The save left nothing unsaved, so the guard did not need to ask.
    expect(t.io.asked).toEqual([]);
  });

  it('a pending save followed by an edit makes the guard ask about the newer revision', async () => {
    const t = await setup();
    t.io.chooseQueue.push('a.lawsmith.json');
    t.edit();
    t.io.holdWrites = true;
    const saving = t.workflow.save();
    await new Promise((r) => setTimeout(r, 0));
    t.edit();
    t.io.askQueue.push('cancel');
    const quitting = t.workflow.requestExit('quit');
    t.io.held.shift()!.resolve();
    await saving;
    expect(await quitting).toBe(false);
    expect(t.io.asked).toHaveLength(1);
  });
});
