// T07 (composition), the mathematics: sum, gain and mask on both A and K, nested masks in the law
// frame, the outer support applied once, triangle gain at known ticks, and stored evaluation order.
// Expected values are derived by hand from SPEC §6.3 and §7, never captured from the implementation.
import { describe, expect, it } from 'vitest';
import { validateField, type FieldDefinition, type FieldExpression, type Gain, type Quat, type Vec3 } from '../src/domain/scene';
import { gainAt, validateExpression } from '../src/fields/expression';
import { compileField, sampleField } from '../src/fields/kernel';

const P: Vec3 = [1, 2, 3];
const IDENTITY: Quat = [0, 0, 0, 1];
const s45 = Math.SQRT1_2;
/** +90° about Z: local +X points along world +Y. */
const Z90: Quat = [0, 0, s45, s45];

const dir = (strength: number, direction: Vec3 = [1, 0, 0]): FieldExpression => ({ kind: 'directional', direction, strength });
const drag = (coefficient: number): FieldExpression => ({ kind: 'linearDrag', coefficient });
const sum = (...terms: FieldExpression[]): FieldExpression => ({ kind: 'sum', terms });
const gain = (g: Gain | number, child: FieldExpression): FieldExpression => ({ kind: 'gain', gain: typeof g === 'number' ? { kind: 'constant', value: g } : g, child });
const sphereMask = (position: Vec3, radius: number, edgeFade: number, child: FieldExpression, rotation: Quat = IDENTITY): FieldExpression => ({
  kind: 'mask',
  pose: { position, rotation },
  region: { kind: 'sphere', radius },
  edgeFade,
  child,
});
const boxMask = (rotation: Quat, halfExtents: Vec3, edgeFade: number, child: FieldExpression, position: Vec3 = [0, 0, 0]): FieldExpression => ({
  kind: 'mask',
  pose: { position, rotation },
  region: { kind: 'box', halfExtents },
  edgeFade,
  child,
});

/** A law at P with a large hard box, so its outer weight is exactly 1 near the center unless a test says otherwise. */
function law(expression: FieldExpression, overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  const result = validateField({ id: 'law', enabled: true, pose: { position: P, rotation: IDENTITY }, region: { kind: 'box', halfExtents: [10, 10, 10] }, edgeFade: 0, expression, ...overrides });
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.value;
}

/** Samples a law at P + r (law-local r for an unrotated law) and tick n. */
function at(field: FieldDefinition, r: Vec3, n = 0) {
  const out = [NaN, NaN, NaN, NaN];
  const weight = sampleField(compileField(field), P[0] + r[0], P[1] + r[1], P[2] + r[2], n, out);
  return { A: out.slice(0, 3), K: out[3]!, weight };
}

const close = (actual: readonly number[], expected: readonly number[]) =>
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e)).toBeLessThanOrEqual(1e-9 + 1e-8 * Math.abs(e)));

describe('T07 A: two drives add', () => {
  it('A1 = [2,0,0] plus A2 = [0,3,0] is [2,3,0], with K = 0', () => {
    const { A, K } = at(law(sum(dir(2, [1, 0, 0]), dir(3, [0, 1, 0]))), [0.3, -0.4, 0.5]);
    expect(A).toEqual([2, 3, 0]);
    expect(K).toBe(0);
  });
});

describe('T07 B: two drags add', () => {
  it('K1 = 2 plus K2 = 3 is K = 5, with zero drive, equal to one K = 5 term', () => {
    const two = at(law(sum(drag(2), drag(3))), [0.3, -0.4, 0.5]);
    const one = at(law(drag(5)), [0.3, -0.4, 0.5]);
    expect(two.K).toBe(5);
    expect(two.A).toEqual([0, 0, 0]);
    expect(two).toEqual(one);
  });
});

describe('T07 C: gain scales both A and K', () => {
  it('gain 2 on [2,0,0] gives [4,0,0]; gain 2 on K = 3 gives K = 6', () => {
    expect(at(law(gain(2, dir(2))), [0, 0, 0]).A).toEqual([4, 0, 0]);
    const g = at(law(gain(2, drag(3))), [0, 0, 0]);
    expect(g.K).toBe(6);
    expect(g.A).toEqual([0, 0, 0]);
    // Both together: drive and drag of one child.
    const both = at(law(gain(2, sum(dir(2), drag(3)))), [0, 0, 0]);
    expect(both.A).toEqual([4, 0, 0]);
    expect(both.K).toBe(6);
  });

  it('gain 0 gives exact zero drive and drag for the whole subtree', () => {
    const { A, K, weight } = at(law(gain(0, sum(dir(200, [0.6, -0.8, 0]), drag(100), { kind: 'softRadial', strength: -200, coreRadius: 0.01 }))), [0.7, -0.2, 0.1]);
    expect(weight).toBe(1);
    for (const c of [...A, K]) expect(Object.is(c, 0)).toBe(true);
  });

  it('a gain of 1 leaves its child bit for bit', () => {
    const child = sum(dir(0.1), { kind: 'vortexY', strength: 7.3, coreRadius: 0.4 }, drag(0.7));
    expect(at(law(gain(1, child)), [0.31, 0.2, -0.77])).toEqual(at(law(child), [0.31, 0.2, -0.77]));
  });
});

