// T01 (box support/fade) and T02 (directional primitive), M1 cases. Expected values are
// derived by hand from SPEC §6.2/§7, not captured from the implementation.
import { describe, expect, it } from 'vitest';
import { STARTING_RECIPE, validateField, type FieldDefinition, type Quat } from '../src/domain/scene';
import { boxGauge, compileField, fadeWeight, rotationMatrix, sampleField } from '../src/fields/directional';

/** SPEC §17.1 component tolerance for pure CPU fixtures. */
const tol = (expected: number) => 1e-9 + 1e-8 * Math.abs(expected);
function expectVec(actual: readonly number[], expected: readonly number[]) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e)).toBeLessThanOrEqual(tol(e)));
}

const law = STARTING_RECIPE.fields[0]!;
const QZ90: Quat = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
const withChanges = (changes: Partial<FieldDefinition>): FieldDefinition => ({ ...law, ...changes });
const sample = (field: FieldDefinition, x: number, y: number, z: number) => {
  const out = [NaN, NaN, NaN];
  const weight = sampleField(compileField(field), x, y, z, out);
  return { weight, out };
};

describe('T01 box support and fade', () => {
  it('fade values are 1, 0.5 and 0 at d = 0.75, 0.875 and 1 for f = 0.25', () => {
    expect(fadeWeight(0.75, 0.25)).toBe(1);
    expect(fadeWeight(0.875, 0.25)).toBe(0.5);
    expect(fadeWeight(1, 0.25)).toBe(0);
  });

  it('is fully active inside 1 - f and zero beyond the outer boundary', () => {
    expect(fadeWeight(0, 0.25)).toBe(1);
    expect(fadeWeight(0.5, 0.25)).toBe(1);
    expect(fadeWeight(1.2, 0.25)).toBe(0);
    // z = 0.2 → 0.2²·(3 − 0.4) = 0.104
    expect(Math.abs(fadeWeight(0.95, 0.25) - 0.104)).toBeLessThanOrEqual(tol(0.104));
  });

  it('f = 0 is an explicit hard boundary', () => {
    expect(fadeWeight(1, 0)).toBe(1);
    expect(fadeWeight(0.999, 0)).toBe(1);
    expect(fadeWeight(1 + 1e-12, 0)).toBe(0);
  });

  it('the box gauge is the largest normalized axis ratio', () => {
    expect(boxGauge(0, 0, 0, 1.5, 2, 1.5)).toBe(0);
    expect(boxGauge(0.75, -1, 0.3, 1.5, 2, 1.5)).toBe(0.5);
    expect(boxGauge(0, 0, -1.5, 1.5, 2, 1.5)).toBe(1);
  });

  it('samples the recipe law at center, interior, fade band, boundary and outside', () => {
    // Center [3,1,0], half-extents [1.5,2,1.5], f = 0.25, strength 12 along +X.
    expect(sample(law, 3, 1, 0).weight).toBe(1);
    expectVec(sample(law, 3, 1, 0).out, [12, 0, 0]);
    expect(sample(law, 3 + 0.75, 1 - 1, 0.5).weight).toBe(1); // d = 0.5
    const band = sample(law, 3 + 0.875 * 1.5, 1, 0); // d = 0.875
    expect(band.weight).toBe(0.5);
    expectVec(band.out, [6, 0, 0]);
    expect(sample(law, 4.5, 1, 0).weight).toBe(0); // d = 1 on +X face
    expect(sample(law, 3, 3, 0).weight).toBe(0); // d = 1 on +Y face
    const outside = sample(law, 0, 1, 0);
    expect(outside.weight).toBe(0);
    outside.out.forEach((c) => expect(Object.is(c, 0)).toBe(true));
  });

  it('rotating the field rotates its support', () => {
    // +90° about Z maps local +X to world +Y, so the world X reach becomes the local Y half-extent (2).
    const rotated = withChanges({ pose: { position: [3, 1, 0], rotation: QZ90 } });
    // World offset [1.9,0,0] → local [0,−1.9,0] → d = 0.95 → weight 0.104; unrotated it is outside.
    expect(Math.abs(sample(rotated, 4.9, 1, 0).weight - 0.104)).toBeLessThanOrEqual(1e-8);
    expect(sample(law, 4.9, 1, 0).weight).toBe(0);
    // World offset [0,1.6,0] → local [1.6,0,0] → d = 1.07 → outside; unrotated d = 0.8 → 0.896.
    expect(sample(rotated, 3, 2.6, 0).weight).toBe(0);
    expect(Math.abs(sample(law, 3, 2.6, 0).weight - 0.896)).toBeLessThanOrEqual(tol(0.896));
  });

  it('resizing support changes reach but not full-strength magnitude', () => {
    const resized = withChanges({ region: { kind: 'box', halfExtents: [3, 4, 3] } });
    expectVec(sample(resized, 3, 1, 0).out, [12, 0, 0]);
    expectVec(sample(withChanges({ region: { kind: 'box', halfExtents: [0.2, 0.2, 0.2] } }), 3, 1, 0).out, [12, 0, 0]);
    // The larger box now reaches x = 5.5 (d = 0.833 → z = 0.667 → 0.741), where the recipe box is zero.
    expect(sample(law, 5.5, 1, 0).weight).toBe(0);
    expect(sample(resized, 5.5, 1, 0).weight).toBeGreaterThan(0.7);
  });
});

