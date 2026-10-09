// The `.lawsmith-run.json` recording format (SPEC §13.3, §15): an immutable RunRecord holding a frozen
// tick-zero root, the commands the host consumed, the frozen final address and the identities that
// qualify exact replay. Writing is canonical and its exact UTF-8 size is computable from parts, so a
// recorder can hold the complete-file budget incrementally. Reading is strict and transactional:
// a candidate record or a precise error, never a partly accepted log.
import { ID_PATTERN, RUN_FORMAT, SCENE_FORMAT, SCENE_LIMITS, deepFreeze, validateField, type FieldDefinition, type SceneDocument, type Vec3 } from '../domain/scene';
import { expressionStats } from '../fields/expression';
import type { AppliedCommand, CommandPayload, EffectiveProfile } from '../simulation/host';
import { ImportError, canonicalJson, readField, readSceneValue } from './sceneFile';

export { RUN_FORMAT };
export const RUN_SCHEMA_VERSION = 1;
export const RUN_SUFFIX = '.lawsmith-run.json';

/** SPEC §13.3 recording limits: 60 simulated seconds, 50,000 commands, 16 MiB of complete UTF-8 run data. */
export const RUN_LIMITS = Object.freeze({
  ticks: 7_200,
  commands: 50_000,
  fileBytes: 16 * 1024 * 1024,
  /** Identity strings are short facts, not documents. */
  identityLength: 512,
});

/** The simulation semantics a run was produced under (SPEC §5.1, §13.1): replay under any other is refused. */
export interface SimulationFingerprint {
  readonly profile: string;
  readonly rapier: string;
  /** SHA-256 of the Rapier WebAssembly module the compatibility package embeds. */
  readonly rapierWasmSha256: string;
  /** Effective engine integration parameters, as the profile pins them. */
  readonly effective: EffectiveProfile;
  readonly fieldKernel: string;
  /** The command vocabulary and its interpretation (SPEC §10.2). */
  readonly commands: string;
  /** The fixed step, seconds. */
  readonly step: string;
}

/**
 * The application and runtime a run was recorded in (SPEC §13.1). Exact replay is qualified only in
 * the same identity; `build` is `packaged` for the shipped app, `dev` or `headless` otherwise.
 */
export interface QualificationIdentity {
  readonly app: string;
  readonly build: string;
  /** The frontend bundle actually executing: its file name and SHA-256. */
  readonly bundle: string;
  /** The locked Tauri family: tauri, tauri-runtime, tauri-runtime-wry, WRY and TAO versions. */
  readonly tauri: string;
  readonly webkit: string;
  readonly os: string;
  readonly arch: string;
}

const IDENTITY_KEYS = ['app', 'arch', 'build', 'bundle', 'os', 'tauri', 'webkit'] as const;

/**
 * The qualification identity from the native runtime record and the bundle: facts observed, never
 * guessed. A composite fact (the Tauri family, the macOS version and build) is unavailable as a whole
 * when any part is, so `qualified` sees it.
 */
export function qualificationIdentity(native: unknown, bundle: string, build: string): QualificationIdentity {
  const facts = typeof native === 'object' && native !== null ? (native as Record<string, string>) : {};
  const fact = (key: string) => facts[key] || `unavailable: ${typeof native === 'string' ? native : `no ${key}`}`;
  const family = ['tauri', 'tauriRuntime', 'tauriRuntimeWry', 'wry', 'tao'].map(fact);
  const system = ['macos', 'macosBuild'].map(fact);
  return Object.freeze({
    app: fact('app'),
    build,
    bundle,
    tauri: family.some((v) => v.startsWith('unavailable')) ? `unavailable: ${family.join('; ')}` : `tauri ${family[0]}; tauri-runtime ${family[1]}; tauri-runtime-wry ${family[2]}; wry ${family[3]}; tao ${family[4]}`,
    webkit: fact('webview'),
    os: system.some((v) => v.startsWith('unavailable')) ? `unavailable: ${system.join('; ')}` : `macOS ${system[0]} (${system[1]})`,
    arch: fact('arch'),
  });
}

/** True when every fact is known and the build is the shipped one: only then is a replay an exactness claim. */
export function qualified(identity: QualificationIdentity): boolean {
  return identity.build === 'packaged' && IDENTITY_KEYS.every((k) => identity[k] !== '' && !identity[k].startsWith('unavailable'));
}

