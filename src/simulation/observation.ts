// Selected-body transition observations (SPEC §9.1, §12): what the host submitted for one body
// over one transition n → n+1, kept to explain it. An observation is telemetry. It never enters the
// canonical state, the engine, a run root, a scene file or command scheduling.
import { ingredientLabels, ingredientsOf, isCompound, type Ingredient } from '../domain/ingredients';
import type { FieldDefinition, MaskExpression, Vec3 } from '../domain/scene';
import { gainAt, nodeAt, type ExprPath } from '../fields/expression';
import { compileField, compileMaskWeight, sampleField, type CompiledField, type MaskWeight } from '../fields/kernel';

/** One law's part of a submitted external acceleration, under the transition's shared β and λ. */
export interface LawContribution {
  readonly id: string;
  /** The law's sampled drive A_i at the body's center, m/s². */
  readonly drive: Vec3;
  /** The law's sampled drag rate K_i, s⁻¹. */
  readonly drag: number;
  /** λβ(A_i − K_i·v), m/s². An algebraic share of the total, not the effect of removing the law. */
  readonly applied: Vec3;
}

export interface TransitionObservation {
  /** `applied`: retained from a completed transition. `preview`: what the next transition would submit now. */
  readonly kind: 'applied' | 'preview';
  readonly bodyId: string;
  readonly fromTick: number;
  readonly toTick: number;
  /** Command cursor at boundary fromTick, after its commands settled: `laws` are exactly the ones applied. */
  readonly cursor: number;
  readonly laws: readonly FieldDefinition[];
  /** The body's center x and velocity v at fromTick, as the host read them before sampling. */
  readonly center: Vec3;
  readonly velocity: Vec3;
  /** Engine-reported mass, kg. */
  readonly mass: number;
  /** Ambient gravity g, m/s². */
  readonly gravity: Vec3;
  /** A = g + ΣA_i, m/s², and K = ΣK_i, s⁻¹. */
  readonly drive: Vec3;
  readonly drag: number;
  /** β(Kh) and λ, shared by every contribution. */
  readonly beta: number;
  readonly lambda: number;
  readonly maxApplied: number;
  /** A − K·v: the instantaneous external acceleration, before β and λ, m/s². */
  readonly instantaneous: Vec3;
  /** λ·a*: the submitted external acceleration, m/s². */
  readonly submitted: Vec3;
  /** mass·λ·a*, the force the host added for the step, N. */
  readonly force: Vec3;
  /** λβ·g, m/s². */
  readonly gravityApplied: Vec3;
  /** In stable law order. Together with `gravityApplied` they sum to `submitted`. */
  readonly contributions: readonly LawContribution[];
  /** Applied only: center and velocity at toTick, after the engine step, contacts included. */
  readonly after: { readonly center: Vec3; readonly velocity: Vec3 } | null;
  /** Applied only: stable IDs of the bodies whose contact with this one carried a normal impulse in the step. */
  readonly contacts: readonly string[] | null;
}

/** What the host read and computed for one body at one boundary. */
export interface SampledTransition {
  readonly kind: TransitionObservation['kind'];
  readonly bodyId: string;
  readonly fromTick: number;
  readonly cursor: number;
  readonly laws: readonly FieldDefinition[];
  readonly gravity: Vec3;
  readonly maxApplied: number;
  /** Center [0..2], velocity [3..5]. */
  readonly state: ArrayLike<number>;
  /** A_i in [4i..4i+2] and K_i in [4i+3], one entry per law in `laws`. */
  readonly samples: ArrayLike<number>;
  /** The adapter's output: λ·a* in [0..2], β in [3], λ in [4]. */
  readonly adapted: ArrayLike<number>;
  readonly mass: number;
  /** The force exactly as submitted. */
  readonly force: Vec3;
  readonly after: TransitionObservation['after'];
  readonly contacts: TransitionObservation['contacts'];
}

const v3 = (a: ArrayLike<number>, i: number): Vec3 => [a[i]!, a[i + 1]!, a[i + 2]!];

/** Builds an observation from one boundary's samples, decomposing it with that boundary's own β and λ. */
export function observeTransition(s: SampledTransition): TransitionObservation {
  const center = v3(s.state, 0);
  const velocity = v3(s.state, 3);
  const beta = s.adapted[3]!;
  const lambda = s.adapted[4]!;
  const factor = lambda * beta;
  const drive = [...s.gravity];
  let drag = 0;
  const contributions = s.laws.map((law, i): LawContribution => {
    const a = v3(s.samples, 4 * i);
    const k = s.samples[4 * i + 3]!;
    for (let c = 0; c < 3; c++) drive[c]! += a[c]!;
    drag += k;
    return { id: law.id, drive: a, drag: k, applied: [factor * (a[0] - k * velocity[0]), factor * (a[1] - k * velocity[1]), factor * (a[2] - k * velocity[2])] };
  });
  return {
    kind: s.kind,
    bodyId: s.bodyId,
    fromTick: s.fromTick,
    toTick: s.fromTick + 1,
    cursor: s.cursor,
    laws: s.laws,
    center,
    velocity,
    mass: s.mass,
    gravity: s.gravity,
    drive: drive as unknown as Vec3,
    drag,
    beta,
    lambda,
    maxApplied: s.maxApplied,
    instantaneous: [drive[0]! - drag * velocity[0], drive[1]! - drag * velocity[1], drive[2]! - drag * velocity[2]],
    submitted: v3(s.adapted, 0),
    force: s.force,
    gravityApplied: [factor * s.gravity[0], factor * s.gravity[1], factor * s.gravity[2]],
    contributions,
    after: s.after,
    contacts: s.contacts,
  };
}

