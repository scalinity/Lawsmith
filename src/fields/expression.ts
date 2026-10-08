// The bounded expression tree inside one law (SPEC §6.3): primitive leaves combined by sum, gain and
// mask. This module validates and canonicalizes a tree, counts it against SPEC §15.2's limits and
// names the capabilities it needs; the kernel compiles it. A tree is declarative data, never code.
import { canonicalQuat, unsign, vec, within } from '../domain/numbers';
import type { FieldExpression, Gain, Pose, RegionDefinition, Validated, Vec3 } from '../domain/scene';
import { isPrimitiveKind, isRegionKind, primitiveDescriptor, regionDescriptor } from './registry';

/** The operators of SPEC §6.3, each with its own versioned capability (SPEC §15.1). */
export const OPERATORS = Object.freeze({
  sum: { capability: 'operator.sum.v1', title: 'Sum' },
  gain: { capability: 'operator.gain.v1', title: 'Gain' },
  mask: { capability: 'operator.mask.v1', title: 'Mask' },
});
export type OperatorKind = keyof typeof OPERATORS;
export const isOperatorKind = (kind: unknown): kind is OperatorKind => typeof kind === 'string' && Object.hasOwn(OPERATORS, kind);
export const OPERATOR_CAPABILITIES: readonly string[] = Object.values(OPERATORS).map((o) => o.capability);

/** SPEC §15.2 per-law limits: every node counts toward `nodes`; a primitive alone has depth 1. */
export const EXPRESSION_LIMITS = Object.freeze({ nodes: 64, depth: 8 });
/** SPEC §9.3: a general gain is finite and within 0–16; triangle min and max obey the same bound. */
export const GAIN_BOUNDS = Object.freeze({ min: 0, max: 16 });

/** A step from a node to a child: a sum term's index, or a gain's or mask's `child`. */
export type ExprStep = number | 'child';
export type ExprPath = readonly ExprStep[];

/** The path in a file or a validation message: `terms[1].child.gain`. */
export function pathText(path: ExprPath): string {
  return path.map((s) => (s === 'child' ? 'child' : `terms[${s}]`)).join('.');
}

/** The node at a path, or undefined when the path leaves the tree. */
export function nodeAt(expression: FieldExpression, path: ExprPath): FieldExpression | undefined {
  let node: FieldExpression | undefined = expression;
  for (const step of path) {
    if (!node) return undefined;
    if (step === 'child') node = node.kind === 'gain' || node.kind === 'mask' ? node.child : undefined;
    else node = node.kind === 'sum' ? node.terms[step] : undefined;
  }
  return node;
}

/** The tree with the node at `path` replaced; every other node is shared, nothing is mutated. */
export function replaceAt(expression: FieldExpression, path: ExprPath, replacement: FieldExpression): FieldExpression {
  if (!path.length) return replacement;
  const [step, ...rest] = path;
  if (step === 'child') {
    if (expression.kind !== 'gain' && expression.kind !== 'mask') throw new Error('path leaves the tree');
    return { ...expression, child: replaceAt(expression.child, rest, replacement) };
  }
  if (expression.kind !== 'sum' || step! >= expression.terms.length) throw new Error('path leaves the tree');
  return { ...expression, terms: expression.terms.map((t, i) => (i === step ? replaceAt(t, rest, replacement) : t)) };
}

/** Visits every node in preorder, children in stored order. Only for validated (bounded) trees. */
export function walk(expression: FieldExpression, visit: (node: FieldExpression, path: ExprPath) => void, path: ExprPath = []): void {
  visit(expression, path);
  if (expression.kind === 'sum') expression.terms.forEach((t, i) => walk(t, visit, [...path, i]));
  else if (expression.kind === 'gain' || expression.kind === 'mask') walk(expression.child, visit, [...path, 'child']);
}

export interface ExpressionStats {
  readonly nodes: number;
  readonly leaves: number;
  readonly depth: number;
}

/** Node, primitive-leaf and depth counts of a validated tree. */
export function expressionStats(expression: FieldExpression): ExpressionStats {
  let nodes = 0;
  let leaves = 0;
  let depth = 0;
  walk(expression, (node, path) => {
    nodes += 1;
    depth = Math.max(depth, path.length + 1);
    if (isPrimitiveKind(node.kind)) leaves += 1;
  });
  return { nodes, leaves, depth };
}

/** Adds every capability a validated tree uses: its primitives, its operators and its masks' regions. */
export function expressionCapabilities(expression: FieldExpression, used: Set<string>): void {
  walk(expression, (node) => {
    if (node.kind === 'sum' || node.kind === 'gain') used.add(OPERATORS[node.kind].capability);
    else if (node.kind === 'mask') {
      used.add(OPERATORS.mask.capability);
      used.add(regionDescriptor(node.region.kind).capability);
    } else used.add(primitiveDescriptor(node.kind).capability);
  });
}

