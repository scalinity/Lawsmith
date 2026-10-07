// The law registry (SPEC §8): one entry per primitive and per support region. An entry joins what
// belongs to its kind: file keys and capability, validation, the CPU evaluator or gauge, numeric
// controls, viewport handles and glyph. Adding a kind touches this table, its tests and an example;
// host stepping and save orchestration consume the entries without knowing which kinds exist.
import { canonicalDirection, unsign, vec, within } from '../domain/numbers';
import type {
  CylinderYRegion,
  DirectionalPrimitive,
  LinearDragPrimitive,
  Primitive,
  RegionDefinition,
  SoftRadialPrimitive,
  SphereRegion,
  BoxRegion,
  Validated,
  Vec3,
  VortexYPrimitive,
} from '../domain/scene';

/** Writes a primitive's local drive A (m/s²) into out[0..2] and returns its K (s⁻¹), before the outer support weight. */
export type LocalEvaluator = (rx: number, ry: number, rz: number, out: number[]) => number;
/** A region's normalized gauge d at local r (SPEC §7): d ≤ 1 inside, not a distance. */
export type Gauge = (rx: number, ry: number, rz: number) => number;
export type ValueKind = 'number' | 'vec3';
export type Glyph = 'direction' | 'radial' | 'axis' | 'drag';

/** One editable number of a law: its inspector field, its bounds, and what one edit is called in undo. */
export interface ScalarControl<T> {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly edit: string;
  get(value: T): number;
  set(value: T, v: number): T;
}

/**
 * A viewport handle (SPEC §10.3). It slides along a rail in the law's local frame and sits at
 * origin + t·axis, where t = offset + scale·value of its control; dragging it sets that control.
 */
export interface HandleRail {
  readonly control: string;
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly scale: number;
  readonly offset: number;
}

export interface RegionDescriptor<R extends RegionDefinition = RegionDefinition> {
  readonly kind: R['kind'];
  readonly capability: string;
  readonly title: string;
  /** File keys besides `kind`. */
  readonly keys: Readonly<Record<string, ValueKind>>;
  readonly controls: readonly ScalarControl<R>[];
  /** Bounds every dimension (SPEC §9.3); a path names the offending key. */
  validate(region: R): Validated<R>;
  compile(region: R): Gauge;
  /** Half-extents of the local bounding box: drawing, arrow lattice and picking frame. */
  bounds(region: R): Vec3;
  /** A point of the outer surface (d = 1); the fade handle sits at (1 − f) times it, on the inner surface. */
  fadeCorner(region: R): Vec3;
  /** The dimension the fade band is a fraction of in SPEC §7's narrow/fast heuristic. */
  narrowest(region: R): number;
  /** This kind sized from another region's bounding half-extents (a support-shape change). */
  fromBounds(bounds: Vec3): R;
  handles(region: R): readonly HandleRail[];
  /**
   * Where a local ray o + s·d (d unit, s ≥ 0) first meets the support, or null on a miss: 0 when it
   * starts inside. Picking uses the semantic shape, never a rendered triangle (SPEC §11.2).
   */
  rayEntry(region: R, o: Vec3, d: Vec3): number | null;
}

/** The ray parameters inside |o_i + s·d_i| ≤ b, intersected with [lo, hi]; null when empty. */
function slab(o: number, d: number, b: number, lo: number, hi: number): [number, number] | null {
  if (Math.abs(d) < 1e-12) return Math.abs(o) <= b ? [lo, hi] : null;
  const t1 = (-b - o) / d;
  const t2 = (b - o) / d;
  const a = Math.max(lo, Math.min(t1, t2));
  const z = Math.min(hi, Math.max(t1, t2));
  return a <= z ? [a, z] : null;
}

/** The ray parameters where |(o + s·d)_xz| ≤ r: a quadratic in s; the whole line when parallel to the axis. */
function disk(o: Vec3, d: Vec3, r: number, lo: number, hi: number, withY: boolean): [number, number] | null {
  const a = d[0] * d[0] + (withY ? d[1] * d[1] : 0) + d[2] * d[2];
  const b = o[0] * d[0] + (withY ? o[1] * d[1] : 0) + o[2] * d[2];
  const c = o[0] * o[0] + (withY ? o[1] * o[1] : 0) + o[2] * o[2] - r * r;
  if (a < 1e-24) return c <= 0 ? [lo, hi] : null;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const s1 = Math.max(lo, (-b - root) / a);
  const s2 = Math.min(hi, (-b + root) / a);
  return s1 <= s2 ? [s1, s2] : null;
}

