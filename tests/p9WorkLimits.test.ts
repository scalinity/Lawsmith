// M9 work-limit fixture (scripts/verify/scenes/p9-work-limits.lawsmith.json): the committed scene is exactly
// SPEC §15.2's limit scene that tests/workLimits.test.ts builds, and it parses as a scene. Its laws are
// rebuilt here from the same rule (limitLaw there) on P5 Compound's first law and canonicalized by
// validateScene; counts are checked against the contractual limits, not against the file itself.
import { describe, expect, it } from 'vitest';
import p5Compound from '../scripts/verify/scenes/p5-compound.lawsmith.json?raw';
import p9WorkLimits from '../scripts/verify/scenes/p9-work-limits.lawsmith.json?raw';
import { SCENE_LIMITS, validateScene, type FieldDefinition, type FieldExpression, type Primitive } from '../src/domain/scene';
import { EXPRESSION_LIMITS, expressionStats } from '../src/fields/expression';
import { parseScene } from '../src/persistence/sceneFile';

const LEAVES: readonly Primitive[] = [
  { kind: 'directional', direction: [0, 1, 0], strength: 0.5 },
  { kind: 'softRadial', strength: -0.5, coreRadius: 0.5 },
  { kind: 'vortexY', strength: 0.5, coreRadius: 0.5 },
  { kind: 'linearDrag', coefficient: 0.25 },
];
const PER_LAW = SCENE_LIMITS.primitiveLeaves / SCENE_LIMITS.fields;
const MASKS = EXPRESSION_LIMITS.depth - 3;

function limitLaw(template: FieldDefinition, i: number): FieldDefinition {
  const terms = Array.from({ length: PER_LAW }, (_, j) => {
    let node: FieldExpression = LEAVES[j % LEAVES.length]!;
    for (let k = 0; k < MASKS; k++) node = { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 4.6 }, edgeFade: 0.25, child: node };
    return { kind: 'gain', gain: { kind: 'triangle', min: 0.5, max: 1.5, periodTicks: 240, phaseTicks: (i * PER_LAW + j) % 240 }, child: node } as FieldExpression;
  });
  const angle = (i * Math.PI) / SCENE_LIMITS.fields;
  return { ...template, id: `limit-${String(i).padStart(2, '0')}`, pose: { ...template.pose, rotation: [0, Math.sin(angle), 0, Math.cos(angle)] }, expression: { kind: 'sum', terms } };
}

describe('the P9 work-limit fixture', () => {
  it('parses, sits exactly at the work limits, and equals the limit scene rebuilt on P5 Compound', () => {
    const p5 = parseScene(p5Compound);
    const p9 = parseScene(p9WorkLimits);
    if (!p5.ok) throw p5.error;
    if (!p9.ok) throw p9.error;
    const scene = p9.document.semantic;
    expect(scene.fields).toHaveLength(SCENE_LIMITS.fields);
    const stats = scene.fields.map((f) => expressionStats(f.expression));
    expect(stats.reduce((n, s) => n + s.leaves, 0)).toBe(SCENE_LIMITS.primitiveLeaves);
    expect(stats.every((s) => s.nodes === 57 && s.depth === EXPRESSION_LIMITS.depth)).toBe(true);
    const base = p5.document.semantic;
    expect(scene.bodies).toEqual(base.bodies);
    expect(scene.emitters).toEqual(base.emitters);
    expect(scene.simulation).toEqual(base.simulation);
    expect(scene.seed).toBe(base.seed);
    const expected = validateScene({ ...base, fields: Array.from({ length: SCENE_LIMITS.fields }, (_, i) => limitLaw(base.fields[0]!, i)) });
    if (!expected.ok) throw new Error(`${expected.path}: ${expected.reason}`);
    expect(scene.fields).toEqual(expected.value.fields);
    expect(p9.document.metadata.title).toBe('P9 Work Limits');
  });
});