describe('T07 D: a mask weights both A and K', () => {
  it('fade 0.25 at gauge d = 0.875 is weight 0.5, halving drive and drag', () => {
    // A unit-radius sphere mask at the law's center; r = [0.875,0,0] sits at d = 0.875.
    const { A, K } = at(law(sphereMask([0, 0, 0], 1, 0.25, sum(dir(2), drag(3)))), [0.875, 0, 0]);
    expect(A).toEqual([1, 0, 0]);
    expect(K).toBe(1.5);
  });

  it('is 1 inside the inner surface and 0 at and beyond the outer one', () => {
    const field = law(sphereMask([0, 0, 0], 1, 0.25, sum(dir(2), drag(3))));
    expect(at(field, [0.75, 0, 0])).toMatchObject({ A: [2, 0, 0], K: 3 });
    expect(at(field, [1, 0, 0])).toMatchObject({ A: [0, 0, 0], K: 0 });
    expect(at(field, [1.5, 0, 0])).toMatchObject({ A: [0, 0, 0], K: 0 });
  });
});

describe('T07 E: nested masks multiply', () => {
  it('two independent 0.5 weights give 0.25 on drive and drag; each mask pose is in the law frame', () => {
    // Outer mask: a unit box turned +90° about Z at the law's center; r = [0.875,0,0] is at its local
    // y = −0.875, d = 0.875, weight 0.5. Inner mask: a unit sphere at law-local [1.75,0,0]; r is 0.875
    // from it, weight 0.5. Composed in the outer mask's frame instead, the inner center would be at
    // [0,1.75,0] and r 1.96 away from it: weight 0.
    const field = law(boxMask(Z90, [1, 1, 1], 0.25, sphereMask([1.75, 0, 0], 1, 0.25, sum(dir(2), drag(3)))));
    const { A, K } = at(field, [0.875, 0, 0]);
    close(A, [0.5, 0, 0]);
    close([K], [0.75]);
  });
});

