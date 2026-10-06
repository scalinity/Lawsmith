// Read-only presentation of host observations: fixed geometry from the scene definition,
// instanced bodies at their last completed positions, and the law drawn from its applied
// definition. Nothing here is physics state; the law's mesh is never the field.
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Scene,
} from 'three/webgpu';
import { abs, float, max, mix, smoothstep, uniform, uv } from 'three/tsl';
import type { FieldDefinition, SceneDefinition } from '../domain/scene';
import { sampleField, type CompiledField } from '../fields/directional';
import type { SimulationHost } from '../simulation/host';
import { tokenColor } from './viewport';

/** Stable arrow scale: 0.05 m of arrow per m/s² of drive (12 m/s² draws 0.6 m). Arrows are never normalized. */
export const ARROW_METERS_PER_MS2 = 0.05;
/** Drive below this magnitude is not drawn (SPEC §12 near-zero display threshold), in m/s². */
export const ARROW_MIN_MS2 = 0.05;
/** Sample lattice as fractions of each local half-extent. The outer layer sits at d = 0.875, where f = 0.25 gives weight 0.5. */
const LATTICE = [-0.875, -0.4375, 0, 0.4375, 0.875];
const MAX_ARROWS = LATTICE.length ** 3; // 125, SPEC §12's per-law cap
/** Sparse samples refresh at most at 30 Hz while a gesture streams edits (SPEC §12). */
const ARROW_REFRESH_MS = 1000 / 30;
const SHAFT_RADIUS = 0.012;
const HEAD_RADIUS = 0.045;
const HEAD_LENGTH = 0.12;

export interface LawViewState {
  selected: boolean;
  /** The gesture's latest accepted value, outlined until the host applies it (SPEC §10.1). */
  preview: FieldDefinition | null;
  /** Throttle arrow refreshes to 30 Hz (during a gesture); otherwise refresh on the next frame. */
  throttle: boolean;
}

export interface WorldView {
  updateBodies(host: SimulationHost): void;
  /** Draws the applied law. `compiled` is the host's evaluator for it; arrows sample it directly. */
  updateLaw(field: FieldDefinition, compiled: CompiledField, state: LawViewState): void;
  /** Number of arrows currently drawn. */
  arrowCount(): number;
}

