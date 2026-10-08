// T05 for M3 at the document level: creating each primitive, the spatial handles' layout and
// value mapping, and one handle drag as one author-undo entry through the ordinary command path.
// Native pointer evidence lives in docs/evidence/M3.md; these fixtures pin the semantics it exercises.
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen, validateField, type FieldDefinition, type Primitive, type RegionDefinition, type Vec3 } from '../src/domain/scene';
import { compileField, sampleField } from '../src/fields/kernel';
import { PRIMITIVES, REGIONS, regionDescriptor } from '../src/fields/registry';
import { lawHandles, railParameter, worldPoint, worldRail, type LawHandle } from '../src/interaction/handles';
import { defaultDocument } from '../src/persistence/defaultScene';
import { parseScene, serializeScene } from '../src/persistence/sceneFile';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

function setup() {
  const document = defaultDocument();
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  return { host, controller };
}

function law(expression: Primitive, region: RegionDefinition, rotation: readonly [number, number, number, number] = [0, 0, 0, 1]): FieldDefinition {
  const result = validateField({ id: 'law', enabled: true, pose: { position: [1, 2, -1], rotation }, region, edgeFade: 0.25, expression });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const ALL_REGIONS: RegionDefinition[] = [{ kind: 'box', halfExtents: [1.5, 2, 1] }, { kind: 'sphere', radius: 2 }, { kind: 'cylinderY', radius: 1.5, halfHeight: 2.5 }];
const ALL_PRIMITIVES = Object.values(PRIMITIVES).map((d) => d.defaults as Primitive);
const named = (handles: LawHandle[], name: string) => handles.find((h) => h.name === name)!;

describe('creating laws from the tool shelf', () => {
  it('each kind gets a stable verb ID, identity pose at the focus point, its default region and SPEC §6.2 parameters', () => {
    const { controller, host } = setup();
    for (const kind of ['directional', 'softRadial', 'vortexY', 'linearDrag'] as const) {
      const result = controller.create(kind, [0.5, 1.5, -0.25]);
      expect(result.ok).toBe(true);
    }
    controller.settle();
    const ids = controller.scene.fields.map((f) => f.id);
    expect(ids).toEqual(['drag', 'pull', 'push', 'sideways', 'swirl']);
    const pull = controller.scene.fields.find((f) => f.id === 'pull')!;
    expect(pull).toEqual({ id: 'pull', enabled: true, pose: { position: [0.5, 1.5, -0.25], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 2 }, edgeFade: 0.25, expression: { kind: 'softRadial', strength: 8, coreRadius: 0.25 } });
    expect(controller.presentationOf('pull')).toEqual({ id: 'pull', label: 'Pull', color: PRIMITIVES.softRadial.color, visible: true });
    expect(controller.scene.fields.find((f) => f.id === 'swirl')!.region).toEqual({ kind: 'cylinderY', radius: 2, halfHeight: 2 });
    expect(host.appliedFields().map((f) => f.id)).toEqual(ids);
    host.dispose();
  });

  it('a second law of a kind takes the next free ID; undo removes it, redo restores the same ID', () => {
    const { controller, host } = setup();
    controller.create('softRadial', [0, 1, 0]);
    const second = controller.create('softRadial', [1, 1, 0]);
    expect(second.ok && second.value.id).toBe('pull-2');
    expect(controller.presentationOf('pull-2').label).toBe('Pull 2');
    controller.undo();
    controller.settle();
    expect(host.appliedFields().some((f) => f.id === 'pull-2')).toBe(false);
    controller.redo();
    controller.settle();
    expect(host.appliedFields().find((f) => f.id === 'pull-2')!.pose.position).toEqual([1, 1, 0]);
    host.dispose();
  });

  it('a created scene saves and reopens canonically; the 33rd law is refused', () => {
    const { controller, host } = setup();
    for (let i = 0; i < 31; i++) expect(controller.create('linearDrag', [i, 1, 0]).ok).toBe(true);
    expect(controller.create('vortexY', [0, 0, 0]).ok).toBe(false);
    const snapshot = controller.snapshot(undefined);
    const text = serializeScene({ format: 'lawsmith.scene', schemaVersion: 1, requiredCapabilities: [], semantic: snapshot.semantic, presentation: snapshot.presentation, metadata: snapshot.metadata });
    const reloaded = parseScene(text);
    expect(reloaded.ok && serializeScene(reloaded.document)).toBe(text);
    host.dispose();
  });
});

describe('spatial handles (SPEC §10.3)', () => {
  it('every law of every kind has its extent, fade and primitive handles, and each sits at its current value', () => {
    for (const region of ALL_REGIONS) {
      for (const expression of ALL_PRIMITIVES) {
        const field = law(expression, region);
        const handles = lawHandles(field);
        const names = handles.map((h) => h.name);
        expect(names).toContain('edgeFade');
        expect(names).toContain(expression.kind === 'linearDrag' ? 'coefficient' : 'strength');
        expect(names.includes('coreRadius')).toBe(expression.kind === 'softRadial' || expression.kind === 'vortexY');
        expect(handles.filter((h) => h.role === 'extent')).toHaveLength(region.kind === 'box' ? 3 : region.kind === 'sphere' ? 1 : 2);
        // At its own rail position a handle reproduces the law (up to rounding of t ↔ value).
        for (const h of handles) {
          const back = h.at(h.t);
          expect(validateField(back).ok).toBe(true);
          expect(JSON.stringify(back.pose)).toBe(JSON.stringify(field.pose));
        }
      }
    }
  });

  it('the fade handle lies on the inner full-strength surface, d = 1 − f, for every region', () => {
    for (const region of ALL_REGIONS) {
      for (const f of [0, 0.25, 0.6, 1]) {
        const field = { ...law(PRIMITIVES.directional.defaults, region), edgeFade: f };
        const h = named(lawHandles(field), 'edgeFade');
        const p = h.origin.map((c, i) => c + h.t * h.axis[i]!) as unknown as Vec3;
        expect(Math.abs(regionDescriptor(region.kind).compile(region)(...p) - (1 - f))).toBeLessThanOrEqual(1e-12);
        // Dragging it moves only f: the outer region is unchanged.
        const moved = h.at(h.t * 0.5 + 0.01);
        expect(moved.region).toEqual(field.region);
        expect(moved.expression).toEqual(field.expression);
      }
    }
  });

  it('extent handles change only their dimension: a sphere stays a sphere, a cylinder keeps one radius', () => {
    const pull = law({ kind: 'softRadial', strength: -7, coreRadius: 0.4 }, { kind: 'sphere', radius: 2 });
    const grown = named(lawHandles(pull), 'radius').at(3);
    expect(grown.region).toEqual({ kind: 'sphere', radius: 3 });
    expect(grown.expression).toEqual(pull.expression);
    expect(grown.edgeFade).toBe(pull.edgeFade);
    const swirl = law({ kind: 'vortexY', strength: 9, coreRadius: 0.3 }, { kind: 'cylinderY', radius: 1.5, halfHeight: 2.5 });
    expect(named(lawHandles(swirl), 'radius').at(2.2).region).toEqual({ kind: 'cylinderY', radius: 2.2, halfHeight: 2.5 });
    expect(named(lawHandles(swirl), 'halfHeight').at(1).region).toEqual({ kind: 'cylinderY', radius: 1.5, halfHeight: 1 });
    expect(named(lawHandles(swirl), 'halfHeight').at(1).expression).toEqual(swirl.expression);
    const push = law(PRIMITIVES.directional.defaults, { kind: 'box', halfExtents: [1.5, 2, 1] });
    expect(named(lawHandles(push), 'halfExtents.2').at(0.5).region).toEqual({ kind: 'box', halfExtents: [1.5, 2, 0.5] });
  });

  it('a strength handle sets the parameter, signed for radial and vortex, without touching the region', () => {
    const pull = law({ kind: 'softRadial', strength: 8, coreRadius: 0.25 }, { kind: 'sphere', radius: 2 });
    const strength = named(lawHandles(pull), 'strength');
    // Anchored halfway out on +X, the rail points inward: t = 0.05 m per m/s², positive pulls.
    expect(strength.origin).toEqual([1, 0, 0]);
    expect(strength.axis).toEqual([-1, 0, 0]);
    expect(strength.t).toBe(0.4);
    const strengthAt = (t: number) => (strength.at(t).expression as { strength: number }).strength;
    expect(strengthAt(0.6)).toBeCloseTo(12, 12);
    expect(strengthAt(-0.25)).toBeCloseTo(-5, 12); // dragged outward through the anchor: repels
    expect(strength.at(0.6).expression).toMatchObject({ kind: 'softRadial', coreRadius: 0.25 });
    expect(strength.at(100).expression).toEqual({ kind: 'softRadial', strength: 200, coreRadius: 0.25 }); // held at the bound
    expect(strength.at(0.6).region).toEqual(pull.region);
    const swirl = named(lawHandles(law({ kind: 'vortexY', strength: 8, coreRadius: 0.25 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 })), 'strength');
    expect(swirl.axis).toEqual([0, 0, -1]); // the drive of a positive vortex at +X
    const push = named(lawHandles(law({ kind: 'directional', direction: [0, 1, 0], strength: 12 }, { kind: 'box', halfExtents: [1, 1, 1] })), 'strength');
    expect(push.axis).toEqual([0, 1, 0]);
    expect(push.at(-1).expression).toMatchObject({ strength: 0 }); // directional strength is never negative
  });

  it('the core handle sets ε alone and stays within 0.01–100 m', () => {
    const swirl = law({ kind: 'vortexY', strength: 8, coreRadius: 0.25 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 });
    const core = named(lawHandles(swirl), 'coreRadius');
    expect(core.t).toBe(0.25);
    expect(core.at(0.8).expression).toEqual({ kind: 'vortexY', strength: 8, coreRadius: 0.8 });
    expect(core.at(-3).expression).toEqual({ kind: 'vortexY', strength: 8, coreRadius: 0.01 });
  });

  it('resizing by handle never changes what the law does at a fixed interior point', () => {
    for (const expression of ALL_PRIMITIVES) {
      const field = law(expression, { kind: 'sphere', radius: 2 });
      const bigger = named(lawHandles(field), 'radius').at(4);
      const point = worldPoint(field, [0.3, 0.2, -0.4]);
      const a = [0, 0, 0, 0];
      const b = [0, 0, 0, 0];
      sampleField(compileField(field), ...point, 0, a);
      sampleField(compileField(bigger), ...point, 0, b);
      expect(b).toEqual(a); // both at full weight: strength, core and coefficient untouched
    }
  });

  it('rails follow the law pose into world space, and a view ray picks the nearest rail parameter', () => {
    const q = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const; // +90° about Z
    const field = law({ kind: 'softRadial', strength: 8, coreRadius: 0.25 }, { kind: 'sphere', radius: 2 }, q);
    const rail = worldRail(field, named(lawHandles(field), 'strength'));
    // Local anchor [1,0,0] → world [0,1,0] + [1,2,−1]; local −X → world −Y.
    expect(rail.origin.map((c) => Math.round(c * 1e12) / 1e12)).toEqual([1, 3, -1]);
    expect(rail.axis.map((c) => Math.round(c * 1e12) / 1e12)).toEqual([0, -1, 0]);
    // A ray along +Z through world [1, 2.5, −1] is closest to the rail at t = 0.5.
    expect(railParameter(rail.origin, rail.axis, [1, 2.5, -10], [0, 0, 1])).toBeCloseTo(0.5, 12);
    expect(railParameter(rail.origin, rail.axis, [1, 10, -1], [0, -1, 0])).toBeNull(); // looking along the rail
  });
});

describe('one handle drag is one author-undo entry (T05)', () => {
  /** A drag as LawInteraction performs it: previews through putField while stepping, then one recorded transaction. */
  function drag(controller: DocumentController, host: SimulationHost, id: string, handle: (f: FieldDefinition) => LawHandle, ts: number[]) {
    controller.settle();
    const before = controller.lawState(id)!;
    const h = handle(before.field);
    const transactionId = controller.newTransaction();
    let latest = before.field;
    for (const t of ts) {
      const result = controller.putField(h.at(t), transactionId);
      if (!result.ok) throw new Error(result.reason);
      latest = result.value.field;
      host.step();
      controller.sync();
    }
    controller.record({ label: h.label, id, transactionId, before, after: { field: latest, presentation: before.presentation } });
    return { before: before.field, latest };
  }

  const cases: [string, Primitive, RegionDefinition, string, number[], (f: FieldDefinition) => unknown][] = [
    ['strength', { kind: 'softRadial', strength: 8, coreRadius: 0.25 }, { kind: 'sphere', radius: 2 }, 'strength', [0.45, 0.5, 0.2, -0.1], (f) => (f.expression as { strength: number }).strength],
    ['fade', { kind: 'linearDrag', coefficient: 2 }, { kind: 'box', halfExtents: [1, 1, 1] }, 'edgeFade', [1.2, 1, 0.9], (f) => f.edgeFade],
    ['core radius', { kind: 'vortexY', strength: 8, coreRadius: 0.25 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 }, 'coreRadius', [0.3, 0.5, 0.7], (f) => (f.expression as { coreRadius: number }).coreRadius],
    ['sphere radius', { kind: 'softRadial', strength: 8, coreRadius: 0.25 }, { kind: 'sphere', radius: 2 }, 'radius', [2.2, 2.6, 3.1], (f) => f.region],
    ['cylinder radius', { kind: 'vortexY', strength: 8, coreRadius: 0.25 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 }, 'radius', [2.3, 2.9], (f) => f.region],
    ['cylinder height', { kind: 'vortexY', strength: 8, coreRadius: 0.25 }, { kind: 'cylinderY', radius: 2, halfHeight: 1 }, 'halfHeight', [1.4, 1.8, 2.2], (f) => f.region],
  ];

  it.each(cases)('%s: previews apply while the world runs; undo and redo restore the endpoints through new commands', (_, expression, region, name, ts, value) => {
    const { controller, host } = setup();
    const created = controller.create(expression.kind, [0, 2, 0]);
    if (!created.ok) throw new Error(created.reason);
    const id = created.value.id;
    controller.editField(id, 'set up', (f) => ({ ...f, region, expression }));
    controller.settle();
    const undoDepth = () => {
      let n = 0;
      while (controller.canUndo) {
        controller.undo();
        n += 1;
      }
      for (let i = 0; i < n; i++) controller.redo();
      controller.settle();
      return n;
    };
    const depth = undoDepth();
    const { before, latest } = drag(controller, host, id, (f) => named(lawHandles(f), name), ts);
    expect(value(latest)).not.toEqual(value(before));
    expect(undoDepth()).toBe(depth + 1); // the whole drag is one entry
    const tick = host.tick;
    expect(controller.undo().ok).toBe(true);
    controller.settle();
    expect(value(host.appliedFields().find((f) => f.id === id)!)).toEqual(value(before));
    expect(host.tick).toBe(tick); // undo restores values; it never rewinds the world
    expect(controller.redo().ok).toBe(true);
    controller.settle();
    expect(value(host.appliedFields().find((f) => f.id === id)!)).toEqual(value(latest));
    host.dispose();
  });

  it('a cancelled handle drag restores its starting law and records nothing', () => {
    const { controller, host } = setup();
    controller.create('softRadial', [0, 2, 0]);
    controller.settle();
    const before = controller.lawState('pull')!;
    const depth = controller.canUndo;
    const h = named(lawHandles(before.field), 'strength');
    controller.putField(h.at(1.5));
    host.step();
    controller.sync();
    controller.putField(before.field); // cancel restores through the command path
    controller.settle();
    expect(host.appliedFields().find((f) => f.id === 'pull')).toEqual(before.field);
    expect(controller.canUndo).toBe(depth);
    host.dispose();
  });

  it('changing the support shape is one validated edit that keeps the bounding size', () => {
    const { controller, host } = setup();
    const result = controller.editField('sideways', 'Change support shape', (f) => ({ ...f, region: REGIONS.cylinderY.fromBounds(regionDescriptor(f.region.kind).bounds(f.region)) }));
    expect(result.ok && result.value.field.region).toEqual({ kind: 'cylinderY', radius: 1.5, halfHeight: 2 });
    controller.settle();
    controller.undo();
    controller.settle();
    expect(host.appliedFields()[0]!.region).toEqual({ kind: 'box', halfExtents: [1.5, 2, 1.5] });
    host.dispose();
  });
});
