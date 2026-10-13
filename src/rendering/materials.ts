// Accounting for the materials Lawsmith's own views create (M9, SPEC §18.2 resource cycles). A material is
// counted from construction until three.js dispatches its `dispose` event, whether or not it is still in the
// scene, so a detached view that was never disposed stays visible as allocated. Materials three.js creates
// for itself (TransformControls, helpers) are not counted. The tracker keeps no strong reference: a WeakSet
// marks counted materials, and the only listener lives on the material itself.
import type { Material } from 'three/webgpu';

let live = 0;
const counted = new WeakSet<Material>();

/** Counts `material` as allocated by the application until it is disposed; returns it unchanged. */
export function ownedMaterial<T extends Material>(material: T): T {
  if (counted.has(material)) return material;
  counted.add(material);
  live += 1;
  const released = () => {
    if (!counted.delete(material)) return;
    live -= 1;
    material.removeEventListener('dispose', released);
  };
  material.addEventListener('dispose', released);
  return material;
}

/** Application-owned materials constructed and not yet disposed. */
export const ownedMaterials = () => live;