/** Why a recording ended. */
export type StopReason = 'user' | 'duration' | 'commands' | 'bytes' | 'fault';
const STOP_REASONS: readonly StopReason[] = ['user', 'duration', 'commands', 'bytes', 'fault'];

/** Digests of the state at the frozen final address: what a replay can check itself against. */
export interface FinalCheck {
  readonly stateSha256: string;
  readonly engineSha256: string;
}

/** An immutable recording (SPEC §13.3). Every nested value is frozen. */
export interface RunRecord {
  readonly format: typeof RUN_FORMAT;
  readonly schemaVersion: number;
  readonly runId: string;
  /** The frozen tick-zero root: the scene document the run started from (no camera). */
  readonly root: SceneDocument;
  readonly simulationFingerprint: SimulationFingerprint;
  readonly qualification: QualificationIdentity;
  readonly commands: readonly AppliedCommand[];
  readonly finalTick: number;
  /** The final cursor: the last included sequence, or 0 for an empty log. */
  readonly lastAppliedSequence: number;
  /** Absent only for a run ended by a simulation fault, whose world no longer holds the final state. */
  readonly finalCheck: FinalCheck | null;
  readonly stopped: StopReason;
}

// ---------------------------------------------------------------- canonical writing and its size

/** Compact canonical JSON: keys sorted by UTF-16 code unit, shortest round-trip numbers, −0 as 0, nonfinite refused. */
export function compactJson(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot serialize nonfinite number ${value}`);
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(compactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${compactJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error(`cannot serialize ${value === null ? 'null' : typeof value}`);
}

/** One command's exact text in the file: compact, on its own line. */
export const commandText = (command: AppliedCommand): string =>
  compactJson({ atTick: command.atTick, payload: command.payload, sequence: command.sequence, transactionId: command.transactionId });

/** UTF-8 length of a string without encoding it. A lone surrogate counts 3 bytes, as an encoder writes U+FFFD. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** A run without its log: the part of the file whose size is fixed once the endpoint is. */
export type RunEnvelope = Omit<RunRecord, 'commands'>;

const HEAD = '{\n  "commands": ';

/** The file with an empty log. The log sorts first, so it always begins `{\n  "commands": []`. */
function envelopeText(run: RunEnvelope): string {
  const text = `${canonicalJson({ ...run, commands: [], finalCheck: run.finalCheck ?? undefined })}\n`;
  if (!text.startsWith(`${HEAD}[]`)) throw new Error('run envelope does not begin with its log');
  return text;
}

/** Size of the whole file from the envelope's size and the log's: `[]`, or one indented line per command. */
export const runBytes = (envelopeBytes: number, commandBytes: number, count: number): number =>
  envelopeBytes - 2 + (count === 0 ? 2 : commandBytes + 6 * count + 4);

/**
 * The envelope at its largest endpoint (SPEC §13.3 reservation): the most digits a final tick and
 * cursor can take, a final check present and the longest stop reason. Advancing time or stopping can
 * then never grow the file past what a recorder has already admitted.
 */
export function reservedEnvelopeBytes(run: Omit<RunEnvelope, 'finalTick' | 'lastAppliedSequence' | 'finalCheck' | 'stopped'>): number {
  return utf8Bytes(
    envelopeText({
      ...run,
      finalTick: RUN_LIMITS.ticks,
      lastAppliedSequence: RUN_LIMITS.commands,
      finalCheck: { stateSha256: '0'.repeat(64), engineSha256: '0'.repeat(64) },
      stopped: 'duration',
    }),
  );
}

/** The run file's exact text: the canonical envelope with one compact command per line. */
export function serializeRun(run: RunRecord): string {
  const envelope = envelopeText(run);
  const log = run.commands.length ? `[\n${run.commands.map((c) => `    ${commandText(c)}`).join(',\n')}\n  ]` : '[]';
  return HEAD + log + envelope.slice(HEAD.length + 2);
}

/** A file name from the root's title, with the explicit `.lawsmith-run.json` suffix. */
export function suggestedRunName(title: string): string {
  const base = title.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';
  return `${base} recording${RUN_SUFFIX}`;
}

// ---------------------------------------------------------------- strict reading

/** What a run must match to be replayed here: this build's simulation and its runtime. */
export interface RunExpectations {
  readonly fingerprint: SimulationFingerprint;
  readonly identity: QualificationIdentity;
}

/**
 * A rejected run. `incompatible` marks a well-formed run from a different simulation or runtime, which
 * cannot replay exactly here (SPEC §13.1), as opposed to a malformed one.
 */
export type RunParse = { ok: true; record: RunRecord } | { ok: false; error: ImportError; incompatible: boolean };

type Obj = Record<string, unknown>;
const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError(path, 'must be an object');
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new ImportError(at(path, key), 'is not a known property');
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ImportError(at(path, key), 'is required');
  return value as Obj;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ImportError(path, 'must be a safe integer');
  if (value < min || value > max) throw new ImportError(path, `must be within ${min}–${max}`);
  return value;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new ImportError(path, 'must be a string');
  if (value.length === 0 || value.length > max) throw new ImportError(path, `must be 1–${max} characters`);
  return value;
}

function id(value: unknown, path: string): string {
  const text = string(value, path, SCENE_LIMITS.idLength);
  if (!ID_PATTERN.test(text)) throw new ImportError(path, 'must be ASCII letters, digits, _ or -');
  return text;
}

const SHA256 = /^[0-9a-f]{64}$/;

class Incompatible extends ImportError {}

function readFingerprint(value: unknown, path: string, expected: SimulationFingerprint): SimulationFingerprint {
  const keys = Object.keys(expected);
  const o = object(value, path, keys);
  const effective = object(o.effective, at(path, 'effective'), Object.keys(expected.effective));
  for (const key of Object.keys(expected.effective)) {
    const recorded = effective[key];
    const wanted = (expected.effective as Record<string, number>)[key];
    if (typeof recorded !== 'number' || !Number.isFinite(recorded)) throw new ImportError(at(at(path, 'effective'), key), 'must be a finite number');
    if (!Object.is(recorded, wanted)) throw new Incompatible(at(at(path, 'effective'), key), `was ${recorded} when recorded; this build's simulation uses ${wanted}`);
  }
  for (const key of keys) {
    if (key === 'effective') continue;
    const recorded = string(o[key], at(path, key), RUN_LIMITS.identityLength);
    const wanted = (expected as unknown as Record<string, string>)[key];
    if (recorded !== wanted) throw new Incompatible(at(path, key), `was ${JSON.stringify(recorded)} when recorded; this build's simulation uses ${JSON.stringify(wanted)}`);
  }
  return expected;
}

