// SPEC §9.1 force adapter on its K=0 path, which is all M1 needs: no M1 law has drag, so
// K = 0, beta(0) = 1 and the external acceleration is the drive total a* = A = g + ΣA_i.
// The beta/expm1 drag factor arrives with the linear-drag primitive in M3.

/**
 * Applies the documented global magnitude limit to a* and writes λ·a* into `out`.
 * λ = min(1, maxApplied/|a*|), with λ = 1 for a zero vector. Returns λ.
 */
export function limitAcceleration(ax: number, ay: number, az: number, maxApplied: number, out: number[]): number {
  const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
  const lambda = magnitude === 0 ? 1 : Math.min(1, maxApplied / magnitude);
  out[0] = lambda * ax;
  out[1] = lambda * ay;
  out[2] = lambda * az;
  return lambda;
}