/** One ingredient's part of its law's share in one transition (M5). */
export interface IngredientShare {
  readonly path: ExprPath;
  readonly label: string;
  /** The ingredient's drive at the sampled center and tick after its own gains and masks and the law's support, world frame, m/s². */
  readonly drive: Vec3;
  /** Its drag rate there, s⁻¹. */
  readonly drag: number;
  /** λβ(A − K·v) with the transition's shared β and λ: an algebraic part of the law's share, not the effect of removing it. */
  readonly applied: Vec3;
  /** Each of its gains and masks at that center and tick, outermost first. */
  readonly factors: readonly { readonly kind: 'gain' | 'mask'; readonly value: number }[];
}

export interface LawIngredients {
  readonly id: string;
  readonly ingredients: readonly IngredientShare[];
  /** The ingredients' drive and drag add up to the law's retained sample within the T03 tolerance. */
  readonly reconciled: boolean;
}

/**
 * A retained law's ingredients, each compiled as the law's whole expression: the same pose, support and
 * kernel, one ingredient at a time. Retained laws are frozen, so each is compiled once.
 */
const compiledParts = new WeakMap<FieldDefinition, CompiledField[]>();
function partsOf(law: FieldDefinition, list: readonly Ingredient[]): CompiledField[] {
  let parts = compiledParts.get(law);
  if (!parts) compiledParts.set(law, (parts = list.map((i) => compileField({ ...law, expression: nodeAt(law.expression, i.path)! }))));
  return parts;
}

/** Mask weights, compiled once per frozen mask node. */
const maskWeights = new WeakMap<MaskExpression, MaskWeight>();
function maskWeight(mask: MaskExpression): MaskWeight {
  let weight = maskWeights.get(mask);
  if (!weight) maskWeights.set(mask, (weight = compileMaskWeight(mask)));
  return weight;
}

const agrees = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-9 + 1e-8 * Math.abs(expected);

/**
 * A compound law's share of one observed transition, split by ingredient. Each ingredient is
 * evaluated from what the observation retained: the law's frozen definition, the sampled center and
 * the transition's tick, so a later edit cannot rewrite it. Each part samples through the kernel the
 * host steps with, under the law's own pose and support, and the transition's own β and λ scale
 * every part. Null for a one-leaf law, which is its own single ingredient.
 */
export function ingredientBreakdown(o: TransitionObservation, index: number): LawIngredients | null {
  const law = o.laws[index];
  const contribution = o.contributions[index];
  if (!law || !contribution || !isCompound(law.expression)) return null;
  const [x, y, z] = o.center;
  const factor = o.lambda * o.beta;
  const v = o.velocity;
  const list = ingredientsOf(law.expression);
  const labels = ingredientLabels(list);
  const parts = partsOf(law, list);
  // Law-local r = Rᵀ(x − p), where each mask's factor is read; the kernel forms the same r.
  const { m, px, py, pz } = parts[0]!;
  const rx = m[0]! * (x - px) + m[3]! * (y - py) + m[6]! * (z - pz);
  const ry = m[1]! * (x - px) + m[4]! * (y - py) + m[7]! * (z - pz);
  const rz = m[2]! * (x - px) + m[5]! * (y - py) + m[8]! * (z - pz);
  const out = [0, 0, 0, 0];
  const total = [0, 0, 0, 0];
  const ingredients = list.map((ingredient, i): IngredientShare => {
    sampleField(parts[i]!, x, y, z, o.fromTick, out);
    const drive: Vec3 = [out[0]!, out[1]!, out[2]!];
    const drag = out[3]!;
    for (let c = 0; c < 3; c++) total[c]! += drive[c]!;
    total[3]! += drag;
    return {
      path: ingredient.path,
      label: labels[i]!,
      drive,
      drag,
      applied: [factor * (drive[0] - drag * v[0]), factor * (drive[1] - drag * v[1]), factor * (drive[2] - drag * v[2])],
      factors: ingredient.modifiers.map(({ node }) => (node.kind === 'gain' ? { kind: 'gain', value: gainAt(node.gain, o.fromTick) } : { kind: 'mask', value: maskWeight(node)(rx, ry, rz) })),
    };
  });
  const reconciled = [0, 1, 2].every((c) => agrees(total[c]!, contribution.drive[c]!)) && agrees(total[3]!, contribution.drag);
  return { id: law.id, ingredients, reconciled };
}