function readIdentity(value: unknown, path: string, expected: QualificationIdentity): QualificationIdentity {
  const o = object(value, path, IDENTITY_KEYS);
  const differences: string[] = [];
  for (const key of IDENTITY_KEYS) {
    const recorded = string(o[key], at(path, key), RUN_LIMITS.identityLength);
    if (recorded !== expected[key]) differences.push(`${key} ${JSON.stringify(recorded)} (here ${JSON.stringify(expected[key])})`);
  }
  if (differences.length) {
    throw new Incompatible(path, `it was recorded by a different Lawsmith build or runtime: ${differences.join('; ')}. Exact replay is qualified only in the environment that recorded it`);
  }
  return expected;
}

function readVec3(value: unknown, path: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new ImportError(path, 'must be an array of 3 numbers');
  return value.map((c, i) => {
    if (typeof c !== 'number' || !Number.isFinite(c)) throw new ImportError(at(path, i), 'must be a finite number');
    return c === 0 ? 0 : c;
  }) as unknown as Vec3;
}

/**
 * Reads one recorded payload into the exact value the host consumed. A payload must already be in
 * the canonical form validation produces, so the value replayed is bit for bit the value recorded.
 */
function readPayload(value: unknown, path: string): CommandPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError(path, 'must be an object');
  const kind = (value as Obj).kind;
  if (kind === 'putField') {
    const o = object(value, path, ['kind', 'field']);
    const read = readField(o.field, at(path, 'field'));
    const result = validateField(read);
    if (!result.ok) throw new ImportError(at(at(path, 'field'), result.path), result.reason);
    if (compactJson(result.value) !== compactJson(o.field)) throw new ImportError(at(path, 'field'), 'is not in the canonical form this build records');
    return { kind, field: result.value };
  }
  if (kind === 'removeField') {
    const o = object(value, path, ['kind', 'id']);
    return { kind, id: id(o.id, at(path, 'id')) };
  }
  if (kind === 'setAmbient') {
    const o = object(value, path, ['kind', 'acceleration']);
    const acceleration = readVec3(o.acceleration, at(path, 'acceleration'));
    if (Math.hypot(...acceleration) > 200) throw new ImportError(at(path, 'acceleration'), 'must have magnitude at most 200 m/s²');
    return { kind, acceleration };
  }
  throw new ImportError(at(path, 'kind'), `unknown command ${JSON.stringify(kind)}; this build applies putField, removeField and setAmbient`);
}