export interface PrimitiveDescriptor<P extends Primitive = Primitive> {
  readonly kind: P['kind'];
  readonly capability: string;
  readonly title: string;
  /** The everyday verb on the creation shelf, also a created law's ID and label base. */
  readonly verb: string;
  readonly glyph: Glyph;
  readonly keys: Readonly<Record<string, ValueKind>>;
  readonly controls: readonly ScalarControl<P>[];
  /** Constructor defaults (SPEC §6.2), never derived from the camera, time or randomness. */
  readonly defaults: P;
  readonly defaultRegion: RegionDefinition;
  /** Presentation default for a created law (one of LAW_COLORS). */
  readonly color: string;
  validate(primitive: P): Validated<P>;
  compile(primitive: P): LocalEvaluator;
  handles(primitive: P, region: RegionDefinition): readonly HandleRail[];
  /** The governing value, signed, for the Laws list. */
  summary(primitive: P): string;
  /** What that value does, in words, for the inspector. */
  describe(primitive: P): string;
}

const reject = (path: string, reason: string): { ok: false; reason: string; path: string } => ({ ok: false, reason, path });
const short = (v: number) => String(Math.round(v * 100) / 100);
const ORIGIN: Vec3 = [0, 0, 0];

/** One meter of handle arrow per 20 m/s², the drive arrows' scale, so a strength tip reads like an arrow. */
export const DRIVE_METERS_PER_MS2 = 0.05;
/** The drag gauge rises 0.2 m per s⁻¹. */
export const DRAG_METERS_PER_S = 0.2;

// ---------------------------------------------------------------- regions (SPEC §7)

const DIMENSION = { min: 0.01, max: 100, step: 0.1, unit: 'm', edit: 'Resize law' } as const;

function halfExtent(axis: 0 | 1 | 2): ScalarControl<BoxRegion> {
  return {
    ...DIMENSION,
    key: `halfExtents.${axis}`,
    label: `Half extent ${'xyz'[axis]}`,
    get: (r) => r.halfExtents[axis],
    set: (r, v) => ({ ...r, halfExtents: r.halfExtents.map((c, i) => (i === axis ? v : c)) as unknown as Vec3 }),
  };
}

const box: RegionDescriptor<BoxRegion> = {
  kind: 'box',
  capability: 'region.box.v1',
  title: 'Box',
  keys: { halfExtents: 'vec3' },
  controls: [halfExtent(0), halfExtent(1), halfExtent(2)],
  validate(r) {
    if (!r.halfExtents.every((h) => within(h, DIMENSION.min, DIMENSION.max))) return reject('halfExtents', 'box half-extents must be within 0.01–100 m');
    return { ok: true, value: { kind: 'box', halfExtents: vec(r.halfExtents) } };
  },
  compile({ halfExtents: [bx, by, bz] }) {
    return (rx, ry, rz) => Math.max(Math.abs(rx) / bx, Math.abs(ry) / by, Math.abs(rz) / bz);
  },
  bounds: (r) => r.halfExtents,
  fadeCorner: (r) => r.halfExtents,
  narrowest: (r) => Math.min(...r.halfExtents),
  fromBounds: (b) => ({ kind: 'box', halfExtents: b }),
  rayEntry({ halfExtents: b }, o, d) {
    let span: [number, number] | null = [0, Infinity];
    for (let i = 0; i < 3 && span; i++) span = slab(o[i]!, d[i]!, b[i]!, span[0], span[1]);
    return span ? span[0] : null;
  },
  handles: () => [
    { control: 'halfExtents.0', origin: ORIGIN, axis: [-1, 0, 0], scale: 1, offset: 0 },
    { control: 'halfExtents.1', origin: ORIGIN, axis: [0, 1, 0], scale: 1, offset: 0 },
    { control: 'halfExtents.2', origin: ORIGIN, axis: [0, 0, -1], scale: 1, offset: 0 },
  ],
};

