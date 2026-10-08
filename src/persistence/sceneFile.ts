// The `.lawsmith.json` scene format (SPEC §5, §15.1–15.2): strict reading into a validated
// candidate document, canonical writing, and the semantic digest. JSON here is declarative data
// only: known keys are read into new objects, nothing is evaluated, fetched or merged.
import {
  SCENE_FORMAT,
  SCENE_LIMITS,
  SCHEMA_VERSION,
  defaultLawPresentation,
  validateScene,
  type BodyDefinition,
  type BodyMaterial,
  type BodyTemplate,
  type ColliderShape,
  type CollisionMode,
  type EmitterDefinition,
  type FieldDefinition,
  type FieldExpression,
  type Gain,
  type LawPresentation,
  type Pose,
  type Quat,
  type SceneDefinition,
  type SceneDocument,
  type SceneMetadata,
  type ScenePresentation,
  type SimulationSettings,
  type Vec3,
  checkCamera,
  checkLawPresentation,
} from '../domain/scene';
import { EXPRESSION_LIMITS, OPERATOR_CAPABILITIES, expressionCapabilities } from '../fields/expression';
import { LAW_CAPABILITIES, isPrimitiveKind, isRegionKind, primitiveDescriptor, regionDescriptor, type ValueKind } from '../fields/registry';

/** The emitter capability; region and primitive capabilities come from the law registry. */
export const EMITTER_CAPABILITY = 'emitter.xorshift32.v1';

/**
 * Semantic capabilities this build implements (SPEC §15.1). A scene lists the ones it needs;
 * an unknown one is rejected, never ignored.
 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([...LAW_CAPABILITIES, ...OPERATOR_CAPABILITIES, EMITTER_CAPABILITY]);

/**
 * The capabilities a semantic block uses, sorted and without repeats: every law's support region,
 * and everything in its expression however deeply nested (primitives, operators, mask regions).
 */
export function requiredCapabilities(scene: SceneDefinition): string[] {
  const used = new Set<string>();
  for (const field of scene.fields) {
    used.add(regionDescriptor(field.region.kind).capability);
    expressionCapabilities(field.expression, used);
  }
  if (scene.emitters.length) used.add(EMITTER_CAPABILITY);
  return [...used].sort();
}

/** A validated document for a semantic block; presentation and metadata take constructor defaults when absent. */
export function createDocument(semantic: SceneDefinition, metadata: SceneMetadata, presentation?: Partial<ScenePresentation>): SceneDocument {
  const laws = semantic.fields.map((f) => presentation?.laws?.find((p) => p.id === f.id) ?? defaultLawPresentation(f.id));
  const camera = presentation?.camera;
  return {
    format: SCENE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    requiredCapabilities: requiredCapabilities(semantic),
    semantic,
    presentation: camera ? { camera, arrows: presentation?.arrows ?? true, laws } : { arrows: presentation?.arrows ?? true, laws },
    metadata,
  };
}

// ---------------------------------------------------------------- canonical writing

/**
 * Canonical JSON (SPEC §15.1): object keys sorted by UTF-16 code unit, so the bytes never depend on
 * construction order; numbers in their shortest round-trip form, never rounded for display;
 * negative zero written as 0; arrays of plain values on one line. Nonfinite numbers are refused.
 */
