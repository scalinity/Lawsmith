// M3 scenes: the editable examples and the P1 workload (canonical files that run without faults or
// limiting), T04 exact reset and cadence for seeded multi-law scenes with edits, and T06 for every
// primitive and region (round trip, capabilities, digest, equal ticks, undo after load, rejection).
// The accepted M2 demo file must still load and re-export byte for byte.
import { beforeAll, describe, expect, it } from 'vitest';
import catchAndRelease from '../examples/catch-and-release.lawsmith.json?raw';
import collisions from '../examples/collisions.lawsmith.json?raw';
import dragPocket from '../examples/drag-pocket.lawsmith.json?raw';
import overlap from '../examples/overlap.lawsmith.json?raw';
import swirl from '../examples/swirl.lawsmith.json?raw';
import m2Demo from '../docs/evidence/m2/m2-demo.lawsmith.json?raw';
import p1Workshop from '../scripts/verify/scenes/p1-workshop.lawsmith.json?raw';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen, type FieldDefinition, type SceneDocument } from '../src/domain/scene';
import { defaultDocument } from '../src/persistence/defaultScene';
import { createDocument, parseScene, semanticDigest, serializeScene } from '../src/persistence/sceneFile';
import { FIXTURE_TICKS, compareRuns, runAtCadence, runFixedSteps, runResetFixture, scriptedEdits } from '../src/simulation/fixtures';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

function load(text: string): SceneDocument {
  const result = parseScene(text);
  if (!result.ok) throw result.error;
  return result.document;
}

const EXAMPLES = Object.entries({ 'catch-and-release': catchAndRelease, swirl, 'drag-pocket': dragPocket, overlap, collisions }).map(([name, text]) => ({ name, text }));
const P1 = p1Workshop;

describe('M3 example scenes', () => {
  it.each(EXAMPLES)('$name is canonical and declares exactly what it uses', ({ text }) => {
    const document = load(text);
    expect(serializeScene(document)).toBe(text);
    const kinds = new Set(document.semantic.fields.flatMap((f) => [f.region.kind, f.expression.kind]));
    expect(document.requiredCapabilities.length).toBe(kinds.size + (document.semantic.emitters.length ? 1 : 0));
  });

  it.each(EXAMPLES)('$name runs 70 s without a fault or the acceleration limiter (SPEC §9.1)', { timeout: 60_000 }, ({ text }) => {
    const host = new SimulationHost(load(text).semantic);
    for (let i = 0; i < 8400; i++) host.step();
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    host.dispose();
  });

  it('together they cover every primitive and region, an overlap and all-body collisions', () => {
    const fields = EXAMPLES.flatMap(({ text }) => load(text).semantic.fields);
    expect(new Set(fields.map((f) => f.expression.kind))).toEqual(new Set(['softRadial', 'vortexY', 'linearDrag']));
    expect(new Set(fields.map((f) => f.region.kind))).toEqual(new Set(['box', 'sphere', 'cylinderY']));
    expect(load(EXAMPLES.find((e) => e.name === 'overlap')!.text).semantic.fields).toHaveLength(3);
    expect(load(EXAMPLES.find((e) => e.name === 'collisions')!.text).semantic.emitters[0]!.template.collisionMode).toBe('all');
  });
});

describe('P1 workshop scene (SPEC §18.1)', () => {
  it('is 200 dynamic spheres with contacts, 16 one-leaf laws over all kinds, 16 fixed colliders', () => {
    const { semantic } = load(P1);
    expect(serializeScene(load(P1))).toBe(P1);
    expect(semantic.bodies.filter((b) => b.type === 'dynamic')).toHaveLength(200);
    expect(semantic.bodies.filter((b) => b.type === 'dynamic').every((b) => b.collisionMode === 'all')).toBe(true);
    expect(semantic.bodies.filter((b) => b.type === 'fixed')).toHaveLength(16);
    expect(semantic.fields).toHaveLength(16);
    expect(new Set(semantic.fields.map((f) => f.expression.kind)).size).toBe(4);
    expect(new Set(semantic.fields.map((f) => f.region.kind)).size).toBe(3);
  });

  it('stays busy and bounded through a warmup and a measured minute', { timeout: 120_000 }, () => {
    const host = new SimulationHost(load(P1).semantic);
    for (let i = 0; i < 8400; i++) host.step();
    const bodies = host.canonicalState().bodies;
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    expect(bodies.filter((b) => b.translation[1]! > -2.5)).toHaveLength(200); // contained by the arena
    expect(bodies.filter((b) => Math.hypot(...b.linvel) > 0.5).length).toBeGreaterThan(150); // still circulating
    host.dispose();
  });
});

