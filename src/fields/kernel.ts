// The pure CPU field kernel (SPEC §6–§8): every law, whatever its expression or region, samples
// through the same transform, normalized gauge, fade and rotation, producing E = (A, K) at a tick.
// Plain numbers only, no Three.js: the simulation host, the probes and the sparse visual samples all
// call `sampleField`, so what is drawn and what probes feel is this evaluator.
import type { FieldDefinition, FieldExpression, Quat } from '../domain/scene';
import { gainAt } from './expression';
import { primitiveDescriptor, regionDescriptor, type Gauge } from './registry';

/**
 * Kernel identity recorded with qualification evidence (SPEC §13.1). v2 adds sum, gain and mask
 * and the tick input; a primitive-only law evaluates exactly as under v1.
 */
export const FIELD_KERNEL_VERSION = 'affine-ak-v2';

/**
 * A compiled expression at law-local r and tick n: writes local A into out[0..2] and returns K,
 * before the outer support weight. The tick comes last, so a primitive's own evaluator, which takes
 * no tick, is already one: a one-leaf law runs exactly its primitive's code.
 */
export type ExpressionEvaluator = (rx: number, ry: number, rz: number, out: number[], tick: number) => number;

/** A validated field prepared for sampling on load or accepted edit; it never reads mutable UI values. */
export interface CompiledField {
  readonly id: string;
  readonly enabled: boolean;
  /** Support center p. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** Rotation R, row-major. */
  readonly m: readonly number[];
  readonly fade: number;
  readonly gauge: Gauge;
  readonly evaluate: ExpressionEvaluator;
  /** Some gain varies with the tick, so a drawn sample belongs to one tick (SPEC §12). */
  readonly timeDependent: boolean;
}

