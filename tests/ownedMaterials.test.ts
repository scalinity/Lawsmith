// M9 T11 resource accounting (SPEC §18.2): application-owned materials are counted from construction to
// disposal, attached to the scene or not. A view detached without disposal must stay visible as allocated,
// which a scene-traversal count misses.
import { describe, expect, it } from 'vitest';
import { LineBasicNodeMaterial, Scene, type Object3D } from 'three/webgpu';
import { createComparisonView } from '../src/rendering/comparisonView';
import { ownedMaterial, ownedMaterials } from '../src/rendering/materials';

const attachedMaterials = (scene: Scene) => {
  const seen = new Set<unknown>();
  scene.traverse((o: Object3D) => {
    const material = (o as { material?: unknown }).material;
    if (material) seen.add(material);
  });
  return seen.size;
};

describe('owned material accounting', () => {
  it('keeps a detached, undisposed view counted until it is disposed (negative control for the traversal count)', () => {
    // tokenColor reads a :root CSS token; Node has no DOM, so this case stubs the two globals it reads, as
    // tests/comparison.test.ts does, and restores them. No window stand-in is introduced.
    const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
    Object.assign(globalThis, { document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '#55aaa4' }) });
    try {
      detachedViewStaysCounted();
    } finally {
      Object.assign(globalThis, { document: oldDocument, getComputedStyle: oldStyle });
    }
  });

  function detachedViewStaysCounted() {
    const scene = new Scene();
    const before = { owned: ownedMaterials(), attached: attachedMaterials(scene) };
    const view = createComparisonView(scene, 4);
    expect(ownedMaterials()).toBe(before.owned + 1);
    expect(attachedMaterials(scene)).toBe(before.attached + 1);
    // The leak: the view leaves the scene without being disposed.
    scene.remove(scene.children.find((o) => o.name === 'Baseline A — outlines')!);
    expect(attachedMaterials(scene)).toBe(before.attached);
    expect(ownedMaterials()).toBe(before.owned + 1);
    view.dispose();
    expect(ownedMaterials()).toBe(before.owned);
  }

  it('counts a material once and releases it on its first disposal only', () => {
    const before = ownedMaterials();
    const material = new LineBasicNodeMaterial();
    expect(ownedMaterial(ownedMaterial(material))).toBe(material);
    expect(ownedMaterials()).toBe(before + 1);
    material.dispose();
    material.dispose();
    expect(ownedMaterials()).toBe(before);
    // A material three.js creates for itself is not counted.
    new LineBasicNodeMaterial().dispose();
    expect(ownedMaterials()).toBe(before);
  });
});
