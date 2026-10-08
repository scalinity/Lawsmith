// M5 ingredient editing (AC5, AC6, AC7): the ingredient list is a view of the expression tree, and every
// edit (add, remove, wrap in a gain or mask, retune) is one validated law put through the document
// controller, one undo entry, restored exactly by undo. Removing an ingredient, a zero constant gain
// and disabling the law each eliminate the contribution; there is no ingredient-enabled flag. The
// authored term order is the evaluation order; the Laws list's order and labels are presentation.
import { beforeAll, describe, expect, it } from 'vitest';
import stormBottle from '../examples/storm-bottle.lawsmith.json?raw';
import { DocumentController } from '../src/domain/document';
import { DEFAULT_TRIANGLE, addIngredient, expressionSummary, ingredientLabels, ingredientsOf, isCompound, keptView, parentLevel, peel, removeIngredient, replaced, unwrapModifier, wrapIngredient } from '../src/domain/ingredients';
import { cloneFrozen, type FieldDefinition, type FieldExpression, type MaskExpression, type SceneDocument } from '../src/domain/scene';
import { nodeAt, replaceAt, validateExpression } from '../src/fields/expression';
import { compileField, sampleField } from '../src/fields/kernel';
import { regionDescriptor } from '../src/fields/registry';
import { lawHandles } from '../src/interaction/handles';
import { createDocument, parseScene, semanticDigest, serializeScene } from '../src/persistence/sceneFile';
import { compareRuns, runFixedSteps } from '../src/simulation/fixtures';
import { controlFor } from '../src/ui/ingredientPanel';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

function load(text: string): SceneDocument {
  const result = parseScene(text);
  if (!result.ok) throw result.error;
  return result.document;
}
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
};

const pull: FieldExpression = { kind: 'softRadial', strength: 14, coreRadius: 0.35 };
const swirl: FieldExpression = { kind: 'vortexY', strength: 12, coreRadius: 0.35 };
const drag: FieldExpression = { kind: 'linearDrag', coefficient: 5 };

