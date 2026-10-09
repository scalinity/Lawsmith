// The `.lawsmith-run.json` format (SPEC §13.3, §15.2): canonical writing whose exact UTF-8 size is
// known from its parts, and a strict, transactional reader that refuses anything this build would not
// replay exactly, naming the path. Valid inputs come from real recordings.
import { beforeAll, describe, expect, it } from 'vitest';
import { deepFreeze } from '../src/domain/scene';
import {
  RUN_LIMITS,
  commandText,
  parseRun,
  qualificationIdentity,
  qualified,
  reservedEnvelopeBytes,
  runBytes,
  serializeRun,
  suggestedRunName,
  utf8Bytes,
  type RunRecord,
} from '../src/persistence/runFile';
import { parseScene } from '../src/persistence/sceneFile';
import { DEFAULT_SCENE_TEXT } from '../src/persistence/defaultScene';
import { initSimulation } from '../src/simulation/host';
import { RAPIER_WASM_SHA256, SIMULATION_FINGERPRINT, exportRun } from '../src/simulation/recorder';
import { EXPECT, TEST_IDENTITY, laboratory, moveTo, session } from './support/run';
import rapierSource from '../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs?raw';
import { sha256Hex } from '../src/simulation/recorder';

beforeAll(async () => {
  await initSimulation();
});

/** A short real recording: a drag, an enable change, a removal and a re-creation, an ambient change. */
async function recorded(title = 'Storm Bottle'): Promise<RunRecord> {
  const document = laboratory();
  const s = session({ ...document, metadata: { title } });
  s.coordinator.startRecording();
  s.steps(10);
  const tx = s.controller.newTransaction();
  for (const x of [-1, -0.5]) {
    s.controller.putField(moveTo(x)(s.controller.lawState('push')!.field), tx);
    s.step();
  }
  s.controller.editField('calm', 'Disable law', (f) => ({ ...f, enabled: false }));
  s.controller.remove('calm');
  s.controller.undo();
  s.controller.setAmbient([0, -9.7, 0]);
  s.steps(5);
  return (await s.coordinator.stopRecording())!;
}

const text = (r: RunRecord) => exportRun(r).text;
type Json = Record<string, unknown> & { commands: Record<string, unknown>[]; root: Record<string, unknown> & { semantic: Record<string, unknown> & { fields: Record<string, unknown>[] } } };
/** The record's JSON, changed by `edit`, as file text (whitespace is free; values are what is checked). */
function mutated(r: RunRecord, edit: (j: Json) => void): string {
  const j = JSON.parse(text(r)) as Json;
  edit(j);
  return JSON.stringify(j, null, 1);
}
const refusal = (t: string) => {
  const result = parseRun(t, EXPECT);
  if (result.ok) throw new Error('expected a refusal');
  return { path: result.error.path, reason: result.error.reason, incompatible: result.incompatible };
};