export function canonicalJson(value: unknown, indent = ''): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot serialize nonfinite number ${value}`);
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v !== 'object' || v === null)) return `[${value.map((v) => canonicalJson(v)).join(', ')}]`;
    const inner = `${indent}  `;
    return `[\n${value.map((v) => inner + canonicalJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${indent}  ${JSON.stringify(key)}: ${canonicalJson((value as Record<string, unknown>)[key], `${indent}  `)}`);
    return entries.length ? `{\n${entries.join(',\n')}\n${indent}}` : '{}';
  }
  throw new Error(`cannot serialize ${value === null ? 'null' : typeof value}`);
}

/** The scene file's exact text. Capabilities are recomputed from the semantic block, so they cannot drift. */
export function serializeScene(document: SceneDocument): string {
  return `${canonicalJson({ ...document, requiredCapabilities: requiredCapabilities(document.semantic) })}\n`;
}

/** SHA-256 of the canonical semantic content: format, schema, capabilities and the semantic block, never presentation. */
export async function semanticDigest(document: SceneDocument): Promise<string> {
  const text = canonicalJson({
    format: document.format,
    schemaVersion: document.schemaVersion,
    requiredCapabilities: requiredCapabilities(document.semantic),
    semantic: document.semantic,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const utf8Length = (text: string) => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------- strict reading

/** A rejected import: the path names the offending value, e.g. `semantic.fields[2].pose.rotation`. */
export class ImportError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(path ? `${path}: ${reason}` : reason);
  }
}

export type ParseResult = { ok: true; document: SceneDocument } | { ok: false; error: ImportError };

const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

type Obj = Record<string, unknown>;

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError(path, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new ImportError(at(path, key), 'is not a known property');
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ImportError(at(path, key), 'is required');
  return value as Obj;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ImportError(path, 'must be a finite number');
  return value;
}

function integer(value: unknown, path: string): number {
  const n = number(value, path);
  if (!Number.isSafeInteger(n)) throw new ImportError(path, 'must be a safe integer');
  return n;
}

function string(value: unknown, path: string, max: number = SCENE_LIMITS.textLength): string {
  if (typeof value !== 'string') throw new ImportError(path, 'must be a string');
  if (value.length > max) throw new ImportError(path, `must be at most ${max} characters`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ImportError(path, 'must be true or false');
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new ImportError(path, 'must be an array');
  if (value.length > max) throw new ImportError(path, `must have at most ${max} entries`);
  return value;
}

function tuple(value: unknown, path: string, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) throw new ImportError(path, `must be an array of ${length} numbers`);
  return value.map((c, i) => number(c, at(path, i)));
}

const vec3 = (value: unknown, path: string) => tuple(value, path, 3) as unknown as Vec3;
const quat = (value: unknown, path: string) => tuple(value, path, 4) as unknown as Quat;

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ImportError(path, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
  return value as T;
}

function pose(value: unknown, path: string): Pose {
  const o = object(value, path, ['position', 'rotation']);
  return { position: vec3(o.position, at(path, 'position')), rotation: quat(o.rotation, at(path, 'rotation')) };
}

function collider(value: unknown, path: string): ColliderShape {
  const kind = oneOf(object(value, path, ['kind'], ['radius', 'halfExtents']).kind, at(path, 'kind'), ['sphere', 'box'] as const);
  if (kind === 'sphere') return { kind, radius: number(object(value, path, ['kind', 'radius']).radius, at(path, 'radius')) };
  return { kind, halfExtents: vec3(object(value, path, ['kind', 'halfExtents']).halfExtents, at(path, 'halfExtents')) };
}

function material(value: unknown, path: string): BodyMaterial {
  const o = object(value, path, ['friction', 'restitution']);
  return { friction: number(o.friction, at(path, 'friction')), restitution: number(o.restitution, at(path, 'restitution')) };
}

const collisionMode = (value: unknown, path: string): CollisionMode => oneOf(value, path, ['all', 'fixedOnly'] as const);

function body(value: unknown, path: string): BodyDefinition {
  const type = oneOf(object(value, path, ['type'], [...BODY_KEYS, 'massKg']).type, at(path, 'type'), ['dynamic', 'fixed'] as const);
  const o = object(value, path, type === 'dynamic' ? [...BODY_KEYS, 'massKg'] : BODY_KEYS);
  const common = {
    id: string(o.id, at(path, 'id'), SCENE_LIMITS.idLength),
    initialPose: pose(o.initialPose, at(path, 'initialPose')),
    initialLinearVelocity: vec3(o.initialLinearVelocity, at(path, 'initialLinearVelocity')),
    initialAngularVelocity: vec3(o.initialAngularVelocity, at(path, 'initialAngularVelocity')),
    collider: collider(o.collider, at(path, 'collider')),
    material: material(o.material, at(path, 'material')),
    collisionMode: collisionMode(o.collisionMode, at(path, 'collisionMode')),
  };
  return type === 'dynamic' ? { ...common, type, massKg: number(o.massKg, at(path, 'massKg')) } : { ...common, type };
}
const BODY_KEYS = ['id', 'type', 'initialPose', 'initialLinearVelocity', 'initialAngularVelocity', 'collider', 'material', 'collisionMode'];

function template(value: unknown, path: string): BodyTemplate {
  const o = object(value, path, ['collider', 'massKg', 'initialLinearVelocity', 'initialAngularVelocity', 'material', 'collisionMode']);
  return {
    collider: collider(o.collider, at(path, 'collider')),
    massKg: number(o.massKg, at(path, 'massKg')),
    initialLinearVelocity: vec3(o.initialLinearVelocity, at(path, 'initialLinearVelocity')),
    initialAngularVelocity: vec3(o.initialAngularVelocity, at(path, 'initialAngularVelocity')),
    material: material(o.material, at(path, 'material')),
    collisionMode: collisionMode(o.collisionMode, at(path, 'collisionMode')),
  };
}

function emitter(value: unknown, path: string): EmitterDefinition {
  const o = object(value, path, ['id', 'pose', 'template', 'seed', 'startTick', 'intervalTicks', 'lifetimeTicks', 'jitter'], ['emissionCount']);
  return {
    id: string(o.id, at(path, 'id'), SCENE_LIMITS.idLength),
    pose: pose(o.pose, at(path, 'pose')),
    template: template(o.template, at(path, 'template')),
    seed: integer(o.seed, at(path, 'seed')),
    startTick: integer(o.startTick, at(path, 'startTick')),
    intervalTicks: integer(o.intervalTicks, at(path, 'intervalTicks')),
    lifetimeTicks: integer(o.lifetimeTicks, at(path, 'lifetimeTicks')),
    ...(o.emissionCount === undefined ? {} : { emissionCount: integer(o.emissionCount, at(path, 'emissionCount')) }),
    jitter: vec3(o.jitter, at(path, 'jitter')),
  };
}

function unsupportedKind(kind: unknown, path: string): never {
  throw new ImportError(path, `unknown kind ${JSON.stringify(kind)}`);
}

/** Reads `{ kind, ...keys }` with exactly the keys a registry entry declares, each a number or a 3-vector. */
function tagged(value: unknown, path: string, kind: string, keys: Readonly<Record<string, ValueKind>>): Record<string, unknown> {
  const o = object(value, path, ['kind', ...Object.keys(keys)]);
  const read: Record<string, unknown> = { kind };
  for (const [key, type] of Object.entries(keys)) read[key] = type === 'vec3' ? vec3(o[key], at(path, key)) : number(o[key], at(path, key));
  return read;
}

function region(value: unknown, path: string): FieldDefinition['region'] {
  const kind = kindOf(value, path);
  if (!isRegionKind(kind)) unsupportedKind(kind, at(path, 'kind'));
  return tagged(value, path, kind, regionDescriptor(kind).keys) as unknown as FieldDefinition['region'];
}

function gain(value: unknown, path: string): Gain {
  const kind = oneOf(kindOf(value, path), at(path, 'kind'), ['constant', 'triangle'] as const);
  if (kind === 'constant') return { kind, value: number(object(value, path, ['kind', 'value']).value, at(path, 'value')) };
  const o = object(value, path, ['kind', 'min', 'max', 'periodTicks', 'phaseTicks']);
  return {
    kind,
    min: number(o.min, at(path, 'min')),
    max: number(o.max, at(path, 'max')),
    periodTicks: integer(o.periodTicks, at(path, 'periodTicks')),
    phaseTicks: integer(o.phaseTicks, at(path, 'phaseTicks')),
  };
}

/**
 * Reads one expression node strictly (SPEC §6.3, §15.2): exactly its known keys, its children in
 * stored order. The depth and node bounds are checked on arrival, before any child is read, so a
 * long or deeply nested file is refused instead of traversed. Semantic bounds follow in validation.
 */
function expression(value: unknown, path: string, depth: number, budget: { nodes: number }): FieldExpression {
  if (depth > EXPRESSION_LIMITS.depth) throw new ImportError(path, `expression depth exceeds ${EXPRESSION_LIMITS.depth}`);
  if (++budget.nodes > EXPRESSION_LIMITS.nodes) throw new ImportError(path, `a law has at most ${EXPRESSION_LIMITS.nodes} expression nodes`);
  const kind = kindOf(value, path);
  if (isPrimitiveKind(kind)) return tagged(value, path, kind, primitiveDescriptor(kind).keys) as unknown as FieldExpression;
  if (kind === 'sum') {
    const termsPath = at(path, 'terms');
    const terms = array(object(value, path, ['kind', 'terms']).terms, termsPath, EXPRESSION_LIMITS.nodes);
    if (!terms.length) throw new ImportError(termsPath, 'a sum needs at least one term');
    return { kind, terms: terms.map((t, i) => expression(t, at(termsPath, i), depth + 1, budget)) };
  }
  if (kind === 'gain') {
    const o = object(value, path, ['kind', 'gain', 'child']);
    return { kind, gain: gain(o.gain, at(path, 'gain')), child: expression(o.child, at(path, 'child'), depth + 1, budget) };
  }
  if (kind === 'mask') {
    const o = object(value, path, ['kind', 'pose', 'region', 'edgeFade', 'child']);
    return {
      kind,
      pose: pose(o.pose, at(path, 'pose')),
      region: region(o.region, at(path, 'region')),
      edgeFade: number(o.edgeFade, at(path, 'edgeFade')),
      child: expression(o.child, at(path, 'child'), depth + 1, budget),
    };
  }
  unsupportedKind(kind, at(path, 'kind'));
}

function field(value: unknown, path: string): FieldDefinition {
  const o = object(value, path, ['id', 'enabled', 'pose', 'region', 'edgeFade', 'expression']);
  return {
    id: string(o.id, at(path, 'id'), SCENE_LIMITS.idLength),
    enabled: boolean(o.enabled, at(path, 'enabled')),
    pose: pose(o.pose, at(path, 'pose')),
    region: region(o.region, at(path, 'region')),
    edgeFade: number(o.edgeFade, at(path, 'edgeFade')),
    expression: expression(o.expression, at(path, 'expression'), 1, { nodes: 0 }),
  };
}

/** The `kind` of a tagged object, read before its other keys are known. */
function kindOf(value: unknown, path: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError(path, 'must be an object');
  if (!Object.hasOwn(value, 'kind')) throw new ImportError(at(path, 'kind'), 'is required');
  return (value as Obj).kind;
}

function settings(value: unknown, path: string): SimulationSettings {
  const o = object(value, path, ['profile', 'stepNumerator', 'stepDenominator', 'ambientAcceleration', 'maxAppliedAcceleration', 'maxLiveBodies']);
  const stepNumerator = integer(o.stepNumerator, at(path, 'stepNumerator'));
  const stepDenominator = integer(o.stepDenominator, at(path, 'stepDenominator'));
  if (stepNumerator !== 1) throw new ImportError(at(path, 'stepNumerator'), 'must be 1');
  if (stepDenominator !== 120) throw new ImportError(at(path, 'stepDenominator'), 'must be 120');
  return {
    profile: string(o.profile, at(path, 'profile'), SCENE_LIMITS.idLength),
    stepNumerator,
    stepDenominator,
    ambientAcceleration: vec3(o.ambientAcceleration, at(path, 'ambientAcceleration')),
    maxAppliedAcceleration: number(o.maxAppliedAcceleration, at(path, 'maxAppliedAcceleration')),
    maxLiveBodies: integer(o.maxLiveBodies, at(path, 'maxLiveBodies')),
  };
}

function semantic(value: unknown, path: string): SceneDefinition {
  const o = object(value, path, ['units', 'seed', 'simulation', 'bodies', 'emitters', 'fields']);
  const units = o.units;
  if (units !== 'm-kg-s') throw new ImportError(at(path, 'units'), 'must be "m-kg-s"; no unit conversion is applied on load');
  const bodiesPath = at(path, 'bodies');
  const emittersPath = at(path, 'emitters');
  const fieldsPath = at(path, 'fields');
  const scene: SceneDefinition = {
    units,
    seed: integer(o.seed, at(path, 'seed')),
    simulation: settings(o.simulation, at(path, 'simulation')),
    bodies: array(o.bodies, bodiesPath, SCENE_LIMITS.dynamicBodies + SCENE_LIMITS.fixedBodies).map((b, i) => body(b, at(bodiesPath, i))),
    emitters: array(o.emitters, emittersPath, SCENE_LIMITS.emitters).map((e, i) => emitter(e, at(emittersPath, i))),
    fields: array(o.fields, fieldsPath, SCENE_LIMITS.fields).map((f, i) => field(f, at(fieldsPath, i))),
  };
  const result = validateScene(scene);
  if (!result.ok) throw new ImportError(at(path, result.path), result.reason);
  return result.value;
}

function presentation(value: unknown, path: string, scene: SceneDefinition): ScenePresentation {
  const o = object(value, path, ['arrows', 'laws'], ['camera']);
  let camera: ScenePresentation['camera'];
  if (o.camera !== undefined) {
    const c = object(o.camera, at(path, 'camera'), ['position', 'target']);
    const position = vec3(c.position, at(path, 'camera.position'));
    const target = vec3(c.target, at(path, 'camera.target'));
    const problem = checkCamera({ position, target });
    if (problem) throw new ImportError(at(path, 'camera'), problem);
    camera = { position, target };
  }
  const lawsPath = at(path, 'laws');
  const stored = new Map<string, LawPresentation>();
  for (const [i, entry] of array(o.laws, lawsPath, SCENE_LIMITS.fields).entries()) {
    const p = at(lawsPath, i);
    const e = object(entry, p, ['id', 'label', 'color', 'visible']);
    const law: LawPresentation = {
      id: string(e.id, at(p, 'id'), SCENE_LIMITS.idLength),
      label: string(e.label, at(p, 'label')),
      color: string(e.color, at(p, 'color')),
      visible: boolean(e.visible, at(p, 'visible')),
    };
    if (!scene.fields.some((f) => f.id === law.id)) throw new ImportError(at(p, 'id'), `no law has id ${JSON.stringify(law.id)}`);
    if (stored.has(law.id)) throw new ImportError(at(p, 'id'), `id ${JSON.stringify(law.id)} appears twice`);
    const error = checkLawPresentation(law);
    if (error) throw new ImportError(p, error);
    stored.set(law.id, law);
  }
  // Laws without a stored entry take the constructor default, so the document is complete.
  const laws = scene.fields.map((f) => stored.get(f.id) ?? defaultLawPresentation(f.id));
  const arrows = boolean(o.arrows, at(path, 'arrows'));
  return camera ? { camera, arrows, laws } : { arrows, laws };
}

function metadata(value: unknown, path: string): SceneMetadata {
  const o = object(value, path, ['title'], ['description']);
  const title = string(o.title, at(path, 'title'));
  return o.description === undefined ? { title } : { title, description: string(o.description, at(path, 'description')) };
}

/** Reads an already parsed JSON value as a scene document, transactionally: a candidate or a precise error. */
export function readSceneValue(value: unknown, path = ''): SceneDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError(path, 'is not a Lawsmith scene (not a JSON object)');
  const root = value as Obj;
  if (root.format !== SCENE_FORMAT) throw new ImportError(at(path, 'format'), `is not a Lawsmith scene (expected format ${JSON.stringify(SCENE_FORMAT)})`);
  const version = integer(root.schemaVersion, at(path, 'schemaVersion'));
  if (version > SCHEMA_VERSION) throw new ImportError(at(path, 'schemaVersion'), `schema ${version} is newer than this build supports (${SCHEMA_VERSION})`);
  if (version !== SCHEMA_VERSION) throw new ImportError(at(path, 'schemaVersion'), `schema ${version} is not supported`);
  const capabilitiesPath = at(path, 'requiredCapabilities');
  const declared = array(root.requiredCapabilities, capabilitiesPath, 64).map((c, i) => string(c, at(capabilitiesPath, i), SCENE_LIMITS.idLength));
  for (const [i, capability] of declared.entries()) {
    if (!KNOWN_CAPABILITIES.has(capability)) throw new ImportError(at(capabilitiesPath, i), `this scene requires ${JSON.stringify(capability)}, which this build does not support`);
  }
  const o = object(value, path, ['format', 'schemaVersion', 'requiredCapabilities', 'semantic', 'presentation', 'metadata']);
  const scene = semantic(o.semantic, at(path, 'semantic'));
  for (const capability of requiredCapabilities(scene)) {
    if (!declared.includes(capability)) throw new ImportError(capabilitiesPath, `the scene uses ${JSON.stringify(capability)} but does not declare it`);
  }
  return {
    format: SCENE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    requiredCapabilities: requiredCapabilities(scene),
    semantic: scene,
    presentation: presentation(o.presentation, at(path, 'presentation'), scene),
    metadata: metadata(o.metadata, at(path, 'metadata')),
  };
}

/** Parses scene file text (SPEC §15.2): size, JSON, format, schema, capabilities, structure and bounds. */
export function parseScene(text: string): ParseResult {
  try {
    if (utf8Length(text) > SCENE_LIMITS.fileBytes) throw new ImportError('', `the file is larger than ${SCENE_LIMITS.fileBytes} bytes`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ImportError('', `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    return { ok: true, document: readSceneValue(value) };
  } catch (error) {
    if (error instanceof ImportError) return { ok: false, error };
    throw error;
  }
}
