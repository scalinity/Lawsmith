// T04 (reset and time), M1 cases: exact reset at ticks 600/1200, cadence independence at
// 30/60/144 Hz, scheduler limits and gap pauses, and reset of the authored configuration.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { STARTING_RECIPE, cloneFrozen } from '../src/domain/scene';
import {
  FIXTURE_TICKS,
  compareRuns,
  runAtCadence,
  runFixedSteps,
  runResetFixture,
  scriptedRecipeEdits,
} from '../src/simulation/fixtures';
import { SimulationHost, initSimulation, xorshift32 } from '../src/simulation/host';
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

  it('xorshift32-v1 matches the reference recurrence', () => {
    // Hand-derived from x ^= x<<13; x ^= x>>>17; x ^= x<<5 on uint32 1.
    expect(xorshift32(1)).toBe(270369);
    expect(xorshift32(270369)).toBe(67634689);
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
    const document = new DocumentController(STARTING_RECIPE, host);
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
    const document = new DocumentController(STARTING_RECIPE, host);
    const base = STARTING_RECIPE.fields[0]!;
    const result = document.putField({ ...base, region: { kind: 'box', halfExtents: [0, 2, 1.5] } });
    expect(result.ok).toBe(false);
    host.settleBoundary();
    expect(host.lastAppliedSequence).toBe(0);
    expect(host.appliedFields()[0]).toEqual(base);
    host.dispose();
  });
});
