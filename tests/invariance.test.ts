// AC6, T04 and T11 for M4: visualization observes the simulation and never becomes its authority.
// The same frozen root and the same tick-addressed commands, observed quietly or by 2,000 probes,
// 32 trails, a changing explained body, one law's arrows and paused previews, reach identical
// authoritative state, engine bytes and emitter PRNG progression at every checkpoint.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen, type SceneDefinition } from '../src/domain/scene';
import { MAX_PROBES, ProbeField } from '../src/observation/probes';
import { MAX_TRAILS, TrailRecorder } from '../src/observation/trails';
import { parseScene } from '../src/persistence/sceneFile';
import { QUIET_VIEW, busyView, observedResetFixture, runObserved, scriptedEdits, scriptedRecipeEdits, visualizationInvariance } from '../src/simulation/fixtures';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import collisions from '../examples/collisions.lawsmith.json?raw';
import dragPocket from '../examples/drag-pocket.lawsmith.json?raw';
import overlap from '../examples/overlap.lawsmith.json?raw';

beforeAll(async () => {
  await initSimulation();
});

function semantic(text: string): SceneDefinition {
  const parsed = parseScene(text);
  if (!parsed.ok) throw parsed.error;
  return parsed.document.semantic;
}

const CASES: [string, SceneDefinition, boolean][] = [
  ['the recipe', STARTING_RECIPE, false],
  ['Overlap', semantic(overlap), true],
  ['Drag Pocket', semantic(dragPocket), true],
  ['Collisions (all-body contacts)', semantic(collisions), true],
];

describe('AC6 visualization cannot alter authority', () => {
  for (const [name, root, scripted] of CASES) {
    it(`${name}: quiet and two busy views agree exactly at ticks 600 and 1200, edits included`, () => {
      const script = scripted ? scriptedEdits(root) : scriptedRecipeEdits();
      const results = visualizationInvariance(root, script);
      console.info(JSON.stringify({ fixture: 'visualization-invariance', scene: name, results: results.map((r) => ({ view: r.view, activity: r.activity, equal: r.comparison.map((c) => c.equal) })) }));
      for (const { activity, comparison } of results) {
        expect(comparison.map((c) => c.tick)).toEqual([600, 1200]);
        for (const c of comparison) {
          expect(c.divergence, `${name}: first divergence`).toBeNull();
          expect(c.engineBytesEqual).toBe(true);
        }
        // The busy views really were busy.
        expect(activity.maxLiveProbes).toBe(MAX_PROBES);
        expect(activity.probeSteps).toBe(1200);
        expect(activity.maxTrails).toBe(Math.min(MAX_TRAILS, 32));
        expect(activity.explainedSteps).toBeGreaterThan(1100);
        expect(activity.previews).toBeGreaterThan(80);
        expect(activity.arrowSamples).toBeGreaterThan(0);
      }
    });
  }

  it('the recipe observed by a busy view still reaches the accepted M1 oracle digests', async () => {
    const sha256 = async (data: string | Uint8Array) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    const [at600, at1200] = runObserved(host, [], busyView(STARTING_RECIPE, 5, 23));
    host.dispose();
    expect([await sha256(JSON.stringify(at600!.state)), await sha256(at600!.engine)]).toEqual(['95ff02d66f208149a621fda3439b5fda5222c04d157d26d74e508b4fab00467e', '935d92ed16b6dbbbf4ab5b1b0594c9c9b8d6d2f91567c8bad871851916663d09']);
    expect([await sha256(JSON.stringify(at1200!.state)), await sha256(at1200!.engine)]).toEqual(['c0871e511bfaf8dfd1bf67792f5bca4bd4a97b7e004ce5883880b1d88924c855', '95c100da14eb5fde78e15f668ff1c27cbadc16eb8703e21941a146f1f892618b']);
  });

  it('emitter PRNG states and skipped emissions are among what is compared', () => {
    const host = new SimulationHost(semantic(overlap));
    const [checkpoint] = runObserved(host, [], busyView(semantic(overlap), 3, 17), [600]);
    host.dispose();
    expect(checkpoint!.state.emitters.length).toBeGreaterThan(0);
    expect(checkpoint!.state.emitters[0]!.ordinal).toBeGreaterThan(0);
    expect(checkpoint!.state).toHaveProperty('skippedEmissions');
  });
});

