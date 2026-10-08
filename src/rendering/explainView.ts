// Drawn explanations (SPEC §11.2, §12): the explained body's vectors at its sampled center, its contact
// marker, recorded trails and inertial probes. Each glyph shape names one quantity, so none depends on
// color alone: velocity is a thin shaft with an open chevron, external acceleration a solid shaft and
// cone, a law's share a thin line in that law's color, contact a starburst, a capped arrow ∥.
// Everything here reads observations; nothing is written back.
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicNodeMaterial,
  Matrix4,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../domain/scene';
import { DRIVE_METERS_PER_MS2 } from '../fields/registry';
import { MAX_PROBES, type ProbeField } from '../observation/probes';
import { MAX_TRAILS, TRAIL_SAMPLES, type TrailRecorder } from '../observation/trails';
import type { TransitionObservation } from '../simulation/observation';
import { tokenColor } from './viewport';

/** Velocity arrows: 1 m of arrow = 5 m/s. */
export const VELOCITY_METERS_PER_MS = 0.2;
/** Acceleration arrows share the drive arrows' scale: 1 m = 20 m/s². */
export const ACCELERATION_METERS_PER_MS2 = DRIVE_METERS_PER_MS2;
/** No explanation arrow is drawn longer than this; a longer one is capped and marked ∥. Its number is never capped. */
export const ARROW_CAP_M = 2;
const PROBE_SIZE_M = 0.022;
/** Vectors shorter than this are not drawn: zero is shown as nothing, never as a direction. */
const MIN_DRAWN_M = 1e-4;

export interface ExplainScene {
  /** The transition to draw (retained or preview), already matched to the explained body; null draws no vectors. */
  observation: TransitionObservation | null;
  /** The explained body's displayed center now, for its selection ring; null when it is not in the scene. */
  body: Vec3 | null;
  bodyRadius: number;
  lawColor(id: string): string;
  camera: PerspectiveCamera;
}

/** A label pinned to a world point, placed over the canvas by the caller. */
export interface ExplainLabel {
  readonly key: 'velocity' | 'acceleration' | 'contact';
  readonly text: string;
  readonly at: Vec3;
}

export interface ExplainView {
  update(scene: ExplainScene, probes: ProbeField, trails: TrailRecorder, explained: string | null): ExplainLabel[];
  /** Bytes of the CPU-side buffers this view allocates; all are allocated once, at creation. */
  bytes(): Record<string, number>;
  /** What is submitted for drawing now: trail line vertices, probe instances and law-share arrows. */
  drawn(): { trailVertices: number; probeInstances: number; shareArrows: number };
}

/** The drawn length of a vector of magnitude `value` at `scale` m per unit, and whether it was capped. */
export function arrowLength(value: number, scale: number): { length: number; capped: boolean } {
  const length = value * scale;
  return length > ARROW_CAP_M ? { length: ARROW_CAP_M, capped: true } : { length, capped: false };
}