describe('T04 exact reset with seeded multi-law scenes', () => {
  for (const name of ['overlap', 'collisions']) {
    it(`${name}: reset with tick-addressed edits of every law agrees exactly at ticks 600 and 1200`, { timeout: 60_000 }, () => {
      const root = load(EXAMPLES.find((e) => e.name === name)!.text).semantic;
      const script = scriptedEdits(root);
      expect(script.length).toBeGreaterThan(6 * root.fields.length);
      const comparison = runResetFixture(root, script);
      expect(comparison.map((c) => c.tick)).toEqual([...FIXTURE_TICKS]);
      for (const c of comparison) {
        expect(c.divergence).toBeNull();
        expect(c.engineBytesEqual).toBe(true);
        expect(c.bodies).toBeGreaterThan(0);
      }
    });
  }

  it('30, 60 and 144 Hz presentation reach the identical multi-law state at equal ticks', { timeout: 60_000 }, () => {
    const root = load(EXAMPLES.find((e) => e.name === 'overlap')!.text).semantic;
    const script = scriptedEdits(root);
    const host = new SimulationHost(root);
    const reference = runFixedSteps(host, script);
    host.dispose();
    for (const hz of [30, 60, 144]) expect(compareRuns(reference, runAtCadence(root, hz, script)).every((c) => c.equal)).toBe(true);
  });

  it('the P1 scene resets exactly too', { timeout: 60_000 }, () => {
    expect(runResetFixture(load(P1).semantic).every((c) => c.equal)).toBe(true);
  });
});

// ---------------------------------------------------------------- T06

/** One law of every primitive and every region, all with edited parameters. */
function vocabulary(): SceneDocument {
  const base = defaultDocument();
  const law = (id: string, region: FieldDefinition['region'], expression: FieldDefinition['expression'], position: FieldDefinition['pose']['position']): FieldDefinition => ({
    id,
    enabled: true,
    pose: { position, rotation: [0, 0.19509032201612825, 0, 0.9807852804032304] },
    region,
    edgeFade: 0.3,
    expression,
  });
  const fields = [
    law('a-push', { kind: 'box', halfExtents: [1.25, 2.5, 0.75] }, { kind: 'directional', direction: [0.6, 0, 0.8], strength: 17.5 }, [2.5, 1, 0]),
    law('b-pull', { kind: 'sphere', radius: 1.7 }, { kind: 'softRadial', strength: -6.25, coreRadius: 0.35 }, [-0.4, 2.2, 0.3]),
    law('c-swirl', { kind: 'cylinderY', radius: 1.3, halfHeight: 1.9 }, { kind: 'vortexY', strength: 11.5, coreRadius: 0.2 }, [0.2, 2.5, -0.2]),
    law('d-drag', { kind: 'cylinderY', radius: 2, halfHeight: 0.6 }, { kind: 'linearDrag', coefficient: 2.75 }, [0, 0.5, 0]),
    law('e-drag', { kind: 'box', halfExtents: [1, 1, 1] }, { kind: 'linearDrag', coefficient: 1.5 }, [0, 3, 0]),
  ];
  return createDocument({ ...base.semantic, fields }, { title: 'Vocabulary', description: 'Every primitive and region.' });
}