describe('the engine artifact in the fingerprint', () => {
  it('RAPIER_WASM_SHA256 is the SHA-256 of the WebAssembly module the installed compatibility package embeds', async () => {
    const payloads = [...rapierSource.matchAll(/"([A-Za-z0-9+/=]{100000,})"/g)].map((m) => Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
    expect(payloads).toHaveLength(1);
    expect([...payloads[0]!.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
    expect(await sha256Hex(payloads[0]!)).toBe(RAPIER_WASM_SHA256);
    expect(SIMULATION_FINGERPRINT.rapierWasmSha256).toBe(RAPIER_WASM_SHA256);
  });
});

describe('exact UTF-8 size (SPEC §13.3)', () => {
  it('utf8Bytes counts what an encoder writes: ASCII, two-, three- and four-byte characters, lone surrogates', () => {
    for (const sample of ['', 'plain', 'é', '€', '嵐の瓶', '🌪️ storm', 'a\u{1F600}b', '\ud800', 'x\udc00y', '😀\ud83d', 'mixed é€🌪️ \u0000 end']) {
      expect(utf8Bytes(sample)).toBe(new TextEncoder().encode(sample).length);
    }
    expect('嵐の瓶'.length).toBe(3);
    expect(utf8Bytes('嵐の瓶')).toBe(9);
  });

  it('the reserved envelope plus the log is the exact size of a file at the largest endpoint, multibyte text included', async () => {
    for (const title of ['Plain', 'Sturmflasche — 嵐の瓶 🌪️']) {
      const r = await recorded(title);
      const base = { format: r.format, schemaVersion: r.schemaVersion, runId: r.runId, root: r.root, simulationFingerprint: r.simulationFingerprint, qualification: r.qualification };
      const reserved = reservedEnvelopeBytes(base);
      for (const n of [0, 1, 2, r.commands.length]) {
        const commands = r.commands.slice(0, n);
        const widest: RunRecord = deepFreeze({ ...structuredClone(r), commands, finalTick: RUN_LIMITS.ticks, lastAppliedSequence: RUN_LIMITS.commands, stopped: 'duration' as const });
        const logBytes = commands.reduce((sum, c) => sum + utf8Bytes(commandText(c)), 0);
        expect(utf8Bytes(serializeRun(widest))).toBe(runBytes(reserved, logBytes, n));
      }
      // The real endpoint is never larger than the reservation.
      const actual = utf8Bytes(text(r));
      const logBytes = r.commands.reduce((sum, c) => sum + utf8Bytes(commandText(c)), 0);
      expect(actual).toBeLessThanOrEqual(runBytes(reserved, logBytes, r.commands.length));
      expect(actual).toBeGreaterThan(text(r).length - (title === 'Plain' ? 1 : 0) - 1);
    }
  });

  it('a file of exactly 16 MiB is read; one byte more is refused, counting bytes, not characters', async () => {
    const r = await recorded();
    const t = text(r);
    // Whitespace before the final brace: valid JSON, and the reader checks values, not layout.
    const close = t.lastIndexOf('}');
    const exact = t.slice(0, close) + ' '.repeat(RUN_LIMITS.fileBytes - utf8Bytes(t)) + t.slice(close);
    expect(utf8Bytes(exact)).toBe(RUN_LIMITS.fileBytes);
    expect(parseRun(exact, EXPECT).ok).toBe(true);
    const over = `${exact} `;
    expect(refusal(over).reason).toMatch(/larger than 16777216 bytes/);
    // A multibyte title that keeps the character count under the limit but not the byte count.
    const wide = mutated(r, (j) => {
      (j.root.metadata as { title: string }).title = '嵐'.repeat(8000);
    });
    const padded = wide.slice(0, -1) + ' '.repeat(RUN_LIMITS.fileBytes - wide.length - 100) + '}';
    expect(padded.length).toBeLessThan(RUN_LIMITS.fileBytes);
    expect(utf8Bytes(padded)).toBeGreaterThan(RUN_LIMITS.fileBytes);
    expect(refusal(padded).reason).toMatch(/larger than/);
  });
});

describe('round trip and identity', () => {
  it('serialize → read → serialize is byte-identical, and the record read is deeply frozen', async () => {
    const r = await recorded('Sturmflasche — 嵐の瓶 🌪️');
    const t = text(r);
    const read = parseRun(t, EXPECT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(serializeRun(read.record)).toBe(t);
    const frozen = (v: unknown): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(frozen(read.record)).toBe(true);
    // One compact command per line, the log first.
    expect(t.startsWith('{\n  "commands": [\n    {"atTick":10,"payload":{"field":')).toBe(true);
    expect(suggestedRunName('Storm/Bottle')).toBe('Storm-Bottle recording.lawsmith-run.json');
  });

  it('only the packaged build with every fact known is a qualified identity', () => {
    expect(qualified(TEST_IDENTITY)).toBe(false);
    const packaged = { ...TEST_IDENTITY, build: 'packaged' };
    expect(qualified(packaged)).toBe(true);
    expect(qualified({ ...packaged, webkit: 'unavailable: no runtime' })).toBe(false);
    expect(qualified({ ...packaged, build: 'dev' })).toBe(false);
  });
});

describe('strict reading: a precise refusal, never a partly accepted run (SPEC §13.3, §15.2)', () => {
  let r: RunRecord;
  beforeAll(async () => {
    r = await recorded();
  });

  it('refuses what is not a recording: not JSON, not an object, a scene, another format, another schema', () => {
    expect(refusal('{').reason).toMatch(/not valid JSON/);
    expect(refusal('[]').reason).toMatch(/not a JSON object/);
    expect(refusal(DEFAULT_SCENE_TEXT)).toMatchObject({ path: 'format', reason: 'this is a Lawsmith scene, not a recording; open it with Open Scene' });
    expect(refusal(mutated(r, (j) => (j.format = 'lawsmith.other'))).path).toBe('format');
    expect(refusal(mutated(r, (j) => (j.schemaVersion = 2))).reason).toMatch(/newer than this build/);
    expect(refusal(mutated(r, (j) => (j.schemaVersion = 0))).reason).toMatch(/not supported/);
    // And the scene reader refuses a recording with the reverse hint.
    const asScene = parseScene(text(r));
    expect(!asScene.ok && asScene.error.reason).toBe('this is a Lawsmith recording, not a scene; open it with Open Recording');
  });

  it('refuses unknown, missing and prototype keys', () => {
    expect(refusal(mutated(r, (j) => (j.extra = 1)))).toMatchObject({ path: 'extra', reason: 'is not a known property' });
    expect(refusal(text(r).replace('{\n  "commands"', '{\n  "__proto__": {"polluted": true},\n  "commands"'))).toMatchObject({ path: '__proto__' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(refusal(mutated(r, (j) => delete j.runId))).toMatchObject({ path: 'runId', reason: 'is required' });
    expect(refusal(mutated(r, (j) => (j.commands[0]!.note = 'x'))).path).toBe('commands[0].note');
    expect(refusal(mutated(r, (j) => ((j.commands[0]!.payload as Record<string, unknown>).extra = 1))).path).toBe('commands[0].payload.extra');
    expect(refusal(mutated(r, (j) => (j.runId = 'run with spaces'))).path).toBe('runId');
  });

  it('refuses a different simulation, as incompatible, naming what differs', () => {
    for (const key of ['profile', 'rapier', 'rapierWasmSha256', 'fieldKernel', 'commands', 'step']) {
      const result = refusal(mutated(r, (j) => ((j.simulationFingerprint as Record<string, unknown>)[key] = 'other')));
      expect(result).toMatchObject({ path: `simulationFingerprint.${key}`, incompatible: true });
      expect(result.reason).toMatch(/when recorded; this build's simulation uses/);
    }
    const dt = refusal(mutated(r, (j) => (((j.simulationFingerprint as Record<string, Record<string, number>>).effective!).dt = 1 / 120)));
    expect(dt).toMatchObject({ path: 'simulationFingerprint.effective.dt', incompatible: true });
  });

  it('refuses another build or runtime, as incompatible, listing every difference, before reading anything else', () => {
    const other = mutated(r, (j) => {
      const q = j.qualification as Record<string, string>;
      q.webkit = '22625.2.5.11.2';
      q.bundle = 'index-other.js sha256:00';
      j.commands = 'not even an array' as never;
    });
    const result = refusal(other);
    expect(result).toMatchObject({ path: 'qualification', incompatible: true });
    expect(result.reason).toMatch(/bundle "index-other.js sha256:00" \(here "vitest \(unbundled sources\)"\); webkit "22625.2.5.11.2"/);
    expect(result.reason).toMatch(/Exact replay is qualified only in the environment that recorded it/);
  });

  it('refuses a bad root: invalid values, unknown capabilities, a camera, a non-canonical form', () => {
    expect(refusal(mutated(r, (j) => ((j.root.semantic.fields[0]!.edgeFade as number) = 2))).path).toBe('root.semantic.fields[0].edgeFade');
    expect(refusal(mutated(r, (j) => (j.root.requiredCapabilities as string[]).push('operator.clamp.v1'))).path).toMatch(/^root.requiredCapabilities/);
    expect(refusal(mutated(r, (j) => ((j.root.presentation as Record<string, unknown>).camera = { position: [1, 1, 1], target: [0, 0, 0] }))).path).toBe('root.presentation.camera');
    expect(refusal(mutated(r, (j) => j.root.semantic.fields.reverse()))).toMatchObject({ path: 'root.semantic', reason: 'is not in the canonical form this build records' });
  });

  it('refuses an endpoint out of range or not the log’s own', () => {
    expect(refusal(mutated(r, (j) => (j.finalTick = 7201))).path).toBe('finalTick');
    expect(refusal(mutated(r, (j) => (j.finalTick = 1.5))).path).toBe('finalTick');
    expect(refusal(mutated(r, (j) => (j.finalTick = -1))).path).toBe('finalTick');
    expect(refusal(mutated(r, (j) => (j.lastAppliedSequence = (j.lastAppliedSequence as number) - 1)))).toMatchObject({ path: 'lastAppliedSequence' });
    expect(refusal(mutated(r, (j) => (j.finalTick = 5))).path).toMatch(/^commands\[\d+\]\.atTick$/);
    expect(refusal(mutated(r, (j) => (j.stopped = 'tired'))).path).toBe('stopped');
    expect(refusal(mutated(r, (j) => delete j.finalCheck))).toMatchObject({ path: 'finalCheck', reason: 'is required' });
    expect(refusal(mutated(r, (j) => (j.stopped = 'fault')))).toMatchObject({ path: 'finalCheck' });
    expect(refusal(mutated(r, (j) => ((j.finalCheck as Record<string, string>).stateSha256 = 'ABC'))).path).toBe('finalCheck.stateSha256');
  });

  it('refuses a log out of order: sequences from 1 without gaps, boundaries never going back', () => {
    expect(refusal(mutated(r, (j) => (j.commands[0]!.sequence = 2))).path).toBe('commands[0].sequence');
    expect(refusal(mutated(r, (j) => (j.commands[2]!.sequence = 2))).path).toBe('commands[2].sequence');
    expect(refusal(mutated(r, (j) => j.commands.splice(1, 1))).path).toBe('commands[1].sequence');
    expect(refusal(mutated(r, (j) => (j.commands[1]!.atTick = 3))).reason).toMatch(/must not precede the previous command's tick 10/);
    expect(refusal(mutated(r, (j) => (j.commands = Array.from({ length: 50_001 }, () => ({}))))).reason).toMatch(/at most 50000 commands/);
    expect(refusal(mutated(r, (j) => delete j.commands[0]!.transactionId)).path).toBe('commands[0].transactionId');
    expect(refusal(mutated(r, (j) => (j.commands[0]!.transactionId = 'tx 1'))).path).toBe('commands[0].transactionId');
  });

  it('refuses payloads this build would not replay exactly: unknown, invalid, non-canonical or nonfinite', () => {
    const payload = (j: Json, i: number) => j.commands[i]!.payload as Record<string, unknown> & { field: Record<string, unknown> & { expression: Record<string, unknown> } };
    expect(refusal(mutated(r, (j) => (payload(j, 0).kind = 'teleport')))).toMatchObject({ path: 'commands[0].payload.kind' });
    expect(refusal(mutated(r, (j) => (payload(j, 0).field.expression.strength = 500))).path).toBe('commands[0].payload.field.expression.strength');
    expect(refusal(mutated(r, (j) => (payload(j, 0).field.expression.direction = [3, 0, 4])))).toMatchObject({ path: 'commands[0].payload.field', reason: 'is not in the canonical form this build records' });
    expect(refusal(mutated(r, (j) => ((payload(j, 0).field.pose as { rotation: number[] }).rotation = [0, 0, 0, -1]))).reason).toBe('is not in the canonical form this build records');
    expect(refusal(text(r).replace('"strength":12', '"strength":1e400')).path).toBe('commands[0].payload.field.expression.strength');
    const ambient = r.commands.findIndex((c) => c.payload.kind === 'setAmbient');
    expect(refusal(mutated(r, (j) => (payload(j, ambient).acceleration = [0, -300, 0]))).path).toBe(`commands[${ambient}].payload.acceleration`);
  });

  it('refuses commands that address laws wrongly: unknown removals, body and emitter IDs, the law and leaf budgets', () => {
    const remove = r.commands.findIndex((c) => c.payload.kind === 'removeField');
    expect(refusal(mutated(r, (j) => ((j.commands[remove]!.payload as { id: string }).id = 'ghost')))).toMatchObject({ path: `commands[${remove}].payload.id`, reason: 'no law "ghost" exists at this point' });
    // Removing twice: the second refers to a law that no longer exists.
    expect(refusal(mutated(r, (j) => ((j.commands[remove + 1]!.payload as Record<string, unknown>) = { kind: 'removeField', id: 'calm' }))).reason).toBe('no law "calm" exists at this point');
    for (const taken of ['floor', 'stream']) {
      expect(refusal(mutated(r, (j) => ((j.commands[0]!.payload as { field: { id: string } }).field.id = taken))).reason).toBe(`id "${taken}" belongs to a body or emitter`);
    }
    // A 33rd law, and a 257th primitive leaf.
    const create = (i: number, id: string, expression: unknown) => ({ atTick: 0, sequence: i + 1, transactionId: 'tx-x', payload: { kind: 'putField', field: { ...(JSON.parse(text(r)) as Json).root.semantic.fields[0], id, expression } } });
    const many = mutated(r, (j) => {
      const leaf = { kind: 'linearDrag', coefficient: 1 };
      j.commands = Array.from({ length: 30 }, (_, i) => create(i, `law-${i}`, leaf)) as never;
      j.lastAppliedSequence = 30;
      j.finalTick = 15;
    });
    expect(refusal(many)).toMatchObject({ path: 'commands[29].payload', reason: 'a scene holds at most 32 laws' });
    const leafy = mutated(r, (j) => {
      const sum = { kind: 'sum', terms: Array.from({ length: 63 }, () => ({ kind: 'linearDrag', coefficient: 1 })) };
      j.commands = Array.from({ length: 5 }, (_, i) => create(i, `big-${i}`, sum)) as never;
      j.lastAppliedSequence = 5;
      j.finalTick = 15;
    });
    // The root holds 5 leaves, so the fourth 63-leaf law makes 257.
    expect(refusal(leafy)).toMatchObject({ path: 'commands[3].payload', reason: 'the scene\'s laws would hold more than 256 primitive leaves' });
  });

  it('a refused run leaves nothing behind: every result is a refusal with no record', () => {
    const result = parseRun(mutated(r, (j) => (j.commands[1]!.sequence = 5)), EXPECT);
    expect(result).toMatchObject({ ok: false, incompatible: false });
    expect('record' in result).toBe(false);
  });
});

describe('the qualification identity (SPEC §13.1)', () => {
  // The packaged app's native runtime record and the identity its saved recording carries
  // (docs/evidence/m6a/m6a-qa.lawsmith-run.json): the format exact replay compares, byte for byte.
  const native = {
    app: 'Lawsmith 0.0.0',
    arch: 'aarch64',
    build: 'release',
    macos: '27.2',
    macosBuild: '26B5091g',
    recovery: 'override',
    tao: '0.37.1',
    tauri: '3.0.0-alpha.4',
    tauriRuntime: '3.0.0-alpha.3',
    tauriRuntimeWry: '3.0.0-alpha.4',
    webview: '22625.2.5.11.1',
    wry: '0.57.0',
  };
  const bundle = 'index-_JsT4sJa.js sha256:4414b3375cbbf6aeb3eecf052045d3d0943018c0bfc34ad0fafdaf17e1e1e9c6';

  it('builds the identity a packaged recording carries, and it is qualified', () => {
    const identity = qualificationIdentity(native, bundle, 'packaged');
    expect(identity).toEqual({
      app: 'Lawsmith 0.0.0',
      arch: 'aarch64',
      build: 'packaged',
      bundle,
      os: 'macOS 27.2 (26B5091g)',
      tauri: 'tauri 3.0.0-alpha.4; tauri-runtime 3.0.0-alpha.3; tauri-runtime-wry 3.0.0-alpha.4; wry 0.57.0; tao 0.37.1',
      webkit: '22625.2.5.11.1',
    });
    expect(qualified(identity)).toBe(true);
  });

  it('a macOS version or build that could not be read leaves the identity unqualified', () => {
    const noBuild = qualificationIdentity({ ...native, macosBuild: 'unavailable: no ProductBuildVersion' }, bundle, 'packaged');
    expect(noBuild.os).toBe('unavailable: 27.2; unavailable: no ProductBuildVersion');
    expect(qualified(noBuild)).toBe(false);
    const { macos: _, ...noVersion } = native;
    expect(qualified(qualificationIdentity(noVersion, bundle, 'packaged'))).toBe(false);
    expect(qualified(qualificationIdentity('unavailable: timed out', bundle, 'packaged'))).toBe(false);
  });
});