/** True when some gain in the tree varies with the tick: its value then depends on n, not just on position. */
export function isTimeDependent(expression: FieldExpression): boolean {
  let varies = false;
  walk(expression, (node) => {
    if (node.kind === 'gain' && node.gain.kind === 'triangle') varies = true;
  });
  return varies;
}

/**
 * A gain's value at tick n (SPEC §6.3), a pure function of n and the accepted parameters: no clock,
 * no frame count, no accumulated phase. Triangle: q = ((n + phase) mod period) / period and
 * g = min + (max − min)·(1 − |2q − 1|). For safe integers n ≥ 0 and 0 ≤ phase < period, (n + phase)
 * mod period is formed as (n mod period) shifted by phase within [0, period), so no intermediate
 * exceeds the period and none rounds.
 */
export function gainAt(gain: Gain, n: number): number {
  if (gain.kind === 'constant') return gain.value;
  const { min, max, periodTicks: p, phaseTicks: phase } = gain;
  const r = n % p;
  const s = r >= p - phase ? r - (p - phase) : r + phase;
  const q = s / p;
  return min + (max - min) * (1 - Math.abs(2 * q - 1));
}

// ---------------------------------------------------------------- validation

type Rejection = { ok: false; reason: string; path: string };
const reject = (path: string, reason: string): Rejection => ({ ok: false, reason, path });
const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly the allowed keys: an unknown semantic key is an error, never ignored (SPEC §15.1). */
function checkKeys(node: Record<string, unknown>, path: string, allowed: readonly string[]): Rejection | null {
  for (const key of Object.keys(node)) if (!allowed.includes(key)) return reject(at(path, key), 'is not a known property');
  for (const key of allowed) if (!Object.hasOwn(node, key)) return reject(at(path, key), 'is required');
  return null;
}

const isTuple = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every((c) => typeof c === 'number');

function validatePose(value: unknown, path: string): Validated<Pose> {
  if (!isObject(value)) return reject(path, 'must be an object');
  const keys = checkKeys(value, path, ['position', 'rotation']);
  if (keys) return keys;
  const { position, rotation } = value;
  if (!isTuple(position, 3) || !position.every((c) => within(c, -1000, 1000))) return reject(at(path, 'position'), 'mask position components must be within ±1000 m');
  const q = isTuple(rotation, 4) ? canonicalQuat(rotation) : null;
  if (!q) return reject(at(path, 'rotation'), 'mask rotation must be a finite nonzero quaternion');
  return { ok: true, value: { position: vec(position as unknown as Vec3), rotation: q } };
}

function validateRegion(value: unknown, path: string): Validated<RegionDefinition> {
  if (!isObject(value)) return reject(path, 'must be an object');
  if (!isRegionKind(value.kind)) return reject(at(path, 'kind'), `unknown region kind ${JSON.stringify(value.kind)}`);
  const descriptor = regionDescriptor(value.kind);
  const keys = checkKeys(value, path, ['kind', ...Object.keys(descriptor.keys)]);
  if (keys) return keys;
  for (const [key, type] of Object.entries(descriptor.keys)) {
    if (type === 'vec3' ? !isTuple(value[key], 3) : typeof value[key] !== 'number') return reject(at(path, key), type === 'vec3' ? 'must be an array of 3 numbers' : 'must be a number');
  }
  const result = descriptor.validate(value as unknown as RegionDefinition);
  return result.ok ? result : { ...result, path: at(path, result.path) };
}

function validateGain(value: unknown, path: string): Validated<Gain> {
  if (!isObject(value)) return reject(path, 'must be an object');
  const range = `${GAIN_BOUNDS.min}–${GAIN_BOUNDS.max}`;
  if (value.kind === 'constant') {
    const keys = checkKeys(value, path, ['kind', 'value']);
    if (keys) return keys;
    if (typeof value.value !== 'number' || !within(value.value, GAIN_BOUNDS.min, GAIN_BOUNDS.max)) return reject(at(path, 'value'), `gain must be finite and within ${range}`);
    return { ok: true, value: { kind: 'constant', value: unsign(value.value) } };
  }
  if (value.kind === 'triangle') {
    const keys = checkKeys(value, path, ['kind', 'min', 'max', 'periodTicks', 'phaseTicks']);
    if (keys) return keys;
    const { min, max, periodTicks, phaseTicks } = value;
    if (typeof min !== 'number' || !within(min, GAIN_BOUNDS.min, GAIN_BOUNDS.max)) return reject(at(path, 'min'), `triangle min must be finite and within ${range}`);
    if (typeof max !== 'number' || !within(max, GAIN_BOUNDS.min, GAIN_BOUNDS.max)) return reject(at(path, 'max'), `triangle max must be finite and within ${range}`);
    if (max < min) return reject(at(path, 'max'), 'triangle max must be at least its min');
    if (typeof periodTicks !== 'number' || !Number.isSafeInteger(periodTicks) || periodTicks < 2) return reject(at(path, 'periodTicks'), 'periodTicks must be an integer of at least 2');
    if (typeof phaseTicks !== 'number' || !Number.isSafeInteger(phaseTicks) || phaseTicks < 0 || phaseTicks >= periodTicks) {
      return reject(at(path, 'phaseTicks'), 'phaseTicks must be an integer from 0 to periodTicks − 1');
    }
    return { ok: true, value: { kind: 'triangle', min: unsign(min), max: unsign(max), periodTicks, phaseTicks: unsign(phaseTicks) } };
  }
  return reject(at(path, 'kind'), `unknown gain kind ${JSON.stringify(value.kind)}`);
}

