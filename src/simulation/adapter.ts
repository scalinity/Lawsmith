// SPEC §9.1 force adapter. Every enabled law is sampled from the same start-of-step state and
// aggregated first, A = g + ΣA_i and K = ΣK_i; one stable drag factor β and one global limiter λ
// then apply to the total, and the host submits the result once. Nothing is applied per law.

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

/**
 * β(z) = −expm1(−z)/z for z = Kh > 0, and 1 at z = 0. expm1 keeps small positive Kh free of
 * cancellation, so β → 1 continuously without a cut-off.
 */
export function dragFactor(k: number, h: number): number {
  const z = k * h;
  return z === 0 ? 1 : -Math.expm1(-z) / z;
}

/**
 * The aggregate affine adapter: a* = β(Kh)·(A − K·v), then the limiter. Writes λ·a* into
 * out[0..2], β into out[3] and λ into out[4]. With K = 0, β = 1 and a* = A, the drive total itself.
 * In free space with A and K frozen over the step and λ = 1, the step gives
 * v_next = e^{−Kh}·v + (1 − e^{−Kh})/K·A.
 */
export function adaptAcceleration(
  ax: number,
  ay: number,
  az: number,
  k: number,
  vx: number,
  vy: number,
  vz: number,
  h: number,
  maxApplied: number,
  out: number[],
): void {
  let beta = 1;
  if (k !== 0) {
    beta = dragFactor(k, h);
    ax = beta * (ax - k * vx);
    ay = beta * (ay - k * vy);
    az = beta * (az - k * vz);
  }
  out[4] = limitAcceleration(ax, ay, az, maxApplied, out);
  out[3] = beta;
}
