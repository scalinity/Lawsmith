// M4 scenes: the P2 workload (SPEC §18.1), the limiter QA scene and the Why It Moves example. Each
// file is canonical; P2 is the declared workload; the QA scene really limits; the example gives an
// explained body overlapping shares and contacts without ever limiting.
import { beforeAll, describe, expect, it } from 'vitest';
import whyItMoves from '../examples/why-it-moves.lawsmith.json?raw';
import limiter from '../scripts/verify/scenes/m4-limiter.lawsmith.json?raw';
import p2Probes from '../scripts/verify/scenes/p2-probes.lawsmith.json?raw';
import { DRIVE_METERS_PER_MS2 } from '../src/fields/registry';
import { ARROW_CAP_M } from '../src/rendering/explainView';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import type { SceneDocument } from '../src/domain/scene';

beforeAll(async () => {
  await initSimulation();
});

function load(text: string): SceneDocument {
  const result = parseScene(text);
  if (!result.ok) throw result.error;
  return result.document;
}

describe('M4 scene files', () => {
  it.each([['P2', p2Probes], ['limiter', limiter], ['Why It Moves', whyItMoves]])('%s is canonical', (_name, text) => {
    expect(serializeScene(load(text))).toBe(text);
  });
});

describe('P2 probes workload (SPEC §18.1)', () => {
  it('is 100 dynamic bodies, four one-leaf laws (one of each primitive) and no emitter', () => {
    const { semantic } = load(p2Probes);
    expect(semantic.bodies.filter((b) => b.type === 'dynamic')).toHaveLength(100);
    expect(semantic.fields).toHaveLength(4);
    expect(new Set(semantic.fields.map((f) => f.expression.kind))).toEqual(new Set(['directional', 'softRadial', 'vortexY', 'linearDrag']));
    expect(semantic.emitters).toHaveLength(0);
  });

  it('runs 70 s without a fault or the limiter, and its bodies keep moving', { timeout: 60_000 }, () => {
    const host = new SimulationHost(load(p2Probes).semantic);
    let moving = 0;
    for (let i = 0; i < 8400; i++) {
      host.step();
      if (i >= 7200 && host.maxSpeed > 1) moving += 1;
    }
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    expect(host.count).toBe(100);
    expect(moving).toBeGreaterThan(1100);
    host.dispose();
  });
});

describe('the limiter QA scene', () => {
  it('an explained body meets a capped arrow with the limiter idle, then the active limiter', () => {
    const host = new SimulationHost(load(limiter).semantic);
    host.explain('stream:0');
    let cappedIdle = 0;
    let limited = 0;
    for (let i = 0; i < 240; i++) {
      host.step();
      const o = host.explanation;
      if (!o || o.toTick !== host.tick) continue;
      const drawn = Math.hypot(...o.submitted) * DRIVE_METERS_PER_MS2;
      if (o.lambda === 1 && drawn > ARROW_CAP_M) cappedIdle += 1;
      if (o.lambda < 1) limited += 1;
    }
    expect(cappedIdle).toBeGreaterThan(5);
    expect(limited).toBeGreaterThan(0);
    expect(host.fault).toBeNull();
    host.dispose();
  });
});

describe('Why It Moves', () => {
  it('gives an explained body steps with both laws’ shares, and later steps with contacts', () => {
    const host = new SimulationHost(load(whyItMoves).semantic);
    host.explain('stream:0');
    let both = 0;
    let contacts = 0;
    for (let i = 0; i < 900; i++) {
      host.step();
      const o = host.explanation;
      if (!o || o.toTick !== host.tick) continue;
      if (o.contributions.every((c) => c.drag > 0 || Math.hypot(...c.applied) > 0)) both += 1;
      if (o.contacts?.length) contacts += 1;
    }
    expect(both).toBeGreaterThan(0);
    expect(contacts).toBeGreaterThan(0);
    expect(host.limitedSteps).toBe(0);
    host.dispose();
  });
});
