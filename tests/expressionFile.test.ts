// T07 I–J and T06 for compound laws: strict validation with precise paths, the node, depth and leaf
// budgets on import and on live edits, versioned operator capabilities, and canonical round trips
// that keep sum order and exact values. Expected values come from SPEC §6.3, §9.3, §15.1 and §15.2.
import { describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen, validateField, validateScene, type FieldDefinition, type FieldExpression, type SceneDefinition } from '../src/domain/scene';
import { EXPRESSION_LIMITS, expressionStats, validateExpression } from '../src/fields/expression';
import { DEFAULT_SCENE_TEXT, defaultDocument } from '../src/persistence/defaultScene';
import { createDocument, parseScene, requiredCapabilities, semanticDigest, serializeScene } from '../src/persistence/sceneFile';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await initSimulation();
});

type Json = Record<string, any>;
const ALL = [
  'emitter.xorshift32.v1',
  'operator.gain.v1',
  'operator.mask.v1',
  'operator.sum.v1',
  'primitive.directional.v1',
  'primitive.linearDrag.v1',
  'primitive.softRadial.v1',
  'primitive.vortexY.v1',
  'region.box.v1',
  'region.cylinderY.v1',
  'region.sphere.v1',
];
const leaf = (strength = 12): Json => ({ kind: 'directional', direction: [1, 0, 0], strength });
const drag = (coefficient = 2): Json => ({ kind: 'linearDrag', coefficient });
const gain = (child: Json, g: Json = { kind: 'constant', value: 2 }): Json => ({ kind: 'gain', gain: g, child });
const triangle = (min = 0, max = 4, periodTicks = 8, phaseTicks = 0): Json => ({ kind: 'triangle', min, max, periodTicks, phaseTicks });
const mask = (child: Json, region: Json = { kind: 'sphere', radius: 1 }, extra: Json = {}): Json => ({ kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region, edgeFade: 0.25, child, ...extra });
const sum = (...terms: Json[]): Json => ({ kind: 'sum', terms });

/** The bundled scene with law 0's expression replaced and every capability declared. */
function scene(expression: Json, declared = ALL): Json {
  const value = JSON.parse(DEFAULT_SCENE_TEXT);
  value.semantic.fields[0].expression = structuredClone(expression);
  value.requiredCapabilities = declared;
  return value;
}
/** The bundled scene with several laws, each a copy of law 0 with its own id and expression. */
function laws(expressions: Json[]): Json {
  const value = JSON.parse(DEFAULT_SCENE_TEXT);
  const base = value.semantic.fields[0];
  value.semantic.fields = expressions.map((expression, i) => ({ ...base, id: `law-${String(i).padStart(2, '0')}`, expression: structuredClone(expression) }));
  value.presentation.laws = [];
  value.requiredCapabilities = ALL;
  return value;
}
const parse = (value: Json) => parseScene(JSON.stringify(value));
const rejected = (value: Json) => {
  const result = parse(value);
  if (result.ok) throw new Error('expected a rejection');
  return result.error;
};
const accepted = (value: Json) => {
  const result = parse(value);
  if (!result.ok) throw result.error;
  return result.document;
};
const nest = (depth: number): Json => (depth === 1 ? leaf() : gain(nest(depth - 1), { kind: 'constant', value: 1 }));