export function createExplainView(scene: Scene): ExplainView {
  const bright = tokenColor('--text');
  const velocityColor = tokenColor('--text-secondary');
  const gravityColor = tokenColor('--text-tertiary');
  const up = new Vector3(0, 1, 0);
  const root = new Group();
  root.renderOrder = 15;
  scene.add(root);

  // Overlay materials draw over volumes, so a vector inside a law's support stays readable.
  const solid = (color: Color) => new MeshBasicNodeMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
  const line = (color: Color, vertexColors = false) => new LineBasicNodeMaterial({ color, vertexColors, depthTest: false, depthWrite: false, transparent: true });

  // ---- velocity: a thin shaft ending in an open chevron of four prongs, tip at the origin
  const thinShaft = new CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0);
  const cone = new ConeGeometry(1, 1, 14).translate(0, 0.5, 0);
  const prong = (axis: 'x' | 'z', angle: number) => {
    const g = new CylinderGeometry(0.11, 0.11, 1, 5).translate(0, -0.5, 0);
    return axis === 'x' ? g.rotateZ(angle) : g.rotateX(angle);
  };
  const chevronGeometry = mergeGeometries([prong('x', 0.62), prong('x', -0.62), prong('z', 0.62), prong('z', -0.62)])!;
  const velocityMaterial = solid(velocityColor);
  const velocityShaft = new Mesh(thinShaft, velocityMaterial);
  const chevron = new Mesh(chevronGeometry, velocityMaterial);
  // ---- external acceleration: a solid shaft and cone
  const accelerationMaterial = solid(bright);
  const accelerationShaft = new Mesh(thinShaft, accelerationMaterial);
  const accelerationHead = new Mesh(cone, accelerationMaterial);
  // ---- ∥ marks where an arrow was capped
  const capMark = () => new LineSegments(geometryOf([-1, 0, 0, 1, 0, 0, -1, 0.6, 0, 1, 0.6, 0]), line(bright));
  const velocityCap = capMark();
  const accelerationCap = capMark();
  // ---- the sampled center: a small three-axis cross where the vectors start
  const cross = new LineSegments(geometryOf([-1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1]), line(bright));
  cross.scale.setScalar(0.05);
  // ---- the explained body: a ring facing the camera; contact: a starburst around it
  const ringPoints: number[] = [];
  for (let i = 0; i < 48; i++) for (const k of [i, i + 1]) ringPoints.push(Math.cos((2 * Math.PI * k) / 48), Math.sin((2 * Math.PI * k) / 48), 0);
  const ring = new LineSegments(geometryOf(ringPoints), line(bright));
  const burstPoints: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (2 * Math.PI * i) / 8 + Math.PI / 8;
    burstPoints.push(1.35 * Math.cos(a), 1.35 * Math.sin(a), 0, 2.1 * Math.cos(a), 2.1 * Math.sin(a), 0);
  }
  const burst = new LineSegments(geometryOf(burstPoints), line(bright));
  // ---- each law's share and gravity's: thin arrows from the center in the law's color; ∥ ticks on capped ones
  const MAX_SHARES = 33;
  const shareMaterial = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true });
  const shareShafts = new InstancedMesh(thinShaft, shareMaterial, MAX_SHARES);
  const shareHeads = new InstancedMesh(cone, shareMaterial, MAX_SHARES);
  for (const mesh of [shareShafts, shareHeads]) {
    mesh.count = 0;
    mesh.setColorAt(0, new Color());
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  }
  const shares = new LineSegments(new BufferGeometry(), line(new Color(1, 1, 1), true));
  const sharePositions = new Float32BufferAttribute(new Float32Array(MAX_SHARES * 4 * 3), 3).setUsage(DynamicDrawUsage);
  const shareColors = new Float32BufferAttribute(new Float32Array(MAX_SHARES * 4 * 3), 3).setUsage(DynamicDrawUsage);
  shares.geometry.setAttribute('position', sharePositions);
  shares.geometry.setAttribute('color', shareColors);

  const parts = [velocityShaft, chevron, accelerationShaft, accelerationHead, velocityCap, accelerationCap, cross, ring, burst, shares, shareShafts, shareHeads];
  for (const part of parts) {
    part.frustumCulled = false;
    part.renderOrder = 16;
    root.add(part);
  }

  // ---- trails: one line-segment buffer for every slot, older samples fading toward the shell
  const shell = tokenColor('--shell');
  const trailColor = tokenColor('--trail');
  const trailSelected = tokenColor('--trail-selected');
  const trailVertices = MAX_TRAILS * (TRAIL_SAMPLES - 1) * 2;
  const trailPositions = new Float32BufferAttribute(new Float32Array(trailVertices * 3), 3).setUsage(DynamicDrawUsage);
  const trailColors = new Float32BufferAttribute(new Float32Array(trailVertices * 3), 3).setUsage(DynamicDrawUsage);
  const trailGeometry = new BufferGeometry();
  trailGeometry.setAttribute('position', trailPositions);
  trailGeometry.setAttribute('color', trailColors);
  trailGeometry.setDrawRange(0, 0);
  const trailLines = new LineSegments(trailGeometry, new LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  trailLines.frustumCulled = false;
  scene.add(trailLines);
  let trailVersion = -1;
  let trailSelection: string | null = null;

  // ---- probes: small unlit octahedra, dim like dust, never lit spheres like bodies
  const probeMesh = new InstancedMesh(new OctahedronGeometry(1, 0), new MeshBasicNodeMaterial({ color: tokenColor('--probe'), transparent: true, opacity: 0.85 }), MAX_PROBES);
  probeMesh.frustumCulled = false;
  probeMesh.count = 0;
  probeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const instances = probeMesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < MAX_PROBES; i++) instances.set([PROBE_SIZE_M, 0, 0, 0, 0, PROBE_SIZE_M, 0, 0, 0, 0, PROBE_SIZE_M, 0, 0, 0, 0, 1], 16 * i);
  scene.add(probeMesh);
  let probeVersion = -1;

  const direction = new Vector3();
  const side = new Vector3();
  const rotation = new Quaternion();
  const origin = new Vector3();
  const color = new Color();
  const at = new Vector3();
  const size = new Vector3();
  const placed = new Matrix4();

  /**
   * Places a shaft and its head along `v` from `origin`, with a ∥ mark if capped; returns the tip, or
   * null for a zero vector. A solid head is a cone ending at the tip; an open head is the chevron at the tip.
   */
  function arrow(v: Vec3, scale: number, shaft: Mesh, radius: number, head: Mesh, headSize: number, cap: LineSegments, open: boolean): { tip: Vec3; capped: boolean } | null {
    const magnitude = Math.hypot(v[0], v[1], v[2]);
    const { length, capped } = arrowLength(magnitude, scale);
    const shown = length >= MIN_DRAWN_M;
    shaft.visible = head.visible = shown;
    cap.visible = shown && capped;
    if (!shown) return null;
    direction.set(v[0] / magnitude, v[1] / magnitude, v[2] / magnitude);
    rotation.setFromUnitVectors(up, direction);
    const headLength = Math.min(headSize * 2.6, 0.4 * length);
    shaft.position.copy(origin);
    shaft.quaternion.copy(rotation);
    shaft.scale.set(radius, open ? length : length - headLength, radius);
    head.quaternion.copy(rotation);
    if (open) {
      head.position.copy(origin).addScaledVector(direction, length);
      head.scale.setScalar(Math.min(0.09, 0.35 * length));
    } else {
      head.position.copy(origin).addScaledVector(direction, length - headLength);
      head.scale.set(headSize, headLength, headSize);
    }
    if (capped) {
      cap.position.copy(origin).addScaledVector(direction, length * 0.82);
      cap.quaternion.copy(rotation);
      cap.scale.setScalar(0.06);
    }
    const tip = origin.clone().addScaledVector(direction, length);
    return { tip: [tip.x, tip.y, tip.z], capped };
  }

  function updateShares(o: TransitionObservation | null, lawColor: (id: string) => string) {
    const p = sharePositions.array as Float32Array;
    const c = shareColors.array as Float32Array;
    let vertex = 0;
    let n = 0;
    const push = (x: number, y: number, z: number, col: Color) => {
      p.set([x, y, z], 3 * vertex);
      c.set([col.r, col.g, col.b], 3 * vertex);
      vertex += 1;
    };
    if (o) {
      const rows: [Vec3, Color][] = o.contributions.map((s) => [s.applied, new Color(lawColor(s.id))]);
      rows.push([o.gravityApplied, gravityColor]);
      for (const [v, col] of rows.slice(0, MAX_SHARES)) {
        const magnitude = Math.hypot(...v);
        const { length, capped } = arrowLength(magnitude, ACCELERATION_METERS_PER_MS2);
        if (length < MIN_DRAWN_M) continue;
        const [x, y, z] = o.center;
        const d = [v[0] / magnitude, v[1] / magnitude, v[2] / magnitude];
        direction.set(d[0]!, d[1]!, d[2]!);
        rotation.setFromUnitVectors(up, direction);
        const head = Math.min(0.07, 0.4 * length);
        shareShafts.setMatrixAt(n, placed.compose(at.set(x, y, z), rotation, size.set(0.0075, length - head, 0.0075)));
        shareHeads.setMatrixAt(n, placed.compose(at.set(x, y, z).addScaledVector(direction, length - head), rotation, size.set(0.024, head, 0.024)));
        shareShafts.setColorAt(n, col);
        shareHeads.setColorAt(n, col);
        n += 1;
        if (capped) {
          // ∥ across the line near its capped end.
          side.set(d[0]!, d[1]!, d[2]!).cross(Math.abs(d[1]!) < 0.9 ? up : new Vector3(1, 0, 0)).normalize().multiplyScalar(0.05);
          for (const at of [0.8, 0.86]) {
            const m = [x + d[0]! * length * at, y + d[1]! * length * at, z + d[2]! * length * at];
            push(m[0]! - side.x, m[1]! - side.y, m[2]! - side.z, col);
            push(m[0]! + side.x, m[1]! + side.y, m[2]! + side.z, col);
          }
        }
      }
    }
    shares.geometry.setDrawRange(0, vertex);
    sharePositions.needsUpdate = shareColors.needsUpdate = true;
    shareShafts.count = shareHeads.count = n;
    for (const mesh of [shareShafts, shareHeads]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function updateTrails(trails: TrailRecorder, explained: string | null) {
    if (trails.version === trailVersion && explained === trailSelection) return;
    trailVersion = trails.version;
    trailSelection = explained;
    const p = trailPositions.array as Float32Array;
    const c = trailColors.array as Float32Array;
    let vertex = 0;
    for (let s = 0; s < MAX_TRAILS; s++) {
      const n = trails.lengths[s]!;
      if (n < 2) continue;
      const base = trails.owners[s] === explained ? trailSelected : trailColor;
      for (let k = 0; k + 1 < n; k++) {
        for (const j of [k, k + 1]) {
          const at = trails.at(s, j);
          p.set(trails.positions.subarray(3 * at, 3 * at + 3), 3 * vertex);
          // Newest samples at full strength, the oldest a quarter of the way out of the shell.
          color.copy(shell).lerp(base, 0.25 + 0.75 * (j / (n - 1)));
          c.set([color.r, color.g, color.b], 3 * vertex);
          vertex += 1;
        }
      }
    }
    trailGeometry.setDrawRange(0, vertex);
    trailPositions.needsUpdate = trailColors.needsUpdate = true;
  }

  function updateProbes(probes: ProbeField) {
    const enabled = probes.settings.enabled;
    probeMesh.visible = enabled;
    if (!enabled || probes.version === probeVersion) return;
    probeVersion = probes.version;
    let n = 0;
    for (let i = 0; i < probes.settings.count; i++) {
      if (!probes.alive[i]) continue;
      const at = 16 * n++ + 12;
      instances[at] = probes.position[3 * i]!;
      instances[at + 1] = probes.position[3 * i + 1]!;
      instances[at + 2] = probes.position[3 * i + 2]!;
    }
    probeMesh.count = n;
    probeMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    update(s, probes, trails, explained) {
      updateTrails(trails, explained);
      updateProbes(probes);
      const labels: ExplainLabel[] = [];
      const o = s.observation;
      ring.visible = s.body !== null;
      if (s.body) {
        ring.position.set(...s.body);
        ring.quaternion.copy(s.camera.quaternion);
        ring.scale.setScalar(Math.max(0.15, 1.9 * s.bodyRadius));
      }
      cross.visible = o !== null;
      updateShares(o, s.lawColor);
      if (!o) {
        for (const part of [velocityShaft, chevron, accelerationShaft, accelerationHead, velocityCap, accelerationCap, burst]) part.visible = false;
        return labels;
      }
      cross.position.set(...o.center);
      origin.set(...o.center);
      const preview = o.kind === 'preview';
      const v = arrow(o.velocity, VELOCITY_METERS_PER_MS, velocityShaft, 0.009, chevron, 0.04, velocityCap, true);
      const speed = Math.hypot(...o.velocity);
      labels.push({ key: 'velocity', text: `v ${speed.toFixed(2)} m/s${v?.capped ? ', arrow capped' : ''}`, at: v?.tip ?? o.center });
      const a = arrow(o.submitted, ACCELERATION_METERS_PER_MS2, accelerationShaft, 0.016, accelerationHead, 0.05, accelerationCap, false);
      const accel = Math.hypot(...o.submitted);
      labels.push({ key: 'acceleration', text: `${preview ? 'next ' : ''}a ${accel.toFixed(2)} m/s²${a?.capped ? ', arrow capped' : ''}`, at: a?.tip ?? o.center });
      // Contact belongs to the step's outcome, so its starburst sits where the step left the body.
      const contacts = o.contacts ?? [];
      burst.visible = contacts.length > 0 && o.after !== null;
      if (burst.visible) {
        burst.position.set(...o.after!.center);
        burst.quaternion.copy(s.camera.quaternion);
        burst.scale.setScalar(Math.max(0.12, 1.4 * s.bodyRadius));
        labels.push({ key: 'contact', text: `contact: ${contacts.join(', ')}`, at: o.after!.center });
      }
      return labels;
    },

    drawn() {
      return { trailVertices: trailGeometry.drawRange.count, probeInstances: probeMesh.visible ? probeMesh.count : 0, shareArrows: shareShafts.count };
    },

    bytes() {
      return {
        probeInstances: instances.byteLength,
        trailLinePositions: (trailPositions.array as Float32Array).byteLength,
        trailLineColors: (trailColors.array as Float32Array).byteLength,
        shareLines: (sharePositions.array as Float32Array).byteLength + (shareColors.array as Float32Array).byteLength,
        shareInstances: (shareShafts.instanceMatrix.array as Float32Array).byteLength + (shareHeads.instanceMatrix.array as Float32Array).byteLength + 2 * MAX_SHARES * 3 * 4,
      };
    },
  };
}

function geometryOf(points: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([...points], 3));
  return geometry;
}
