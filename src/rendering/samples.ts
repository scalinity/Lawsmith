// Sparse spatial samples of one law (SPEC §12): the host's compiled evaluator read at lattice points
// over the law's bounding box, with nothing recomputed or guessed. A drive sample becomes an arrow
// along A itself; a drag sample has no direction of its own, so it carries only K.
import type { Vec3 } from '../domain/scene';
import { sampleField, type CompiledField } from '../fields/kernel';

/** Lattices as fractions of each local bounding half-extent. The selected law's outer layer sits at d = 0.875, where f = 0.25 gives weight 0.5. */
export const SELECTED_LATTICE: readonly number[] = [-0.875, -0.4375, 0, 0.4375, 0.875];
export const OTHER_LATTICE: readonly number[] = [-0.5, 0.5];
/** SPEC §12's per-law cap: 125 samples. */
export const MAX_SAMPLES = SELECTED_LATTICE.length ** 3;
/** Drive below this magnitude is not drawn (SPEC §12 near-zero display threshold), in m/s². */
export const ARROW_MIN_MS2 = 0.05;
/** Drag below this rate is not drawn, in s⁻¹. */
export const DOT_MIN_PER_S = 0.01;

/** Values per entry: an arrow is x, y, z, Ax, Ay, Az; a dot is x, y, z, K. */
export const ARROW_STRIDE = 6;
export const DOT_STRIDE = 4;

const sample = [0, 0, 0, 0];

/**
 * Evaluates the law at each lattice point of its local bounding box at tick n: an arrow wherever |A|
 * reaches ARROW_MIN_MS2 and a dot wherever K reaches DOT_MIN_PER_S, written into the two buffers. The
 * view passes the host's current tick, the one its next step samples.
 */
export function sampleLattice(c: CompiledField, bounds: Vec3, lattice: readonly number[], tick: number, arrows: Float64Array, dots: Float64Array): { arrows: number; dots: number } {
  const { m } = c;
  let n = 0;
  let d = 0;
  for (const fx of lattice) {
    for (const fy of lattice) {
      for (const fz of lattice) {
        const rx = fx * bounds[0];
        const ry = fy * bounds[1];
        const rz = fz * bounds[2];
        const wx = c.px + m[0]! * rx + m[1]! * ry + m[2]! * rz;
        const wy = c.py + m[3]! * rx + m[4]! * ry + m[5]! * rz;
        const wz = c.pz + m[6]! * rx + m[7]! * ry + m[8]! * rz;
        sampleField(c, wx, wy, wz, tick, sample);
        if (sample[3]! >= DOT_MIN_PER_S) {
          dots.set([wx, wy, wz, sample[3]!], DOT_STRIDE * d++);
        }
        if (Math.hypot(sample[0]!, sample[1]!, sample[2]!) >= ARROW_MIN_MS2) {
          arrows.set([wx, wy, wz, sample[0]!, sample[1]!, sample[2]!], ARROW_STRIDE * n++);
        }
      }
    }
  }
  return { arrows: n, dots: d };
}