describe('T07 I: strict validation with precise paths (AC3)', () => {
  const cases: [string, Json, string, RegExp][] = [
    ['an empty sum', sum(), 'semantic.fields[0].expression.terms', /at least one term/],
    ['a sum whose terms are not an array', { kind: 'sum', terms: leaf() }, 'semantic.fields[0].expression.terms', /array/],
    ['a gain without a child', { kind: 'gain', gain: { kind: 'constant', value: 1 } }, 'semantic.fields[0].expression.child', /required/],
    ['a mask without a child', { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 1 }, edgeFade: 0 }, 'semantic.fields[0].expression.child', /required/],
    ['an extra key on an operator', { ...sum(leaf()), priority: 1 }, 'semantic.fields[0].expression.priority', /not a known property/],
    ['an extra key on a nested leaf', sum(leaf(), { ...drag(), label: 'x' }), 'semantic.fields[0].expression.terms[1].label', /not a known property/],
    ['an extra key on a gain', gain(leaf(), { kind: 'constant', value: 1, signed: true }), 'semantic.fields[0].expression.gain.signed', /not a known property/],
    ['an unknown expression kind', sum(leaf(), { kind: 'replaceGravity', child: leaf() }), 'semantic.fields[0].expression.terms[1].kind', /unknown kind "replaceGravity"/],
    ['an unknown gain kind', gain(leaf(), { kind: 'sine', value: 1 }), 'semantic.fields[0].expression.gain.kind', /must be one of/],
    ['a negative gain', gain(drag(), { kind: 'constant', value: -1 }), 'semantic.fields[0].expression.gain.value', /0–16/],
    ['a gain above 16', gain(leaf(), { kind: 'constant', value: 16.000001 }), 'semantic.fields[0].expression.gain.value', /0–16/],
    ['a triangle period of 0', gain(leaf(), triangle(0, 4, 0, 0)), 'semantic.fields[0].expression.gain.periodTicks', /at least 2/],
    ['a triangle period of 1', gain(leaf(), triangle(0, 4, 1, 0)), 'semantic.fields[0].expression.gain.periodTicks', /at least 2/],
    ['a fractional period', gain(leaf(), triangle(0, 4, 2.5, 0)), 'semantic.fields[0].expression.gain.periodTicks', /safe integer/],
    ['a phase equal to the period', gain(leaf(), triangle(0, 4, 8, 8)), 'semantic.fields[0].expression.gain.phaseTicks', /0 to periodTicks/],
    ['a negative phase', gain(leaf(), triangle(0, 4, 8, -1)), 'semantic.fields[0].expression.gain.phaseTicks', /0 to periodTicks/],
    ['a fractional phase', gain(leaf(), triangle(0, 4, 8, 0.5)), 'semantic.fields[0].expression.gain.phaseTicks', /safe integer/],
    ['min above max', gain(leaf(), triangle(3, 2, 8, 0)), 'semantic.fields[0].expression.gain.max', /at least its min/],
    ['a negative min', gain(drag(), triangle(-0.5, 2, 8, 0)), 'semantic.fields[0].expression.gain.min', /0–16/],
    ['a triangle max above 16', gain(leaf(), triangle(0, 17, 8, 0)), 'semantic.fields[0].expression.gain.max', /0–16/],
    ['a zero mask quaternion', mask(leaf(), undefined, { pose: { position: [0, 0, 0], rotation: [0, 0, 0, 0] } }), 'semantic.fields[0].expression.pose.rotation', /quaternion/],
    ['a mask position beyond ±1000 m', mask(leaf(), undefined, { pose: { position: [1000.5, 0, 0], rotation: [0, 0, 0, 1] } }), 'semantic.fields[0].expression.pose.position', /±1000/],
    ['a mask radius below 0.01 m', sum(drag(), mask(leaf(), { kind: 'sphere', radius: 0.001 })), 'semantic.fields[0].expression.terms[1].region.radius', /0\.01–100/],
    ['a nested mask cylinder too tall', mask(mask(leaf(), { kind: 'cylinderY', radius: 1, halfHeight: 101 })), 'semantic.fields[0].expression.child.region.halfHeight', /0\.01–100/],
    ['a mask fade above 1', mask(leaf(), undefined, { edgeFade: 1.5 }), 'semantic.fields[0].expression.edgeFade', /0–1/],
    ['an unknown mask region kind', mask(leaf(), { kind: 'sdf', radius: 1 }), 'semantic.fields[0].expression.region.kind', /unknown kind "sdf"/],
    ['a nested leaf out of range', sum(leaf(), drag(101)), 'semantic.fields[0].expression.terms[1].coefficient', /0–100/],
  ];
  for (const [name, expression, path, reason] of cases) {
    it(`rejects ${name} at ${path}`, () => {
      const error = rejected(scene(expression));
      expect(error.path).toBe(path);
      expect(error.reason).toMatch(reason);
    });
  }

  it('names the nested path SPEC §15.2 describes: fields[2].expression.terms[1].gain.phaseTicks', () => {
    const value = laws([leaf(), leaf(), sum(leaf(), gain(drag(), triangle(0, 4, 8, 9)))]);
    expect(rejected(value).path).toBe('semantic.fields[2].expression.terms[1].gain.phaseTicks');
    // The same scene validated in memory names the path relative to the semantic block.
    const memory = validateScene(JSON.parse(JSON.stringify(value)).semantic);
    expect(memory.ok === false && memory.path).toBe('fields[2].expression.terms[1].gain.phaseTicks');
  });

  it('names fields[0].expression.child.region.radius for a nested mask region', () => {
    const value = laws([gain(mask(leaf(), { kind: 'sphere', radius: 200 }))]);
    expect(rejected(value).path).toBe('semantic.fields[0].expression.child.region.radius');
  });

  it('accepts depth 8 and rejects depth 9 before reading the deeper node', () => {
    expect(expressionStats(accepted(scene(nest(EXPRESSION_LIMITS.depth))).semantic.fields[0]!.expression).depth).toBe(8);
    const error = rejected(scene(nest(EXPRESSION_LIMITS.depth + 1)));
    expect(error.path).toBe(`semantic.fields[0].expression${'.child'.repeat(8)}`);
    expect(error.reason).toMatch(/depth exceeds 8/);
  });

  it('accepts 64 nodes in a law and rejects 65, counting operators and leaves alike', () => {
    expect(expressionStats(accepted(scene(sum(...Array.from({ length: 63 }, () => drag())))).semantic.fields[0]!.expression).nodes).toBe(64);
    const error = rejected(scene(sum(...Array.from({ length: 64 }, () => drag()))));
    expect(error.path).toBe('semantic.fields[0].expression.terms[63]');
    expect(error.reason).toMatch(/at most 64 expression nodes/);
    // Wrappers count: 32 gains around 32 leaves, plus the sum, is 65 nodes.
    expect(rejected(scene(sum(...Array.from({ length: 32 }, () => gain(drag())))))!.reason).toMatch(/at most 64/);
  });

  it('a huge terms array is refused by its length, not traversed', () => {
    const error = rejected(scene({ kind: 'sum', terms: Array.from({ length: 100_000 }, () => drag()) }));
    expect(error.path).toBe('semantic.fields[0].expression.terms');
  });

  it('holds the 256-leaf budget across the scene: laws valid on their own cannot exceed it together', () => {
    const big = () => sum(...Array.from({ length: 63 }, () => drag(0.5)));
    // 4 × 63 + 4 = 256 leaves: accepted.
    expect(accepted(laws([big(), big(), big(), big(), sum(drag(), drag(), drag(), drag())])).semantic.fields).toHaveLength(5);
    // 4 × 63 + 5 = 257: the law that crosses the budget is named.
    const error = rejected(laws([big(), big(), big(), big(), sum(drag(), drag(), drag(), drag(), drag())]));
    expect(error.path).toBe('semantic.fields[4].expression');
    expect(error.reason).toMatch(/256 primitive leaves/);
  });

  it('a law still names an unknown operator capability, never silently dropping it', () => {
    const error = rejected(scene(sum(leaf()), [...ALL, 'operator.priority.v1']));
    expect(error.path).toBe('requiredCapabilities[11]');
  });
});

