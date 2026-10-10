// Baseline outlines are observations only: this module owns no host, collider or field evaluator.
import { BufferAttribute, BufferGeometry, LineBasicNodeMaterial, LineSegments, Quaternion, Vector3, type Scene } from 'three/webgpu';
import type { Comparison } from '../simulation/comparison';
import { tokenColor } from './viewport';

const SEGMENTS = 16;
const VERTICES = SEGMENTS * 3 * 2;
export function createComparisonView(scene: Scene, capacity: number) {
  const positions = new Float32Array(capacity * VERTICES * 3);
  const geometry = new BufferGeometry();
  const attribute = new BufferAttribute(positions, 3);
  geometry.setAttribute('position', attribute);
  const material = new LineBasicNodeMaterial({ color: tokenColor('--baseline'), transparent: true, opacity: 0.7, depthWrite: false });
  const outlines = new LineSegments(geometry, material);
  outlines.name = 'Baseline A — outlines';
  outlines.frustumCulled = false;
  outlines.renderOrder = 2;
  scene.add(outlines);
  const rotation = new Quaternion();
  const point = new Vector3();
  let disposed = false;
  return {
    update(comparison: Comparison, show: boolean) {
      outlines.visible = show;
      if (!show || disposed) return;
      let offset = 0;
      comparison.visit(comparison.host.tick, (_id, radius, pose) => {
        rotation.set(pose[3]!, pose[4]!, pose[5]!, pose[6]!);
        for (let plane = 0; plane < 3; plane++) {
          for (let n = 0; n < SEGMENTS; n++) {
            for (const end of [n, n + 1]) {
              const angle = 2 * Math.PI * end / SEGMENTS;
              const x = Math.cos(angle) * radius * 1.08;
              const y = Math.sin(angle) * radius * 1.08;
              point.set(plane === 2 ? 0 : x, plane === 0 ? y : plane === 2 ? x : 0, plane === 0 ? 0 : y).applyQuaternion(rotation);
              positions[offset++] = pose[0]! + point.x;
              positions[offset++] = pose[1]! + point.y;
              positions[offset++] = pose[2]! + point.z;
            }
          }
        }
      });
      geometry.setDrawRange(0, offset / 3);
      attribute.needsUpdate = true;
    },
    counts() { return { geometries: disposed ? 0 : 1, materials: disposed ? 0 : 1, objects: disposed ? 0 : 1, bytes: disposed ? 0 : positions.byteLength }; },
    dispose() { if (disposed) return; scene.remove(outlines); geometry.dispose(); material.dispose(); disposed = true; },
  };
}
