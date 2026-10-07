// T04 (reset and time), M1 cases: exact reset at ticks 600/1200, cadence independence at
// 30/60/144 Hz, scheduler limits and gap pauses, and reset of the authored configuration.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { STARTING_RECIPE, cloneFrozen, validateEmitter, type EmitterDefinition } from '../src/domain/scene';
import { createDocument } from '../src/persistence/sceneFile';
import {
  FIXTURE_TICKS,
  compareRuns,
  runAtCadence,
  runFixedSteps,
  runResetFixture,
  scriptedRecipeEdits,
} from '../src/simulation/fixtures';
import { SimulationFault, SimulationHost, initSimulation, xorshift32 } from '../src/simulation/host';
import { FixedStepScheduler, MAX_STEPS_PER_FRAME } from '../src/simulation/scheduler';

const STEP_MS = 1000 / 120;

beforeAll(async () => {
  await initSimulation();
});

describe('T04 exact reset', () => {
  it('two runs of the fixed recipe agree exactly at ticks 600 and 1200', () => {
    const result = runResetFixture(STARTING_RECIPE);
    console.info(JSON.stringify({ fixture: 'reset', result }));
    expect(result.map((c) => c.tick)).toEqual([...FIXTURE_TICKS]);
    for (const checkpoint of result) {
      expect(checkpoint.divergence).toBeNull();
      expect(checkpoint.engineBytesEqual).toBe(true);
      expect(checkpoint.bodies).toBe(64);
    }
  });

  it('two runs with the same tick-addressed edits agree exactly', () => {
    const result = runResetFixture(STARTING_RECIPE, scriptedRecipeEdits());
    expect(result.every((c) => c.equal)).toBe(true);
  });

  it('reports the first divergent tick, entity and component', () => {
    const host = new SimulationHost(STARTING_RECIPE);
    const first = runFixedSteps(host);
    const reseeded = cloneFrozen({
      ...STARTING_RECIPE,
      emitters: STARTING_RECIPE.emitters.map((e) => ({ ...e, seed: e.seed + 1 })),
    });
    host.reset(reseeded);
    const second = runFixedSteps(host);
    host.dispose();
    const [at600] = compareRuns(first, second);
    expect(at600!.equal).toBe(false);
    expect(at600!.divergence).toMatchObject({ tick: 600 });
    expect(at600!.divergence!.path).toMatch(/^(emitters|bodies)\./);
  });

  it('a checkpoint keeps the laws of its own tick: later edits cannot rewrite it', () => {
    // Two runs whose laws differ at tick 600 but converge by tick 700. The laws stay far from
    // the stream, so engine bytes cannot tell them apart; only the semantic checkpoint can.
    const base = STARTING_RECIPE.fields[0]!;
    const at = (atTick: number, x: number) => ({ atTick, payload: { kind: 'putField' as const, field: cloneFrozen({ ...base, pose: { ...base.pose, position: [x, 1, 0] as const } }) } });
    const first = runFixedSteps(new SimulationHost(STARTING_RECIPE), [at(100, 40), at(700, 60)]);
    const second = runFixedSteps(new SimulationHost(STARTING_RECIPE), [at(100, 50), at(700, 60)]);
    expect(first[0]!.state.fields[0]!.pose.position).toEqual([40, 1, 0]);
    const [at600, at1200] = compareRuns(first, second);
    expect(at600!.engineBytesEqual).toBe(true);
    expect(at600!.equal).toBe(false);
    expect(at600!.divergence!.path).toBe('fields.0.pose.position.0');
    expect(at1200!.equal).toBe(true);
  });

  it('the emitter keeps at most 64 live bodies and consumes three PRNG draws per birth', () => {
    const host = new SimulationHost(STARTING_RECIPE);
    let maxLive = 0;
    for (let i = 0; i < 1200; i++) {
      host.step();
      maxLive = Math.max(maxLive, host.count);
    }
    const state = host.canonicalState();
    host.dispose();
    expect(maxLive).toBe(64);
    // Births at boundaries 0, 8, …, 1192: 150 scheduled births, 450 draws.
    let prng = STARTING_RECIPE.emitters[0]!.seed;
    for (let i = 0; i < 450; i++) prng = xorshift32(prng);
    expect(state.emitters[0]).toEqual({ id: 'stream', prngState: prng, ordinal: 150 });
  });

  it('an unbounded emitter faults before a birth whose death tick would leave the safe-integer range', () => {
    const [stream] = STARTING_RECIPE.emitters;
    const host = new SimulationHost(cloneFrozen({ ...STARTING_RECIPE, emitters: [{ ...stream!, intervalTicks: 1, lifetimeTicks: Number.MAX_SAFE_INTEGER }] }));
    // Boundary 0: death tick 2^53 − 1 is still safe.
    host.step();
    const before = host.canonicalState();
    // Boundary 1: 1 + (2^53 − 1) is not; nothing at that boundary changes.
    expect(() => host.step()).toThrow(SimulationFault);
    expect(host.fault).toMatchObject({ tick: 1, entity: 'stream' });
    expect(host.canonicalState()).toEqual(before);
    host.dispose();
  });

  it('xorshift32-v1 matches the reference recurrence', () => {
    // Hand-derived from x ^= x<<13; x ^= x>>>17; x ^= x<<5 on uint32 1.
    expect(xorshift32(1)).toBe(270369);
    expect(xorshift32(270369)).toBe(67634689);
  });
});