describe('T07 I: in-memory candidates (live edits)', () => {
  it('validates the same rules and paths without a file', () => {
    const bad = validateExpression(sum(leaf(), gain(drag(), { kind: 'constant', value: Number.NaN })));
    expect(bad).toMatchObject({ ok: false, path: 'terms[1].gain.value' });
    const infinite = validateExpression(gain(leaf(), triangle(0, Infinity)));
    expect(infinite).toMatchObject({ ok: false, path: 'gain.max' });
  });

  it('refuses a cyclic object by name instead of recursing', () => {
    const cycle: Json = { kind: 'sum', terms: [] };
    cycle.terms.push(leaf(), cycle);
    expect(validateExpression(cycle)).toMatchObject({ ok: false, path: 'terms[1]', reason: 'expression contains a cycle' });
    const self: Json = { kind: 'gain', gain: { kind: 'constant', value: 1 } };
    self.child = self;
    expect(validateExpression(self)).toMatchObject({ ok: false, path: 'child', reason: 'expression contains a cycle' });
  });

  it('a shared subtree is two nodes, counted twice', () => {
    const shared = sum(...Array.from({ length: 32 }, () => drag()));
    expect(validateExpression(sum(shared, shared))).toMatchObject({ ok: false, reason: /at most 64/ });
  });

  it('a live edit past the scene leaf budget is refused before the host sees it', async () => {
    const big = (n: number) => ({ kind: 'sum', terms: Array.from({ length: n }, () => drag(0.5)) }) as unknown as FieldExpression;
    const base = defaultDocument();
    const host = new SimulationHost(cloneFrozen(base.semantic));
    const controller = new DocumentController(base, host);
    const fields: FieldDefinition[] = [];
    for (let i = 0; i < 4; i++) {
      const put = controller.putField({ ...base.semantic.fields[0]!, id: `big-${i}`, expression: big(63) });
      expect(put.ok).toBe(true);
      if (put.ok) fields.push(put.value.field);
    }
    // 252 leaves submitted but not yet applied, plus the recipe's 1: a 4-leaf law would make 257.
    const over = controller.putField({ ...base.semantic.fields[0]!, id: 'one-more', expression: big(4) });
    expect(over).toMatchObject({ ok: false, path: 'expression' });
    const revision = controller.revision;
    expect(controller.putField({ ...base.semantic.fields[0]!, id: 'one-more', expression: big(3) }).ok).toBe(true);
    expect(controller.revision).toBe(revision + 1);
    controller.settle();
    expect(host.appliedFields().map((f) => f.id)).toEqual(['big-0', 'big-1', 'big-2', 'big-3', 'one-more', 'sideways']);
    // Growing one law past the budget is refused too; its applied value stays.
    const grow = controller.editField('one-more', 'Add ingredient', (f) => ({ ...f, expression: big(4) }));
    expect(grow.ok).toBe(false);
    controller.settle();
    expect(expressionStats(host.appliedFields().find((f) => f.id === 'one-more')!.expression).leaves).toBe(3);
    host.dispose();
  });

  /** The bundled recipe (one 1-leaf law) plus `count` laws of 63 drag leaves each, applied. */
  function budgetScene(count: number) {
    const base = defaultDocument();
    const host = new SimulationHost(cloneFrozen(base.semantic));
    const controller = new DocumentController(base, host);
    const law = (id: string, leaves: number): FieldDefinition => ({ ...base.semantic.fields[0]!, id, expression: { kind: 'sum', terms: Array.from({ length: leaves }, () => drag(0.5)) } as unknown as FieldExpression });
    for (let i = 0; i < count; i++) expect(controller.putField(law(`big-${i}`, 63)).ok).toBe(true);
    controller.settle();
    const leavesOf = (id: string) => expressionStats(host.appliedFields().find((f) => f.id === id)!.expression).leaves;
    return { host, controller, law, leavesOf };
  }

  it('a queued removal frees its leaves before the boundary', () => {
    const { host, controller, law } = budgetScene(4);
    // 253 leaves applied. The deletion of big-0 is queued; its 63 leaves are already free.
    expect(controller.remove('big-0').ok).toBe(true);
    expect(controller.putField(law('big-4', 63)).ok).toBe(true);
    expect(controller.putField(law('big-5', 4))).toMatchObject({ ok: false, path: 'expression' });
    controller.settle();
    expect(host.appliedFields().map((f) => f.id)).toEqual(['big-1', 'big-2', 'big-3', 'big-4', 'sideways']);
    host.dispose();
  });

  it('an undo past the leaf budget is refused, leaving the law and both histories as they were', () => {
    const { host, controller, law, leavesOf } = budgetScene(4);
    expect(controller.editField('big-0', 'Remove ingredients', (f) => ({ ...f, expression: law('x', 1).expression })).ok).toBe(true);
    // 191 leaves; an unrecorded law brings the scene back to 253, so undoing the shrink would make 315.
    expect(controller.putField(law('big-4', 62)).ok).toBe(true);
    const revision = controller.revision;
    expect(controller.undo()).toMatchObject({ ok: false, path: 'expression' });
    expect(controller.revision).toBe(revision);
    expect([controller.canUndo, controller.canRedo]).toEqual([true, false]);
    controller.settle();
    expect(leavesOf('big-0')).toBe(1);
    // With room again (192 leaves, 254 after), the same undo goes through.
    expect(controller.putField(law('big-4', 1)).ok).toBe(true);
    expect(controller.undo().ok).toBe(true);
    controller.settle();
    expect(leavesOf('big-0')).toBe(63);
    expect([controller.canUndo, controller.canRedo]).toEqual([false, true]);
    host.dispose();
  });

  it('a redo past the leaf budget is refused and stays available', () => {
    const { host, controller, law, leavesOf } = budgetScene(0);
    expect(controller.putField(law('grown', 1)).ok).toBe(true);
    controller.settle();
    expect(controller.editField('grown', 'Add ingredients', (f) => ({ ...f, expression: law('x', 63).expression })).ok).toBe(true);
    expect(controller.undo().ok).toBe(true);
    // 2 leaves; unrecorded laws bring the scene to 195, so redoing the growth would make 257.
    for (let i = 0; i < 3; i++) expect(controller.putField(law(`big-${i}`, 63)).ok).toBe(true);
    expect(controller.putField(law('big-3', 4)).ok).toBe(true);
    const revision = controller.revision;
    expect(controller.redo()).toMatchObject({ ok: false, path: 'expression' });
    expect(controller.revision).toBe(revision);
    expect([controller.canUndo, controller.canRedo]).toEqual([false, true]);
    controller.settle();
    expect(leavesOf('grown')).toBe(1);
    // One leaf fewer elsewhere makes exactly 256, which is allowed.
    expect(controller.putField(law('big-3', 3)).ok).toBe(true);
    expect(controller.redo().ok).toBe(true);
    controller.settle();
    expect(leavesOf('grown')).toBe(63);
    host.dispose();
  });

  it('creating or duplicating a law at the leaf budget is refused with nothing recorded', () => {
    const { host, controller, law } = budgetScene(4);
    expect(controller.putField(law('big-4', 3)).ok).toBe(true);
    controller.settle();
    // 256 leaves: a new law's one leaf does not fit.
    const revision = controller.revision;
    expect(controller.create('directional', [0, 0, 0])).toMatchObject({ ok: false, path: 'expression' });
    expect(controller.duplicate('sideways')).toMatchObject({ ok: false, path: 'expression' });
    expect(controller.revision).toBe(revision);
    expect(controller.canUndo).toBe(false);
    controller.settle();
    expect(host.appliedFields().map((f) => f.id)).toEqual(['big-0', 'big-1', 'big-2', 'big-3', 'big-4', 'sideways']);
    host.dispose();
  });
});