describe('the ingredient view of an expression', () => {
  it('a one-leaf law is one ingredient with no modifiers; a sum is its terms in stored order', () => {
    expect(ingredientsOf(pull)).toEqual([{ path: [], modifiers: [], core: { path: [], node: pull } }]);
    const storm = load(stormBottle).semantic.fields[0]!.expression;
    const list = ingredientsOf(storm);
    expect(list.map((i) => i.path)).toEqual([[0], [1], [2]]);
    expect(list[2]!.modifiers.map((m) => [m.path, m.node.kind])).toEqual([[[2], 'mask']]);
    expect(list[2]!.core.path).toEqual([2, 'child']);
    expect(ingredientLabels(list)).toEqual(['Pull', 'Swirl', 'Drag']);
    expect(expressionSummary(storm)).toBe('pull + swirl + drag');
    expect(expressionSummary(pull)).toBe('soft radial, 14 m/s²');
  });

  it('peels nested gains and masks outermost first; a nested sum is a group with its own ingredients', () => {
    const tree: FieldExpression = { kind: 'gain', gain: { kind: 'constant', value: 2 }, child: { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 1 }, edgeFade: 0, child: { kind: 'sum', terms: [pull, pull] } } };
    const [only] = ingredientsOf(tree);
    expect(only!.modifiers.map((m) => m.node.kind)).toEqual(['gain', 'mask']);
    expect(only!.core.node.kind).toBe('sum');
    expect(ingredientLabels([only!])).toEqual(['Group']);
    expect(ingredientLabels(ingredientsOf(tree, ['child', 'child']))).toEqual(['Pull', 'Pull 2']);
  });

  it('opens a group past its gains and masks, and goes back up to the level holding it', () => {
    const masked = (child: FieldExpression): FieldExpression => ({ kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 1 }, edgeFade: 0, child });
    const gained = (child: FieldExpression): FieldExpression => ({ kind: 'gain', gain: { kind: 'constant', value: 2 }, child });
    // Root sum: [pull, gain(mask(sum(swirl, sum(drag, pull))))].
    const inner: FieldExpression = { kind: 'sum', terms: [drag, pull] };
    const tree: FieldExpression = { kind: 'sum', terms: [pull, gained(masked({ kind: 'sum', terms: [swirl, inner] }))] };
    // Opening term 1's group lands on its sum, beneath the gain and the mask.
    expect(peel(tree, [1]).core.path).toEqual([1, 'child', 'child']);
    expect(peel(tree, [1, 'child', 'child', 1]).core.path).toEqual([1, 'child', 'child', 1]);
    // Up from the nested group is term 1's group; up from that is the law's own list.
    expect(parentLevel([1, 'child', 'child', 1])).toEqual([1, 'child', 'child']);
    expect(parentLevel([1, 'child', 'child'])).toBeNull();
    expect(parentLevel([0])).toBeNull();
    // A root gain over a sum: its one ingredient's group is at ['child'], and a group inside it goes back there.
    const rooted = gained({ kind: 'sum', terms: [pull, inner] });
    expect(peel(rooted, []).core.path).toEqual(['child']);
    expect(parentLevel(['child'])).toBeNull();
    expect(parentLevel(['child', 1])).toEqual(['child']);
  });

  it('keeps the open group and focus only while they still name a group and one of its ingredients', () => {
    const tree: FieldExpression = { kind: 'sum', terms: [pull, { kind: 'sum', terms: [swirl, drag] }] };
    expect(keptView(tree, [1], [1, 1])).toMatchObject({ level: [1], focus: [1, 1] });
    expect(keptView(tree, [1], [1, 1]).ingredients.map((i) => i.path)).toEqual([[1, 0], [1, 1]]);
    // The focused term was removed: the group stays open, the focus goes.
    const fewer: FieldExpression = { kind: 'sum', terms: [pull, { kind: 'sum', terms: [swirl] }] };
    expect(keptView(fewer, [1], [1, 1])).toMatchObject({ level: [1], focus: null });
    // The group is no longer a sum: back to the law's list, with no focus.
    const flat: FieldExpression = { kind: 'sum', terms: [pull, swirl] };
    expect(keptView(flat, [1], [1, 1])).toMatchObject({ level: null, focus: null });
    // A focus at the law's level survives; a one-leaf law has no list, so no focus.
    expect(keptView(flat, null, [0]).focus).toEqual([0]);
    expect(keptView(pull, null, [])).toEqual({ level: null, focus: null, ingredients: [] });
  });

  it('adds an ingredient as the last term; a one-leaf law becomes a sum with its leaf first', () => {
    const one = ok(addIngredient(pull, null, 'vortexY'));
    expect(one.expression).toEqual({ kind: 'sum', terms: [pull, { kind: 'vortexY', strength: 8, coreRadius: 0.25 }] });
    expect(one.path).toEqual([1]);
    const two = ok(addIngredient(one.expression, null, 'linearDrag'));
    expect((two.expression as unknown as { terms: FieldExpression[] }).terms.map((t) => t.kind)).toEqual(['softRadial', 'vortexY', 'linearDrag']);
    expect(two.path).toEqual([2]);
  });

  it('removes one term; a law keeps its last ingredient', () => {
    const storm = load(stormBottle).semantic.fields[0]!.expression;
    const withoutSwirl = ok(removeIngredient(storm, [1]));
    expect(ingredientLabels(ingredientsOf(withoutSwirl.expression))).toEqual(['Pull', 'Drag']);
    expect(removeIngredient(pull, []).ok).toBe(false);
    expect(removeIngredient({ kind: 'sum', terms: [pull] }, [0]).ok).toBe(false);
  });

  it('an edit at a path that has left the tree is refused, never thrown', () => {
    const tree: FieldExpression = { kind: 'sum', terms: [pull, swirl] };
    expect(replaceAt(tree, [1], drag)).toEqual({ kind: 'sum', terms: [pull, drag] });
    for (const path of [[2], [-1], [0, 'child'], [1, 0]] as const) expect(replaceAt(tree, path, drag)).toBeUndefined();
    expect(replaceAt(pull, ['child'], drag)).toBeUndefined();
    expect(replaced(tree, [2], drag)).toEqual({ ok: false, reason: 'that part of the law no longer exists' });
    expect(replaced(tree, [0], drag, [7])).toEqual({ ok: true, expression: { kind: 'sum', terms: [drag, swirl] }, path: [7] });
  });

  it('a sum left with one term becomes that term: a one-leaf law again, or a group of one its ingredient', () => {
    const back = ok(removeIngredient({ kind: 'sum', terms: [pull, swirl] }, [1]));
    expect(back).toEqual({ ok: true, expression: pull, path: [] });
    expect(isCompound(back.expression)).toBe(false);
    const nested: FieldExpression = { kind: 'sum', terms: [drag, { kind: 'gain', gain: { kind: 'constant', value: 2 }, child: { kind: 'sum', terms: [pull, swirl] } }] };
    const ungrouped = ok(removeIngredient(nested, [1, 'child', 0]));
    expect(ungrouped.expression).toEqual({ kind: 'sum', terms: [drag, { kind: 'gain', gain: { kind: 'constant', value: 2 }, child: swirl }] });
    expect(ungrouped.path).toEqual([1, 'child']);
    // The one term adds what the one-term sum added, bit for bit, at every sampled point.
    const one: FieldExpression = { kind: 'sum', terms: [swirl] };
    const law = (expression: FieldExpression): FieldDefinition => ({ id: 'x', enabled: true, pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 3 }, edgeFade: 0.25, expression });
    const sample = (expression: FieldExpression, x: number) => {
      const out = [0, 0, 0, 0];
      const weight = sampleField(compileField(law(expression)), x, 0.5, 0.7, 7, out);
      return [weight, ...out];
    };
    for (const x of [-1.2, -0.3, 0, 0.4, 2.1]) expect(sample(one, x)).toEqual(sample(swirl, x));
  });

  it('wraps an ingredient in a gain or a mask and unwraps it again, leaving the tree as it was', () => {
    const storm = load(stormBottle).semantic.fields[0]!;
    const gained = ok(wrapIngredient(storm.expression, [1], 'gain', storm.region));
    expect(nodeAt(gained.expression, [1])).toEqual({ kind: 'gain', gain: { kind: 'constant', value: 1 }, child: swirl });
    const masked = ok(wrapIngredient(gained.expression, [1], 'mask', storm.region));
    expect(ingredientsOf(masked.expression)[1]!.modifiers.map((m) => m.node.kind)).toEqual(['mask', 'gain']);
    expect(ok(unwrapModifier(ok(unwrapModifier(masked.expression, [1])).expression, [1])).expression).toEqual(storm.expression);
  });
});

