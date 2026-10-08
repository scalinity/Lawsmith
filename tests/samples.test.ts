// T08 for M4, spatial samples (AC1, AC3; SPEC §12): every sparse arrow is the compiled evaluator's
// drive at its own lattice point, and a pure drag law draws dots carrying K and no arrow, because a
// spatial point has no velocity and so no drag direction.
import { describe, expect, it } from 'vitest';
import { validateField, type FieldDefinition, type Primitive, type Quat, type RegionDefinition, type Vec3 } from '../src/domain/scene';
import { compileField, sampleField } from '../src/fields/kernel';
import { regionDescriptor } from '../src/fields/registry';
import { ARROW_MIN_MS2, ARROW_STRIDE, DOT_STRIDE, MAX_SAMPLES, OTHER_LATTICE, SELECTED_LATTICE, sampleLattice } from '../src/rendering/samples';

function law(expression: Primitive, region: RegionDefinition, rotation: Quat = [0, 0, 0, 1], center: Vec3 = [1, -0.5, 2]): FieldDefinition {
  const result = validateField({ id: 'l', enabled: true, pose: { position: center, rotation }, region, edgeFade: 0.25, expression });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const s = Math.SQRT1_2;
const ROTATIONS: Quat[] = [[0, 0, 0, 1], [0, 0, s, s], [s, 0, 0, s]];
const PRIMITIVES: Primitive[] = [
  { kind: 'directional', direction: [1, 0, 0], strength: 12 },
  { kind: 'softRadial', strength: -8, coreRadius: 0.25 },
  { kind: 'vortexY', strength: 8, coreRadius: 0.25 },
  { kind: 'linearDrag', coefficient: 2 },
];
const REGIONS: RegionDefinition[] = [
  { kind: 'box', halfExtents: [1.5, 2, 1.2] },
  { kind: 'sphere', radius: 1.6 },
  { kind: 'cylinderY', radius: 1.2, halfHeight: 1.5 },
];

function draw(field: FieldDefinition, lattice: readonly number[]) {
  const compiled = compileField(field);
  const arrows = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
  const dots = new Float64Array(DOT_STRIDE * MAX_SAMPLES);
  const counts = sampleLattice(compiled, regionDescriptor(field.region.kind).bounds(field.region), lattice, 0, arrows, dots);
  return { compiled, arrows, dots, counts };
}

describe('AC1 sparse samples are the authoritative evaluator', () => {
  it('every arrow and dot of every kind, region and rotation equals sampleField at its point', () => {
    const out = [0, 0, 0, 0];
    for (const expression of PRIMITIVES) {
      for (const region of REGIONS) {
        for (const rotation of ROTATIONS) {
          const { compiled, arrows, dots, counts } = draw(law(expression, region, rotation), SELECTED_LATTICE);
          expect(counts.arrows).toBeLessThanOrEqual(MAX_SAMPLES);
          for (let a = 0; a < counts.arrows; a++) {
            const [x, y, z, ax, ay, az] = arrows.subarray(ARROW_STRIDE * a, ARROW_STRIDE * a + ARROW_STRIDE);
            sampleField(compiled, x!, y!, z!, 0, out);
            expect([ax, ay, az]).toEqual(out.slice(0, 3));
            expect(Math.hypot(ax!, ay!, az!)).toBeGreaterThanOrEqual(ARROW_MIN_MS2);
          }
          for (let d = 0; d < counts.dots; d++) {
            const [x, y, z, k] = dots.subarray(DOT_STRIDE * d, DOT_STRIDE * d + DOT_STRIDE);
            sampleField(compiled, x!, y!, z!, 0, out);
            expect(k).toBe(out[3]);
          }
        }
      }
    }
  });

  it('hand values: the recipe box draws [12,0,0] at its center, and [0,12,0] turned +90° about Z', () => {
    const at = (rotation: Quat) => {
      const { arrows, counts } = draw(law({ kind: 'directional', direction: [1, 0, 0], strength: 12 }, { kind: 'box', halfExtents: [1.5, 2, 1.5] }, rotation, [3, 1, 0]), SELECTED_LATTICE);
      for (let a = 0; a < counts.arrows; a++) {
        const e = arrows.subarray(ARROW_STRIDE * a, ARROW_STRIDE * a + ARROW_STRIDE);
        if (Math.abs(e[0]! - 3) < 1e-12 && Math.abs(e[1]! - 1) < 1e-12 && Math.abs(e[2]!) < 1e-12) return [e[3]!, e[4]!, e[5]!];
      }
      return null;
    };
    expect(at([0, 0, 0, 1])).toEqual([12, 0, 0]);
    const turned = at([0, 0, s, s])!;
    expect(Math.abs(turned[0]!)).toBeLessThan(1e-12);
    expect(Math.abs(turned[1]! - 12)).toBeLessThan(1e-12);
  });

  it('the other laws’ sparse lattice is eight samples', () => {
    expect(draw(law(PRIMITIVES[0]!, REGIONS[0]!), OTHER_LATTICE).counts.arrows).toBe(8);
  });
});

describe('AC3 drag at a spatial point carries K, never a direction', () => {
  it('a pure drag law draws no arrows at all, in every region and rotation, and its dots carry K', () => {
    for (const region of REGIONS) {
      for (const rotation of ROTATIONS) {
        const { dots, counts } = draw(law({ kind: 'linearDrag', coefficient: 2 }, region, rotation), SELECTED_LATTICE);
        expect(counts.arrows).toBe(0);
        expect(counts.dots).toBeGreaterThan(0);
        for (let d = 0; d < counts.dots; d++) {
          const k = dots[DOT_STRIDE * d + 3]!;
          expect(k).toBeGreaterThan(0);
          expect(k).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('at the center of the support the dot carries the full coefficient', () => {
    const { dots, counts } = draw(law({ kind: 'linearDrag', coefficient: 3.5 }, REGIONS[1]!, ROTATIONS[0], [0, 0, 0]), SELECTED_LATTICE);
    let center: number | null = null;
    for (let d = 0; d < counts.dots; d++) if (dots[DOT_STRIDE * d] === 0 && dots[DOT_STRIDE * d + 1] === 0 && dots[DOT_STRIDE * d + 2] === 0) center = dots[DOT_STRIDE * d + 3]!;
    expect(center).toBe(3.5);
  });
});