/** Every expression variant M5 writes. */
const VARIANTS: Record<string, Json> = {
  'a one-leaf law': leaf(),
  'a simple sum': sum(leaf(2), { kind: 'vortexY', strength: -3, coreRadius: 0.5 }),
  'a constant gain': gain(drag(3), { kind: 'constant', value: 0.75 }),
  'a triangle gain': gain(leaf(), triangle(0.25, 3.5, 240, 37)),
  'a box mask': mask(drag(), { kind: 'box', halfExtents: [1, 0.5, 2] }, { pose: { position: [0.5, -1, 0.25], rotation: [0, 0, 0.3826834323650898, 0.9238795325112867] } }),
  'a cylinder mask': mask(leaf(), { kind: 'cylinderY', radius: 0.75, halfHeight: 1.25 }, { edgeFade: 0 }),
  'nested masks': mask(mask(drag(), { kind: 'box', halfExtents: [1, 1, 1] }), { kind: 'sphere', radius: 1.5 }, { edgeFade: 0.5 }),
  'a storm bottle': sum(
    { kind: 'softRadial', strength: 10, coreRadius: 0.3 },
    gain({ kind: 'vortexY', strength: 14, coreRadius: 0.3 }, triangle(0, 2, 240, 0)),
    mask(drag(1.5), { kind: 'box', halfExtents: [2, 1, 2] }, { pose: { position: [0, -1, 0], rotation: [0, 0, 0, 1] } }),
  ),
};