/** A document of the Storm Bottle with its bottle in the stream; its host is reset to the authored scene. */
function stormDocument() {
  const document = load(stormBottle);
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  controller.editField('storm-bottle', 'Move law', (f) => ({ ...f, pose: { ...f.pose, position: [0, 1.6, 0] } }));
  controller.settle();
  return { controller, host, base: controller.lawState('storm-bottle')!.field };
}

/** The applied bottle's (A, K) at a point in its lower half, inside the drag mask, at tick n. */
function sampleBottle(host: SimulationHost, n = host.tick): number[] {
  const out = [0, 0, 0, 0];
  sampleField(host.compiledField('storm-bottle')!, 0.6, 1.0, 0.3, n, out);
  return out;
}

describe('AC7: three ways to take a contribution out, each undone exactly', () => {
  it('removing an ingredient eliminates its contribution; undo restores the prior expression', () => {
    const { controller, host, base } = stormDocument();
    const before = sampleBottle(host);
    expect(before[3]).toBeGreaterThan(0);
    const edit = controller.editField('storm-bottle', 'Remove ingredient', (f) => ({ ...f, expression: ok(removeIngredient(f.expression, [2])).expression }));
    expect(edit.ok).toBe(true);
    controller.settle();
    expect(sampleBottle(host)[3]).toBe(0);
    const tick = host.tick;
    expect(controller.undo().ok).toBe(true);
    controller.settle();
    expect(host.appliedFields()[0]).toEqual(base);
    expect(sampleBottle(host)).toEqual(before);
    expect(host.tick).toBe(tick); // undo restores the law, never the clock
    expect(controller.redo().ok).toBe(true);
    controller.settle();
    expect(ingredientsOf(host.appliedFields()[0]!.expression)).toHaveLength(2);
    host.dispose();
  });

  it('a zero constant gain eliminates its contribution and nothing else; undo restores it', () => {
    const { controller, host, base } = stormDocument();
    const before = sampleBottle(host);
    controller.editField('storm-bottle', 'Add gain', (f) => ({ ...f, expression: ok(wrapIngredient(f.expression, [2], 'gain', f.region)).expression }));
    controller.settle();
    expect(sampleBottle(host)).toEqual(before); // a gain of 1 changes nothing
    controller.editField('storm-bottle', 'Change gain', (f) => {
      const g = nodeAt(f.expression, [2]) as Extract<FieldExpression, { kind: 'gain' }>;
      return { ...f, expression: replaceAt(f.expression, [2], { ...g, gain: { kind: 'constant', value: 0 } })! };
    });
    controller.settle();
    const zeroed = sampleBottle(host);
    expect(zeroed[3]).toBe(0);
    // Pull and swirl still act: the same drive as a bottle without its drag.
    const withoutDrag = new SimulationHost(cloneFrozen({ ...controller.scene, fields: [{ ...base, expression: ok(removeIngredient(base.expression, [2])).expression }] }));
    expect(zeroed.slice(0, 3)).toEqual(sampleBottle(withoutDrag).slice(0, 3));
    withoutDrag.dispose();
    controller.undo();
    controller.undo();
    controller.settle();
    expect(host.appliedFields()[0]).toEqual(base);
    host.dispose();
  });

  it('disabling the containing law eliminates the whole law; undo enables it again', () => {
    const { controller, host, base } = stormDocument();
    controller.editField('storm-bottle', 'Disable law', (f) => ({ ...f, enabled: false }));
    controller.settle();
    expect(sampleBottle(host)).toEqual([0, 0, 0, 0]);
    controller.undo();
    controller.settle();
    expect(host.appliedFields()[0]).toEqual(base);
    host.dispose();
  });

  it('there is no ingredient-enabled flag: such a key is refused as unknown', () => {
    expect(validateExpression({ kind: 'sum', terms: [pull, { ...drag, enabled: false }] })).toMatchObject({ ok: false, path: 'terms[1].enabled' });
    expect(validateExpression({ kind: 'gain', enabled: false, gain: { kind: 'constant', value: 1 }, child: drag })).toMatchObject({ ok: false, path: 'enabled' });
  });

  it('each ingredient action is one undo entry, and undo walks them back in order', () => {
    const { controller, host, base } = stormDocument();
    const steps: [string, (f: FieldDefinition) => FieldDefinition][] = [
      ['Add ingredient', (f) => ({ ...f, expression: ok(addIngredient(f.expression, null, 'directional')).expression })],
      ['Add mask', (f) => ({ ...f, expression: ok(wrapIngredient(f.expression, [3], 'mask', f.region)).expression })],
      ['Add gain', (f) => ({ ...f, expression: ok(wrapIngredient(f.expression, [1], 'gain', f.region)).expression })],
    ];
    const seen: FieldExpression[] = [base.expression];
    for (const [label, change] of steps) {
      expect(controller.editField('storm-bottle', label, change).ok).toBe(true);
      controller.settle();
      seen.push(host.appliedFields()[0]!.expression);
    }
    for (let i = seen.length - 1; i > 0; i--) {
      expect(controller.undo().ok).toBe(true);
      controller.settle();
      expect(host.appliedFields()[0]!.expression).toEqual(seen[i - 1]);
    }
    expect(controller.canUndo).toBe(true); // the move into the stream
    host.dispose();
  });
});