interface Budget {
  nodes: number;
}

/**
 * One node and its subtree. Depth is checked on arrival, before any child is read, and every node
 * counts toward the budget, so neither a deep nor a wide candidate can recurse without bound; a node
 * that is its own ancestor (a cyclic in-memory object) is refused by name.
 */
function visit(value: unknown, path: string, depth: number, budget: Budget, ancestors: unknown[]): Validated<FieldExpression> {
  if (depth > EXPRESSION_LIMITS.depth) return reject(path, `expression depth exceeds ${EXPRESSION_LIMITS.depth}`);
  if (!isObject(value)) return reject(path, 'must be an expression object');
  if (ancestors.includes(value)) return reject(path, 'expression contains a cycle');
  budget.nodes += 1;
  if (budget.nodes > EXPRESSION_LIMITS.nodes) return reject(path, `a law has at most ${EXPRESSION_LIMITS.nodes} expression nodes`);
  const kind = value.kind;

  if (isPrimitiveKind(kind)) {
    const descriptor = primitiveDescriptor(kind);
    const keys = checkKeys(value, path, ['kind', ...Object.keys(descriptor.keys)]);
    if (keys) return keys;
    for (const [key, type] of Object.entries(descriptor.keys)) {
      if (type === 'vec3' ? !isTuple(value[key], 3) : typeof value[key] !== 'number') return reject(at(path, key), type === 'vec3' ? 'must be an array of 3 numbers' : 'must be a number');
    }
    const result = descriptor.validate(value as never);
    return result.ok ? result : { ...result, path: at(path, result.path) };
  }

  ancestors.push(value);
  try {
    if (kind === 'sum') {
      const keys = checkKeys(value, path, ['kind', 'terms']);
      if (keys) return keys;
      const terms = value.terms;
      const termsPath = at(path, 'terms');
      if (!Array.isArray(terms)) return reject(termsPath, 'must be an array');
      if (terms.length === 0) return reject(termsPath, 'a sum needs at least one term');
      if (terms.length > EXPRESSION_LIMITS.nodes) return reject(termsPath, `a law has at most ${EXPRESSION_LIMITS.nodes} expression nodes`);
      const out: FieldExpression[] = [];
      for (let i = 0; i < terms.length; i++) {
        const term = visit(terms[i], at(termsPath, i), depth + 1, budget, ancestors);
        if (!term.ok) return term;
        out.push(term.value);
      }
      return { ok: true, value: { kind: 'sum', terms: out } };
    }
    if (kind === 'gain') {
      const keys = checkKeys(value, path, ['kind', 'gain', 'child']);
      if (keys) return keys;
      const gain = validateGain(value.gain, at(path, 'gain'));
      if (!gain.ok) return gain;
      const child = visit(value.child, at(path, 'child'), depth + 1, budget, ancestors);
      if (!child.ok) return child;
      return { ok: true, value: { kind: 'gain', gain: gain.value, child: child.value } };
    }
    if (kind === 'mask') {
      const keys = checkKeys(value, path, ['kind', 'pose', 'region', 'edgeFade', 'child']);
      if (keys) return keys;
      const pose = validatePose(value.pose, at(path, 'pose'));
      if (!pose.ok) return pose;
      const region = validateRegion(value.region, at(path, 'region'));
      if (!region.ok) return region;
      if (typeof value.edgeFade !== 'number' || !within(value.edgeFade, 0, 1)) return reject(at(path, 'edgeFade'), 'mask edge fade must be within 0–1');
      const child = visit(value.child, at(path, 'child'), depth + 1, budget, ancestors);
      if (!child.ok) return child;
      return { ok: true, value: { kind: 'mask', pose: pose.value, region: region.value, edgeFade: unsign(value.edgeFade), child: child.value } };
    }
    return reject(at(path, 'kind'), `unknown expression kind ${JSON.stringify(kind)}`);
  } finally {
    ancestors.pop();
  }
}

/**
 * Validates a law's expression against SPEC §6.3, §9.3 and §15.2 and resolves its canonical form:
 * primitive directions normalized, mask quaternions canonical, negative zeros removed. Sum terms
 * keep their stored order, because that order is the evaluation order. Paths are relative to the
 * expression (`terms[1].gain.phaseTicks`); nothing is clipped, dropped or repaired.
 */
export function validateExpression(expression: unknown): Validated<FieldExpression> {
  return visit(expression, '', 1, { nodes: 0 }, []);
}
