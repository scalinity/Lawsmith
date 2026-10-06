// Pure CPU field kernel for M1's one law: box support with normalized fade (SPEC §7) and the
// directional primitive (SPEC §6.2). Plain numbers only, no Three.js: the simulation host and
// the sparse arrows both sample through `sampleField`, so the arrows show this evaluator.
import type { FieldDefinition, Quat } from '../domain/scene';

/** Kernel identity recorded with qualification evidence (SPEC §13.1). */
export const FIELD_KERNEL_VERSION = 'directional-box-v1';

/** A validated field prepared for sampling; it never reads mutable UI values. */
export interface CompiledField {
  readonly id: string;
  readonly enabled: boolean;
  /** Support center p. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** Rotation R, row-major. */
  readonly m: readonly number[];
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly fade: number;
  /** Full-support world drive: R · (strength · direction). */
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
}

/** Rotation matrix of a unit quaternion [x,y,z,w], row-major. */
export function rotationMatrix([x, y, z, w]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Box gauge d = max(|rx|/bx, |ry|/by, |rz|/bz): a normalized gauge, not a distance. */
export function boxGauge(rx: number, ry: number, rz: number, bx: number, by: number, bz: number): number {
  return Math.max(Math.abs(rx) / bx, Math.abs(ry) / by, Math.abs(rz) / bz);
}

/** SPEC §7 weight: hard boundary at f=0, otherwise smoothstep of z=clamp((1-d)/f,0,1). */
export function fadeWeight(d: number, f: number): number {
  if (f === 0) return d <= 1 ? 1 : 0;
  const z = Math.min(1, Math.max(0, (1 - d) / f));
  return z * z * (3 - 2 * z);
}

export function compileField(field: FieldDefinition): CompiledField {
  const m = rotationMatrix(field.pose.rotation);
  const { direction, strength } = field.expression;
  const lx = strength * direction[0];
  const ly = strength * direction[1];
  const lz = strength * direction[2];
  const [bx, by, bz] = field.region.halfExtents;
  const [px, py, pz] = field.pose.position;
  return Object.freeze({
    id: field.id,
    enabled: field.enabled,
    px, py, pz,
    m: Object.freeze(m),
    bx, by, bz,
    fade: field.edgeFade,
    ax: m[0]! * lx + m[1]! * ly + m[2]! * lz,
    ay: m[3]! * lx + m[4]! * ly + m[5]! * lz,
    az: m[6]! * lx + m[7]! * ly + m[8]! * lz,
  });
}

/**
 * Samples the field's world-space drive at world point (x,y,z) into `out` and returns the
 * support weight. Local coordinates are r = Rᵀ(x - p). A disabled field and any point with
 * zero weight write exact positive zeros. K is identically zero for this primitive.
 */
export function sampleField(field: CompiledField, x: number, y: number, z: number, out: number[]): number {
  let weight = 0;
  if (field.enabled) {
    const { m } = field;
    const dx = x - field.px;
    const dy = y - field.py;
    const dz = z - field.pz;
    const rx = m[0]! * dx + m[3]! * dy + m[6]! * dz;
    const ry = m[1]! * dx + m[4]! * dy + m[7]! * dz;
    const rz = m[2]! * dx + m[5]! * dy + m[8]! * dz;
    weight = fadeWeight(boxGauge(rx, ry, rz, field.bx, field.by, field.bz), field.fade);
  }
  if (weight === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  } else {
    out[0] = weight * field.ax;
    out[1] = weight * field.ay;
    out[2] = weight * field.az;
  }
  return weight;
}