/**
 * Reads the command log against the root it starts from: ordered sequences from 1, nondecreasing
 * boundaries within the final address, payloads valid, removals of laws that exist at that point,
 * creations of IDs no body or emitter holds, and the scene's law and leaf budgets throughout.
 */
function readCommands(value: unknown, path: string, root: SceneDocument, finalTick: number): AppliedCommand[] {
  if (!Array.isArray(value)) throw new ImportError(path, 'must be an array');
  if (value.length > RUN_LIMITS.commands) throw new ImportError(path, `must have at most ${RUN_LIMITS.commands} commands`);
  const reserved = new Set([...root.semantic.bodies.map((b) => b.id), ...root.semantic.emitters.map((e) => e.id)]);
  const leaves = new Map(root.semantic.fields.map((f) => [f.id, expressionStats(f.expression).leaves]));
  let leafTotal = [...leaves.values()].reduce((a, b) => a + b, 0);
  let previousTick = 0;
  const commands: AppliedCommand[] = [];
  for (const [i, entry] of value.entries()) {
    const p = at(path, i);
    const o = object(entry, p, ['atTick', 'payload', 'sequence', 'transactionId']);
    const atTick = integer(o.atTick, at(p, 'atTick'), 0, finalTick);
    if (atTick < previousTick) throw new ImportError(at(p, 'atTick'), `must not precede the previous command's tick ${previousTick}`);
    previousTick = atTick;
    const sequence = integer(o.sequence, at(p, 'sequence'), 1, RUN_LIMITS.commands);
    if (sequence !== i + 1) throw new ImportError(at(p, 'sequence'), `must be ${i + 1}: sequences start at 1 and increase by one`);
    const transactionId = id(o.transactionId, at(p, 'transactionId'));
    const payload = readPayload(o.payload, at(p, 'payload'));
    if (payload.kind === 'removeField') {
      if (!leaves.has(payload.id)) throw new ImportError(at(at(p, 'payload'), 'id'), `no law ${JSON.stringify(payload.id)} exists at this point`);
      leafTotal -= leaves.get(payload.id)!;
      leaves.delete(payload.id);
    } else if (payload.kind === 'putField') {
      const { field } = payload as { field: FieldDefinition };
      if (reserved.has(field.id)) throw new ImportError(at(at(p, 'payload'), 'field.id'), `id ${JSON.stringify(field.id)} belongs to a body or emitter`);
      if (!leaves.has(field.id) && leaves.size >= SCENE_LIMITS.fields) throw new ImportError(at(p, 'payload'), `a scene holds at most ${SCENE_LIMITS.fields} laws`);
      const count = expressionStats(field.expression).leaves;
      leafTotal += count - (leaves.get(field.id) ?? 0);
      leaves.set(field.id, count);
      if (leafTotal > SCENE_LIMITS.primitiveLeaves) throw new ImportError(at(p, 'payload'), `the scene's laws would hold more than ${SCENE_LIMITS.primitiveLeaves} primitive leaves`);
    }
    commands.push({ atTick, sequence, transactionId, payload });
  }
  return commands;
}

/**
 * Parses a run file (SPEC §13.3, §15.2): size, JSON, format, schema, simulation fingerprint and
 * qualified identity, then the root, endpoint and every command. Nothing is executed or merged.
 */