const sphere: RegionDescriptor<SphereRegion> = {
  kind: 'sphere',
  capability: 'region.sphere.v1',
  title: 'Sphere',
  keys: { radius: 'number' },
  controls: [{ ...DIMENSION, key: 'radius', label: 'Radius', get: (r) => r.radius, set: (r, v) => ({ ...r, radius: v }) }],
  validate(r) {
    if (!within(r.radius, DIMENSION.min, DIMENSION.max)) return reject('radius', 'sphere radius must be within 0.01–100 m');
    return { ok: true, value: { kind: 'sphere', radius: r.radius } };
  },
  compile({ radius: s }) {
    return (rx, ry, rz) => Math.sqrt(rx * rx + ry * ry + rz * rz) / s;
  },
  bounds: (r) => [r.radius, r.radius, r.radius],
  fadeCorner: (r) => {
    const c = r.radius / Math.sqrt(3);
    return [c, c, c];
  },
  narrowest: (r) => r.radius,
  fromBounds: (b) => ({ kind: 'sphere', radius: Math.max(...b) }),
  rayEntry: (r, o, d) => disk(o, d, r.radius, 0, Infinity, true)?.[0] ?? null,
  handles: () => [{ control: 'radius', origin: ORIGIN, axis: [0, 1, 0], scale: 1, offset: 0 }],
};

const cylinderY: RegionDescriptor<CylinderYRegion> = {
  kind: 'cylinderY',
  capability: 'region.cylinderY.v1',
  title: 'Cylinder',
  keys: { radius: 'number', halfHeight: 'number' },
  controls: [
    { ...DIMENSION, key: 'radius', label: 'Radius', get: (r) => r.radius, set: (r, v) => ({ ...r, radius: v }) },
    { ...DIMENSION, key: 'halfHeight', label: 'Half height', get: (r) => r.halfHeight, set: (r, v) => ({ ...r, halfHeight: v }) },
  ],
  validate(r) {
    if (!within(r.radius, DIMENSION.min, DIMENSION.max)) return reject('radius', 'cylinder radius must be within 0.01–100 m');
    if (!within(r.halfHeight, DIMENSION.min, DIMENSION.max)) return reject('halfHeight', 'cylinder half-height must be within 0.01–100 m');
    return { ok: true, value: { kind: 'cylinderY', radius: r.radius, halfHeight: r.halfHeight } };
  },
  compile({ radius: s, halfHeight: h }) {
    return (rx, ry, rz) => Math.max(Math.sqrt(rx * rx + rz * rz) / s, Math.abs(ry) / h);
  },
  bounds: (r) => [r.radius, r.halfHeight, r.radius],
  fadeCorner: (r) => {
    const c = r.radius / Math.SQRT2;
    return [c, r.halfHeight, c];
  },
  narrowest: (r) => Math.min(r.radius, r.halfHeight),
  fromBounds: (b) => ({ kind: 'cylinderY', radius: Math.max(b[0], b[2]), halfHeight: b[1] }),
  rayEntry(r, o, d) {
    const radial = disk(o, d, r.radius, 0, Infinity, false);
    return radial ? (slab(o[1], d[1], r.halfHeight, radial[0], radial[1])?.[0] ?? null) : null;
  },
  handles: () => [
    { control: 'radius', origin: ORIGIN, axis: [-1, 0, 0], scale: 1, offset: 0 },
    { control: 'halfHeight', origin: ORIGIN, axis: [0, 1, 0], scale: 1, offset: 0 },
  ],
};

// ---------------------------------------------------------------- primitives (SPEC §6.2)

const SIGNED = { min: -200, max: 200, step: 1, unit: 'm/s²', edit: 'Change strength' } as const;
const CORE = { min: 0.01, max: 100, step: 0.05, unit: 'm', edit: 'Change core radius' } as const;

/** Strength and core radius of the two signed, softened primitives. */
function softened<P extends SoftRadialPrimitive | VortexYPrimitive>(): ScalarControl<P>[] {
  return [
    { ...SIGNED, key: 'strength', label: 'Strength', get: (p) => p.strength, set: (p, v) => ({ ...p, strength: v }) },
    { ...CORE, key: 'coreRadius', label: 'Core radius', get: (p) => p.coreRadius, set: (p, v) => ({ ...p, coreRadius: v }) },
  ];
}

