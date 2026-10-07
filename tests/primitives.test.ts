// T01 (sphere and Y-cylinder support, all three regions under rotation and resizing) and T02
// (soft radial, vortex and linear drag) for M3, plus the registry's own consistency. Expected values
// are worked by hand from SPEC §6.2 and §7, never captured from the implementation.
import { describe, expect, it } from 'vitest';
import { LAW_COLORS, validateField, type FieldDefinition, type Primitive, type Quat, type RegionDefinition, type Vec3 } from '../src/domain/scene';
import { compileField, sampleField } from '../src/fields/kernel';
import { LAW_CAPABILITIES, PRIMITIVES, REGIONS, primitiveDescriptor, regionDescriptor } from '../src/fields/registry';

/** SPEC §17.1 component tolerance for pure CPU fixtures. */
const tol = (expected: number) => 1e-9 + 1e-8 * Math.abs(expected);
function expectVec(actual: readonly number[], expected: readonly number[]) {
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `component ${i}: ${actual[i]} vs ${e}`).toBeLessThanOrEqual(tol(e)));
}
const isZero = (values: readonly number[]) => values.every((v) => v === 0);

const IDENTITY: Quat = [0, 0, 0, 1];
const QZ90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const QX90: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const CENTER: Vec3 = [1, 2, 3];
const BIG: RegionDefinition = { kind: 'sphere', radius: 50 };

function law(expression: Primitive, region: RegionDefinition = BIG, changes: Partial<FieldDefinition> = {}): FieldDefinition {
  const result = validateField({ id: 'law', enabled: true, pose: { position: CENTER, rotation: IDENTITY }, region, edgeFade: 0.25, expression, ...changes });
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.value;
}

/** Samples at CENTER + offset: { A, K, weight }. */
function at(field: FieldDefinition, offset: Vec3) {
  const out = [NaN, NaN, NaN, NaN];
  const weight = sampleField(compileField(field), CENTER[0] + offset[0], CENTER[1] + offset[1], CENTER[2] + offset[2], out);
  return { A: out.slice(0, 3), K: out[3]!, weight };
}

const push: Primitive = { kind: 'directional', direction: [1, 0, 0], strength: 12 };
const weightAt = (region: RegionDefinition, offset: Vec3, changes: Partial<FieldDefinition> = {}) => at(law(push, region, changes), offset).weight;

describe('T01 sphere support', () => {
  const sphere: RegionDefinition = { kind: 'sphere', radius: 2 };

  it('is fully active through d = 1 − f, half at d = 0.875 and zero from d = 1 (f = 0.25)', () => {
    expect(weightAt(sphere, [0, 0, 0])).toBe(1);
    expect(weightAt(sphere, [1.5, 0, 0])).toBe(1); // d = 0.75, the full-strength boundary
    expect(weightAt(sphere, [0, 1.75, 0])).toBe(0.5); // d = 0.875
    expect(weightAt(sphere, [0, 0, 2])).toBe(0); // d = 1
    expect(weightAt(sphere, [0, 0, -2.5])).toBe(0);
  });

  it('is spherical: the same d in every direction, and the bounding box corner is outside', () => {
    const r = 1.75 / Math.sqrt(3);
    expect(Math.abs(weightAt(sphere, [r, -r, r]) - 0.5)).toBeLessThanOrEqual(1e-12);
    expect(weightAt(sphere, [1.2, 1.2, 1.2])).toBe(0); // |r| = 2.078 > 2, inside the bounding box
  });

  it('f = 0 is a hard boundary', () => {
    expect(weightAt(sphere, [0, 2, 0], { edgeFade: 0 })).toBe(1);
    expect(weightAt(sphere, [0, 2 + 1e-9, 0], { edgeFade: 0 })).toBe(0);
  });

  it('resizing changes its reach, never the primitive: the same radial drive at the same point', () => {
    const pull: Primitive = { kind: 'softRadial', strength: 8, coreRadius: 0.25 };
    expect(weightAt(sphere, [3, 0, 0])).toBe(0);
    expect(weightAt({ kind: 'sphere', radius: 4 }, [3, 0, 0])).toBe(1); // d = 0.75
    // At |r| = 1 both radii give weight 1: A = −8·r/sqrt(1 + 0.0625), independent of the radius.
    const expected = [-8 / Math.sqrt(1.0625), 0, 0];
    expectVec(at(law(pull, sphere), [1, 0, 0]).A, expected);
    expectVec(at(law(pull, { kind: 'sphere', radius: 4 }), [1, 0, 0]).A, expected);
  });
});

