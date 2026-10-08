// A compound law as a short list of ingredients (SPEC §6.3, M5): the editor's view of the expression
// tree, and the pure edits it makes. An ingredient is one term of the law's sum (or the whole
// expression when it is not a sum) with its gains and masks peeled off; its core is a primitive or,
// for a nested sum, a group. Every edit returns a new tree; the document validates it as an ordinary
// law put, so nothing here touches a compiled evaluator or the host.
import { nodeAt, replaceAt, type ExprPath } from '../fields/expression';
import { isPrimitiveKind, primitiveDescriptor, regionDescriptor, type PrimitiveKind } from '../fields/registry';
import type { FieldExpression, Gain, GainExpression, MaskExpression, Primitive, RegionDefinition, SumExpression } from './scene';

export type Modifier = GainExpression | MaskExpression;

export interface Ingredient {
  /** Path of the ingredient's outermost node. */
  readonly path: ExprPath;
  /** The gains and masks around its core, outermost first. */
  readonly modifiers: readonly { readonly path: ExprPath; readonly node: Modifier }[];
  /** The primitive it applies, or a nested sum: a group of ingredients. */
  readonly core: { readonly path: ExprPath; readonly node: Primitive | SumExpression };
}

/** A law is compound once its expression is anything but a single primitive. */
export const isCompound = (expression: FieldExpression) => !isPrimitiveKind(expression.kind);

/** Peels the gains and masks off the node at `path`. */
export function peel(expression: FieldExpression, path: ExprPath): Ingredient {
  const modifiers: { path: ExprPath; node: Modifier }[] = [];
  let at = path;
  let node = nodeAt(expression, path)!;
  while (node.kind === 'gain' || node.kind === 'mask') {
    modifiers.push({ path: at, node });
    at = [...at, 'child'];
    node = node.child;
  }
  return { path, modifiers, core: { path: at, node } };
}

/**
 * The ingredients of a level, in stored order, which is their evaluation order: the terms of the sum
 * at `group`, or at the root a sum's terms or else the whole expression as one ingredient.
 */
export function ingredientsOf(expression: FieldExpression, group: ExprPath | null = null): Ingredient[] {
  const level = group === null ? expression : nodeAt(expression, group);
  if (!level) return [];
  const base = group ?? [];
  if (level.kind === 'sum') return level.terms.map((_, i) => peel(expression, [...base, i]));
  return group === null ? [peel(expression, [])] : [];
}

export const samePath = (a: ExprPath | null, b: ExprPath | null) => a !== null && b !== null && a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * The level holding the group whose sum is at `group`: past the group's own gains and masks to its
 * ingredient, then past that ingredient's term index to the sum holding it; the law's list at the top.
 */
export function parentLevel(group: ExprPath): ExprPath | null {
  const p = [...group];
  while (p[p.length - 1] === 'child') p.pop();
  p.pop();
  return p.length ? p : null;
}

/**
 * The editor's open group and focused ingredient once the law has changed: the group while it is still
 * a sum, the focus while it is still one of that level's ingredients, and otherwise the law's own list
 * and no focus. A one-leaf law has no ingredient list.
 */
export function keptView(expression: FieldExpression, level: ExprPath | null, focus: ExprPath | null): { level: ExprPath | null; focus: ExprPath | null; ingredients: Ingredient[] } {
  const kept = level !== null && nodeAt(expression, level)?.kind === 'sum' ? level : null;
  const ingredients = isCompound(expression) ? ingredientsOf(expression, kept) : [];
  return { level: kept, focus: ingredients.some((i) => samePath(i.path, focus)) ? focus : null, ingredients };
}