describe('T02 directional primitive', () => {
  it('local full-support [12,0,0] becomes [0,12,0] after a +90° Z rotation', () => {
    expectVec(sample(law, 3, 1, 0).out, [12, 0, 0]);
    const rotated = withChanges({ pose: { position: [3, 1, 0], rotation: QZ90 } });
    expectVec(sample(rotated, 3, 1, 0).out, [0, 12, 0]);
  });

  it('a disabled law contributes exact zeros everywhere', () => {
    const off = withChanges({ enabled: false });
    const { weight, out } = sample(off, 3, 1, 0);
    expect(weight).toBe(0);
    out.forEach((c) => expect(Object.is(c, 0)).toBe(true));
  });

  it('outputs are finite at the center, on the axes and on every face', () => {
    const rotated = withChanges({ pose: { position: [3, 1, 0], rotation: QZ90 } });
    const points: [number, number, number][] = [];
    for (const s of [-1, -0.875, -0.75, 0, 0.75, 0.875, 1, 1.5]) {
      points.push([3 + s * 1.5, 1, 0], [3, 1 + s * 2, 0], [3, 1, s * 1.5], [3 + s * 1.5, 1 + s * 2, s * 1.5]);
    }
    for (const field of [law, rotated]) {
      for (const [x, y, z] of points) sample(field, x, y, z).out.forEach((c) => expect(Number.isFinite(c)).toBe(true));
    }
  });

  it('rotation matrices are orthonormal', () => {
    for (const q of [[0, 0, 0, 1], QZ90, [0.2, -0.4, 0.1, 0.888819441731559]] as Quat[]) {
      const m = rotationMatrix(q);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const dot = m[3 * i]! * m[3 * j]! + m[3 * i + 1]! * m[3 * j + 1]! + m[3 * i + 2]! * m[3 * j + 2]!;
          expect(Math.abs(dot - (i === j ? 1 : 0))).toBeLessThanOrEqual(1e-8);
        }
      }
    }
  });
});

describe('field validation (SPEC §9.3)', () => {
  it('normalizes direction and rotation on acceptance', () => {
    const result = validateField(
      withChanges({
        pose: { position: [3, 1, 0], rotation: [0, 0, 0, 2] },
        expression: { kind: 'directional', direction: [3, 0, 4], strength: 12 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pose.rotation).toEqual([0, 0, 0, 1]);
    expectVec(result.value.expression.direction, [0.6, 0, 0.8]);
    expect(Object.isFrozen(result.value.pose.position)).toBe(true);
  });

  it('normalizes very large finite rotations and directions to finite unit values', () => {
    const big = Number.MAX_VALUE;
    const result = validateField(
      withChanges({
        pose: { position: [3, 1, 0], rotation: [1e308, 1e308, 1e308, 1e308] },
        expression: { kind: 'directional', direction: [big, big, big], strength: 12 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = (v: readonly number[]) => Math.sqrt(v.reduce((sum, c) => sum + c * c, 0));
    expectVec(result.value.pose.rotation, [0.5, 0.5, 0.5, 0.5]);
    expectVec(result.value.expression.direction, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
    expect(Math.abs(unit(result.value.pose.rotation) - 1)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(unit(result.value.expression.direction) - 1)).toBeLessThanOrEqual(1e-8);
  });

  it('normalizes very small nonzero rotations and directions without underflow', () => {
    const result = validateField(
      withChanges({
        pose: { position: [3, 1, 0], rotation: [0, 0, 0, 1e-300] },
        expression: { kind: 'directional', direction: [0, 5e-324, 0], strength: 12 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pose.rotation).toEqual([0, 0, 0, 1]);
    expect(result.value.expression.direction).toEqual([0, 1, 0]);
  });

  it.each([
    ['a half-extent below 0.01 m', { region: { kind: 'box', halfExtents: [0.005, 2, 1.5] } }],
    ['a negative half-extent', { region: { kind: 'box', halfExtents: [-1.5, 2, 1.5] } }],
    ['a position beyond ±1000 m', { pose: { position: [1001, 1, 0], rotation: [0, 0, 0, 1] } }],
    ['a nonfinite position', { pose: { position: [NaN, 1, 0], rotation: [0, 0, 0, 1] } }],
    ['a zero quaternion', { pose: { position: [3, 1, 0], rotation: [0, 0, 0, 0] } }],
    ['strength above 200 m/s²', { expression: { kind: 'directional', direction: [1, 0, 0], strength: 201 } }],
    ['a zero direction', { expression: { kind: 'directional', direction: [0, 0, 0], strength: 12 } }],
    ['fade above 1', { edgeFade: 1.5 }],
    ['a reserved separator in the id', { id: 'stream:1' }],
  ] as [string, Partial<FieldDefinition>][])('rejects %s', (_, changes) => {
    expect(validateField(withChanges(changes)).ok).toBe(false);
  });
});