describe('T01 Y-cylinder support', () => {
  const cylinder: RegionDefinition = { kind: 'cylinderY', radius: 2, halfHeight: 1 };

  it('uses d = max(sqrt(rx² + rz²)/s, |ry|/H)', () => {
    expect(weightAt(cylinder, [0, 0, 0])).toBe(1);
    expect(weightAt(cylinder, [1.5, 0, 0])).toBe(1); // radial 0.75
    expect(weightAt(cylinder, [0, 0.875, 0])).toBe(0.5); // axial 0.875
    expect(weightAt(cylinder, [0, 0, 2])).toBe(0); // radial exactly 1
    // 1.2² + 1.6² is 4 only up to rounding: d = 1 − 1 ulp, so the weight is ~1e-31, not 0.
    expect(weightAt(cylinder, [1.2, 0, 1.6])).toBeLessThanOrEqual(1e-12);
    // max(0.8, 0.9) = 0.9 → z = 0.4 → 0.16 · 2.2 = 0.352
    expect(Math.abs(weightAt(cylinder, [0, 0.9, 1.6]) - 0.352)).toBeLessThanOrEqual(tol(0.352));
    expect(weightAt(cylinder, [0, 1.01, 0])).toBe(0);
  });

  it('has a circular cross-section: X, Z and the diagonal agree, and the box corner is outside', () => {
    const r = 1.75 / Math.SQRT2;
    expect(weightAt(cylinder, [1.75, 0, 0])).toBe(0.5);
    expect(weightAt(cylinder, [0, 0, -1.75])).toBe(0.5);
    expect(Math.abs(weightAt(cylinder, [r, 0.2, -r]) - 0.5)).toBeLessThanOrEqual(1e-12);
    expect(weightAt(cylinder, [1.9, 0, 1.9])).toBe(0);
  });

  it('rotates its axis with the law: +90° about Z turns local Y into world −X', () => {
    const rotated = { pose: { position: CENTER, rotation: QZ90 } };
    // World offset [0.875,0,0] is local [0,−0.875,0]: axial 0.875 → 0.5; unrotated it is radial 0.4375 → 1.
    expect(Math.abs(weightAt(cylinder, [0.875, 0, 0], rotated) - 0.5)).toBeLessThanOrEqual(1e-12);
    expect(weightAt(cylinder, [0.875, 0, 0])).toBe(1);
    expect(weightAt(cylinder, [0, 1.5, 0], rotated)).toBe(1); // local [1.5,0,0]: radial 0.75
  });

  it('resizes radius and half-height separately', () => {
    // radius 3: radial d = 2.5/3 → z = 2/3 → (4/9)(3 − 4/3) = 20/27
    expect(Math.abs(weightAt({ kind: 'cylinderY', radius: 3, halfHeight: 1 }, [2.5, 0, 0]) - 20 / 27)).toBeLessThanOrEqual(tol(20 / 27));
    expect(weightAt({ kind: 'cylinderY', radius: 3, halfHeight: 1 }, [0, 0.95, 0])).toBe(weightAt(cylinder, [0, 0.95, 0]));
    expect(weightAt({ kind: 'cylinderY', radius: 2, halfHeight: 3 }, [0, 2.25, 0])).toBe(1); // axial 0.75
  });
});

describe('T01 rotated box support', () => {
  it('rotation about X swaps the Y and Z reach', () => {
    const box: RegionDefinition = { kind: 'box', halfExtents: [1, 1, 3] };
    const rotated = { pose: { position: CENTER, rotation: QX90 } };
    // +90° about X maps local Z to world −Y: world [0,2.25,0] is local [0,0,−2.25] → 0.75 → 1.
    expect(weightAt(box, [0, 2.25, 0], rotated)).toBe(1);
    expect(weightAt(box, [0, 2.25, 0])).toBe(0);
  });
});