describe('T06 M3 scenes', () => {
  it('round-trips every primitive and region exactly, with sorted capabilities, canonically', () => {
    const original = vocabulary();
    const text = serializeScene(original);
    const reloaded = load(text);
    expect(reloaded.semantic.fields).toEqual(original.semantic.fields.map((f) => ({ ...f, pose: { ...f.pose } })));
    expect(reloaded.requiredCapabilities).toEqual([
      'emitter.xorshift32.v1',
      'primitive.directional.v1',
      'primitive.linearDrag.v1',
      'primitive.softRadial.v1',
      'primitive.vortexY.v1',
      'region.box.v1',
      'region.cylinderY.v1',
      'region.sphere.v1',
    ]);
    expect(serializeScene(reloaded)).toBe(text);
    expect(serializeScene(load(serializeScene(reloaded)))).toBe(text);
  });

  it('the reloaded vocabulary reaches the same state and engine bytes at ticks 600 and 1200, with edits', { timeout: 60_000 }, () => {
    const original = vocabulary();
    const reloaded = load(serializeScene(original));
    const script = scriptedEdits(reloaded.semantic);
    const a = new SimulationHost(cloneFrozen(original.semantic));
    const b = new SimulationHost(reloaded.semantic);
    const comparison = compareRuns(runFixedSteps(a, script), runFixedSteps(b, script));
    a.dispose();
    b.dispose();
    expect(comparison.every((c) => c.equal)).toBe(true);
  });

  it('the semantic digest follows every M3 parameter and ignores presentation', async () => {
    const digest = (mutate: (v: Record<string, any>) => void) => {
      const value = JSON.parse(serializeScene(vocabulary()));
      mutate(value);
      return semanticDigest(load(JSON.stringify(value)));
    };
    const base = await digest(() => {});
    for (const mutate of [
      (v: Record<string, any>) => (v.semantic.fields[1].expression.coreRadius = 0.4),
      (v: Record<string, any>) => (v.semantic.fields[1].expression.strength = 6.25),
      (v: Record<string, any>) => (v.semantic.fields[2].region.halfHeight = 2),
      (v: Record<string, any>) => (v.semantic.fields[3].expression.coefficient = 3),
      (v: Record<string, any>) => (v.semantic.fields[1].region.radius = 1.8),
      (v: Record<string, any>) => (v.semantic.fields[4].edgeFade = 0.5),
    ]) {
      expect(await digest(mutate)).not.toBe(base);
    }
    expect(await digest((v) => (v.presentation.laws[2].color = '#7aa7d9'))).toBe(base);
    expect(await digest((v) => (v.presentation.laws[3].visible = false))).toBe(base);
  });

  it('rejects unsupported or malformed M3 content at its path, before replacing anything', () => {
    const value = () => JSON.parse(serializeScene(vocabulary()));
    const reject = (mutate: (v: Record<string, any>) => void) => {
      const v = value();
      mutate(v);
      const result = parseScene(JSON.stringify(v));
      expect(result.ok).toBe(false);
      return result.ok ? null : result.error;
    };
    expect(reject((v) => v.requiredCapabilities.push('primitive.softRadial.v2'))!.reason).toContain('primitive.softRadial.v2');
    expect(reject((v) => (v.requiredCapabilities = v.requiredCapabilities.filter((c: string) => c !== 'region.sphere.v1')))!.path).toBe('requiredCapabilities');
    expect(reject((v) => (v.semantic.fields[1].expression.direction = [1, 0, 0]))!.path).toBe('semantic.fields[1].expression.direction');
    expect(reject((v) => delete v.semantic.fields[1].expression.coreRadius)!.path).toBe('semantic.fields[1].expression.coreRadius');
    expect(reject((v) => (v.semantic.fields[1].expression.coreRadius = 0))!.path).toBe('semantic.fields[1].expression.coreRadius');
    expect(reject((v) => (v.semantic.fields[2].expression.strength = -201))!.path).toBe('semantic.fields[2].expression.strength');
    expect(reject((v) => (v.semantic.fields[3].expression.coefficient = -0.5))!.path).toBe('semantic.fields[3].expression.coefficient');
    expect(reject((v) => (v.semantic.fields[2].region.halfHeight = 101))!.path).toBe('semantic.fields[2].region.halfHeight');
    expect(reject((v) => (v.semantic.fields[1].region.halfExtents = [1, 1, 1]))!.path).toBe('semantic.fields[1].region.halfExtents');
    expect(reject((v) => (v.semantic.fields[1].region = { kind: 'ellipsoid', radii: [1, 2, 3] }))!.path).toBe('semantic.fields[1].region.kind');
    expect(reject((v) => (v.semantic.fields[1].expression = { kind: 'gravity', strength: 9.81 }))!.path).toBe('semantic.fields[1].expression.kind');
  });

  it('undo works after load: a loaded core-radius edit undoes to the file’s value', () => {
    const document = load(serializeScene(vocabulary()));
    const host = new SimulationHost(cloneFrozen(document.semantic));
    const controller = new DocumentController(defaultDocument(), new SimulationHost(cloneFrozen(defaultDocument().semantic)));
    controller.load(document, host);
    const result = controller.editField('b-pull', 'Change core radius', (f) => ({ ...f, expression: { kind: 'softRadial', strength: -6.25, coreRadius: 0.5 } }));
    expect(result.ok).toBe(true);
    host.step();
    controller.sync();
    controller.undo();
    controller.settle();
    expect(controller.scene.fields.find((f) => f.id === 'b-pull')!.expression).toEqual({ kind: 'softRadial', strength: -6.25, coreRadius: 0.35 });
    expect(host.appliedFields().find((f) => f.id === 'b-pull')!.expression).toEqual({ kind: 'softRadial', strength: -6.25, coreRadius: 0.35 });
    host.dispose();
  });

  it('the accepted M2 demo file still loads and re-exports byte for byte', () => {
    const text = m2Demo;
    expect(serializeScene(load(text))).toBe(text);
  });
});