// SPEC §5.3 (safe tick/ordinal/count values) and §10.1 (integer completed-step clock), at the
// limit itself. No test can step to 2^53, so each host is placed at its boundary tick directly and
// then driven through the real step(). Every premise is proved in BigInt, independently of the host.
describe('safe-integer boundary', () => {
  const S = Number.MAX_SAFE_INTEGER;
  const big = BigInt(S);
  const stream = STARTING_RECIPE.emitters[0]!;
  const emitter = (id: string, schedule: Pick<EmitterDefinition, 'startTick' | 'intervalTicks' | 'lifetimeTicks' | 'emissionCount'>): EmitterDefinition => ({ ...stream, id, ...schedule });
  const hostAt = (tick: number, emitters: EmitterDefinition[]) => {
    const host = new SimulationHost(cloneFrozen({ ...STARTING_RECIPE, emitters }));
    host.tick = tick;
    return host;
  };
  /** Everything that can affect the future or the frame, compared exactly. */
  const observe = (host: SimulationHost) => ({ state: host.canonicalState(), engine: host.engineSnapshot(), positions: host.positions.slice(), count: host.count });

  it('a finite schedule whose last birth sits at the limit runs to the largest safe tick', () => {
    // Last birth S − 1, death S; a next birth would be S + 2, but a count of one leaves none.
    const last = emitter('last', { startTick: S - 1, intervalTicks: 3, lifetimeTicks: 1, emissionCount: 1 });
    expect(BigInt(S - 1) + 1n).toBe(big);
    expect(validateEmitter(last).ok).toBe(true);
    const host = hostAt(S - 1, [last]);
    host.step();
    expect(host.fault).toBeNull();
    expect(host.tick).toBe(S);
    const state = host.canonicalState();
    expect(state.emitters).toEqual([{ id: 'last', prngState: xorshift32(xorshift32(xorshift32(stream.seed))), ordinal: 1 }]);
    expect(state.bodies.map((b) => [b.id, b.deathTick])).toEqual([['last:0', S]]);
    host.dispose();
  });

  it('an unbounded emitter faults at a birth whose next scheduled birth would leave the range', () => {
    // The reviewer's case: birth S − 1 and its death S are safe; the next birth S + 2 is not.
    const edge = emitter('edge', { startTick: S - 1, intervalTicks: 3, lifetimeTicks: 1, emissionCount: undefined });
    expect(BigInt(S - 1) + 1n <= big && BigInt(S - 1) + 3n > big).toBe(true);
    const host = hostAt(S - 1, [edge]);
    const before = observe(host);
    expect(() => host.step()).toThrow(SimulationFault);
    expect(host.fault).toMatchObject({ tick: S - 1, entity: 'edge', reason: 'Emitter schedule leaves the safe-integer range' });
    expect(Number.isSafeInteger(host.tick)).toBe(true);
    expect(observe(host)).toEqual(before);
    // The host refuses to step until reset, and still changes nothing.
    expect(() => host.step()).toThrow(SimulationFault);
    expect(observe(host)).toEqual(before);
    host.dispose();
  });

  it('a next unbounded birth exactly at the limit is accepted', () => {
    // Birth S − 3, next birth exactly S: legal, so the bound is inclusive.
    const edge = emitter('edge', { startTick: S - 3, intervalTicks: 3, lifetimeTicks: 1, emissionCount: undefined });
    expect(BigInt(S - 3) + 3n).toBe(big);
    const host = hostAt(S - 3, [edge]);
    host.step();
    expect(host.fault).toBeNull();
    expect(host.tick).toBe(S - 2);
    expect(host.canonicalState().emitters[0]!.ordinal).toBe(1);
    host.dispose();
  });

  it('the clock faults rather than advance past the largest safe tick', () => {
    const last = emitter('last', { startTick: S - 1, intervalTicks: 3, lifetimeTicks: 1, emissionCount: 1 });
    const host = hostAt(S - 1, [last]);
    host.step(); // S − 1 → S, the last legal transition
    expect(Number.isSafeInteger(S + 1)).toBe(false);
    const before = observe(host);
    expect(() => host.step()).toThrow(SimulationFault);
    expect(host.fault).toMatchObject({ tick: S, entity: 'simulation clock', reason: 'Tick leaves the safe-integer range' });
    expect(host.tick).toBe(S);
    expect(Number.isSafeInteger(host.tick)).toBe(true);
    // Body last:0 dies at S, so this boundary's expiry was due; the fault came first.
    expect(observe(host)).toEqual(before);
    expect(observe(host).state.bodies.map((b) => b.id)).toEqual(['last:0']);
    host.dispose();
  });

  it('a schedule fault changes no tick, PRNG, ordinal, body, engine or law state', () => {
    // A moving body due to expire at S − 1 beside the reviewer's emitter: the fault at S − 1 must
    // precede that boundary's expiry, any draw or ordinal, the engine step and the clock.
    const early = emitter('early', { startTick: S - 3, intervalTicks: 1, lifetimeTicks: 2, emissionCount: 1 });
    const edge = emitter('edge', { startTick: S - 1, intervalTicks: 3, lifetimeTicks: 1, emissionCount: undefined });
    expect(validateEmitter(early).ok).toBe(true);
    const host = hostAt(S - 3, [early, edge]);
    host.step(); // S − 3: early:0 born, deathTick S − 1
    host.step(); // S − 2
    const before = observe(host);
    expect(before.state.tick).toBe(S - 1);
    expect(before.state.bodies.map((b) => [b.id, b.deathTick])).toEqual([['early:0', S - 1]]);
    expect(before.state.emitters).toEqual([
      { id: 'early', prngState: xorshift32(xorshift32(xorshift32(stream.seed))), ordinal: 1 },
      { id: 'edge', prngState: stream.seed, ordinal: 0 },
    ]);
    expect(() => host.step()).toThrow(SimulationFault);
    expect(host.fault).toMatchObject({ tick: S - 1, entity: 'edge' });
    expect(observe(host)).toEqual(before);
    expect(host.appliedFields()).toEqual(STARTING_RECIPE.fields);
    host.dispose();
  });

  it('an ordinary unbounded emitter still emits at every interval', () => {
    // Births at boundaries 0…239 (240 births, 720 draws); lifetime 1 leaves only the newest alive.
    const host = new SimulationHost(cloneFrozen({ ...STARTING_RECIPE, emitters: [emitter('stream', { startTick: 0, intervalTicks: 1, lifetimeTicks: 1, emissionCount: undefined })] }));
    for (let i = 0; i < 240; i++) host.step();
    const state = host.canonicalState();
    host.dispose();
    let prng = stream.seed;
    for (let i = 0; i < 720; i++) prng = xorshift32(prng);
    expect(host.fault).toBeNull();
    expect(state.tick).toBe(240);
    expect(state.emitters).toEqual([{ id: 'stream', prngState: prng, ordinal: 240 }]);
    expect(state.bodies.map((b) => [b.id, b.deathTick])).toEqual([['stream:239', 240]]);
  });
});