describe('T02 soft radial', () => {
  const pull = (strength: number, coreRadius = 1): Primitive => ({ kind: 'softRadial', strength, coreRadius });

  it('r = [1,0,0], ε = 1, strength 2 gives [−√2, 0, 0]', () => {
    const sample = at(law(pull(2)), [1, 0, 0]);
    expect(sample.weight).toBe(1);
    expectVec(sample.A, [-Math.SQRT2, 0, 0]);
    expect(sample.K).toBe(0);
  });

  it('is exactly zero at the center, finite with the smallest core and largest strength', () => {
    expect(isZero(at(law(pull(2)), [0, 0, 0]).A)).toBe(true);
    expect(isZero(at(law(pull(200, 0.01)), [0, 0, 0]).A)).toBe(true);
    const near = at(law(pull(200, 0.01)), [1e-9, 0, 0]).A;
    near.forEach((c) => expect(Number.isFinite(c)).toBe(true));
    expectVec(near, [-200 * 1e-9 / Math.sqrt(1e-18 + 1e-4), 0, 0]);
  });

  it('negative strength repels', () => {
    expectVec(at(law(pull(-2)), [1, 0, 0]).A, [Math.SQRT2, 0, 0]);
  });

  it('is A = −s·r/sqrt(r·r + ε²) away from the axes, not inverse-square', () => {
    // r = [3,4,0]: sqrt(26); a 1/r² law would give 2/25 along −r̂ instead.
    expectVec(at(law(pull(2)), [3, 4, 0]).A, [-6 / Math.sqrt(26), -8 / Math.sqrt(26), 0]);
  });

  it('points at the law center whatever the law rotation', () => {
    expectVec(at(law(pull(2), BIG, { pose: { position: CENTER, rotation: QZ90 } }), [1, 0, 0]).A, [-Math.SQRT2, 0, 0]);
  });
});

describe('T02 vortex about local Y', () => {
  const swirl = (strength: number, coreRadius = 1): Primitive => ({ kind: 'vortexY', strength, coreRadius });

  it('r = [1,0,0], ε = 1, strength 2 gives [0, 0, −√2]; negative strength reverses it', () => {
    expectVec(at(law(swirl(2)), [1, 0, 0]).A, [0, 0, -Math.SQRT2]);
    expectVec(at(law(swirl(-2)), [1, 0, 0]).A, [0, 0, Math.SQRT2]);
    expectVec(at(law(swirl(2)), [0, 0, 1]).A, [Math.SQRT2, 0, 0]); // u × [0,0,1] = [1,0,0]
  });

  it('is exactly zero on the axis at any height, and independent of height elsewhere', () => {
    expect(isZero(at(law(swirl(2)), [0, 0.5, 0]).A)).toBe(true);
    expect(isZero(at(law(swirl(200, 0.01)), [0, -3, 0]).A)).toBe(true);
    expectVec(at(law(swirl(2)), [1, 0.7, 0]).A, [0, 0, -Math.SQRT2]);
  });

  it('has no radial or axial component: A·r = 0 and A_y = 0', () => {
    const { A } = at(law(swirl(5, 0.3)), [0.4, -1.1, -2.3]);
    expect(Math.abs(A[0]! * 0.4 + A[2]! * -2.3)).toBeLessThanOrEqual(1e-12);
    expect(A[1]).toBe(0);
  });

  it('rotates with the law: +90° about X turns the local −Z drive at +X into world +Y', () => {
    expectVec(at(law(swirl(2), BIG, { pose: { position: CENTER, rotation: QX90 } }), [1, 0, 0]).A, [0, Math.SQRT2, 0]);
  });
});