describe('T07 F: a mask moves support, never a vector frame (AC2)', () => {
  // A long box mask along its own X, turned +90° about Z: in the law frame it lies along Y.
  const masked = law(boxMask(Z90, [2, 0.5, 0.5], 0, dir(12, [1, 0, 0])));

  it('a rotated mask leaves the child directional along the law’s +X', () => {
    // r = [0,1.5,0] is inside the turned mask (its local x = 1.5): the drive is the law's [12,0,0],
    // not the mask-turned [0,12,0].
    expect(at(masked, [0, 1.5, 0]).A).toEqual([12, 0, 0]);
    // r = [1.5,0,0] is outside it (local y = −1.5 > 0.5).
    expect(at(masked, [1.5, 0, 0]).A).toEqual([0, 0, 0]);
  });

  it('a translated mask moves the region the child acts in, not the child’s center', () => {
    // A radial pull inside a sphere mask moved to [2,0,0]: at r = [2,0,0] the pull still points to the
    // law's center (−X), at the softened strength for |r| = 2.
    const field = law(sphereMask([2, 0, 0], 0.5, 0, { kind: 'softRadial', strength: 2, coreRadius: 1 }));
    close(at(field, [2, 0, 0]).A, [-4 / Math.sqrt(5), 0, 0]);
    expect(at(field, [0, 0, 0]).A).toEqual([0, 0, 0]);
  });

  it('the outer law rotation turns every primitive’s drive and every mask with the law', () => {
    // The law turned +90° about Z: local +X is world +Y. A sphere mask at law-local [1.5,0,0] sits at
    // world P + [0,1.5,0], and the directional drive inside it is world [0,12,0].
    const field = law(sphereMask([1.5, 0, 0], 1, 0, dir(12, [1, 0, 0])), { pose: { position: P, rotation: Z90 } });
    const out = [0, 0, 0, 0];
    sampleField(compileField(field), P[0], P[1] + 1.5, P[2], 0, out);
    close(out.slice(0, 3), [0, 12, 0]);
    sampleField(compileField(field), P[0] + 1.5, P[1], P[2], 0, out);
    expect(out.slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('signed radial and vortex strengths keep their sign under a mask', () => {
    // r = [1,0,0], ε = 1: radial −s·r/√2 and vortex s·(u × ρ)/√2 = s·[0,0,−1]/√2.
    const masked = (expression: FieldExpression) => at(law(sphereMask([0, 0, 0], 2, 0, expression)), [1, 0, 0]).A;
    close(masked({ kind: 'softRadial', strength: 2, coreRadius: 1 }), [-Math.SQRT2, 0, 0]);
    close(masked({ kind: 'softRadial', strength: -2, coreRadius: 1 }), [Math.SQRT2, 0, 0]);
    close(masked({ kind: 'vortexY', strength: 2, coreRadius: 1 }), [0, 0, -Math.SQRT2]);
    close(masked({ kind: 'vortexY', strength: -2, coreRadius: 1 }), [0, 0, Math.SQRT2]);
  });
});

describe('T07: the outer support applies exactly once', () => {
  it('fade 0.25 at d = 0.875 halves the whole expression once, not once per term', () => {
    // A box of half-extent 1, so r = [0.875,0,0] is at d = 0.875: 0.5·(2 + 0) and 0.5·(0 + 3).
    const field = law(sum(dir(2), drag(3)), { region: { kind: 'box', halfExtents: [1, 1, 1] }, edgeFade: 0.25 });
    const { A, K, weight } = at(field, [0.875, 0, 0]);
    expect(weight).toBe(0.5);
    expect(A).toEqual([1, 0, 0]);
    expect(K).toBe(1.5);
  });

  it('a disabled compound law contributes exact zeros', () => {
    const { A, K, weight } = at(law(sum(dir(2), drag(3)), { enabled: false }), [0, 0, 0]);
    expect(weight).toBe(0);
    for (const c of [...A, K]) expect(Object.is(c, 0)).toBe(true);
  });
});

describe('T07 G: triangle gain at known ticks (AC4)', () => {
  const tri = (min: number, max: number, periodTicks: number, phaseTicks: number): Gain => ({ kind: 'triangle', min, max, periodTicks, phaseTicks });

  it('min 0, max 4, period 8, phase 0: 0, 2, 4, 2, 0 at ticks 0, 2, 4, 6, 8', () => {
    const g = tri(0, 4, 8, 0);
    expect([0, 2, 4, 6, 8].map((n) => gainAt(g, n))).toEqual([0, 2, 4, 2, 0]);
    expect([1, 3, 5, 7].map((n) => gainAt(g, n))).toEqual([1, 3, 3, 1]);
  });

  it('phase 2 shifts the same curve by exactly two ticks, wrapping at the period', () => {
    const base = tri(0, 4, 8, 0);
    const shifted = tri(0, 4, 8, 2);
    for (let n = 0; n < 40; n++) expect(gainAt(shifted, n)).toBe(gainAt(base, n + 2));
    expect([0, 2, 4, 6, 8].map((n) => gainAt(shifted, n))).toEqual([2, 4, 2, 0, 2]);
  });

  it('a nonzero min lifts the floor: min 1, max 3, period 4', () => {
    expect([0, 1, 2, 3, 4].map((n) => gainAt(tri(1, 3, 4, 0), n))).toEqual([1, 2, 3, 2, 1]);
  });

  it('forms (n + phase) mod period without rounding at the largest safe ticks', () => {
    // n = 2⁵³ − 1, phase 6, period 8: (2⁵³ + 5) mod 8 = 5, q = 0.625, g = 4·(1 − 0.25) = 3. The
    // naive n + phase is not representable and would round to a neighbouring residue.
    expect(gainAt(tri(0, 4, 8, 6), Number.MAX_SAFE_INTEGER)).toBe(3);
    // The largest period: n = P − 1, phase P − 1 → (2P − 2) mod P = P − 2.
    const P = Number.MAX_SAFE_INTEGER;
    expect(gainAt(tri(0, 4, P, P - 1), P - 1)).toBe(0 + 4 * (1 - Math.abs((2 * (P - 2)) / P - 1)));
  });

  it('drives the compiled law: drive and drag follow g(n), and the same tick always gives the same value', () => {
    const field = compileField(law(gain(tri(0, 4, 8, 0), sum(dir(1), drag(1)))));
    expect(field.timeDependent).toBe(true);
    const out = [0, 0, 0, 0];
    for (const [n, g] of [[0, 0], [2, 2], [4, 4], [6, 2], [8, 0], [12, 4]] as const) {
      sampleField(field, P[0], P[1], P[2], n, out);
      expect(out).toEqual([g, 0, 0, g]);
    }
    // A paused tick, sampled again and again: one value.
    const first = [0, 0, 0, 0];
    sampleField(field, P[0], P[1], P[2], 5, first);
    for (let i = 0; i < 100; i++) {
      sampleField(field, P[0], P[1], P[2], 5, out);
      expect(out).toEqual(first);
    }
  });

  it('a stationary law is not tick-dependent, and a constant gain is not either', () => {
    expect(compileField(law(gain(3, sum(dir(1), drag(1))))).timeDependent).toBe(false);
    expect(compileField(law(dir(1))).timeDependent).toBe(false);
  });
});

describe('T07 H: stored sum order is the evaluation order', () => {
  // 0.1, 0.2 and 0.3 are not associative in binary floating point: (0.1 + 0.2) + 0.3 = 0.6000000000000001
  // while (0.3 + 0.2) + 0.1 = 0.6 and 0.1 + (0.2 + 0.3) = 0.6. Directional drive is strength × 1, exact.
  const leftToRight = (a: number, b: number, c: number) => a + b + c;

  it('the fixture is order-sensitive', () => {
    expect(leftToRight(0.1, 0.2, 0.3)).not.toBe(leftToRight(0.3, 0.2, 0.1));
  });

  it('A and K are summed left to right in stored order, whatever the order', () => {
    for (const [a, b, c] of [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.2, 0.3, 0.1]]) {
      const drive = at(law(sum(dir(a!), dir(b!), dir(c!))), [0, 0, 0]);
      expect(drive.A[0]).toBe(leftToRight(a!, b!, c!));
      const drags = at(law(sum(drag(a!), drag(b!), drag(c!))), [0, 0, 0]);
      expect(drags.K).toBe(leftToRight(a!, b!, c!));
    }
  });

  it('nesting is kept: (0.1 + 0.2) + 0.3 and 0.1 + (0.2 + 0.3) stay different trees with different sums', () => {
    expect(at(law(sum(sum(dir(0.1), dir(0.2)), dir(0.3))), [0, 0, 0]).A[0]).toBe((0.1 + 0.2) + 0.3);
    expect(at(law(sum(dir(0.1), sum(dir(0.2), dir(0.3)))), [0, 0, 0]).A[0]).toBe(0.1 + (0.2 + 0.3));
  });

  it('validation keeps the stored term order', () => {
    const result = validateExpression(sum(drag(3), dir(2), drag(1)));
    expect(result.ok && result.value.kind === 'sum' && result.value.terms.map((t) => t.kind)).toEqual(['linearDrag', 'directional', 'linearDrag']);
  });
});

describe('T07: K stays nonnegative and every output finite', () => {
  it('across seeded random trees, points and ticks', () => {
    let state = 0x9e3779b9;
    const random = () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 2 ** 32;
    };
    const pick = (lo: number, hi: number) => lo + (hi - lo) * random();
    const leaf = (): FieldExpression => {
      const k = random();
      if (k < 0.25) return dir(pick(0, 200), [pick(-1, 1), pick(-1, 1), pick(0.1, 1)]);
      if (k < 0.5) return { kind: 'softRadial', strength: pick(-200, 200), coreRadius: pick(0.01, 2) };
      if (k < 0.75) return { kind: 'vortexY', strength: pick(-200, 200), coreRadius: pick(0.01, 2) };
      return drag(pick(0, 100));
    };
    const tree = (depth: number): FieldExpression => {
      const k = random();
      if (depth >= 4 || k < 0.3) return leaf();
      if (k < 0.55) return sum(tree(depth + 1), tree(depth + 1));
      if (k < 0.8) {
        const min = pick(0, 16);
        return gain(random() < 0.5 ? pick(0, 16) : { kind: 'triangle', min, max: pick(min, 16), periodTicks: 2 + Math.floor(pick(0, 500)), phaseTicks: 0 }, tree(depth + 1));
      }
      return sphereMask([pick(-2, 2), pick(-2, 2), pick(-2, 2)], pick(0.5, 3), pick(0, 1), tree(depth + 1));
    };
    const out = [0, 0, 0, 0];
    for (let t = 0; t < 200; t++) {
      const field = compileField(law(tree(1), { pose: { position: P, rotation: [pick(-1, 1), pick(-1, 1), pick(-1, 1), pick(-1, 1)] } }));
      for (let s = 0; s < 50; s++) {
        sampleField(field, P[0] + pick(-4, 4), P[1] + pick(-4, 4), P[2] + pick(-4, 4), Math.floor(pick(0, 1e6)), out);
        expect(out.every(Number.isFinite)).toBe(true);
        expect(out[3]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
