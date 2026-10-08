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
import { abs, float, max, mix, normalView, smoothstep, uniform, uv } from 'three/tsl';
import { peel } from '../domain/ingredients';
import type { FieldDefinition, FieldExpression, LawPresentation, MaskExpression, RegionDefinition, SceneDefinition, Vec3 } from '../domain/scene';
import { nodeAt, walk, type ExprPath } from '../fields/expression';
import type { CompiledField } from '../fields/kernel';
import { DRIVE_METERS_PER_MS2, isPrimitiveKind, primitiveDescriptor, regionDescriptor, type Glyph, type RegionKind } from '../fields/registry';
import { handlePoint, type LawHandle } from '../interaction/handles';
import type { SimulationHost } from '../simulation/host';
import { ARROW_STRIDE, DOT_STRIDE, MAX_SAMPLES, OTHER_LATTICE, SELECTED_LATTICE, sampleLattice } from './samples';
import { tokenColor } from './viewport';

/** A drag dot's radius is this times √K: its area is proportional to K (2 s⁻¹ draws about 5 cm). */
export const DOT_METERS_PER_SQRT_K = 0.035;
/** Every law's sparse arrows together stay within P1's 250 (SPEC §18.1). */
export const ARROW_BUDGET = 250;
/** Sparse samples refresh at most at 30 Hz while a gesture streams edits (SPEC §12). */
const ARROW_REFRESH_MS = 1000 / 30;
const SHAFT_RADIUS = 0.012;
const HEAD_RADIUS = 0.045;
const HEAD_LENGTH = 0.12;
/** Handles keep a steady on-screen size: this fraction of their distance from the camera. */
const HANDLE_SIZE = 0.011;

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
  /** Presentation default: draw drive arrows and drag dots. */
  arrows: boolean;
  /** Draw only the selected law's arrows and dots. A view filter: every law still acts (SPEC §10.2). */
  onlySelectedArrows: boolean;
  /** The selected law's spatial handles, in handle mode. */
  handles: { field: FieldDefinition; handles: readonly LawHandle[]; hover: string | null; active: string | null } | null;
  /** The ingredient being edited in the selected compound law; its masks are drawn brighter. */
  focus: ExprPath | null;
  /** The host's tick: drawn samples of a tick-dependent law are this tick's (SPEC §12). */
  tick: number;
  camera: Vector3;
}

/** A scene's fixed geometry, emitter outlines and body capacity, built beside the displayed scene. */
export interface PreparedScene {
  readonly fixed: Group;
  /** Body instances for a new capacity; null when the displayed ones already fit. */
  readonly bodies: InstancedMesh | null;
}

export interface WorldView {
  /**
   * Builds a loaded scene's view without touching the displayed one; this is the step that can fail.
   * `own` gives it body instances of its own even at the displayed capacity, as a view kept beside
   * another (a replay context's) must have.
   */
  prepareScene(root: SceneDefinition, own?: boolean): PreparedScene;
  /** Displays a prepared scene and releases the one it replaces. */
  showScene(prepared: PreparedScene): void;
  /**
   * Displays a prepared scene and returns the displaced one unreleased, so a retained context's view
   * can be shown again (SPEC §13.2). The caller releases or keeps what it gets back.
   */
  swapScene(prepared: PreparedScene): PreparedScene;
  /** Releases a prepared scene that will not be shown. */
  discardScene(prepared: PreparedScene): void;
  updateBodies(host: SimulationHost): void;
  /** Draws the applied laws. Arrows and dots sample each law's compiled evaluator directly. */
  updateLaws(laws: readonly LawView[], state: LawsViewState): void;
  /** Number of drive arrows currently drawn. */
  arrowCount(): number;
}

interface LawVisual {
  group: Group;
  shell: Mesh;
  outer: LineSegments;
  inner: LineSegments;
  axis: LineSegments;
  shellIntensity: { value: number };
  /** Face-border cue for a box; a silhouette cue for round shapes. */
  boxShell: MeshBasicNodeMaterial;
  roundShell: MeshBasicNodeMaterial;
  outerMaterial: LineBasicNodeMaterial;
  innerMaterial: LineBasicNodeMaterial;
  shafts: InstancedMesh;
  heads: InstancedMesh;
  dots: InstancedMesh;
  color: Color;
  /** What the drawn samples came from; a new compiled field, a density change or a toggle redraws them. */
  sampleSource: CompiledField | null;
  sampleLattice: readonly number[] | null;
  samplesShown: boolean;
  sampledAt: number;
  sampledTick: number;
}

