// The pure CPU field kernel (SPEC §6–§8): every law, whatever its primitive or region, samples
// through the same transform, normalized gauge, fade and rotation, producing E = (A, K). Plain
// numbers only, no Three.js: the simulation host and the sparse visual samples both call
// `sampleField`, so what is drawn is this evaluator.
import type { FieldDefinition, Quat } from '../domain/scene';
import { primitiveDescriptor, regionDescriptor, type Gauge, type LocalEvaluator } from './registry';

/** Kernel identity recorded with qualification evidence (SPEC §13.1). */
export const FIELD_KERNEL_VERSION = 'affine-ak-v1';

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
  readonly evaluate: LocalEvaluator;
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

export function compileField(field: FieldDefinition): CompiledField {
  const [px, py, pz] = field.pose.position;
  return Object.freeze({
    id: field.id,
    enabled: field.enabled,
    px, py, pz,
    m: Object.freeze(rotationMatrix(field.pose.rotation)),
    fade: field.edgeFade,
    gauge: regionDescriptor(field.region.kind).compile(field.region),
    evaluate: primitiveDescriptor(field.expression.kind).compile(field.expression),
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
 * Samples the field at world point (x,y,z): world drive A into out[0..2] and drag rate K into
 * out[3], both already multiplied by the support weight, which is returned. Local coordinates
 * are r = Rᵀ(x − p); the local drive is rotated by R, and K, a scalar, is not. A disabled field
 * and any point with zero weight write exact positive zeros.
 */
export function sampleField(field: CompiledField, x: number, y: number, z: number, out: number[]): number {
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
  const k = field.evaluate(rx, ry, rz, local);
  const lx = local[0]!;
  const ly = local[1]!;
  const lz = local[2]!;
  out[0] = weight * (m[0]! * lx + m[1]! * ly + m[2]! * lz);
  out[1] = weight * (m[3]! * lx + m[4]! * ly + m[5]! * lz);
  out[2] = weight * (m[6]! * lx + m[7]! * ly + m[8]! * lz);
  out[3] = weight * k;
  return weight;
}