/** Each ingredient's everyday name: its primitive's verb or "Group", numbered when a name repeats. */
export function ingredientLabels(ingredients: readonly Ingredient[]): string[] {
  const seen = new Map<string, number>();
  return ingredients.map(({ core }) => {
    const base = core.node.kind === 'sum' ? 'Group' : primitiveDescriptor(core.node.kind).verb;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

/** The Laws-list summary: a primitive's kind and value, or the ingredients a compound law adds. */
export function expressionSummary(expression: FieldExpression): string {
  if (isPrimitiveKind(expression.kind)) {
    const primitive = primitiveDescriptor(expression.kind);
    return `${primitive.title.toLowerCase()}, ${primitive.summary(expression as Primitive)}`;
  }
  return ingredientLabels(ingredientsOf(expression))
    .map((label) => label.toLowerCase())
    .join(' + ');
}

export type Edited = { ok: true; expression: FieldExpression; path: ExprPath } | { ok: false; reason: string };

/**
 * Adds a primitive with its registry defaults as the last ingredient of a level. A law that is not
 * yet a sum becomes one: its whole expression is the first term and the new primitive the second.
 */
export function addIngredient(expression: FieldExpression, group: ExprPath | null, kind: PrimitiveKind): Edited {
  const leaf = primitiveDescriptor(kind).defaults;
  const at = group ?? [];
  const level = nodeAt(expression, at);
  if (!level) return { ok: false, reason: 'no such group' };
  if (level.kind === 'sum') return { ok: true, expression: replaceAt(expression, at, { kind: 'sum', terms: [...level.terms, leaf] }), path: [...at, level.terms.length] };
  if (group !== null) return { ok: false, reason: 'only a group takes ingredients' };
  return { ok: true, expression: { kind: 'sum', terms: [expression, leaf] }, path: [1] };
}

/** Removes one ingredient from its sum. A sum keeps at least one term; a law's last one goes with the law. */
export function removeIngredient(expression: FieldExpression, path: ExprPath): Edited {
  const index = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  const parent = typeof index === 'number' ? nodeAt(expression, parentPath) : undefined;
  if (!parent || parent.kind !== 'sum') return { ok: false, reason: 'a law keeps its last ingredient; delete the law to remove it' };
  if (parent.terms.length === 1) return { ok: false, reason: 'a group keeps at least one ingredient' };
  return { ok: true, expression: replaceAt(expression, parentPath, { kind: 'sum', terms: parent.terms.filter((_, i) => i !== index) }), path: parentPath };
}

/** The gain an ingredient starts with: 1, which changes nothing until it is edited. */
export const DEFAULT_GAIN: Gain = { kind: 'constant', value: 1 };
/** A triangle swings 0 → 2 → 0 over 2 s (240 ticks) from phase 0, averaging the unscaled ingredient. */
export const DEFAULT_TRIANGLE: Gain = { kind: 'triangle', min: 0, max: 2, periodTicks: 240, phaseTicks: 0 };

/** A new mask: a sphere at the law's center, half the law's largest reach, with the usual fade. */
export function defaultMask(lawRegion: RegionDefinition, child: FieldExpression): MaskExpression {
  const radius = Math.max(0.01, Math.round(50 * Math.max(...regionDescriptor(lawRegion.kind).bounds(lawRegion))) / 100);
  return { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius }, edgeFade: 0.25, child };
}

/** Wraps an ingredient in a new gain or mask, outermost: its path then names the wrapper. */
export function wrapIngredient(expression: FieldExpression, path: ExprPath, wrapper: 'gain' | 'mask', lawRegion: RegionDefinition): Edited {
  const node = nodeAt(expression, path);
  if (!node) return { ok: false, reason: 'no such ingredient' };
  const wrapped: Modifier = wrapper === 'gain' ? { kind: 'gain', gain: DEFAULT_GAIN, child: node } : defaultMask(lawRegion, node);
  return { ok: true, expression: replaceAt(expression, path, wrapped), path };
}

/** Removes one gain or mask, keeping what it wrapped. */
export function unwrapModifier(expression: FieldExpression, path: ExprPath): Edited {
  const node = nodeAt(expression, path);
  if (!node || (node.kind !== 'gain' && node.kind !== 'mask')) return { ok: false, reason: 'no such gain or mask' };
  return { ok: true, expression: replaceAt(expression, path, node.child), path };
}