/** Releases a body instance mesh with its material (an InstancedMesh's dispose leaves the material). */
function disposeBodies(mesh: InstancedMesh): void {
  mesh.dispose();
  (mesh.material as Material).dispose();
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

/** Line segments around unit circles: `planes` lists which two axes each circle spans, at an optional offset on the third. */
function circles(planes: readonly [number, number, number, number][], segments = 64): BufferGeometry {
  const points: number[] = [];
  for (const [a, b, c, offset] of planes) {
    for (let i = 0; i < segments; i++) {
      for (const k of [i, i + 1]) {
        const p = [0, 0, 0];
        const angle = (2 * Math.PI * k) / segments;
        p[a] = Math.cos(angle);
        p[b] = Math.sin(angle);
        p[c] = offset;
        points.push(...p);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return geometry;
}

function segments(points: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([...points], 3));
  return geometry;
}

export function createWorldView(scene: Scene, root: SceneDefinition): WorldView {
  const teal = tokenColor('--teal');
  const lavender = tokenColor('--lavender');
  const tertiary = tokenColor('--text-tertiary');

  // Unit shapes, scaled by each region's bounding half-extents: a sphere's three equal radii and a
  // cylinder's radius in X and Z keep both round, so the drawn support is the analytic one.
  const unitBox = new BoxGeometry(2, 2, 2);
  const unitSphere = new SphereGeometry(1, 40, 20);
  const unitCylinder = new CylinderGeometry(1, 1, 2, 48, 1);
  const shapes: Record<RegionKind, { shell: BufferGeometry; edges: BufferGeometry; round: boolean }> = {
    box: { shell: unitBox, edges: new EdgesGeometry(unitBox), round: false },
    sphere: { shell: unitSphere, edges: circles([[0, 1, 2, 0], [1, 2, 0, 0], [0, 2, 1, 0]]), round: true },
    cylinderY: {
      shell: unitCylinder,
      edges: (() => {
        const rims = circles([[0, 2, 1, 1], [0, 2, 1, -1]]).getAttribute('position').array;
        return segments([...rims, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 1, 0, 0, -1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1]);
      })(),
      round: true,
    },
  };
  const axisLine = segments([0, -1, 0, 0, 1, 0]);
  const ring = circles([[0, 2, 1, 0]]);
  const shaftGeometry = new CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0);
  const headGeometry = new ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
  const sphereGeometry = new SphereGeometry(1, 20, 14);
  const dotGeometry = new SphereGeometry(1, 10, 8);
  const shared = new Set<BufferGeometry>([unitBox, unitSphere, unitCylinder, ...Object.values(shapes).map((s) => s.edges), axisLine, ring, shaftGeometry, headGeometry, sphereGeometry, dotGeometry]);
  const arrowMaterial = new MeshBasicNodeMaterial({ color: lavender });
  const dotMaterial = new MeshBasicNodeMaterial({ color: tokenColor('--text-secondary'), transparent: true, opacity: 0.75 });

  let fixed = new Group();
  let bodies: InstancedMesh | null = null;

  function prepareScene(next: SceneDefinition, own = false): PreparedScene {
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
        // A grid on the top face of a broad block, so entry into a law's support can be judged against the floor.
        const size = 2 * Math.min(hx, hz);
        if (size >= 4) {
          const grid = new GridHelper(size, Math.max(1, Math.round(size)), tokenColor('--divider'), tokenColor('--grid-minor'));
          grid.position.y = hy + 0.002;
          block.add(grid);
        }
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
      const outline = new LineSegments(segments(points), new LineBasicNodeMaterial({ color: tertiary }));
      outline.position.set(...emitter.pose.position);
      built.add(outline);
    }

    const capacity = next.simulation.maxLiveBodies;
    if (!own && bodies && bodies.instanceMatrix.count === capacity) return { fixed: built, bodies: null };
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
        disposeBodies(bodies);
      }
      bodies = prepared.bodies;
      scene.add(bodies);
    }
    bodies!.count = 0;
  }

  function swapScene(prepared: PreparedScene): PreparedScene {
    scene.remove(fixed);
    const displaced: PreparedScene = { fixed, bodies: prepared.bodies ? bodies : null };
    fixed = prepared.fixed;
    scene.add(fixed);
    if (prepared.bodies) {
      if (bodies) scene.remove(bodies);
      bodies = prepared.bodies;
      scene.add(bodies);
    }
    bodies!.count = 0;
    return displaced;
  }

  function discardScene(prepared: PreparedScene): void {
    disposeTree(prepared.fixed, shared);
    if (prepared.bodies) disposeBodies(prepared.bodies);
  }

  // Each law: a translucent support shell, its outer edges and, when selected, the inner
  // full-strength surface at d = 1 − f, which for these normalized gauges is the shape scaled by
  // 1 − f. The TSL cues raise opacity toward a box's face borders or a round shape's silhouette, so
  // the volume reads through its own translucency; they compute no field values.
  const border = max(abs(uv().x.sub(0.5)), abs(uv().y.sub(0.5))).mul(2);
  const silhouette = float(1).sub(abs(normalView.z));
  const visuals = new Map<string, LawVisual>();

  function createVisual(): LawVisual {
    const shellIntensity = uniform(1);
    const boxShell = new MeshBasicNodeMaterial({ color: teal, transparent: true, depthWrite: false, side: DoubleSide });
    boxShell.opacityNode = mix(float(0.035), float(0.15), smoothstep(0.86, 1, border)).mul(shellIntensity);
    const roundShell = new MeshBasicNodeMaterial({ color: teal, transparent: true, depthWrite: false, side: DoubleSide });
    roundShell.opacityNode = mix(float(0.03), float(0.13), smoothstep(0.55, 1, silhouette)).mul(shellIntensity);
    const shell = new Mesh(unitBox, boxShell);
    shell.renderOrder = 1;
    const outerMaterial = new LineBasicNodeMaterial({ color: teal, transparent: true });
    const innerMaterial = new LineBasicNodeMaterial({ color: teal, transparent: true, opacity: 0.35 });
    const outer = new LineSegments(shapes.box.edges, outerMaterial);
    const inner = new LineSegments(shapes.box.edges, innerMaterial);
    const axis = new LineSegments(axisLine, innerMaterial);
    const group = new Group();
    group.add(shell, outer, inner, axis);
    const shafts = new InstancedMesh(shaftGeometry, arrowMaterial, MAX_SAMPLES);
    const heads = new InstancedMesh(headGeometry, arrowMaterial, MAX_SAMPLES);
    const dots = new InstancedMesh(dotGeometry, dotMaterial, MAX_SAMPLES);
    for (const mesh of [shafts, heads, dots]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    scene.add(group);
    return { group, shell, outer, inner, axis, shellIntensity, boxShell, roundShell, outerMaterial, innerMaterial, shafts, heads, dots, color: new Color(), sampleSource: null, sampleLattice: null, samplesShown: false, sampledAt: -Infinity, sampledTick: -1 };
  }

  function removeVisual(visual: LawVisual): void {
    scene.remove(visual.group, visual.shafts, visual.heads, visual.dots);
    for (const m of [visual.boxShell, visual.roundShell, visual.outerMaterial, visual.innerMaterial]) m.dispose();
    visual.shafts.dispose();
    visual.heads.dispose();
    visual.dots.dispose();
  }

  const previewMaterial = new LineBasicNodeMaterial({ color: lavender, transparent: true, opacity: 0.8 });
  const preview = new LineSegments(shapes.box.edges, previewMaterial);
  preview.visible = false;
  scene.add(preview);

  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const direction = new Vector3();
  const arrowSamples = new Float64Array(ARROW_STRIDE * MAX_SAMPLES);
  const dotSamples = new Float64Array(DOT_STRIDE * MAX_SAMPLES);

  /**
   * Draws the host's compiled evaluator on a local lattice over the region's bounds (samples.ts): an
   * arrow along each nonzero drive A and a dot for each nonzero drag rate K, which has no direction.
   */
  function refreshSamples(visual: LawVisual, c: CompiledField, bounds: Vec3, lattice: readonly number[], tick: number): number {
    const { shafts, heads, dots } = visual;
    const counts = sampleLattice(c, bounds, lattice, tick, arrowSamples, dotSamples);
    for (let d = 0; d < counts.dots; d++) {
      const [wx, wy, wz, k] = dotSamples.subarray(DOT_STRIDE * d, DOT_STRIDE * d + DOT_STRIDE);
      const r = DOT_METERS_PER_SQRT_K * Math.sqrt(k!);
      dots.setMatrixAt(d, matrix.makeScale(r, r, r).setPosition(wx!, wy!, wz!));
    }
    for (let a = 0; a < counts.arrows; a++) {
      const [wx, wy, wz, ax, ay, az] = arrowSamples.subarray(ARROW_STRIDE * a, ARROW_STRIDE * a + ARROW_STRIDE);
      const magnitude = Math.hypot(ax!, ay!, az!);
      const length = magnitude * DRIVE_METERS_PER_MS2;
      const head = Math.min(HEAD_LENGTH, 0.45 * length);
      direction.set(ax! / magnitude, ay! / magnitude, az! / magnitude);
      rotation.setFromUnitVectors(up, direction);
      // Each arrow is centered on its sample point.
      position.set(wx!, wy!, wz!).addScaledVector(direction, -length / 2);
      shafts.setMatrixAt(a, matrix.compose(position, rotation, scale.set(SHAFT_RADIUS, length - head, SHAFT_RADIUS)));
      position.addScaledVector(direction, length - head);
      heads.setMatrixAt(a, matrix.compose(position, rotation, scale.set(HEAD_RADIUS, head, HEAD_RADIUS)));
    }
    const n = counts.arrows;
    shafts.count = heads.count = n;
    dots.count = counts.dots;
    shafts.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = dots.instanceMatrix.needsUpdate = true;
    return n;
  }

  function place(object: { position: Vector3; quaternion: Quaternion }, field: FieldDefinition) {
    object.position.set(...field.pose.position);
    object.quaternion.set(...field.pose.rotation);
  }

  function setShape(visual: LawVisual, region: RegionDefinition) {
    const shape = shapes[region.kind];
    visual.shell.geometry = shape.shell;
    visual.shell.material = shape.round ? visual.roundShell : visual.boxShell;
    visual.outer.geometry = shape.edges;
    visual.inner.geometry = shape.edges;
  }

  // ---- spatial handles of the selected law (handle mode), drawn over every volume
  const handleGroup = new Group();
  handleGroup.renderOrder = 20;
  const overlay = (color: Color) => new MeshBasicNodeMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
  const lineOverlay = (color: Color, opacity = 1) => new LineBasicNodeMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
  const roleMaterial = { extent: overlay(tokenColor('--text')), fade: overlay(teal), strength: overlay(lavender), core: overlay(tokenColor('--text-secondary')) };
  // One knob per handle. A compound law's handle count follows its focused ingredient's masks, so the
  // knobs grow to the longest list shown; every handle that can be grabbed is drawn.
  const knobs: Mesh[] = [];
  const makeKnob = () => {
    const mesh = new Mesh(sphereGeometry, roleMaterial.extent);
    mesh.renderOrder = 22;
    handleGroup.add(mesh);
    return mesh;
  };
  const strengthShaft = new Mesh(shaftGeometry, roleMaterial.strength);
  const strengthHead = new Mesh(headGeometry, roleMaterial.strength);
  const gauge = new LineSegments(segments([0, 0, 0, 0, 1, 0]), lineOverlay(lavender));
  const fadeRail = new LineSegments(segments([0, 0, 0, 1, 1, 1]), lineOverlay(teal, 0.5));
  const coreRing = new LineSegments(ring, lineOverlay(tokenColor('--text-secondary')));
  for (const object of [strengthShaft, strengthHead, gauge, fadeRail, coreRing]) {
    object.renderOrder = 21;
    handleGroup.add(object);
  }
  scene.add(handleGroup);
  const local = new Vector3();
  const world = new Vector3();

  function updateHandles(state: LawsViewState) {
    const shown = state.handles;
    handleGroup.visible = shown !== null;
    if (!shown) return;
    const { field, handles } = shown;
    place(handleGroup, field);
    handleGroup.updateMatrixWorld(true);
    while (knobs.length < handles.length) knobs.push(makeKnob());
    knobs.forEach((knob, i) => {
      const h = handles[i];
      knob.visible = h !== undefined;
      if (!h) return;
      knob.position.set(...handlePoint(h));
      knob.material = roleMaterial[h.role];
      world.copy(knob.position).applyMatrix4(handleGroup.matrixWorld);
      const emphasis = h.name === shown.active || h.name === shown.hover ? 1.4 : 1;
      knob.scale.setScalar(HANDLE_SIZE * emphasis * world.distanceTo(state.camera));
    });
    // The strength handle is an arrow tip (directional, radial, vortex) or a gauge (drag, which has no direction).
    const strength = handles.find((h) => h.role === 'strength');
    const glyph = strength?.glyph;
    strengthShaft.visible = strengthHead.visible = strength !== undefined && glyph !== 'drag' && Math.abs(strength.t) > 1e-6;
    gauge.visible = strength !== undefined && glyph === 'drag';
    if (strength) {
      const length = Math.abs(strength.t);
      const sign = Math.sign(strength.t) || 1;
      direction.set(...strength.axis).multiplyScalar(sign);
      if (glyph === 'drag') {
        gauge.position.set(...strength.origin);
        gauge.quaternion.setFromUnitVectors(up, direction);
        gauge.scale.set(1, Math.max(length, 1e-6), 1);
      } else if (strengthShaft.visible) {
        const head = Math.min(HEAD_LENGTH * 1.3, 0.45 * length);
        rotation.setFromUnitVectors(up, direction);
        strengthShaft.position.set(...strength.origin);
        strengthShaft.quaternion.copy(rotation);
        strengthShaft.scale.set(SHAFT_RADIUS * 1.6, length - head, SHAFT_RADIUS * 1.6);
        strengthHead.position.copy(local.set(...strength.origin).addScaledVector(direction, length - head));
        strengthHead.quaternion.copy(rotation);
        strengthHead.scale.set(HEAD_RADIUS * 1.3, head, HEAD_RADIUS * 1.3);
      }
    }
    // The fade handle slides on the line from the center to an outer-surface corner.
    fadeRail.scale.set(...regionDescriptor(field.region.kind).fadeCorner(field.region));
    const core = handles.find((h) => h.role === 'core');
    coreRing.visible = core !== undefined;
    if (core) coreRing.scale.setScalar(Math.max(core.t, 1e-6));
  }

  // ---- the selected law's masks (SPEC §6.3): each mask's region in the law frame, where it moves support
  const maskGroup = new Group();
  maskGroup.renderOrder = 3;
  const maskMaterial = lineOverlay(lavender, 0.9);
  const maskDimMaterial = new LineBasicNodeMaterial({ color: lavender, transparent: true, opacity: 0.35 });
  const maskInnerMaterial = new LineBasicNodeMaterial({ color: lavender, transparent: true, opacity: 0.3 });
  // One outline per mask in the law, grown to the most masks shown.
  const maskLines: { pose: Group; outer: LineSegments; inner: LineSegments }[] = [];
  const makeMaskLine = () => {
    const pose = new Group();
    const outer = new LineSegments(shapes.box.edges, maskDimMaterial);
    const inner = new LineSegments(shapes.box.edges, maskInnerMaterial);
    pose.add(outer, inner);
    maskGroup.add(pose);
    return { pose, outer, inner };
  };
  scene.add(maskGroup);

  function updateMasks(field: FieldDefinition | undefined, focus: ExprPath | null) {
    const masks: { mask: MaskExpression; focused: boolean }[] = [];
    if (field && !isPrimitiveKind(field.expression.kind)) {
      const focused = new Set<FieldExpression>();
      if (focus && nodeAt(field.expression, focus)) for (const m of peel(field.expression, focus).modifiers) focused.add(m.node);
      walk(field.expression, (node) => {
        if (node.kind === 'mask') masks.push({ mask: node, focused: focused.has(node) });
      });
    }
    maskGroup.visible = masks.length > 0;
    if (field) place(maskGroup, field);
    while (maskLines.length < masks.length) maskLines.push(makeMaskLine());
    maskLines.forEach((line, i) => {
      const entry = masks[i];
      line.pose.visible = entry !== undefined;
      if (!entry) return;
      const { mask, focused } = entry;
      line.pose.position.set(...mask.pose.position);
      line.pose.quaternion.set(...mask.pose.rotation);
      const bounds = regionDescriptor(mask.region.kind).bounds(mask.region);
      line.outer.geometry = line.inner.geometry = shapes[mask.region.kind].edges;
      line.outer.material = focused ? maskMaterial : maskDimMaterial;
      line.outer.scale.set(...bounds);
      const core = 1 - mask.edgeFade;
      line.inner.visible = focused && mask.edgeFade > 0;
      line.inner.scale.set(core * bounds[0], core * bounds[1], core * bounds[2]);
    });
  }

  /** The glyphs of a law's primitives, cached per accepted expression. */
  const glyphCache = new WeakMap<FieldExpression, Set<Glyph>>();
  const glyphsOf = (expression: FieldExpression) => {
    let glyphs = glyphCache.get(expression);
    if (!glyphs) {
      const found = new Set<Glyph>();
      walk(expression, (node) => {
        if (isPrimitiveKind(node.kind)) found.add(primitiveDescriptor(node.kind).glyph);
      });
      glyphCache.set(expression, (glyphs = found));
    }
    return glyphs;
  };

  showScene(prepareScene(root));

  let drawnArrows = 0;
  return {
    prepareScene,
    showScene,
    swapScene,
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
      // The selected law samples densely; every other law takes a sparse lattice while the budget lasts.
      let budget = ARROW_BUDGET - (laws.some((l) => l.field.id === state.selectedId && l.presentation.visible) ? MAX_SAMPLES : 0);
      drawnArrows = 0;
      for (const { field, compiled, presentation } of laws) {
        present.add(field.id);
        let visual = visuals.get(field.id);
        if (!visual) visuals.set(field.id, (visual = createVisual()));
        const selected = field.id === state.selectedId;
        const bounds = regionDescriptor(field.region.kind).bounds(field.region);
        setShape(visual, field.region);
        visual.group.visible = presentation.visible;
        place(visual.group, field);
        visual.shell.scale.set(...bounds);
        visual.outer.scale.set(...bounds);
        const core = 1 - field.edgeFade;
        visual.inner.scale.set(core * bounds[0], core * bounds[1], core * bounds[2]);
        visual.inner.visible = selected && field.edgeFade > 0 && field.enabled;
        // A vortex's axis is its local Y: drawn through the support when selected, so the swirl's frame is visible.
        visual.axis.visible = selected && glyphsOf(field.expression).has('axis');
        visual.axis.scale.set(1, bounds[1], 1);
        visual.color.set(presentation.color);
        visual.shellIntensity.value = !field.enabled ? 0.35 : selected ? 1 : 0.7;
        visual.boxShell.color.copy(visual.color);
        visual.roundShell.color.copy(visual.color);
        visual.innerMaterial.color.copy(visual.color);
        visual.outerMaterial.color.copy(field.enabled ? visual.color : tertiary);
        visual.outerMaterial.opacity = !field.enabled ? 0.6 : selected ? 1 : 0.5;

        // Hiding a law hides its samples too, and so does the selected-law filter; neither changes
        // what any law does (SPEC §5.4, §10.2).
        let lattice: readonly number[] | null = null;
        if (state.arrows && presentation.visible && (!state.onlySelectedArrows || selected)) {
          if (selected) lattice = SELECTED_LATTICE;
          else if (budget >= OTHER_LATTICE.length ** 3) {
            lattice = OTHER_LATTICE;
            budget -= OTHER_LATTICE.length ** 3;
          }
        }
        const show = lattice !== null;
        const due = !state.throttle || !selected || now - visual.sampledAt >= ARROW_REFRESH_MS;
        // A tick-dependent law's samples belong to one tick: they follow the clock at most at 30 Hz.
        const stale = compiled.timeDependent && visual.sampledTick !== state.tick && now - visual.sampledAt >= ARROW_REFRESH_MS;
        if (show && (compiled !== visual.sampleSource || lattice !== visual.sampleLattice || !visual.samplesShown || stale) && due) {
          refreshSamples(visual, compiled, bounds, lattice!, state.tick);
          visual.sampleSource = compiled;
          visual.sampleLattice = lattice;
          visual.sampledAt = now;
          visual.sampledTick = state.tick;
        }
        visual.samplesShown = show;
        visual.shafts.visible = visual.heads.visible = visual.dots.visible = show;
        if (show) drawnArrows += visual.shafts.count;
      }
      for (const [id, visual] of visuals) {
        if (present.has(id)) continue;
        removeVisual(visual);
        visuals.delete(id);
      }

      preview.visible = state.preview !== null;
      if (state.preview) {
        place(preview, state.preview);
        preview.geometry = shapes[state.preview.region.kind].edges;
        preview.scale.set(...regionDescriptor(state.preview.region.kind).bounds(state.preview.region));
      }
      updateHandles(state);
      const selected = laws.find((l) => l.field.id === state.selectedId && l.presentation.visible);
      updateMasks(selected?.field, state.focus);
    },

    arrowCount: () => drawnArrows,
  };
}
