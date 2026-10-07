// T08/T11 for M4 trails (SPEC §12): stored positions equal the host's own observations at every
// fourth completed tick, buffers stay bounded, and a reset or a loaded scene clears the old world's
// trails. Expected positions come from canonicalState(), never from the recorder.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, type BodyDefinition, type SceneDefinition } from '../src/domain/scene';
import { MAX_TRAILS, TRAIL_INTERVAL_TICKS, TRAIL_SAMPLES, TrailRecorder, type TrailMode } from '../src/observation/trails';
import { parseScene } from '../src/persistence/sceneFile';
import { scriptedEdits, type ScriptedCommand } from '../src/simulation/fixtures';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import { FixedStepScheduler } from '../src/simulation/scheduler';
import dragPocket from '../examples/drag-pocket.lawsmith.json?raw';
import overlap from '../examples/overlap.lawsmith.json?raw';

beforeAll(async () => {
  await initSimulation();
});

const EXAMPLES: Record<string, string> = { overlap, 'drag-pocket': dragPocket };
function example(name: string): SceneDefinition {
  const parsed = parseScene(EXAMPLES[name]!);
  if (!parsed.ok) throw parsed.error;
  return parsed.document.semantic;
}

/** Every body's translation at every completed tick divisible by four, from the canonical state. */
type Observed = Map<number, Map<string, number[]>>;

function run(root: SceneDefinition, mode: TrailMode, ticks: number, script: readonly ScriptedCommand[] = [], selected: (tick: number) => string | null = () => null) {
  const host = new SimulationHost(root);
  const trails = new TrailRecorder(mode);
  const observed: Observed = new Map();
  let revision = 0;
  while (host.tick < ticks) {
    for (const c of script) if (c.atTick === host.tick) host.submit(c.payload, ++revision);
    const id = selected(host.tick);
    host.explain(id);
    host.step();
    trails.record(host, id);
    if (host.tick % TRAIL_INTERVAL_TICKS === 0) observed.set(host.tick, new Map(host.canonicalState().bodies.map((b) => [b.id, b.translation])));
  }
  return { host, trails, observed };
}

/** Each stored trail: consecutive four-tick samples ending at the latest one, equal to the observations. */
function expectFaithful(trails: TrailRecorder, observed: Observed, now: number) {
  const latest = now - (now % TRAIL_INTERVAL_TICKS);
  let trailsSeen = 0;
  for (let s = 0; s < MAX_TRAILS; s++) {
    const owner = trails.owners[s];
    if (owner === null) {
      expect(trails.lengths[s]).toBe(0);
      continue;
    }
    trailsSeen += 1;
    const n = trails.lengths[s]!;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(TRAIL_SAMPLES);
    for (let k = 0; k < n; k++) {
      const at = trails.at(s, k);
      const tick = trails.ticks[at]!;
      expect(tick).toBe(latest - TRAIL_INTERVAL_TICKS * (n - 1 - k));
      const expected = observed.get(tick)!.get(owner!);
      expect(expected, `${owner} at ${tick}`).toBeDefined();
      expect([trails.positions[3 * at], trails.positions[3 * at + 1], trails.positions[3 * at + 2]]).toEqual(expected);
    }
  }
  expect(trailsSeen).toBe(trails.count);
}

