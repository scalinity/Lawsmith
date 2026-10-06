// Read-only presentation of host observations: fixed geometry from the scene definition,
// instanced bodies at their last completed positions, and each law drawn from its applied
// definition. Nothing here is physics state; a law's mesh is never the field.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
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
  type Material,
  type Object3D,
  type Scene,
} from 'three/webgpu';
import { abs, float, max, mix, smoothstep, uniform, uv } from 'three/tsl';
import type { FieldDefinition, LawPresentation, SceneDefinition } from '../domain/scene';
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

/** One applied law as the view needs it: its definition, the host's evaluator for it, its display state. */
export interface LawView {
  field: FieldDefinition;
  compiled: CompiledField;
  presentation: LawPresentation;
}

export interface LawsViewState {
  selectedId: string | null;
  /** The gesture's latest accepted value, outlined until the host applies it (SPEC §10.1). */
  preview: FieldDefinition | null;
  /** Throttle the selected law's arrow refreshes to 30 Hz (during a gesture). */
  throttle: boolean;
  /** Presentation default: draw drive arrows. */
  arrows: boolean;
}

/** A scene's fixed geometry, emitter outlines and body capacity, built beside the displayed scene. */
export interface PreparedScene {
  readonly fixed: Group;
  /** Body instances for a new capacity; null when the displayed ones already fit. */
  readonly bodies: InstancedMesh | null;
}

export interface WorldView {
  /** Builds a loaded scene's view without touching the displayed one; this is the step that can fail. */
  prepareScene(root: SceneDefinition): PreparedScene;
  /** Displays a prepared scene and releases the one it replaces. */
  showScene(prepared: PreparedScene): void;
  /** Releases a prepared scene that will not be shown. */
  discardScene(prepared: PreparedScene): void;
  updateBodies(host: SimulationHost): void;
  /** Draws the applied laws. Arrows sample each law's compiled evaluator directly. */
  updateLaws(laws: readonly LawView[], state: LawsViewState): void;
  /** Number of arrows currently drawn. */
  arrowCount(): number;
}

interface LawVisual {
  group: Group;
  shell: Mesh;
  outer: LineSegments;
  inner: LineSegments;
  shellIntensity: { value: number };
  shellMaterial: MeshBasicNodeMaterial;
  outerMaterial: LineBasicNodeMaterial;
  innerMaterial: LineBasicNodeMaterial;
  shafts: InstancedMesh;
  heads: InstancedMesh;
  color: Color;
  /** What the drawn arrows were sampled from; a new compiled field or a toggle redraws them. */
  arrowSource: CompiledField | null;
  arrowsShown: boolean;
  arrowRefreshedAt: number;
}

/** Releases the GPU resources a subtree owns; shared geometries survive. */
function disposeTree(object: Object3D, shared: ReadonlySet<BufferGeometry>): void {
  object.traverse((child) => {
    const node = child as Partial<Mesh>;
    if (node.geometry && !shared.has(node.geometry)) node.geometry.dispose();
    const material = node.material as Material | Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
  });
}