describe('T04 cadence independence', () => {
  it('30, 60 and 144 Hz presentation reach identical state at equal ticks', () => {
    const script = scriptedRecipeEdits();
    const reference = runFixedSteps(new SimulationHost(STARTING_RECIPE), script);
    for (const hz of [30, 60, 144]) {
      const comparison = compareRuns(reference, runAtCadence(STARTING_RECIPE, hz, script));
      console.info(JSON.stringify({ fixture: 'cadence', hz, comparison }));
      expect(comparison.every((c) => c.equal)).toBe(true);
    }
  });
});

describe('T04 live scheduler', () => {
  it('runs two steps per 60 Hz frame', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    scheduler.play();
    scheduler.frame(0, 0);
    const steps = Array.from({ length: 60 }, (_, i) => scheduler.frame(((i + 1) * 1000) / 60, 0).steps);
    expect(steps.every((s) => s === 2)).toBe(true);
  });

  it('admits at most 100 ms per frame and runs at most 8 steps, discarding the debt', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    scheduler.play();
    scheduler.frame(0, 0);
    const slow = scheduler.frame(400, 400);
    expect(slow.steps).toBe(MAX_STEPS_PER_FRAME);
    expect(slow.droppedMs).toBeCloseTo(400 - 8 * STEP_MS, 9);
    expect(scheduler.frame(400 + STEP_MS, 400 + STEP_MS).steps).toBe(1); // no hidden backlog survives
  });

  it('pauses before stepping after a frame gap above one second', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    scheduler.play();
    scheduler.frame(0, 0);
    expect(scheduler.frame(1500, 1500)).toEqual({ steps: 0, gap: true, droppedMs: 0 });
    expect(scheduler.playing).toBe(false);
    expect(scheduler.frame(1516, 1516).steps).toBe(0); // stays paused: Play is explicit
  });

  it('pauses on a wall-clock gap even when the presentation clock barely moved (sleep)', () => {
    // macOS's monotonic clock does not advance during system sleep; the wall clock does.
    const scheduler = new FixedStepScheduler(STEP_MS);
    scheduler.play();
    scheduler.frame(1000, 50_000);
    const wake = scheduler.frame(1016.7, 50_000 + 3_600_000);
    expect(wake).toEqual({ steps: 0, gap: true, droppedMs: 0 });
    expect(scheduler.playing).toBe(false);
  });

  it('Play starts from a fresh timestamp, so a paused interval never becomes simulated time', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    scheduler.frame(0, 0);
    scheduler.frame(900, 900); // paused frames
    scheduler.play();
    expect(scheduler.frame(950, 950).steps).toBe(0);
    expect(scheduler.frame(950 + 2 * STEP_MS, 950 + 2 * STEP_MS).steps).toBe(2);
  });
});

