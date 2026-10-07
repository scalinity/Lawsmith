// Spatial parameter handles (SPEC §10.3, §11): the viewport controls for a law's extent, fade,
// strength and core radius. Each handle slides on a rail in the law's local frame; its position
// encodes one control's value, and dragging it yields a complete law value for the ordinary
// command path. Pure math, no Three.js, so the layout and the mapping are tested directly.
import { EDGE_FADE, type FieldDefinition, type Vec3 } from '../domain/scene';
import { rotationMatrix } from '../fields/kernel';
import { primitiveDescriptor, regionDescriptor, type HandleRail, type ScalarControl } from '../fields/registry';

export type HandleRole = 'extent' | 'fade' | 'strength' | 'core';

export interface LawHandle {
  /** The control it sets, e.g. `strength`, `radius`, `halfExtents.0`, `edgeFade`. */
  readonly name: string;
  readonly role: HandleRole;
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
): LawHandle {
  return {
    name: control.key,
    role,
    label: control.edit,
    origin: rail.origin,
    axis: rail.axis,
    t: rail.offset + rail.scale * current,
    at: (t) => apply(clamp((t - rail.offset) / rail.scale, control.min, control.max)),
  };
}

/** Every handle of a law: its region's extents, the fade on the inner surface, then the primitive's own. */
export function lawHandles(field: FieldDefinition): LawHandle[] {
  const region = regionDescriptor(field.region.kind);
  const primitive = primitiveDescriptor(field.expression.kind);
  const handles: LawHandle[] = [];
  for (const rail of region.handles(field.region)) {
    const control = region.controls.find((c) => c.key === rail.control)!;
    handles.push(handle(rail, 'extent', control, control.get(field.region), (v) => ({ ...field, region: control.set(field.region, v) })));
  }
  // The fade handle sits on the inner full-strength surface, d = 1 − f, along the line from the
  // center to an outer-surface corner: t = |C|·(1 − f).
  const corner = region.fadeCorner(field.region);
  const length = Math.hypot(...corner);
  const fadeRail: HandleRail = { control: EDGE_FADE.key, origin: [0, 0, 0], axis: corner.map((c) => c / length) as unknown as Vec3, scale: -length, offset: length };
  handles.push(handle(fadeRail, 'fade', EDGE_FADE, field.edgeFade, (v) => ({ ...field, edgeFade: v })));
  for (const rail of primitive.handles(field.expression, field.region)) {
    const control = primitive.controls.find((c) => c.key === rail.control)!;
    const role: HandleRole = control.key === 'coreRadius' ? 'core' : 'strength';
    handles.push(handle(rail, role, control, control.get(field.expression), (v) => ({ ...field, expression: control.set(field.expression, v) })));
  }
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