function validateSoftened<P extends SoftRadialPrimitive | VortexYPrimitive>(p: P, name: string): Validated<P> {
  if (!within(p.strength, SIGNED.min, SIGNED.max)) return reject('strength', `${name} strength must be within −200–200 m/s²`);
  if (!within(p.coreRadius, CORE.min, CORE.max)) return reject('coreRadius', 'core radius must be within 0.01–100 m');
  return { ok: true, value: { kind: p.kind, strength: unsign(p.strength), coreRadius: p.coreRadius } as P };
}

/** The strength handle of a signed primitive sits halfway out along local +X, inside the support. */
const anchor = (region: RegionDefinition): Vec3 => [0.5 * regionDescriptor(region.kind).bounds(region)[0], 0, 0];
const coreRail: HandleRail = { control: 'coreRadius', origin: ORIGIN, axis: [0, 0, 1], scale: 1, offset: 0 };

const directional: PrimitiveDescriptor<DirectionalPrimitive> = {
  kind: 'directional',
  capability: 'primitive.directional.v1',
  title: 'Directional',
  verb: 'Push',
  glyph: 'direction',
  keys: { direction: 'vec3', strength: 'number' },
  controls: [{ ...SIGNED, min: 0, key: 'strength', label: 'Strength', get: (p) => p.strength, set: (p, v) => ({ ...p, strength: v }) }],
  defaults: { kind: 'directional', direction: [1, 0, 0], strength: 12 },
  defaultRegion: { kind: 'box', halfExtents: [1.5, 2, 1.5] },
  color: '#55aaa4',
  validate(p) {
    if (!within(p.strength, 0, 200)) return reject('strength', 'directional strength must be within 0–200 m/s²');
    const d = canonicalDirection(p.direction);
    if (!d) return reject('direction', 'direction must be finite and nonzero');
    return { ok: true, value: { kind: 'directional', direction: d, strength: unsign(p.strength) } };
  },
  // A = strength · direction, K = 0: a constant drive, rotated with the law.
  compile({ direction, strength }) {
    const lx = strength * direction[0];
    const ly = strength * direction[1];
    const lz = strength * direction[2];
    return (_rx, _ry, _rz, out) => {
      out[0] = lx;
      out[1] = ly;
      out[2] = lz;
      return 0;
    };
  },
  handles: (p) => [{ control: 'strength', origin: ORIGIN, axis: p.direction, scale: DRIVE_METERS_PER_MS2, offset: 0 }],
  summary: (p) => `${short(p.strength)} m/s²`,
  describe: () => 'pushes along its arrow, which turns with the law',
};

const softRadial: PrimitiveDescriptor<SoftRadialPrimitive> = {
  kind: 'softRadial',
  capability: 'primitive.softRadial.v1',
  title: 'Soft radial',
  verb: 'Pull',
  glyph: 'radial',
  keys: { strength: 'number', coreRadius: 'number' },
  controls: softened(),
  defaults: { kind: 'softRadial', strength: 8, coreRadius: 0.25 },
  defaultRegion: { kind: 'sphere', radius: 2 },
  color: '#d9a35b',
  validate: (p) => validateSoftened(p, 'soft radial'),
  // A = −strength · r / sqrt(r·r + ε²), K = 0. Soft radial acceleration, not inverse-square
  // gravity; exactly zero at the center, where the core keeps it finite.
  compile({ strength, coreRadius }) {
    const e2 = coreRadius * coreRadius;
    return (rx, ry, rz, out) => {
      const c = -strength / Math.sqrt(rx * rx + ry * ry + rz * rz + e2);
      out[0] = c * rx;
      out[1] = c * ry;
      out[2] = c * rz;
      return 0;
    };
  },
  // Positive strength points the arrow inward (attraction); dragging it through the anchor reverses it.
  handles: (_p, region) => [{ control: 'strength', origin: anchor(region), axis: [-1, 0, 0], scale: DRIVE_METERS_PER_MS2, offset: 0 }, coreRail],
  summary: (p) => `${short(p.strength)} m/s²`,
  describe: (p) => (p.strength < 0 ? 'pushes away from its center' : 'pulls toward its center'),
};