describe('T04 reset of the authored configuration', () => {
  it('settles pending edits, rebuilds the current configuration at tick 0, and never replays a drag', () => {
    const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    const document = new DocumentController(createDocument(STARTING_RECIPE, { title: 'recipe' }), host);
    const base = STARTING_RECIPE.fields[0]!;
    for (let i = 0; i < 90; i++) host.step();
    // A drag: several previews, then one still-pending final value.
    for (const x of [2.5, 1.5, 0.5]) {
      expect(document.putField({ ...base, pose: { ...base.pose, position: [x, 1, 0] } }).ok).toBe(true);
      host.step();
      document.sync();
    }
    expect(document.putField({ ...base, pose: { ...base.pose, position: [0.2, 1, 0] } }).ok).toBe(true);

    const root = document.reset();
    expect(host.tick).toBe(0);
    expect(host.lastAppliedSequence).toBe(0);
    expect(host.appliedFields()[0]!.pose.position).toEqual([0.2, 1, 0]);
    expect(document.scene.fields[0]!.pose.position).toEqual([0.2, 1, 0]);
    expect(Object.isFrozen(root.fields[0]!.pose.position)).toBe(true);

    // The rebuilt run equals a fresh build of that configuration.
    const afterReset = runFixedSteps(host);
    const fresh = new SimulationHost(root);
    const comparison = compareRuns(afterReset, runFixedSteps(fresh));
    fresh.dispose();
    host.dispose();
    expect(comparison.every((c) => c.equal)).toBe(true);
  });

  it('rejects an invalid edit before it reaches the host', () => {
    const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    const document = new DocumentController(createDocument(STARTING_RECIPE, { title: 'recipe' }), host);
    const base = STARTING_RECIPE.fields[0]!;
    const result = document.putField({ ...base, region: { kind: 'box', halfExtents: [0, 2, 1.5] } });
    expect(result.ok).toBe(false);
    host.settleBoundary();
    expect(host.lastAppliedSequence).toBe(0);
    expect(host.appliedFields()[0]).toEqual(base);
    host.dispose();
  });
});

describe('M1 regression oracle', () => {
  const sha256 = async (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // The accepted M1 packaged app's run digests for the recipe (docs/evidence/M1.md, Exact reset
  // and cadence: state 95ff02d6…/c0871e51…, engine 935d92ed…/95c100da…). M2 must not move them.
  it('the recipe still reaches the accepted M1 state and engine digests at ticks 600 and 1200', async () => {
    const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    const seen: Record<number, [string, string]> = {};
    for (let t = 1; t <= 1200; t++) {
      host.step();
      if (t === 600 || t === 1200) seen[t] = [await sha256(JSON.stringify(host.canonicalState())), await sha256(host.engineSnapshot())];
    }
    host.dispose();
    expect(seen[600]).toEqual(['95ff02d66f208149a621fda3439b5fda5222c04d157d26d74e508b4fab00467e', '935d92ed16b6dbbbf4ab5b1b0594c9c9b8d6d2f91567c8bad871851916663d09']);
    expect(seen[1200]).toEqual(['c0871e511bfaf8dfd1bf67792f5bca4bd4a97b7e004ce5883880b1d88924c855', '95c100da14eb5fde78e15f668ff1c27cbadc16eb8703e21941a146f1f892618b']);
  });
});
