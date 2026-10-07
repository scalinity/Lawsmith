// Numeric helpers shared by scene validation and the law registry (SPEC §9.3, §15.1). They import
// types only, so both can use them without a runtime dependency on each other.
import type { Quat, Vec3 } from './scene';

export const finite = (values: readonly number[]) => values.every(Number.isFinite);
export const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
/** Negative zero becomes positive zero, so equal values serialize and compare identically. */
export const unsign = (value: number) => (value === 0 ? 0 : value);
export const vec = (v: Vec3): Vec3 => [unsign(v[0]), unsign(v[1]), unsign(v[2])];

/** A stored unit value is kept as is when its norm is within this of 1 (SPEC §15.1), so save/load never drifts. */
const UNIT_RETAIN = 1e-12;

/**
 * Unit vector by scaled normalization: dividing by the largest magnitude first keeps the length
 * in [1, 2], so no finite nonzero input overflows or underflows. An input already within 1e-12
 * of unit length is retained unchanged. Null for zero or nonfinite input.
 */
function unit(values: readonly number[]): number[] | null {
  if (!finite(values)) return null;
  const scale = Math.max(...values.map(Math.abs));
  if (!(scale > 0)) return null;
  const scaled = values.map((c) => c / scale);
  const length = Math.hypot(...scaled);
  if (Math.abs(scale * length - 1) <= UNIT_RETAIN) return values.map(unsign);
  return scaled.map((c) => unsign(c / length));
}

/**
 * SPEC §15.1 canonical quaternion: a unit quaternion whose first nonzero component in the order
 * w, x, y, z is positive. Null for a zero or nonfinite quaternion.
 */
export function canonicalQuat(q: readonly number[]): Quat | null {
  const u = unit(q);
  if (!u) return null;
  const [x, y, z, w] = u as [number, number, number, number];
  const first = [w, x, y, z].find((c) => c !== 0)!;
  const sign = first < 0 ? -1 : 1;
  return [unsign(sign * x), unsign(sign * y), unsign(sign * z), unsign(sign * w)];
}

/** A canonical unit direction (no sign rule: a direction's sign is meaningful). */
export function canonicalDirection(v: readonly number[]): Vec3 | null {
  const u = unit(v);
  return u ? (u as unknown as Vec3) : null;
}