describe('T04 reset with the view changed across it', () => {
  for (const [name, root, scripted] of CASES) {
    it(`${name}: quiet before the reset, busy after, identical at 600 and 1200`, () => {
      const result = observedResetFixture(root, scripted ? scriptedEdits(root) : scriptedRecipeEdits());
      for (const c of result) {
        expect(c.divergence).toBeNull();
        expect(c.engineBytesEqual).toBe(true);
      }
    });
  }
});

describe('T11 visual buffers stay bounded through toggles, resets and loads', () => {
  it('20 cycles of probe and trail toggles, resets and scene loads allocate nothing new', () => {
    const roots = [semantic(overlap), semantic(collisions), STARTING_RECIPE];
    const probes = new ProbeField();
    const trails = new TrailRecorder('all');
    const probeBytes = JSON.stringify(probes.bytes());
    const trailBytes = JSON.stringify(trails.bytes());
    const arrays = [probes.position, probes.velocity, probes.alive, probes.bornAt, trails.positions, trails.ticks];
    let host = new SimulationHost(roots[0]!);
    for (let cycle = 0; cycle < 20; cycle++) {
      probes.configure({ enabled: cycle % 2 === 0, count: cycle % 3 === 0 ? MAX_PROBES : 500 + cycle, seed: cycle + 1 });
      trails.mode = cycle % 3 === 0 ? 'all' : cycle % 3 === 1 ? 'selected' : 'off';
      for (let n = 0; n < 130; n++) {
        probes.sync(host);
        host.step();
        probes.advance(host);
        trails.record(host, host.ids[0] ?? null);
        expect(probes.live).toBeLessThanOrEqual(MAX_PROBES);
        expect(trails.count).toBeLessThanOrEqual(MAX_TRAILS);
      }
      if (cycle % 2 === 0) host.reset(roots[cycle % roots.length]!);
      else {
        host.dispose();
        host = new SimulationHost(roots[cycle % roots.length]!);
      }
    }
    host.dispose();
    expect(JSON.stringify(probes.bytes())).toBe(probeBytes);
    expect(JSON.stringify(trails.bytes())).toBe(trailBytes);
    // The very same arrays: nothing was reallocated.
    expect([probes.position, probes.velocity, probes.alive, probes.bornAt, trails.positions, trails.ticks]).toEqual(arrays);
    arrays.forEach((a, i) => expect(a).toBe([probes.position, probes.velocity, probes.alive, probes.bornAt, trails.positions, trails.ticks][i]));
  });

  it('the default trace and probe buffers total well under 32 MiB', () => {
    const total = [new ProbeField().bytes(), new TrailRecorder().bytes()].flatMap((b) => Object.values(b)).reduce((a, b) => a + b, 0);
    console.info(JSON.stringify({ fixture: 'visual-buffers', probes: new ProbeField().bytes(), trails: new TrailRecorder().bytes(), total }));
    expect(total).toBeLessThan(32 * 1024 * 1024);
  });

  it('the quiet view does no probe or trail work at all', () => {
    const host = new SimulationHost(STARTING_RECIPE);
    const activity = { probeSteps: 0, maxLiveProbes: 0, maxTrails: 0, explainedSteps: 0, previews: 0, arrowSamples: 0 };
    runObserved(host, [], QUIET_VIEW, [240], activity);
    host.dispose();
    expect([activity.probeSteps, activity.maxLiveProbes, activity.maxTrails, activity.explainedSteps, activity.previews]).toEqual([0, 0, 0, 0, 0]);
  });
});