const vortexY: PrimitiveDescriptor<VortexYPrimitive> = {
  kind: 'vortexY',
  capability: 'primitive.vortexY.v1',
  title: 'Vortex',
  verb: 'Swirl',
  glyph: 'axis',
  keys: { strength: 'number', coreRadius: 'number' },
  controls: softened(),
  defaults: { kind: 'vortexY', strength: 8, coreRadius: 0.25 },
  defaultRegion: { kind: 'cylinderY', radius: 2, halfHeight: 2 },
  color: '#c58ae5',
  validate: (p) => validateSoftened(p, 'vortex'),
  // ρ = r − u(u·r) = [rx, 0, rz] with u = +Y; A = strength · (u × ρ) / sqrt(ρ·ρ + ε²) with
  // u × ρ = [rz, 0, −rx], K = 0. Tangential only: no confinement, exactly zero on the axis.
  compile({ strength, coreRadius }) {
    const e2 = coreRadius * coreRadius;
    return (rx, _ry, rz, out) => {
      const c = strength / Math.sqrt(rx * rx + rz * rz + e2);
      out[0] = c * rz;
      out[1] = 0;
      out[2] = -c * rx;
      return 0;
    };
  },
  // At +X the drive of a positive strength points along −Z: the arrow shows the circulation.
  handles: (_p, region) => [{ control: 'strength', origin: anchor(region), axis: [0, 0, -1], scale: DRIVE_METERS_PER_MS2, offset: 0 }, coreRail],
  summary: (p) => `${short(p.strength)} m/s²`,
  describe: (p) => `turns ${p.strength < 0 ? 'clockwise' : 'counterclockwise'} seen from its +Y axis, without holding bodies in orbit`,
};

const linearDrag: PrimitiveDescriptor<LinearDragPrimitive> = {
  kind: 'linearDrag',
  capability: 'primitive.linearDrag.v1',
  title: 'Linear drag',
  verb: 'Drag',
  glyph: 'drag',
  keys: { coefficient: 'number' },
  controls: [
    { key: 'coefficient', label: 'Coefficient', unit: 's⁻¹', min: 0, max: 100, step: 0.5, edit: 'Change drag', get: (p) => p.coefficient, set: (p, v) => ({ ...p, coefficient: v }) },
  ],
  defaults: { kind: 'linearDrag', coefficient: 2 },
  defaultRegion: { kind: 'sphere', radius: 1.5 },
  color: '#7aa7d9',
  validate(p) {
    if (!within(p.coefficient, 0, 100)) return reject('coefficient', 'drag coefficient must be within 0–100 s⁻¹');
    return { ok: true, value: { kind: 'linearDrag', coefficient: unsign(p.coefficient) } };
  },
  // A = 0, K = coefficient: isotropic resistance relative to the stationary world.
  compile({ coefficient }) {
    return (_rx, _ry, _rz, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return coefficient;
    };
  },
  // A gauge, not an arrow: drag has no direction of its own.
  handles: (_p, region) => [{ control: 'coefficient', origin: anchor(region), axis: [0, 1, 0], scale: DRAG_METERS_PER_S, offset: 0 }],
  summary: (p) => `${short(p.coefficient)} s⁻¹`,
  describe: () => 'resists motion relative to the world, in no direction of its own',
};

// ---------------------------------------------------------------- lookup

export const REGIONS = Object.freeze({ box, sphere, cylinderY });
export const PRIMITIVES = Object.freeze({ directional, softRadial, vortexY, linearDrag });
export type RegionKind = keyof typeof REGIONS;
export type PrimitiveKind = keyof typeof PRIMITIVES;

export const isRegionKind = (kind: unknown): kind is RegionKind => typeof kind === 'string' && Object.hasOwn(REGIONS, kind);
export const isPrimitiveKind = (kind: unknown): kind is PrimitiveKind => typeof kind === 'string' && Object.hasOwn(PRIMITIVES, kind);

/** The entry for a region kind, typed for any region: a value always reaches the entry of its own kind. */
export const regionDescriptor = (kind: RegionKind) => REGIONS[kind] as unknown as RegionDescriptor;
export const primitiveDescriptor = (kind: PrimitiveKind) => PRIMITIVES[kind] as unknown as PrimitiveDescriptor;

/** Every capability a registry entry provides. */
export const LAW_CAPABILITIES: readonly string[] = [...Object.values(REGIONS), ...Object.values(PRIMITIVES)].map((d) => d.capability);