describe('T02 linear drag', () => {
  const drag: Primitive = { kind: 'linearDrag', coefficient: 2 };

  it('has zero drive and K = 2 in full support, scaled by the support weight in the fade band', () => {
    const inside = at(law(drag, { kind: 'sphere', radius: 2 }), [0.5, 0, 0]);
    expect(isZero(inside.A)).toBe(true);
    expect(inside.K).toBe(2);
    expect(at(law(drag, { kind: 'sphere', radius: 2 }), [0, 1.75, 0]).K).toBe(1);
    expect(at(law(drag, { kind: 'sphere', radius: 2 }), [0, 2, 0]).K).toBe(0);
  });

  it('K does not rotate: rotating the region turns only its support', () => {
    const box: RegionDefinition = { kind: 'box', halfExtents: [3, 0.5, 0.5] };
    const rotated = law(drag, box, { pose: { position: CENTER, rotation: QZ90 } });
    expect(at(rotated, [0, 2, 0]).K).toBe(2); // local [2,0,0]: inside the long axis
    expect(at(law(drag, box), [0, 2, 0]).K).toBe(0);
    expect(isZero(at(rotated, [0, 2, 0]).A)).toBe(true);
  });
});

describe('disabled laws and finite outputs (T02, AC1)', () => {
  const regions: RegionDefinition[] = [{ kind: 'box', halfExtents: [1, 2, 3] }, { kind: 'sphere', radius: 2 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 }];
  const primitives = Object.values(PRIMITIVES).map((d) => d.defaults as Primitive);

  it('a disabled law of every kind returns exact zeros', () => {
    for (const region of regions) {
      for (const expression of primitives) {
        const { A, K, weight } = at(law(expression, region, { enabled: false }), [0, 0, 0]);
        expect(weight).toBe(0);
        [...A, K].forEach((c) => expect(Object.is(c, 0)).toBe(true));
      }
    }
  });

  it('every kind is finite at its center, on its axes and boundaries, and outside', () => {
    const offsets: Vec3[] = [];
    for (const s of [-1.5, -1, -0.875, -0.5, 0, 0.5, 0.875, 1, 1.5]) offsets.push([s, 0, 0], [0, s, 0], [0, 0, s], [s, s, s], [s, -s, 0.5 * s]);
    for (const region of regions) {
      for (const expression of [...primitives, { kind: 'softRadial', strength: -200, coreRadius: 0.01 } as Primitive, { kind: 'vortexY', strength: 200, coreRadius: 0.01 } as Primitive]) {
        for (const rotation of [IDENTITY, QZ90, QX90]) {
          const field = law(expression, region, { pose: { position: CENTER, rotation } });
          for (const o of offsets) {
            const { A, K } = at(field, o);
            [...A, K].forEach((c) => expect(Number.isFinite(c)).toBe(true));
            expect(K).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe('registry', () => {
  it('provides exactly the M3 capabilities, in the versioned naming of M2', () => {
    expect([...LAW_CAPABILITIES].sort()).toEqual([
      'primitive.directional.v1',
      'primitive.linearDrag.v1',
      'primitive.softRadial.v1',
      'primitive.vortexY.v1',
      'region.box.v1',
      'region.cylinderY.v1',
      'region.sphere.v1',
    ]);
  });

  it('SPEC §6.2 defaults validate unchanged; created colors come from the law palette', () => {
    expect(PRIMITIVES.directional.defaults).toEqual({ kind: 'directional', direction: [1, 0, 0], strength: 12 });
    expect(PRIMITIVES.softRadial.defaults).toEqual({ kind: 'softRadial', strength: 8, coreRadius: 0.25 });
    expect(PRIMITIVES.vortexY.defaults).toEqual({ kind: 'vortexY', strength: 8, coreRadius: 0.25 });
    expect(PRIMITIVES.linearDrag.defaults).toEqual({ kind: 'linearDrag', coefficient: 2 });
    for (const d of Object.values(PRIMITIVES)) {
      const field = law(d.defaults as Primitive, d.defaultRegion);
      expect(field.expression).toEqual(d.defaults);
      expect(field.region).toEqual(d.defaultRegion);
      expect(LAW_COLORS).toContain(d.color);
    }
  });

  it('every control accepts its own bounds and validation rejects just beyond them (SPEC §9.3)', () => {
    for (const d of Object.values(PRIMITIVES)) {
      const descriptor = primitiveDescriptor(d.kind);
      for (const control of descriptor.controls) {
        for (const [value, ok] of [[control.min, true], [control.max, true], [control.min - 1e-6, false], [control.max + 1e-6, false], [NaN, false]] as const) {
          const expression = control.set(descriptor.defaults, value);
          expect(validateField({ ...law(descriptor.defaults, descriptor.defaultRegion), expression }).ok, `${d.kind}.${control.key} = ${value}`).toBe(ok);
        }
      }
    }
    for (const r of Object.values(REGIONS)) {
      const descriptor = regionDescriptor(r.kind);
      const base = descriptor.fromBounds([1, 2, 3]);
      for (const control of descriptor.controls) {
        for (const [value, ok] of [[control.min, true], [control.max, true], [control.min - 1e-6, false], [control.max + 1e-6, false], [Infinity, false]] as const) {
          expect(validateField({ ...law(push, base), region: control.set(base, value) }).ok, `${r.kind}.${control.key} = ${value}`).toBe(ok);
        }
      }
    }
  });

  it('documents the SPEC §9.3 strength ranges: directional 0–200, signed 200 for radial and vortex, drag 0–100', () => {
    const bounds = (kind: keyof typeof PRIMITIVES, key: string) => {
      const c = primitiveDescriptor(kind).controls.find((x) => x.key === key)!;
      return [c.min, c.max];
    };
    expect(bounds('directional', 'strength')).toEqual([0, 200]);
    expect(bounds('softRadial', 'strength')).toEqual([-200, 200]);
    expect(bounds('vortexY', 'strength')).toEqual([-200, 200]);
    expect(bounds('softRadial', 'coreRadius')).toEqual([0.01, 100]);
    expect(bounds('linearDrag', 'coefficient')).toEqual([0, 100]);
  });

  it('a support-shape change keeps the bounding size, never an ellipse', () => {
    expect(REGIONS.sphere.fromBounds([1.5, 2, 1.5])).toEqual({ kind: 'sphere', radius: 2 });
    expect(REGIONS.cylinderY.fromBounds([1.5, 2, 1])).toEqual({ kind: 'cylinderY', radius: 1.5, halfHeight: 2 });
    expect(REGIONS.box.fromBounds(REGIONS.cylinderY.bounds({ kind: 'cylinderY', radius: 1.5, halfHeight: 2 }))).toEqual({ kind: 'box', halfExtents: [1.5, 2, 1.5] });
  });
});

describe('semantic picking rays (SPEC §11.2)', () => {
  it('meet each support where the analytic shape is, and miss its bounding-box corners', () => {
    expect(REGIONS.box.rayEntry({ kind: 'box', halfExtents: [1, 1, 1] }, [-5, 0, 0], [1, 0, 0])).toBe(4);
    expect(REGIONS.box.rayEntry({ kind: 'box', halfExtents: [1, 1, 1] }, [0, 0, 0], [1, 0, 0])).toBe(0);
    expect(REGIONS.box.rayEntry({ kind: 'box', halfExtents: [1, 1, 1] }, [-5, 1.5, 0], [1, 0, 0])).toBeNull();
    expect(REGIONS.sphere.rayEntry({ kind: 'sphere', radius: 2 }, [-5, 0, 0], [1, 0, 0])).toBe(3);
    expect(REGIONS.sphere.rayEntry({ kind: 'sphere', radius: 2 }, [-5, 1.9, 1.9], [1, 0, 0])).toBeNull();
    const cylinder = { kind: 'cylinderY', radius: 2, halfHeight: 1 } as const;
    expect(REGIONS.cylinderY.rayEntry(cylinder, [-5, 0, 0], [1, 0, 0])).toBe(3);
    expect(REGIONS.cylinderY.rayEntry(cylinder, [0, 5, 0], [0, -1, 0])).toBe(4);
    expect(REGIONS.cylinderY.rayEntry(cylinder, [-5, 1.5, 0], [1, 0, 0])).toBeNull();
    expect(REGIONS.cylinderY.rayEntry(cylinder, [1.9, -5, 1.9], [0, 1, 0])).toBeNull();
  });
});