describe('T07 J and T06: canonical round trips (AC6)', () => {
  for (const [name, expression] of Object.entries(VARIANTS)) {
    it(`serialize → parse → serialize is byte-identical for ${name}`, () => {
      const document = accepted(scene(expression));
      const text = serializeScene(document);
      const again = parseScene(text);
      if (!again.ok) throw again.error;
      expect(serializeScene(again.document)).toBe(text);
      expect(again.document.semantic).toEqual(document.semantic);
    });
  }

  it('several compound laws with every region shape round trip in one scene', () => {
    const value = laws(Object.values(VARIANTS));
    value.semantic.fields[1].region = { kind: 'sphere', radius: 3 };
    value.semantic.fields[2].region = { kind: 'cylinderY', radius: 2, halfHeight: 4 };
    const document = accepted(value);
    const text = serializeScene(document);
    const again = parseScene(text);
    expect(again.ok && serializeScene(again.document)).toBe(text);
  });

  it('keeps the stored term order and exact accepted values, without quantizing', () => {
    const terms = [leaf(0.1 + 0.2), drag(1 / 3), leaf(0.1)];
    const text = serializeScene(accepted(scene(sum(...terms))));
    const read = parseScene(text);
    if (!read.ok) throw read.error;
    const expression = read.document.semantic.fields[0]!.expression;
    expect(expression).toEqual({ kind: 'sum', terms: [leaf(0.30000000000000004), drag(0.3333333333333333), leaf(0.1)] });
    expect(text).toContain('"strength": 0.30000000000000004');
  });

  it('canonicalizes nested values: negative zero, mask quaternion sign and scale, leaf directions', () => {
    const document = accepted(
      scene(
        sum(
          mask({ kind: 'directional', direction: [3, 0, 4], strength: 12 }, { kind: 'sphere', radius: 1 }, { pose: { position: [-0, 0, -0], rotation: [0, 0, -2, -2] } }),
          gain(drag(-0), { kind: 'constant', value: -0 }),
          gain(drag(1), triangle(-0, 1, 4, -0)),
        ),
      ),
    );
    const expression = document.semantic.fields[0]!.expression as Json;
    const [masked, zeroGain, tri] = expression.terms;
    expect(masked.pose.position.map((c: number) => Object.is(c, 0))).toEqual([true, true, true]);
    // Scaled normalization (SPEC §15.1): [0,0,−2,−2]/2 = [0,0,−1,−1], over its length √2, then the
    // sign rule makes w positive: 1/√2 by division, 0.7071067811865475.
    expect(masked.pose.rotation).toEqual([0, 0, 1 / Math.SQRT2, 1 / Math.SQRT2]);
    expect(masked.child.direction).toEqual([0.6, 0, 0.8]);
    expect(Object.is(zeroGain.gain.value, 0)).toBe(true);
    expect(Object.is(zeroGain.child.coefficient, 0)).toBe(true);
    expect(Object.is(tri.gain.min, 0) && Object.is(tri.gain.phaseTicks, 0)).toBe(true);
    // Once canonical, idempotent.
    expect(validateExpression(expression)).toEqual({ ok: true, value: expression });
  });

  it('declares every capability the tree uses, recursively, sorted and once each', () => {
    const document = accepted(scene(sum(mask(gain(leaf()), { kind: 'cylinderY', radius: 1, halfHeight: 1 }), mask(drag(), { kind: 'cylinderY', radius: 1, halfHeight: 2 }))));
    expect(document.requiredCapabilities).toEqual([
      'emitter.xorshift32.v1',
      'operator.gain.v1',
      'operator.mask.v1',
      'operator.sum.v1',
      'primitive.directional.v1',
      'primitive.linearDrag.v1',
      'region.box.v1',
      'region.cylinderY.v1',
    ]);
    expect(JSON.parse(serializeScene(document)).requiredCapabilities).toEqual(document.requiredCapabilities);
  });

  it('rejects a file that uses a nested capability without declaring it', () => {
    const declared = ALL.filter((c) => c !== 'region.cylinderY.v1');
    const error = rejected(scene(sum(drag(), mask(leaf(), { kind: 'cylinderY', radius: 1, halfHeight: 1 })), declared));
    expect(error.path).toBe('requiredCapabilities');
    expect(error.reason).toContain('region.cylinderY.v1');
    // An operator, too.
    expect(rejected(scene(gain(leaf()), ALL.filter((c) => c !== 'operator.gain.v1'))).reason).toContain('operator.gain.v1');
  });

  it('a primitive-only scene declares no operator capability and is byte-identical to its M4 form', () => {
    expect(serializeScene(defaultDocument())).toBe(DEFAULT_SCENE_TEXT);
    expect(defaultDocument().requiredCapabilities.some((c) => c.startsWith('operator.'))).toBe(false);
  });
});