export function createWorldView(scene: Scene, root: SceneDefinition): WorldView {
  const teal = tokenColor('--teal');
  const lavender = tokenColor('--lavender');
  const tertiary = tokenColor('--text-tertiary');

  const unitBox = new BoxGeometry(2, 2, 2);
  const unitEdges = new EdgesGeometry(unitBox);
  const shaftGeometry = new CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0);
  const headGeometry = new ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
  const sphereGeometry = new SphereGeometry(1, 20, 14);
  const shared = new Set<BufferGeometry>([unitBox, unitEdges, shaftGeometry, headGeometry, sphereGeometry]);
  const arrowMaterial = new MeshBasicNodeMaterial({ color: lavender });

  let fixed = new Group();
  let bodies: InstancedMesh | null = null;

  function prepareScene(next: SceneDefinition): PreparedScene {
    const built = new Group();
    for (const body of next.bodies) {
      if (body.type !== 'fixed') continue;
      const block = new Group();
      block.position.set(...body.initialPose.position);
      block.quaternion.set(...body.initialPose.rotation);
      const material = new MeshStandardNodeMaterial({ color: tokenColor('--floor'), roughness: 1 });
      if (body.collider.kind === 'box') {
        const [hx, hy, hz] = body.collider.halfExtents;
        const mesh = new Mesh(new BoxGeometry(2 * hx, 2 * hy, 2 * hz), material);
        mesh.receiveShadow = true;
        block.add(mesh);
        // A grid on the top face, so entry into a law's support can be judged against the floor.
        const size = 2 * Math.min(hx, hz);
        const grid = new GridHelper(size, Math.max(1, Math.round(size)), tokenColor('--divider'), tokenColor('--grid-minor'));
        grid.position.y = hy + 0.002;
        block.add(grid);
      } else {
        const mesh = new Mesh(sphereGeometry, material);
        mesh.scale.setScalar(body.collider.radius);
        mesh.receiveShadow = true;
        block.add(mesh);
      }
      built.add(block);
    }
    // Emitters: an outline of the spawn jitter square.
    for (const emitter of next.emitters) {
      const jx = Math.max(emitter.jitter[0], 0.05);
      const jz = Math.max(emitter.jitter[2], 0.05);
      const corners = [-jx, -jz, jx, -jz, jx, -jz, jx, jz, jx, jz, -jx, jz, -jx, jz, -jx, -jz];
      const points: number[] = [];
      for (let i = 0; i < corners.length; i += 2) points.push(corners[i]!, 0, corners[i + 1]!);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      const outline = new LineSegments(geometry, new LineBasicNodeMaterial({ color: tertiary }));
      outline.position.set(...emitter.pose.position);
      built.add(outline);
    }

    const capacity = next.simulation.maxLiveBodies;
    if (bodies && bodies.instanceMatrix.count === capacity) return { fixed: built, bodies: null };
    const fresh = new InstancedMesh(sphereGeometry, new MeshStandardNodeMaterial({ color: tokenColor('--body'), roughness: 0.45, metalness: 0.05 }), capacity);
    fresh.castShadow = true;
    fresh.frustumCulled = false;
    return { fixed: built, bodies: fresh };
  }

  function showScene(prepared: PreparedScene): void {
    scene.remove(fixed);
    disposeTree(fixed, shared);
    fixed = prepared.fixed;
    scene.add(fixed);
    if (prepared.bodies) {
      if (bodies) {
        scene.remove(bodies);
        bodies.dispose();
      }
      bodies = prepared.bodies;
      scene.add(bodies);
    }
    bodies!.count = 0;
  }

  function discardScene(prepared: PreparedScene): void {
    disposeTree(prepared.fixed, shared);
    prepared.bodies?.dispose();
  }

  // Each law: a translucent support shell, its outer edges and, when selected, the inner
  // full-strength surface at d = 1 − f. The TSL cue raises opacity toward each face's border, so
  // the box reads through its own translucency; it computes no field values.
  const border = max(abs(uv().x.sub(0.5)), abs(uv().y.sub(0.5))).mul(2);
  const visuals = new Map<string, LawVisual>();

  function createVisual(): LawVisual {
    const shellIntensity = uniform(1);
    const shellMaterial = new MeshBasicNodeMaterial({ color: teal, transparent: true, depthWrite: false, side: DoubleSide });
    shellMaterial.opacityNode = mix(float(0.035), float(0.15), smoothstep(0.86, 1, border)).mul(shellIntensity);
    const shell = new Mesh(unitBox, shellMaterial);
    shell.renderOrder = 1;
    const outerMaterial = new LineBasicNodeMaterial({ color: teal, transparent: true });
    const innerMaterial = new LineBasicNodeMaterial({ color: teal, transparent: true, opacity: 0.35 });
    const outer = new LineSegments(unitEdges, outerMaterial);
    const inner = new LineSegments(unitEdges, innerMaterial);
    const group = new Group();
    group.add(shell, outer, inner);
    const shafts = new InstancedMesh(shaftGeometry, arrowMaterial, MAX_ARROWS);
    const heads = new InstancedMesh(headGeometry, arrowMaterial, MAX_ARROWS);
    for (const mesh of [shafts, heads]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    scene.add(group);
    return {
      group,
      shell,
      outer,
      inner,
      shellIntensity,
      shellMaterial,
      outerMaterial,
      innerMaterial,
      shafts,
      heads,
      color: new Color(),
      arrowSource: null,
      arrowsShown: false,
      arrowRefreshedAt: -Infinity,
    };
  }

  function removeVisual(visual: LawVisual): void {
    scene.remove(visual.group, visual.shafts, visual.heads);
    for (const m of [visual.shellMaterial, visual.outerMaterial, visual.innerMaterial]) m.dispose();
    visual.shafts.dispose();
    visual.heads.dispose();
  }

  const preview = new LineSegments(unitEdges, new LineBasicNodeMaterial({ color: lavender, transparent: true, opacity: 0.8 }));
  preview.visible = false;
  scene.add(preview);

  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const direction = new Vector3();
  const drive = [0, 0, 0];

  /** Samples the host's compiled evaluator on the local lattice and draws one arrow per nonzero drive. */
  function refreshArrows(visual: LawVisual, c: CompiledField) {
    const { m } = c;
    const { shafts, heads } = visual;
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

  showScene(prepareScene(root));

  return {
    prepareScene,
    showScene,
    discardScene,

    updateBodies(host) {
      if (!bodies) return;
      const { positions, radii, count } = host;
      for (let i = 0; i < count; i++) {
        const r = radii[i]!;
        matrix.makeScale(r, r, r).setPosition(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
        bodies.setMatrixAt(i, matrix);
      }
      bodies.count = count;
      bodies.instanceMatrix.needsUpdate = true;
    },

    updateLaws(laws, state) {
      const now = performance.now();
      const present = new Set<string>();
      for (const { field, compiled, presentation } of laws) {
        present.add(field.id);
        let visual = visuals.get(field.id);
        if (!visual) visuals.set(field.id, (visual = createVisual()));
        const selected = field.id === state.selectedId;
        const [hx, hy, hz] = field.region.halfExtents;
        visual.group.visible = presentation.visible;
        place(visual.group, field);
        visual.shell.scale.set(hx, hy, hz);
        visual.outer.scale.set(hx, hy, hz);
        const core = 1 - field.edgeFade;
        visual.inner.scale.set(core * hx, core * hy, core * hz);
        visual.inner.visible = selected && field.edgeFade > 0 && field.enabled;
        visual.color.set(presentation.color);
        visual.shellIntensity.value = !field.enabled ? 0.35 : selected ? 1 : 0.7;
        visual.shellMaterial.color.copy(visual.color);
        visual.innerMaterial.color.copy(visual.color);
        visual.outerMaterial.color.copy(field.enabled ? visual.color : tertiary);
        visual.outerMaterial.opacity = !field.enabled ? 0.6 : selected ? 1 : 0.5;

        // Hiding a law hides its arrows too; its effect is unchanged (SPEC §5.4).
        const show = state.arrows && presentation.visible;
        const due = !state.throttle || !selected || now - visual.arrowRefreshedAt >= ARROW_REFRESH_MS;
        if (show && (compiled !== visual.arrowSource || !visual.arrowsShown) && due) {
          refreshArrows(visual, compiled);
          visual.arrowSource = compiled;
          visual.arrowRefreshedAt = now;
        }
        visual.arrowsShown = show;
        visual.shafts.visible = visual.heads.visible = show;
      }
      for (const [id, visual] of visuals) {
        if (present.has(id)) continue;
        removeVisual(visual);
        visuals.delete(id);
      }

      preview.visible = state.preview !== null;
      if (state.preview) {
        place(preview, state.preview);
        preview.scale.set(...state.preview.region.halfExtents);
      }
    },

    arrowCount: () => {
      let n = 0;
      for (const visual of visuals.values()) if (visual.arrowsShown) n += visual.shafts.count;
      return n;
    },
  };
}