describe('AC7: authored term order is evaluation; the Laws list is presentation', () => {
  /** Two laws whose list order (by ID) and labels differ from any term order. */
  function twoLaws(terms: FieldExpression[]) {
    const document = load(stormBottle);
    const bottle = { ...document.semantic.fields[0]!, id: 'z-bottle', pose: { ...document.semantic.fields[0]!.pose, position: [0, 1.6, 0] as const }, expression: { kind: 'sum' as const, terms } };
    const other = { ...bottle, id: 'a-other', pose: { ...bottle.pose, position: [30, 1.6, 0] as const }, expression: pull };
    return createDocument({ ...document.semantic, fields: [other, bottle] }, document.metadata, {
      arrows: true,
      laws: [
        { id: 'a-other', label: 'Second in my head', color: '#55aaa4', visible: true },
        { id: 'z-bottle', label: 'First in my head', color: '#c58ae5', visible: true },
      ],
    });
  }
  const tiny = [0.1, 0.2, 0.3].map((s): FieldExpression => ({ kind: 'directional', direction: [1, 0, 0], strength: s }));

  it('reversing the stored terms is a semantic edit: the bits and the digest change', async () => {
    const forward = load(serializeScene(twoLaws(tiny)));
    const reversed = load(serializeScene(twoLaws([...tiny].reverse())));
    const sampleAt = (document: SceneDocument) => {
      const host = new SimulationHost(document.semantic);
      const out = [0, 0, 0, 0];
      sampleField(host.compiledField('z-bottle')!, 0, 1.6, 0, 0, out);
      host.dispose();
      return out[0];
    };
    expect(sampleAt(forward)).toBe(0.1 + 0.2 + 0.3);
    expect(sampleAt(reversed)).toBe(0.3 + 0.2 + 0.1);
    expect(await semanticDigest(forward)).not.toBe(await semanticDigest(reversed));
  });

  it('relabeling, recoloring or hiding laws changes neither evaluation nor digest; laws still apply in ID order', async () => {
    const document = load(serializeScene(twoLaws(tiny)));
    const relabeled = createDocument(document.semantic, document.metadata, {
      arrows: false,
      laws: document.presentation.laws.map((l, i) => ({ ...l, label: `Law ${9 - i}`, color: '#7aa7d9', visible: i === 0 })),
    });
    expect(await semanticDigest(relabeled)).toBe(await semanticDigest(document));
    const host = new SimulationHost(relabeled.semantic);
    expect(host.appliedFields().map((f) => f.id)).toEqual(['a-other', 'z-bottle']);
    expect(ingredientsOf(host.appliedFields()[1]!.expression).map((i) => (i.core.node as { strength: number }).strength)).toEqual([0.1, 0.2, 0.3]);
    host.dispose();
  });
});