/** Rotation matrix of a unit quaternion [x,y,z,w], row-major. */
export function rotationMatrix([x, y, z, w]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** SPEC §7 weight: hard boundary at f=0, otherwise smoothstep of z=clamp((1-d)/f,0,1). */
export function fadeWeight(d: number, f: number): number {
  if (f === 0) return d <= 1 ? 1 : 0;
  const z = Math.min(1, Math.max(0, (1 - d) / f));
  return z * z * (3 - 2 * z);
}

const zero: ExpressionEvaluator = (_rx, _ry, _rz, out) => {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  return 0;
};

/**
 * Compiles a validated expression once, on load or an accepted edit, into closures over its
 * constants: no validation, parsing or allocation happens per sample. Each sum owns one scratch
 * vector, so sampling allocates nothing. Every node keeps SPEC §6.3's exact arithmetic:
 *
 * - sum: A = A₁ + A₂ + … and K = K₁ + K₂ + …, left to right in stored order, starting from the
 *   first term, never reordered or reassociated;
 * - gain: g·A and g·K with g = gainAt(gain, n); a zero gain writes exact zeros without evaluating
 *   its subtree;
 * - mask: w·A and w·K with w the SPEC §7 weight of r in the mask's pose, which is relative to the law
 *   frame; the child still evaluates at the law-local r, so a mask moves support, never a vector frame.
 */
export function compileExpression(expression: FieldExpression): { evaluate: ExpressionEvaluator; timeDependent: boolean } {
  switch (expression.kind) {
    case 'sum': {
      const terms = expression.terms.map(compileExpression);
      const first = terms[0]!.evaluate;
      const rest = terms.slice(1).map((t) => t.evaluate);
      const part = [0, 0, 0];
      const evaluate: ExpressionEvaluator = (rx, ry, rz, out, n) => {
        let k = first(rx, ry, rz, out, n);
        for (let i = 0; i < rest.length; i++) {
          k += rest[i]!(rx, ry, rz, part, n);
          out[0] = out[0]! + part[0]!;
          out[1] = out[1]! + part[1]!;
          out[2] = out[2]! + part[2]!;
        }
        return k;
      };
      return { evaluate, timeDependent: terms.some((t) => t.timeDependent) };
    }
    case 'gain': {
      const { gain } = expression;
      if (gain.kind === 'constant' && gain.value === 0) return { evaluate: zero, timeDependent: false };
      const compiled = compileExpression(expression.child);
      const child = compiled.evaluate;
      if (gain.kind === 'constant') {
        const g = gain.value;
        const evaluate: ExpressionEvaluator = (rx, ry, rz, out, n) => {
          const k = child(rx, ry, rz, out, n);
          out[0] = g * out[0]!;
          out[1] = g * out[1]!;
          out[2] = g * out[2]!;
          return g * k;
        };
        return { evaluate, timeDependent: compiled.timeDependent };
      }
      const evaluate: ExpressionEvaluator = (rx, ry, rz, out, n) => {
        const g = gainAt(gain, n);
        if (g === 0) return zero(rx, ry, rz, out, n);
        const k = child(rx, ry, rz, out, n);
        out[0] = g * out[0]!;
        out[1] = g * out[1]!;
        out[2] = g * out[2]!;
        return g * k;
      };
      return { evaluate, timeDependent: true };
    }
    case 'mask': {
      const compiled = compileExpression(expression.child);
      const child = compiled.evaluate;
      const gauge = regionDescriptor(expression.region.kind).compile(expression.region);
      const m = rotationMatrix(expression.pose.rotation);
      const [px, py, pz] = expression.pose.position;
      const f = expression.edgeFade;
      const evaluate: ExpressionEvaluator = (rx, ry, rz, out, n) => {
        // Mask-local coordinates Rₘᵀ(r − pₘ), for the weight only.
        const dx = rx - px;
        const dy = ry - py;
        const dz = rz - pz;
        const w = fadeWeight(gauge(m[0]! * dx + m[3]! * dy + m[6]! * dz, m[1]! * dx + m[4]! * dy + m[7]! * dz, m[2]! * dx + m[5]! * dy + m[8]! * dz), f);
        if (w === 0) return zero(rx, ry, rz, out, n);
        const k = child(rx, ry, rz, out, n);
        out[0] = w * out[0]!;
        out[1] = w * out[1]!;
        out[2] = w * out[2]!;
        return w * k;
      };
      return { evaluate, timeDependent: compiled.timeDependent };
    }
    default:
      return { evaluate: primitiveDescriptor(expression.kind).compile(expression), timeDependent: false };
  }
}

export function compileField(field: FieldDefinition): CompiledField {
  const [px, py, pz] = field.pose.position;
  const { evaluate, timeDependent } = compileExpression(field.expression);
  return Object.freeze({
    id: field.id,
    enabled: field.enabled,
    px, py, pz,
    m: Object.freeze(rotationMatrix(field.pose.rotation)),
    fade: field.edgeFade,
    gauge: regionDescriptor(field.region.kind).compile(field.region),
    evaluate,
    timeDependent,
  });
}

/**
 * SPEC §7's conservative fade-band scale, f × the region's narrowest dimension: a body whose
 * one-step travel exceeds it can skip the band between center samples. Null for a hard boundary
 * (f = 0), which has no band to compare.
 */
export function fadeBand(field: FieldDefinition): number | null {
  return field.edgeFade === 0 ? null : field.edgeFade * regionDescriptor(field.region.kind).narrowest(field.region);
}

/** Local drive scratch; the kernel is single-threaded and never reentrant. */
const local = [0, 0, 0];

/**
 * Samples the field at world point (x,y,z) and tick n: world drive A into out[0..2] and drag rate K
 * into out[3], both already multiplied by the outer support weight, which is returned. Local
 * coordinates are r = Rᵀ(x − p); the expression evaluates once at (r, n); its local drive is rotated
 * by R, and K, a scalar, is not. The outer weight applies once, to the whole expression. A disabled
 * field and any point with zero weight write exact positive zeros. Every caller passes the tick it
 * explains: the host its boundary n, a probe the transition it takes, a drawn sample its own tick.
 */
export function sampleField(field: CompiledField, x: number, y: number, z: number, tick: number, out: number[]): number {
  let weight = 0;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  const { m } = field;
  if (field.enabled) {
    const dx = x - field.px;
    const dy = y - field.py;
    const dz = z - field.pz;
    rx = m[0]! * dx + m[3]! * dy + m[6]! * dz;
    ry = m[1]! * dx + m[4]! * dy + m[7]! * dz;
    rz = m[2]! * dx + m[5]! * dy + m[8]! * dz;
    weight = fadeWeight(field.gauge(rx, ry, rz), field.fade);
  }
  if (weight === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return 0;
  }
  const k = field.evaluate(rx, ry, rz, local, tick);
  const lx = local[0]!;
  const ly = local[1]!;
  const lz = local[2]!;
  out[0] = weight * (m[0]! * lx + m[1]! * ly + m[2]! * lz);
  out[1] = weight * (m[3]! * lx + m[4]! * ly + m[5]! * lz);
  out[2] = weight * (m[6]! * lx + m[7]! * ly + m[8]! * lz);
  out[3] = weight * k;
  return weight;
}