export function createWorldView(scene: Scene, root: SceneDefinition): WorldView {
  const teal = tokenColor('--teal');
  const lavender = tokenColor('--lavender');
  const tertiary = tokenColor('--text-tertiary');

  for (const body of root.bodies) {
    if (body.type !== 'fixed' || body.collider.kind !== 'box') continue;
    const [hx, hy, hz] = body.collider.halfExtents;
    const block = new Mesh(new BoxGeometry(2 * hx, 2 * hy, 2 * hz), new MeshStandardNodeMaterial({ color: tokenColor('--floor'), roughness: 1 }));
    block.position.set(...body.initialPose.position);
    block.receiveShadow = true;
    scene.add(block);
    const size = 2 * Math.min(hx, hz);
    const grid = new GridHelper(size, Math.round(size), tokenColor('--divider'), tokenColor('--grid-minor'));
    const [bx, by, bz] = body.initialPose.position;
    grid.position.set(bx, by + hy + 0.002, bz);
    scene.add(grid);
  }

  // Emitters: an outline of the spawn jitter square.
  for (const emitter of root.emitters) {
    const jx = Math.max(emitter.jitter[0], 0.05);
    const jz = Math.max(emitter.jitter[2], 0.05);
    const corners = [-jx, -jz, jx, -jz, jx, -jz, jx, jz, jx, jz, -jx, jz, -jx, jz, -jx, -jz];
    const points: number[] = [];
    for (let i = 0; i < corners.length; i += 2) points.push(corners[i]!, 0, corners[i + 1]!);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const outline = new LineSegments(geometry, new LineBasicNodeMaterial({ color: tertiary }));
    outline.position.set(...emitter.pose.position);
    scene.add(outline);
  }

  const bodies = new InstancedMesh(
    new SphereGeometry(1, 20, 14),
    new MeshStandardNodeMaterial({ color: tokenColor('--body'), roughness: 0.45, metalness: 0.05 }),
    root.simulation.maxLiveBodies,
  );
  bodies.count = 0;
  bodies.castShadow = true;
  bodies.frustumCulled = false;
  scene.add(bodies);

  // The law: a translucent support shell, its outer edges and, when selected, the inner
  // full-strength surface at d = 1 − f. The TSL cue raises opacity toward each face's
  // border, so the box reads through its own translucency; it computes no field values.
  const unitBox = new BoxGeometry(2, 2, 2);
  const unitEdges = new EdgesGeometry(unitBox);
  const law = new Group();
  const shellIntensity = uniform(1);
  const shellMaterial = new MeshBasicNodeMaterial({ color: teal, transparent: true, depthWrite: false, side: DoubleSide });
  const border = max(abs(uv().x.sub(0.5)), abs(uv().y.sub(0.5))).mul(2);
  shellMaterial.opacityNode = mix(float(0.035), float(0.15), smoothstep(0.86, 1, border)).mul(shellIntensity);
  const shell = new Mesh(unitBox, shellMaterial);
  shell.renderOrder = 1;
  const outerMaterial = new LineBasicNodeMaterial({ color: teal, transparent: true });
  const outer = new LineSegments(unitEdges, outerMaterial);
  const inner = new LineSegments(unitEdges, new LineBasicNodeMaterial({ color: teal, transparent: true, opacity: 0.35 }));
  law.add(shell, outer, inner);
  scene.add(law);

  const preview = new LineSegments(unitEdges, new LineBasicNodeMaterial({ color: lavender, transparent: true, opacity: 0.8 }));
  preview.visible = false;
  scene.add(preview);

  const arrowMaterial = new MeshBasicNodeMaterial({ color: lavender });
  const shafts = new InstancedMesh(new CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0), arrowMaterial, MAX_ARROWS);
  const heads = new InstancedMesh(new ConeGeometry(1, 1, 12).translate(0, 0.5, 0), arrowMaterial, MAX_ARROWS);
  for (const mesh of [shafts, heads]) {
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const direction = new Vector3();
  const drive = [0, 0, 0];
  let arrowSource: CompiledField | null = null;
  let arrowRefreshedAt = -Infinity;

  /** Samples the host's compiled evaluator on the local lattice and draws one arrow per nonzero drive. */
  function refreshArrows(c: CompiledField) {
    const { m } = c;
    let n = 0;
    for (const fx of LATTICE) {
      for (const fy of LATTICE) {
        for (const fz of LATTICE) {
          const rx = fx * c.bx;
          const ry = fy * c.by;
          const rz = fz * c.bz;
          const wx = c.px + m[0]! * rx + m[1]! * ry + m[2]! * rz;
          const wy = c.py + m[3]! * rx + m[4]! * ry + m[5]! * rz;
          const wz = c.pz + m[6]! * rx + m[7]! * ry + m[8]! * rz;
          sampleField(c, wx, wy, wz, drive);
          const magnitude = Math.hypot(drive[0]!, drive[1]!, drive[2]!);
          if (magnitude < ARROW_MIN_MS2) continue;
          const length = magnitude * ARROW_METERS_PER_MS2;
          const head = Math.min(HEAD_LENGTH, 0.45 * length);
          direction.set(drive[0]! / magnitude, drive[1]! / magnitude, drive[2]! / magnitude);
          rotation.setFromUnitVectors(up, direction);
          // Each arrow is centered on its sample point.
          position.set(wx, wy, wz).addScaledVector(direction, -length / 2);
          shafts.setMatrixAt(n, matrix.compose(position, rotation, scale.set(SHAFT_RADIUS, length - head, SHAFT_RADIUS)));
          position.addScaledVector(direction, length - head);
          heads.setMatrixAt(n, matrix.compose(position, rotation, scale.set(HEAD_RADIUS, head, HEAD_RADIUS)));
          n += 1;
        }
      }
    }
    shafts.count = heads.count = n;
    shafts.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  }

  function place(object: { position: Vector3; quaternion: Quaternion }, field: FieldDefinition) {
    object.position.set(...field.pose.position);
    object.quaternion.set(...field.pose.rotation);
  }

  return {
    updateBodies(host) {
      const { positions, radii, count } = host;
      for (let i = 0; i < count; i++) {
        const r = radii[i]!;
        matrix.makeScale(r, r, r).setPosition(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
        bodies.setMatrixAt(i, matrix);
      }
      bodies.count = count;
      bodies.instanceMatrix.needsUpdate = true;
    },

    updateLaw(field, compiled, state) {
      const [hx, hy, hz] = field.region.halfExtents;
      place(law, field);
      shell.scale.set(hx, hy, hz);
      outer.scale.set(hx, hy, hz);
      const core = 1 - field.edgeFade;
      inner.scale.set(core * hx, core * hy, core * hz);
      inner.visible = state.selected && field.edgeFade > 0 && field.enabled;
      shellIntensity.value = !field.enabled ? 0.35 : state.selected ? 1 : 0.7;
      outerMaterial.color.copy(field.enabled ? teal : tertiary);
      outerMaterial.opacity = !field.enabled ? 0.6 : state.selected ? 1 : 0.5;

      preview.visible = state.preview !== null;
      if (state.preview) {
        place(preview, state.preview);
        preview.scale.set(...state.preview.region.halfExtents);
      }

      const now = performance.now();
      if (compiled !== arrowSource && (!state.throttle || now - arrowRefreshedAt >= ARROW_REFRESH_MS)) {
        refreshArrows(compiled);
        arrowSource = compiled;
        arrowRefreshedAt = now;
      }
    },

    arrowCount: () => shafts.count,
  };
}