describe('T06: the semantic digest follows the expression, not its presentation', () => {
  const storm = () => accepted(scene(VARIANTS['a storm bottle']!));

  it('an identical scene keeps its digest through a round trip', async () => {
    const document = storm();
    const again = parseScene(serializeScene(document));
    if (!again.ok) throw again.error;
    expect(await semanticDigest(again.document)).toBe(await semanticDigest(document));
  });

  it('reordering terms, changing a triangle phase or moving a mask changes it', async () => {
    const digest = await semanticDigest(storm());
    const edits: ((e: Json) => void)[] = [
      (e) => e.terms.reverse(),
      (e) => (e.terms[1].gain.phaseTicks = 38),
      (e) => (e.terms[2].pose.position[1] = -0.9),
    ];
    for (const edit of edits) {
      const value = scene(VARIANTS['a storm bottle']!);
      edit(value.semantic.fields[0].expression);
      expect(await semanticDigest(accepted(value))).not.toBe(digest);
    }
  });

  it('a label, color, visibility or camera change does not', async () => {
    const document = storm();
    const digest = await semanticDigest(document);
    const relabeled = createDocument(document.semantic, document.metadata, {
      ...document.presentation,
      camera: { position: [5, 5, 5], target: [0, 0, 0] },
      laws: document.presentation.laws.map((l) => ({ ...l, label: 'Storm Bottle', color: '#c58ae5', visible: false })),
    });
    expect(await semanticDigest(relabeled)).toBe(digest);
  });

  it('the capability list in a document is recomputed from its laws, never trusted', () => {
    const document = storm();
    const semantic: SceneDefinition = document.semantic;
    expect(requiredCapabilities(semantic)).toEqual(document.requiredCapabilities);
  });
});

describe('T07: validated laws stay plain frozen data', () => {
  it('a validated compound law is frozen all the way down and serializes as JSON', () => {
    const result = validateField({ ...defaultDocument().semantic.fields[0]!, expression: VARIANTS['a storm bottle'] as unknown as FieldExpression });
    if (!result.ok) throw new Error(result.reason);
    const expression = result.value.expression as Json;
    expect(Object.isFrozen(expression) && Object.isFrozen(expression.terms) && Object.isFrozen(expression.terms[2].pose.position)).toBe(true);
    expect(JSON.parse(JSON.stringify(expression))).toEqual(expression);
  });
});
