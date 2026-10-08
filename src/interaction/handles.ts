// Spatial parameter handles (SPEC §10.3, §11): the viewport controls for a law's extent, fade,
// strength and core radius. Each handle slides on a rail in the law's local frame; its position
// encodes one control's value, and dragging it yields a complete law value for the ordinary
// command path. Pure math, no Three.js, so the layout and the mapping are tested directly.
import { peel } from '../domain/ingredients';
import { EDGE_FADE, type FieldDefinition, type FieldExpression, type MaskExpression, type Primitive, type RegionDefinition, type Vec3 } from '../domain/scene';
import { nodeAt, pathText, replaceAt, type ExprPath } from '../fields/expression';
import { rotationMatrix } from '../fields/kernel';
import { isPrimitiveKind, primitiveDescriptor, regionDescriptor, type Glyph, type HandleRail, type ScalarControl } from '../fields/registry';

export type HandleRole = 'extent' | 'fade' | 'strength' | 'core';

export interface LawHandle {
  /**
   * The control it sets, e.g. `strength`, `radius`, `halfExtents.0`, `edgeFade` for the law itself;
   * an ingredient's handles are prefixed with its node's path, e.g. `expression.terms[2].region.radius`.
   */
  readonly name: string;
  readonly role: HandleRole;
  /** A strength handle's primitive glyph: an arrow tip, or a gauge for drag. */
  readonly glyph?: Glyph;
  /** Undo label of one drag. */
  readonly label: string;
  /** Rail in the law's local frame: the handle sits at origin + t·axis. */
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly t: number;
  /** The complete law for rail parameter t; the control's value is held within its supported range. */
  at(t: number): FieldDefinition;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function handle<T>(
  rail: HandleRail,
  role: HandleRole,
  control: Pick<ScalarControl<T>, 'key' | 'min' | 'max' | 'edit'>,
  current: number,
  apply: (value: number) => FieldDefinition,
  name: string = control.key,
  label: string = control.edit,
): LawHandle {
  return {
    name,
    role,
    label,
    origin: rail.origin,
    axis: rail.axis,
    t: rail.offset + rail.scale * current,
    at: (t) => apply(clamp((t - rail.offset) / rail.scale, control.min, control.max)),
  };
}

/** A region's extent handles and its fade handle, for the law's support or a mask's. */
function supportHandles(region: RegionDefinition, edgeFade: number, setRegion: (r: RegionDefinition) => FieldDefinition, setFade: (f: number) => FieldDefinition, prefix: string, labels: { resize?: string; fade?: string }): LawHandle[] {
  const descriptor = regionDescriptor(region.kind);
  const handles: LawHandle[] = [];
  for (const rail of descriptor.handles(region)) {
    const control = descriptor.controls.find((c) => c.key === rail.control)!;
    handles.push(handle(rail, 'extent', control, control.get(region), (v) => setRegion(control.set(region, v)), prefix + control.key, labels.resize));
  }
  // The fade handle sits on the inner full-strength surface, d = 1 − f, along the line from the
  // center to an outer-surface corner: t = |C|·(1 − f).
  const corner = descriptor.fadeCorner(region);
  const length = Math.hypot(...corner);
  const fadeRail: HandleRail = { control: EDGE_FADE.key, origin: [0, 0, 0], axis: corner.map((c) => c / length) as unknown as Vec3, scale: -length, offset: length };
  handles.push(handle(fadeRail, 'fade', EDGE_FADE, edgeFade, setFade, prefix + EDGE_FADE.key, labels.fade));
  return handles;
}

/** A primitive's strength and core handles; its rails sit in the law frame, where every primitive of the law lives. */
function primitiveHandles(field: FieldDefinition, primitive: Primitive, setPrimitive: (p: Primitive) => FieldDefinition, prefix: string): LawHandle[] {
  const descriptor = primitiveDescriptor(primitive.kind);
  return descriptor.handles(primitive, field.region).map((rail) => {
    const control = descriptor.controls.find((c) => c.key === rail.control)!;
    const role: HandleRole = control.key === 'coreRadius' ? 'core' : 'strength';
    return { ...handle(rail, role, control, control.get(primitive), (v) => setPrimitive(control.set(primitive, v)), prefix + control.key), glyph: descriptor.glyph };
  });
}

/** A mask's rails carried from its own frame into the law frame: pₘ + Rₘ·origin and Rₘ·axis. */
function inMaskFrame(h: LawHandle, mask: MaskExpression): LawHandle {
  const m = rotationMatrix(mask.pose.rotation);
  const rotate = ([x, y, z]: Vec3): Vec3 => [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
  const o = rotate(h.origin);
  const [px, py, pz] = mask.pose.position;
  return { ...h, origin: [o[0] + px, o[1] + py, o[2] + pz], axis: rotate(h.axis) };
}

/** A node's handle-name prefix, its path as a file names it: `expression.terms[2].`. */
const prefixOf = (path: ExprPath) => (path.length ? `expression.${pathText(path)}.` : 'expression.');

/**
 * Every handle of a law: its region's extents and the fade on the inner surface, then the primitive's
 * own for a one-leaf law. For a compound law, `focus` names the ingredient being edited: its
 * primitive's strength and core handles and each of its masks' extents and fade come too, each
 * setting that one node, so a drag still yields a complete law value for the ordinary command path.
 */
export function lawHandles(field: FieldDefinition, focus: ExprPath | null = null): LawHandle[] {
  const withExpression = (path: ExprPath, node: FieldExpression): FieldDefinition => ({ ...field, expression: replaceAt(field.expression, path, node) });
  const handles = supportHandles(field.region, field.edgeFade, (region) => ({ ...field, region }), (edgeFade) => ({ ...field, edgeFade }), '', {});
  if (isPrimitiveKind(field.expression.kind)) {
    handles.push(...primitiveHandles(field, field.expression as Primitive, (p) => ({ ...field, expression: p }), ''));
    return handles;
  }
  if (focus === null || !nodeAt(field.expression, focus)) return handles;
  const ingredient = peel(field.expression, focus);
  for (const { path, node } of ingredient.modifiers) {
    if (node.kind !== 'mask') continue;
    const prefix = prefixOf(path);
    const own = supportHandles(node.region, node.edgeFade, (region) => withExpression(path, { ...node, region }), (edgeFade) => withExpression(path, { ...node, edgeFade }), `${prefix}region.`, { resize: 'Resize mask', fade: 'Change mask fade' });
    // The mask's fade handle keeps the name `…edgeFade` beside its region's `…region.*` handles.
    handles.push(...own.map((h) => inMaskFrame(h.role === 'fade' ? { ...h, name: `${prefix}${EDGE_FADE.key}` } : h, node)));
  }
  const core = ingredient.core;
  if (core.node.kind !== 'sum') handles.push(...primitiveHandles(field, core.node, (p) => withExpression(core.path, p), prefixOf(core.path)));
  return handles;
}

/** A handle's local position: origin + t·axis. */
export function handlePoint(h: Pick<LawHandle, 'origin' | 'axis' | 't'>): Vec3 {
  return [h.origin[0] + h.t * h.axis[0], h.origin[1] + h.t * h.axis[1], h.origin[2] + h.t * h.axis[2]];
}

/** A handle's rail in world space: R·origin + p and R·axis. */
export function worldRail(field: FieldDefinition, h: Pick<LawHandle, 'origin' | 'axis'>): { origin: Vec3; axis: Vec3 } {
  const m = rotationMatrix(field.pose.rotation);
  const [px, py, pz] = field.pose.position;
  const rotate = ([x, y, z]: Vec3): Vec3 => [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
  const o = rotate(h.origin);
  return { origin: [o[0] + px, o[1] + py, o[2] + pz], axis: rotate(h.axis) };
}

/** A local point in world space. */
export function worldPoint(field: FieldDefinition, local: Vec3): Vec3 {
  return worldRail(field, { origin: local, axis: [0, 0, 0] }).origin;
}

/**
 * The rail parameter t whose point origin + t·axis is closest to the view ray C + s·D (both
 * directions unit, world space), or null when the ray is nearly parallel to the rail and the
 * closest point is ill-defined.
 */
export function railParameter(origin: Vec3, axis: Vec3, rayOrigin: Vec3, rayDirection: Vec3): number | null {
  const w = [origin[0] - rayOrigin[0], origin[1] - rayOrigin[1], origin[2] - rayOrigin[2]];
  const b = axis[0] * rayDirection[0] + axis[1] * rayDirection[1] + axis[2] * rayDirection[2];
  const d = axis[0] * w[0]! + axis[1] * w[1]! + axis[2] * w[2]!;
  const e = rayDirection[0] * w[0]! + rayDirection[1] * w[1]! + rayDirection[2] * w[2]!;
  const denominator = 1 - b * b;
  if (denominator < 1e-6) return null;
  return (b * e - d) / denominator;
}