describe('AC5: the bottle moves, turns and resizes as one law', () => {
  it('resizing the outer support leaves every ingredient, gain, mask and core untouched', () => {
    const { controller, host, base } = stormDocument();
    controller.editField('storm-bottle', 'Resize law', (f) => ({ ...f, region: { kind: 'cylinderY', radius: 2.2, halfHeight: 2.5 } }));
    controller.settle();
    const resized = host.appliedFields()[0]!;
    expect(resized.expression).toEqual(base.expression);
    expect(resized.pose).toEqual(base.pose);
    // At a point inside both supports, the drive and drag are identical: support grew, strength did not.
    const before = new SimulationHost(cloneFrozen({ ...controller.scene, fields: [base] }));
    expect(sampleBottle(host)).toEqual(sampleBottle(before));
    before.dispose();
    host.dispose();
  });

  it('moving and turning carries the primitive frame and every mask with the law', () => {
    const { controller, host } = stormDocument();
    const before = sampleBottle(host);
    // Turned 90° about Y and moved by [2,0,−1]: the same law-local point gives the turned drive.
    const s = Math.SQRT1_2;
    controller.editField('storm-bottle', 'Move law', (f) => ({ ...f, pose: { position: [2, 1.6, -1], rotation: [0, s, 0, s] } }));
    controller.settle();
    // Law-local [0.6,−0.6,0.3] is world [2,1.6,−1] + R_y(90°)·[0.6,−0.6,0.3] = [2.3, 1.0, −1.6].
    const out = [0, 0, 0, 0];
    sampleField(host.compiledField('storm-bottle')!, 2 + 0.3, 1.0, -1 - 0.6, host.tick, out);
    // R_y(90°) maps [x,y,z] to [z,y,−x].
    const expected = [before[2]!, before[1]!, -before[0]!, before[3]!];
    expected.forEach((e, i) => expect(Math.abs(out[i]! - e)).toBeLessThanOrEqual(1e-9 + 1e-8 * Math.abs(e)));
    host.dispose();
  });

  it('dragging the outer support handles changes support only; a focused ingredient’s handles set that node only', () => {
    const { base } = stormDocument();
    const outer = lawHandles(base);
    expect(outer.map((h) => h.name)).toEqual(['radius', 'halfHeight', 'edgeFade']);
    const bigger = outer[0]!.at(outer[0]!.t + 0.5);
    expect(bigger.expression).toBe(base.expression);
    expect(bigger.region).toEqual({ ...base.region, radius: 1.9 });
    // Focused on Drag: its mask's extents and fade, then the drag gauge, each prefixed by its node's path.
    const drag = lawHandles(base, [2]);
    expect(drag.map((h) => h.name).slice(3)).toEqual([
      'expression.terms[2].region.halfExtents.0',
      'expression.terms[2].region.halfExtents.1',
      'expression.terms[2].region.halfExtents.2',
      'expression.terms[2].edgeFade',
      'expression.terms[2].child.coefficient',
    ]);
    const wider = drag.find((h) => h.name === 'expression.terms[2].region.halfExtents.1')!;
    const moved = wider.at(wider.t + 0.4);
    expect((nodeAt(moved.expression, [2]) as { region: unknown }).region).toEqual({ kind: 'box', halfExtents: [1.6, 1.75, 1.6] });
    expect(moved.region).toBe(base.region);
    // The mask's rails sit in the law frame at its pose: its y-extent rail starts at the mask center.
    expect(wider.origin).toEqual([0, -0.45, 0]);
    expect(regionDescriptor(base.region.kind).bounds(base.region)).toEqual([1.4, 1.8, 1.4]);
  });
});

