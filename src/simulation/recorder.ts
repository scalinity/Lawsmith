// The run recorder (SPEC §13.3): it observes the commands the live host actually consumes, from a
// frozen tick-zero root, and closes at the first limit with its prefix intact. It never fabricates a
// command from input events: the host offers it each resolved command before applying it.
import { deepFreeze, type SceneDocument } from '../domain/scene';
import { FIELD_KERNEL_VERSION } from '../fields/kernel';
import {
  RUN_FORMAT,
  RUN_LIMITS,
  RUN_SCHEMA_VERSION,
  commandText,
  reservedEnvelopeBytes,
  runBytes,
  serializeRun,
  utf8Bytes,
  type QualificationIdentity,
  type RunRecord,
  type SimulationFingerprint,
  type StopReason,
} from '../persistence/runFile';
import { SIMULATION_PROFILE, type AppliedCommand, type CommandRecorder, type SimulationHost } from './host';

/**
 * SHA-256 of the WebAssembly module `@dimforge/rapier3d-compat` 0.21.0 embeds (its base64 payload,
 * decoded). A test derives it again from the installed package, so a changed engine artifact fails.
 */
export const RAPIER_WASM_SHA256 = '17cfa80eebd8de0291b948496dbffba724b98b489687f8272ca236a7bbf1dd4b';

/** The command vocabulary and its interpretation, as `SimulationHost` applies it. */
export const COMMAND_SEMANTICS = 'lawsmith.commands.v1: putField, removeField, setAmbient at boundary atTick';

/** This build's simulation semantics (SPEC §13.1): profile, engine artifact, kernel and commands. */
export const SIMULATION_FINGERPRINT: SimulationFingerprint = deepFreeze({
  profile: SIMULATION_PROFILE.id,
  rapier: SIMULATION_PROFILE.rapier,
  rapierWasmSha256: RAPIER_WASM_SHA256,
  effective: { ...SIMULATION_PROFILE.effective },
  fieldKernel: FIELD_KERNEL_VERSION,
  commands: COMMAND_SEMANTICS,
  step: '1/120',
});

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The final address and the state there, captured synchronously when the recorder closes. */
export interface Closing {
  readonly reason: StopReason;
  readonly tick: number;
  readonly sequence: number;
  /** `JSON.stringify(host.futureState())` and the engine snapshot; null after a fault, when the world no longer holds that state. */
  readonly state: string | null;
  readonly engine: Uint8Array | null;
}

/** A root or envelope too large for any recording to fit (SPEC §13.3: reject starting it). */
export class RecordingTooLarge extends Error {}

const LIMIT_REASONS: ReadonlySet<StopReason> = new Set(['duration', 'commands', 'bytes']);

export class RunRecorder implements CommandRecorder {
  private readonly log: AppliedCommand[] = [];
  private logBytes = 0;
  /** Size of the admitted command, between `admit` and its `append`. */
  private admitted = 0;
  private readonly envelopeBytes: number;
  closed: Closing | null = null;
  /** Told, synchronously, when the recorder closes itself at a limit (the host is then halted). */
  onLimit: ((reason: StopReason) => void) | null = null;

  /**
   * Starts recording `host`, which must have just been rebuilt from `root.semantic`: tick 0, cursor 0,
   * nothing queued. The root is the frozen document the run starts from; it is never edited.
   */
  constructor(
    private readonly host: SimulationHost,
    readonly root: SceneDocument,
    readonly qualification: QualificationIdentity,
    readonly runId: string,
    readonly fingerprint: SimulationFingerprint = SIMULATION_FINGERPRINT,
  ) {
    if (host.tick !== 0 || host.lastAppliedSequence !== 0 || host.pendingCount !== 0 || host.recorder || host.halted) {
      throw new Error('A recording starts from a freshly rebuilt world at (0, 0) with nothing queued.');
    }
    this.envelopeBytes = RunRecorder.check(root, qualification, runId, fingerprint);
    host.recorder = this;
  }

  /**
   * The reserved envelope's size for a run from `root` (SPEC §13.3): refuses, before anything is
   * rebuilt, a root whose recording could not hold even an empty log.
   */
  static check(root: SceneDocument, qualification: QualificationIdentity, runId: string, fingerprint: SimulationFingerprint = SIMULATION_FINGERPRINT): number {
    const bytes = reservedEnvelopeBytes({ format: RUN_FORMAT, schemaVersion: RUN_SCHEMA_VERSION, runId, root, simulationFingerprint: fingerprint, qualification });
    if (runBytes(bytes, 0, 0) > RUN_LIMITS.fileBytes) {
      throw new RecordingTooLarge(`This scene alone would take ${bytes} bytes of a recording; a recording holds at most ${RUN_LIMITS.fileBytes}.`);
    }
    return bytes;
  }