export function parseRun(text: string, expected: RunExpectations): RunParse {
  try {
    if (utf8Bytes(text) > RUN_LIMITS.fileBytes) throw new ImportError('', `the file is larger than ${RUN_LIMITS.fileBytes} bytes`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ImportError('', `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError('', 'is not a Lawsmith recording (not a JSON object)');
    const top = value as Obj;
    if (top.format === SCENE_FORMAT) throw new ImportError('format', 'this is a Lawsmith scene, not a recording; open it with Open Scene');
    if (top.format !== RUN_FORMAT) throw new ImportError('format', `is not a Lawsmith recording (expected format ${JSON.stringify(RUN_FORMAT)})`);
    const version = integer(top.schemaVersion, 'schemaVersion', 0, Number.MAX_SAFE_INTEGER);
    if (version > RUN_SCHEMA_VERSION) throw new ImportError('schemaVersion', `schema ${version} is newer than this build supports (${RUN_SCHEMA_VERSION})`);
    if (version !== RUN_SCHEMA_VERSION) throw new ImportError('schemaVersion', `schema ${version} is not supported`);
    const o = object(
      value,
      '',
      ['commands', 'finalTick', 'format', 'lastAppliedSequence', 'qualification', 'root', 'runId', 'schemaVersion', 'simulationFingerprint', 'stopped'],
      ['finalCheck'],
    );
    // Compatibility first: a run from another simulation or runtime is refused before anything else is read.
    const simulationFingerprint = readFingerprint(o.simulationFingerprint, 'simulationFingerprint', expected.fingerprint);
    const qualification = readIdentity(o.qualification, 'qualification', expected.identity);
    const runId = id(o.runId, 'runId');
    const root = readSceneValue(o.root, 'root');
    if (root.presentation.camera) throw new ImportError('root.presentation.camera', 'a recording root holds no camera');
    if (canonicalJson(root.semantic) !== canonicalJson((o.root as Obj).semantic)) throw new ImportError('root.semantic', 'is not in the canonical form this build records');
    const finalTick = integer(o.finalTick, 'finalTick', 0, RUN_LIMITS.ticks);
    const lastAppliedSequence = integer(o.lastAppliedSequence, 'lastAppliedSequence', 0, RUN_LIMITS.commands);
    if (typeof o.stopped !== 'string' || !STOP_REASONS.includes(o.stopped as StopReason)) throw new ImportError('stopped', `must be one of ${STOP_REASONS.map((r) => JSON.stringify(r)).join(', ')}`);
    const stopped = o.stopped as StopReason;
    if (stopped === 'duration' && finalTick !== RUN_LIMITS.ticks) throw new ImportError('stopped', `a recording stopped at its duration limit ends at tick ${RUN_LIMITS.ticks}`);
    let finalCheck: FinalCheck | null = null;
    if (o.finalCheck !== undefined) {
      const c = object(o.finalCheck, 'finalCheck', ['engineSha256', 'stateSha256']);
      for (const key of ['engineSha256', 'stateSha256'] as const) if (typeof c[key] !== 'string' || !SHA256.test(c[key] as string)) throw new ImportError(`finalCheck.${key}`, 'must be 64 lowercase hex digits');
      finalCheck = { stateSha256: c.stateSha256 as string, engineSha256: c.engineSha256 as string };
    }
    if ((stopped === 'fault') !== (finalCheck === null)) throw new ImportError('finalCheck', stopped === 'fault' ? 'is not recorded for a run ended by a fault' : 'is required');
    const commands = readCommands(o.commands, 'commands', root, finalTick);
    const last = commands.length ? commands[commands.length - 1]!.sequence : 0;
    if (lastAppliedSequence !== last) throw new ImportError('lastAppliedSequence', `must be ${last}, the last included sequence`);
    if (stopped === 'commands' && commands.length !== RUN_LIMITS.commands) throw new ImportError('stopped', `a recording stopped at its command limit holds ${RUN_LIMITS.commands} commands`);
    // Every object here is new, built by this reader: freezing in place is enough, no copy of the log.
    const record: RunRecord = deepFreeze({
      format: RUN_FORMAT,
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      root,
      simulationFingerprint,
      qualification,
      commands,
      finalTick,
      lastAppliedSequence,
      finalCheck,
      stopped,
    });
    return { ok: true, record };
  } catch (error) {
    if (error instanceof ImportError) return { ok: false, error, incompatible: error instanceof Incompatible };
    throw error;
  }
}