describe('AC6: export, reload and reset keep the whole expression and its equal-tick behavior', () => {
  it('an edited compound scene saved and reopened runs exactly as the authored one', () => {
    const { controller, host } = stormDocument();
    controller.editField('storm-bottle', 'Add gain', (f) => ({ ...f, expression: ok(wrapIngredient(f.expression, [1], 'gain', f.region)).expression }));
    controller.editField('storm-bottle', 'Change gain', (f) => ({ ...f, expression: replaceAt(f.expression, [1], { ...(nodeAt(f.expression, [1]) as Extract<FieldExpression, { kind: 'gain' }>), gain: { kind: 'triangle', min: 0, max: 2, periodTicks: 240, phaseTicks: 17 } })! }));
    const snapshot = controller.snapshot(undefined);
    const text = serializeScene(createDocument(snapshot.semantic, snapshot.metadata, snapshot.presentation));
    const reopened = load(text);
    expect(reopened.semantic).toEqual(snapshot.semantic);
    const authored = new SimulationHost(cloneFrozen(snapshot.semantic));
    const loaded = new SimulationHost(reopened.semantic);
    expect(compareRuns(runFixedSteps(authored), runFixedSteps(loaded)).every((c) => c.equal)).toBe(true);
    // And the controller's own reset reproduces it from tick 0.
    controller.reset();
    const fresh = new SimulationHost(reopened.semantic);
    expect(compareRuns(runFixedSteps(fresh), runFixedSteps(host)).every((c) => c.equal)).toBe(true);
    for (const h of [authored, loaded, fresh, host]) h.dispose();
  });
});

describe("the ingredient editor's controls", () => {
  const sphereMask = (child: FieldExpression): MaskExpression => ({ kind: 'mask', pose: { position: [0.5, -1, 2], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 1.25 }, edgeFade: 0.3, child });

  it('reads and sets each kind of key on the node it names; a key that does not fit the node gives null', () => {
    const strength = controlFor(swirl, 'primitive.strength')!;
    expect([strength.label, strength.value]).toEqual(['Change strength', '12']);
    expect(strength.set(-4)).toEqual({ ...swirl, strength: -4 });
    expect(controlFor(swirl, 'primitive.coreRadius')!.set(0.5)).toEqual({ ...swirl, coreRadius: 0.5 });
    const pulsing: FieldExpression = { kind: 'gain', gain: DEFAULT_TRIANGLE, child: swirl };
    expect(controlFor(pulsing, 'gain.min')).toMatchObject({ label: 'Change gain', value: '0' });
    expect(controlFor(pulsing, 'gain.phaseTicks')!.set(7)).toEqual({ ...pulsing, gain: { ...DEFAULT_TRIANGLE, phaseTicks: 7 } });
    const masked = sphereMask(swirl);
    expect(controlFor(masked, 'position.1')).toMatchObject({ label: 'Move mask', value: '-1' });
    expect(controlFor(masked, 'position.1')!.set(3)).toEqual({ ...masked, pose: { ...masked.pose, position: [0.5, 3, 2] } });
    expect(controlFor(masked, 'region.radius')).toMatchObject({ label: 'Resize mask', value: '1.25' });
    expect(controlFor(masked, 'edgeFade')!.set(0)).toEqual({ ...masked, edgeFade: 0 });
    // Rotation is typed in degrees about x, y and z; only the edited angle changes.
    const turned = controlFor(masked, 'rotation.2')!.set(90) as MaskExpression;
    expect(turned.pose.rotation.map((c) => +c.toFixed(12))).toEqual([0, 0, +Math.SQRT1_2.toFixed(12), +Math.SQRT1_2.toFixed(12)]);
    expect(controlFor(turned, 'rotation.2')).toMatchObject({ label: 'Rotate mask', value: '90' });
    const misfits: [FieldExpression, string][] = [
      [pulsing, 'primitive.strength'],
      [swirl, 'gain.min'],
      [pulsing, 'gain.kind'],
      [pulsing, 'gain.value'],
      [swirl, 'position.0'],
      [masked, 'region.halfExtents'],
      [masked, 'nonsense'],
    ];
    for (const [node, key] of misfits) expect(controlFor(node, key)).toBeNull();
  });
});