  /** Commands recorded so far. */
  get count(): number {
    return this.log.length;
  }

  /** The complete file's size so far, with the endpoint reserved at its largest. */
  get bytes(): number {
    return runBytes(this.envelopeBytes, this.logBytes, this.log.length);
  }

  /** The completed tick the live world has reached. */
  get tick(): number {
    return this.closed?.tick ?? this.host.tick;
  }

  /** Preflight (SPEC §13.3): refuses a command that would exceed the count or the complete UTF-8 budget, before it mutates anything. */
  admit(command: AppliedCommand): boolean {
    if (this.closed) return false;
    if (this.log.length + 1 > RUN_LIMITS.commands) {
      this.close('commands');
      return false;
    }
    const size = utf8Bytes(commandText(command));
    if (runBytes(this.envelopeBytes, this.logBytes + size, this.log.length + 1) > RUN_LIMITS.fileBytes) {
      this.close('bytes');
      return false;
    }
    this.admitted = size;
    return true;
  }

  append(command: AppliedCommand): void {
    // The log is append-only and immutable once consumed; the payload is the resolved, frozen value.
    this.log.push(Object.freeze({ atTick: command.atTick, sequence: command.sequence, transactionId: command.transactionId, payload: deepFreeze(command.payload) }));
    this.logBytes += this.admitted;
  }

  /** After a completed transition: the record closes on reaching 60 simulated seconds. */
  stepped(tick: number): void {
    if (tick >= RUN_LIMITS.ticks) this.close('duration');
  }

  /** Ends the recording at the world's current address: an ordinary stop, or after a fault. */
  stop(reason: 'user' | 'fault' = 'user'): void {
    this.close(reason);
  }

  /**
   * Freezes the prefix and the final address now, with the state there, and detaches from the host.
   * At a limit the host stays halted, so no later command or step can follow the record's end.
   */
  private close(reason: StopReason): void {
    if (this.closed) return;
    const host = this.host;
    const faulted = reason === 'fault' || host.fault !== null;
    this.closed = Object.freeze({
      reason: faulted ? 'fault' : reason,
      tick: host.tick,
      sequence: host.lastAppliedSequence,
      state: faulted ? null : JSON.stringify(host.futureState()),
      engine: faulted ? null : host.engineSnapshot(),
    });
    host.recorder = null;
    if (LIMIT_REASONS.has(reason)) {
      host.halted = true;
      this.onLimit?.(reason);
    }
  }

  /**
   * The immutable RunRecord, once closed: the final check is the SHA-256 of the state and engine bytes
   * captured at the final address. Its exact size is checked against what the recorder reserved.
   */
  async record(): Promise<RunRecord> {
    const closed = this.closed;
    if (!closed) throw new Error('the recording is still running');
    const last = this.log.length ? this.log[this.log.length - 1]!.sequence : 0;
    if (closed.sequence !== last) throw new Error(`the final cursor ${closed.sequence} is not the last recorded sequence ${last}`);
    const finalCheck = closed.state === null ? null : { stateSha256: await sha256Hex(closed.state), engineSha256: await sha256Hex(closed.engine!) };
    const record: RunRecord = deepFreeze({
      format: RUN_FORMAT,
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: this.runId,
      root: this.root,
      simulationFingerprint: this.fingerprint,
      qualification: this.qualification,
      commands: [...this.log],
      finalTick: closed.tick,
      lastAppliedSequence: closed.sequence,
      finalCheck,
      stopped: closed.reason,
    });
    return record;
  }
}

/**
 * The exact export (SPEC §13.3): the canonical text and its UTF-8 size, refused if over the limit, so
 * a saved run is always one this build's reader accepts by size.
 */
export function exportRun(record: RunRecord): { text: string; bytes: number } {
  const text = serializeRun(record);
  const bytes = utf8Bytes(text);
  if (bytes > RUN_LIMITS.fileBytes) throw new Error(`the recording is ${bytes} bytes; a run file holds at most ${RUN_LIMITS.fileBytes}`);
  return { text, bytes };
}