describe('T08 trails equal the actual body observations every fourth tick', () => {
  it('free motion under an active field, with emitted bodies dying and slots reused (all mode)', () => {
    const root = example('overlap');
    const { host, trails, observed } = run(root, 'all', 1200, scriptedEdits(root));
    expect(trails.count).toBe(MAX_TRAILS);
    expectFaithful(trails, observed, host.tick);
    // Every owner is a living body; none of the stream's dead bodies keeps a slot.
    for (const owner of trails.owners) expect(host.ids).toContain(owner);
    host.dispose();
  });

  it('the recipe stream with its scripted law edits', () => {
    const { host, trails, observed } = run(STARTING_RECIPE, 'all', 900);
    expectFaithful(trails, observed, host.tick);
    host.dispose();
  });

  it('holds exactly ten seconds once full: 300 samples, the oldest 1196 ticks before the newest', () => {
    const ball: BodyDefinition = { ...STARTING_RECIPE.bodies[0]!, id: 'ball', type: 'dynamic', massKg: 1, initialPose: { position: [0, 3, 0], rotation: [0, 0, 0, 1] }, collider: { kind: 'sphere', radius: 0.08 }, collisionMode: 'fixedOnly' };
    const root = cloneFrozen({ ...STARTING_RECIPE, emitters: [], bodies: [...STARTING_RECIPE.bodies, ball] });
    const { host, trails, observed } = run(root, 'all', 1600);
    const s = trails.slot('ball')!;
    expect(trails.lengths[s]).toBe(TRAIL_SAMPLES);
    expect(trails.ticks[trails.at(s, TRAIL_SAMPLES - 1)]).toBe(1600);
    expect(trails.ticks[trails.at(s, 0)]).toBe(1600 - 4 * 299);
    expectFaithful(trails, observed, host.tick);
    host.dispose();
  });

  it('selected mode keeps the explained body only, and a new selection starts its own trail', () => {
    const root = example('overlap');
    const pick = (tick: number) => (tick < 400 ? 'stream:2' : 'stream:20');
    const { host, trails, observed } = run(root, 'selected', 600, [], pick);
    expect(trails.count).toBe(1);
    const s = trails.slot('stream:20')!;
    expect(trails.slot('stream:2')).toBeUndefined();
    // Selected from boundary 400 on, so its first sample is the next fourth tick after the step from 400.
    expect(trails.ticks[trails.at(s, 0)]).toBe(404);
    expectFaithful(trails, observed, host.tick);
    host.dispose();
  });

  it('the same ticks give the same trails at 30, 60 and 144 Hz presentation: no wall clock decides a sample', () => {
    const root = example('overlap');
    const buffers = [30, 60, 144].map((hz) => {
      const host = new SimulationHost(root);
      const trails = new TrailRecorder('all');
      const scheduler = new FixedStepScheduler(1000 / 120);
      scheduler.play();
      for (let frame = 0; host.tick < 720; frame++) {
        const t = (frame * 1000) / hz;
        const { steps } = scheduler.frame(t, t);
        for (let i = 0; i < steps && host.tick < 720; i++) {
          host.step();
          trails.record(host, null);
        }
      }
      host.dispose();
      return { positions: [...trails.positions], ticks: [...trails.ticks], owners: [...trails.owners] };
    });
    expect(buffers[1]).toEqual(buffers[0]);
    expect(buffers[2]).toEqual(buffers[0]);
  });
});

describe('trails reset with their world', () => {
  it('a reset clears every trail, and none shows a sample from before it', () => {
    const root = example('overlap');
    const host = new SimulationHost(root);
    const trails = new TrailRecorder('all');
    for (let n = 0; n < 500; n++) {
      host.step();
      trails.record(host, null);
    }
    expect(trails.count).toBeGreaterThan(0);
    host.reset(root);
    for (let n = 0; n < 8; n++) {
      host.step();
      trails.record(host, null);
    }
    for (let s = 0; s < MAX_TRAILS; s++) {
      for (let k = 0; k < trails.lengths[s]!; k++) expect(trails.ticks[trails.at(s, k)]).toBeLessThanOrEqual(8);
    }
    expect(Math.max(...[...trails.lengths])).toBe(2);
    host.dispose();
  });

  it('a newly loaded scene (a different host) clears the previous scene’s trails', () => {
    const first = new SimulationHost(example('overlap'));
    const trails = new TrailRecorder('all');
    for (let n = 0; n < 300; n++) {
      first.step();
      trails.record(first, null);
    }
    const loaded = new SimulationHost(example('drag-pocket'));
    loaded.step();
    loaded.step();
    loaded.step();
    loaded.step();
    trails.record(loaded, null);
    for (const owner of trails.owners) if (owner !== null) expect(loaded.ids).toContain(owner);
    expect(Math.max(...[...trails.lengths])).toBe(1);
    first.dispose();
    loaded.dispose();
  });

  it('off records nothing and a mode change starts afresh', () => {
    const host = new SimulationHost(example('overlap'));
    const trails = new TrailRecorder('off');
    for (let n = 0; n < 40; n++) {
      host.step();
      trails.record(host, 'stream:1');
    }
    expect(trails.count).toBe(0);
    expect(trails.version).toBe(0);
    trails.mode = 'all';
    for (let n = 0; n < 8; n++) {
      host.step();
      trails.record(host, null);
    }
    expect(trails.count).toBeGreaterThan(0);
    trails.mode = 'selected';
    expect(trails.count).toBe(0);
    host.dispose();
  });
});
