// T06 (persistence), format half: the SPEC §15 schema, canonical serialization and idempotence,
// SPEC §15.1 quaternion canonicalization, transactional rejection with precise paths, the semantic
// digest's presentation independence, and equal-tick behavior of a reloaded scene. Expected values
// come from SPEC rules (sign rule, unit retention, limits), not from captured serializer output.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, canonicalQuat, checkCamera, cloneFrozen, type Quat, type SceneDocument } from '../src/domain/scene';
import { DEFAULT_SCENE_TEXT, defaultDocument } from '../src/persistence/defaultScene';
import { createDocument, parseScene, semanticDigest, serializeScene } from '../src/persistence/sceneFile';
import { FIXTURE_TICKS, compareRuns, runFixedSteps, scriptedRecipeEdits } from '../src/simulation/fixtures';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

type Json = Record<string, any>;
const json = (): Json => JSON.parse(DEFAULT_SCENE_TEXT);
const parse = (value: Json | string) => parseScene(typeof value === 'string' ? value : JSON.stringify(value));
const loaded = (value: Json | string): SceneDocument => {
  const result = parse(value);
  if (!result.ok) throw result.error;
  return result.document;
};
const rejection = (value: Json | string) => {
  const result = parse(value);
  expect(result.ok).toBe(false);
  return result.ok ? null : result.error;
};

/** Reorders every object's keys, so a test can prove the output does not depend on input order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  return value;
}

describe('T06 bundled default scene', () => {
  it('is the starting recipe, read through ordinary validation', () => {
    const document = defaultDocument();
    expect(document.semantic).toEqual(STARTING_RECIPE);
    expect(document.requiredCapabilities).toEqual(['emitter.xorshift32.v1', 'primitive.directional.v1', 'region.box.v1']);
    expect(document.presentation.laws).toEqual([{ id: 'sideways', label: 'Sideways', color: '#55aaa4', visible: true }]);
  });

  it('is already canonical: re-export reproduces the bundled bytes', () => {
    expect(serializeScene(defaultDocument())).toBe(DEFAULT_SCENE_TEXT);
  });
});

describe('T06 canonical serialization', () => {
  it('save → load → save is byte-identical for an edited scene', () => {
    const base = defaultDocument();
    const field = base.semantic.fields[0]!;
    const edited = createDocument(
      {
        ...base.semantic,
        fields: [
          { ...field, pose: { position: [0.1 + 0.2, 1 / 3, -0.7071067811865476], rotation: [0.1, -0.2, 0.3, -0.9] } },
          { ...field, id: 'second', enabled: false, region: { kind: 'box', halfExtents: [0.01, 99.99, Math.PI] } },
        ],
      },
      base.metadata,
      base.presentation,
    );
    const first = serializeScene(loaded(serializeScene(edited)));
    const second = serializeScene(loaded(first));
    const third = serializeScene(loaded(second));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not depend on the input key order', () => {
    expect(serializeScene(loaded(reversedKeys(json()) as Json))).toBe(DEFAULT_SCENE_TEXT);
  });

  it('sorts entity arrays and capabilities, and keeps full precision', () => {
    const value = json();
    const field = value.semantic.fields[0];
    value.semantic.fields = [{ ...field, id: 'zeta' }, { ...field, id: 'alpha', pose: { ...field.pose, position: [0.30000000000000004, 1, 0] } }];
    value.presentation.laws = [];
    value.requiredCapabilities = ['region.box.v1', 'primitive.directional.v1', 'emitter.xorshift32.v1'];
    const document = loaded(value);
    expect(document.semantic.fields.map((f) => f.id)).toEqual(['alpha', 'zeta']);
    const text = serializeScene(document);
    expect(text).toContain('"position": [0.30000000000000004, 1, 0]');
    expect(text.indexOf('"id": "alpha"')).toBeLessThan(text.indexOf('"id": "zeta"'));
    expect(text).toContain('"requiredCapabilities": ["emitter.xorshift32.v1", "primitive.directional.v1", "region.box.v1"]');
  });

  it('writes negative zero as 0 and loads it as positive zero', () => {
    const value = json();
    value.semantic.fields[0].pose.position = [-0, 1, -0];
    const text = JSON.stringify(value).replace('"position":[0,1,0]', '"position":[-0,1,-0.0]');
    expect(text).toContain('-0.0');
    const document = loaded(text);
    expect(Object.is(document.semantic.fields[0]!.pose.position[0], 0)).toBe(true);
    expect(Object.is(document.semantic.fields[0]!.pose.position[2], 0)).toBe(true);
    const text2 = serializeScene(document);
    expect(text2).toContain('"position": [0, 1, 0]');
    expect(text2).not.toMatch(/-0(?![.\d])/);
  });

  it('round trip preserves semantic values, IDs, ordering, seed, profile, law pose/support and initial conditions', () => {
    const original = defaultDocument();
    const reloaded = loaded(serializeScene(original));
    expect(reloaded.semantic).toEqual(original.semantic);
    expect(reloaded.semantic.seed).toBe(0x4c415731);
    expect(reloaded.semantic.emitters[0]!.seed).toBe(0x4c415731);
    expect(reloaded.semantic.simulation.profile).toBe('lawsmith-m1-rapier-0.21.0');
  });
});

describe('T06 canonical quaternions (SPEC §15.1)', () => {
  const rotationOf = (rotation: readonly number[]) => {
    const value = json();
    value.semantic.fields[0].pose.rotation = rotation;
    return loaded(value).semantic.fields[0]!.pose.rotation;
  };

  it('keeps an already canonical unit quaternion bit for bit', () => {
    const q: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    expect(rotationOf(q)).toEqual(q);
  });

  it('gives the opposite-sign equivalent the canonical sign (first nonzero of w, x, y, z positive)', () => {
    expect(rotationOf([0, 0, -Math.SQRT1_2, -Math.SQRT1_2])).toEqual([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(rotationOf([-0.5, -0.5, -0.5, -0.5])).toEqual([0.5, 0.5, 0.5, 0.5]);
    // w = 0: the sign comes from x, then y.
    expect(rotationOf([-1, 0, 0, 0])).toEqual([1, 0, 0, 0]);
    expect(rotationOf([0, -1, 0, 0])).toEqual([0, 1, 0, 0]);
    expect(rotationOf([0, 0, 0, -1])).toEqual([0, 0, 0, 1]);
  });

  it('normalizes a valid nonunit quaternion once', () => {
    expect(rotationOf([0, 0, 0, 2])).toEqual([0, 0, 0, 1]);
    const q = rotationOf([1, 2, 3, 4]);
    expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThanOrEqual(1e-15);
    expect(q[3]).toBeGreaterThan(0);
  });

  it('normalizes a tiny nonzero quaternion without underflow', () => {
    expect(rotationOf([0, 0, 1e-300, 0])).toEqual([0, 0, 1, 0]);
    expect(rotationOf([5e-324, 0, 0, 0])).toEqual([1, 0, 0, 0]);
  });

  it('retains a nearly unit quaternion within 1e-12 instead of renormalizing it', () => {
    const q: Quat = [0, 0, 0, 1 + 4e-13];
    expect(rotationOf(q)).toEqual(q);
    expect(canonicalQuat([0, 0, 0, 1 + 4e-12])).toEqual([0, 0, 0, 1]);
  });

  it('is idempotent: repeated save/load never drifts', () => {
    const value = json();
    value.semantic.fields[0].pose.rotation = [0.123456789, -0.987654321, 0.5, -0.25];
    let text = serializeScene(loaded(value));
    const first = text;
    for (let i = 0; i < 10; i++) text = serializeScene(loaded(text));
    expect(text).toBe(first);
    expect(canonicalQuat(loaded(first).semantic.fields[0]!.pose.rotation)).toEqual(loaded(first).semantic.fields[0]!.pose.rotation);
  });

  it('accepts a near-unit identity emitter rotation and stores the exact identity', () => {
    const value = json();
    value.semantic.emitters[0].pose.rotation = [0, 0, 0, 1 + 4e-13];
    const document = loaded(value);
    expect(document.semantic.emitters[0]!.pose.rotation).toEqual([0, 0, 0, 1]);
    expect(serializeScene(loaded(serializeScene(document)))).toBe(serializeScene(document));
    // Scaled or sign-flipped identities resolve the same way; any vector part is still a rotation.
    value.semantic.emitters[0].pose.rotation = [0, 0, 0, -2];
    expect(loaded(value).semantic.emitters[0]!.pose.rotation).toEqual([0, 0, 0, 1]);
    value.semantic.emitters[0].pose.rotation = [1e-9, 0, 0, 1];
    expect(rejection(value)!.path).toBe('semantic.emitters[0].pose.rotation');
  });

  it('rejects a zero quaternion', () => {
    const value = json();
    value.semantic.fields[0].pose.rotation = [0, 0, 0, 0];
    expect(rejection(value)!.path).toBe('semantic.fields[0].pose.rotation');
  });
});

describe('T06 transactional rejection (AC6)', () => {
  const cases: [string, (v: Json) => void, string][] = [
    ['an out-of-range dimension', (v) => (v.semantic.fields[0].region.halfExtents = [0, 2, 1.5]), 'semantic.fields[0].region.halfExtents'],
    ['a float-overflowing finite dimension', (v) => (v.semantic.fields[0].region.halfExtents = [1e308, 2, 1.5]), 'semantic.fields[0].region.halfExtents'],
    ['out-of-range motion', (v) => (v.semantic.emitters[0].template.initialLinearVelocity = [0, -300, 0]), 'semantic.emitters[0].template.initialLinearVelocity'],
    ['a negative acceleration limit', (v) => (v.semantic.simulation.maxAppliedAcceleration = -1), 'semantic.simulation.maxAppliedAcceleration'],
    ['an out-of-range setting', (v) => (v.semantic.simulation.maxLiveBodies = 513), 'semantic.simulation.maxLiveBodies'],
    ['a changed step', (v) => (v.semantic.simulation.stepDenominator = 60), 'semantic.simulation.stepDenominator'],
    ['a zero seed', (v) => (v.semantic.emitters[0].seed = 0), 'semantic.emitters[0].seed'],
    ['a zero direction', (v) => (v.semantic.fields[0].expression.direction = [0, 0, 0]), 'semantic.fields[0].expression.direction'],
    ['duplicate law IDs', (v) => v.semantic.fields.push({ ...v.semantic.fields[0] }), 'semantic.fields[1].id'],
    ['an ID shared across entity kinds', (v) => (v.semantic.fields[0].id = 'floor'), 'semantic.fields[0].id'],
    ['an ID with a reserved separator', (v) => (v.semantic.fields[0].id = 'stream:3'), 'semantic.fields[0].id'],
    ['an ID longer than 64 characters', (v) => (v.semantic.fields[0].id = 'x'.repeat(65)), 'semantic.fields[0].id'],
    ['a short vector', (v) => (v.semantic.fields[0].pose.position = [3, 1]), 'semantic.fields[0].pose.position'],
    ['a non-numeric component', (v) => (v.semantic.fields[0].pose.rotation = [0, 0, '0', 1]), 'semantic.fields[0].pose.rotation[2]'],
    ['a non-array entity list', (v) => (v.semantic.bodies = { floor: v.semantic.bodies[0] }), 'semantic.bodies'],
    ['too many laws', (v) => (v.semantic.fields = Array.from({ length: 33 }, (_, i) => ({ ...v.semantic.fields[0], id: `law${i}` }))), 'semantic.fields'],
    ['an unknown semantic property', (v) => (v.semantic.fields[0].priority = 1), 'semantic.fields[0].priority'],
    ['a missing semantic property', (v) => delete v.semantic.fields[0].edgeFade, 'semantic.fields[0].edgeFade'],
    ['a wrong unit system', (v) => (v.semantic.units = 'cm-g-s'), 'semantic.units'],
    ['an unavailable profile', (v) => (v.semantic.simulation.profile = 'lawsmith-m9-rapier-0.30.0'), 'semantic.simulation.profile'],
    ['a fixed body with velocity', (v) => (v.semantic.bodies[0].initialLinearVelocity = [0, 1, 0]), 'semantic.bodies[0].initialLinearVelocity'],
    ['an emitter rotation this build does not define', (v) => (v.semantic.emitters[0].pose.rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2]), 'semantic.emitters[0].pose.rotation'],
    ['spawn positions beyond ±1000 m', (v) => (v.semantic.emitters[0].pose.position = [999.9, 6, 0]), 'semantic.emitters[0].jitter'],
    ['an emitter schedule past the safe-integer range', (v) => Object.assign(v.semantic.emitters[0], { startTick: 0, intervalTicks: 8, lifetimeTicks: Number.MAX_SAFE_INTEGER, emissionCount: 2 }), 'semantic.emitters[0].emissionCount'],
    ['a dynamic box body', (v) => v.semantic.bodies.push({ ...v.semantic.bodies[0], id: 'crate', type: 'dynamic', massKg: 1 }), 'semantic.bodies[1].collider.kind'],
    ['a presentation entry for no law', (v) => (v.presentation.laws[0].id = 'ghost'), 'presentation.laws[0].id'],
    ['an empty label', (v) => (v.presentation.laws[0].label = ''), 'presentation.laws[0]'],
    ['a color outside the palette syntax', (v) => (v.presentation.laws[0].color = 'red'), 'presentation.laws[0]'],
    ['a description over 8192 characters', (v) => (v.metadata.description = 'x'.repeat(8193)), 'metadata.description'],
    ['a newer schema', (v) => (v.schemaVersion = 2), 'schemaVersion'],
    ['another format', (v) => (v.format = 'lawsmith.run'), 'format'],
  ];

  it.each(cases)('rejects %s at its path', (_, mutate, path) => {
    const value = json();
    mutate(value);
    expect(rejection(value)!.path).toBe(path);
  });

  it('accepts a finite emitter schedule whose last death tick is exactly the safe-integer limit', () => {
    const value = json();
    Object.assign(value.semantic.emitters[0], { startTick: 0, intervalTicks: 8, lifetimeTicks: Number.MAX_SAFE_INTEGER - 8, emissionCount: 2 });
    expect(parse(value).ok).toBe(true);
    value.semantic.emitters[0].lifetimeTicks += 1;
    expect(rejection(value)!.path).toBe('semantic.emitters[0].emissionCount');
  });

  it('rejects an unknown required capability before reading the scene', () => {
    const value = json();
    value.requiredCapabilities.push('primitive.vortexY.v2');
    value.semantic = 'not even read';
    const error = rejection(value)!;
    expect(error.path).toBe('requiredCapabilities[3]');
    expect(error.reason).toContain('primitive.vortexY.v2');
  });

  it('rejects an operator this build lacks and names it, never dropping the law', () => {
    const value = json();
    // A deferred operator (SPEC §6.3): unknown here, so the law is refused, not evaluated without it.
    value.semantic.fields[0].expression = { kind: 'clamp', max: 4, child: { kind: 'directional', direction: [1, 0, 0], strength: 12 } };
    const error = rejection(value)!;
    expect(error.path).toBe('semantic.fields[0].expression.kind');
    expect(error.reason).toContain('"clamp"');
  });

  it('rejects an operator capability this build lacks before reading the scene', () => {
    const value = json();
    value.requiredCapabilities.push('operator.clamp.v1');
    const error = rejection(value)!;
    expect(error.path).toBe('requiredCapabilities[3]');
    expect(error.reason).toContain('operator.clamp.v1');
  });

  it('rejects a scene that uses a capability it does not declare', () => {
    const value = json();
    value.requiredCapabilities = ['region.box.v1', 'primitive.directional.v1'];
    expect(rejection(value)!.path).toBe('requiredCapabilities');
  });

  it('rejects nonfinite numbers written as overflowing literals', () => {
    const text = DEFAULT_SCENE_TEXT.replace('"strength": 12', '"strength": 1e400');
    expect(rejection(text)!.path).toBe('semantic.fields[0].expression.strength');
  });

  it('rejects an oversized file before parsing it', () => {
    const text = DEFAULT_SCENE_TEXT + ' '.repeat(5 * 1024 * 1024);
    expect(rejection(text)!.reason).toContain('larger than 5242880 bytes');
  });

  it('rejects text that is not JSON, and JSON that is not an object', () => {
    expect(rejection('{"format": "lawsmith.scene",')!.reason).toContain('not valid JSON');
    expect(rejection('[1, 2, 3]')!.reason).toContain('not a Lawsmith scene');
  });

  it('never takes prototype-shaped keys as data', () => {
    const value = json();
    const text = JSON.stringify(value).replace('"enabled":true', '"enabled":true,"__proto__":{"enabled":false}');
    expect(rejection(text)!.path).toBe('semantic.fields[0].__proto__');
    expect(({} as Json).enabled).toBeUndefined();
  });
});

describe('T06 camera framing', () => {
  it('the reader and the save-time capture share one check, so a saved camera reopens', () => {
    const value = json();
    value.presentation.camera = { position: [0, 0, 12000], target: [0, 0, 0] };
    expect(rejection(value)!.path).toBe('presentation.camera');
    expect(checkCamera({ position: [0, 0, 12000], target: [0, 0, 0] })).not.toBeNull();
    expect(checkCamera({ position: [9, 7, 11], target: [0, 1, 0] })).toBeNull();
    expect(checkCamera({ position: [1, 1, 1], target: [1, 1, 1] })).not.toBeNull();
  });
});

describe('T06 semantic digest (AC4)', () => {
  const digestOf = (mutate: (v: Json) => void) => {
    const value = json();
    mutate(value);
    return semanticDigest(loaded(value));
  };

  it('ignores camera, color, label, visibility and arrows', async () => {
    const base = await digestOf(() => {});
    expect(await digestOf((v) => (v.presentation.camera = { position: [-4, 2, 8], target: [1, 0, 0] }))).toBe(base);
    expect(await digestOf((v) => delete v.presentation.camera)).toBe(base);
    expect(await digestOf((v) => (v.presentation.laws[0].color = '#c58ae5'))).toBe(base);
    expect(await digestOf((v) => (v.presentation.laws[0].label = 'Push'))).toBe(base);
    expect(await digestOf((v) => (v.presentation.laws[0].visible = false))).toBe(base);
    expect(await digestOf((v) => (v.presentation.arrows = false))).toBe(base);
    expect(await digestOf((v) => (v.metadata.title = 'Renamed'))).toBe(base);
  });

  it('changes when a law is disabled or its strength changes', async () => {
    const base = await digestOf(() => {});
    expect(await digestOf((v) => (v.semantic.fields[0].enabled = false))).not.toBe(base);
    expect(await digestOf((v) => (v.semantic.fields[0].expression.strength = 11))).not.toBe(base);
  });
});

describe('T06 equal-tick behavior after reload (AC1, AC2)', () => {
  it('a reloaded scene reaches the same state as the original at ticks 600 and 1200', () => {
    const base = defaultDocument();
    const field = base.semantic.fields[0]!;
    const original = createDocument({ ...base.semantic, fields: [{ ...field, pose: { position: [0.35, 1.2, 0.1], rotation: [0, 0, 0.19509032201612825, 0.9807852804032304] } }] }, base.metadata);
    const reloaded = loaded(serializeScene(original));
    const a = new SimulationHost(cloneFrozen(original.semantic));
    const b = new SimulationHost(reloaded.semantic);
    const comparison = compareRuns(runFixedSteps(a), runFixedSteps(b));
    a.dispose();
    b.dispose();
    expect(comparison.map((c) => c.tick)).toEqual([...FIXTURE_TICKS]);
    for (const c of comparison) {
      expect(c.divergence).toBeNull();
      expect(c.engineBytesEqual).toBe(true);
    }
  });

  it('the same holds with tick-addressed edits applied after load', () => {
    const reloaded = loaded(serializeScene(defaultDocument()));
    const script = scriptedRecipeEdits(reloaded.semantic.fields[0]);
    const a = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    const b = new SimulationHost(reloaded.semantic);
    const comparison = compareRuns(runFixedSteps(a, script), runFixedSteps(b, script));
    a.dispose();
    b.dispose();
    expect(comparison.every((c) => c.equal)).toBe(true);
  });
});
