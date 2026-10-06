// Application-local recovery (SPEC §15.3), frontend half: the bounded envelope and a serialized
// writer. The envelope holds the acknowledged main authored scene and its generation/revision;
// it is never a live engine snapshot. The native store orders writes and rejects stale ones.
import { SCENE_LIMITS, type SceneDocument } from '../domain/scene';
import { ImportError, canonicalJson, readSceneValue, utf8Length } from './sceneFile';
import type { DocumentIo, IoFailure } from './io';

export const RECOVERY_FORMAT = 'lawsmith.recovery';
const ENVELOPE_VERSION = 1;
const RECOVERY_LIMIT = SCENE_LIMITS.fileBytes + 64 * 1024;

export interface RecoveryEnvelope {
  readonly generation: number;
  readonly revision: number;
  readonly document: SceneDocument;
}

export function serializeRecovery(envelope: RecoveryEnvelope): string {
  return `${canonicalJson({ format: RECOVERY_FORMAT, version: ENVELOPE_VERSION, generation: envelope.generation, revision: envelope.revision, scene: envelope.document })}\n`;
}

/** Validates a stored snapshot exactly like an imported scene, plus its small envelope. */
export function parseRecovery(text: string): { ok: true; envelope: RecoveryEnvelope } | { ok: false; reason: string } {
  try {
    if (utf8Length(text) > RECOVERY_LIMIT) throw new ImportError('', 'the snapshot exceeds its size limit');
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError('', 'not a recovery snapshot');
    const o = value as Record<string, unknown>;
    if (o.format !== RECOVERY_FORMAT || o.version !== ENVELOPE_VERSION) throw new ImportError('format', 'not a Lawsmith recovery snapshot');
    for (const key of Object.keys(o)) if (!['format', 'version', 'generation', 'revision', 'scene'].includes(key)) throw new ImportError(key, 'is not a known property');
    const generation = o.generation;
    const revision = o.revision;
    if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new ImportError('generation', 'must be a positive integer');
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new ImportError('revision', 'must be a nonnegative integer');
    return { ok: true, envelope: { generation: generation as number, revision: revision as number, document: readSceneValue(o.scene, 'scene') } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A capture of the authored document for recovery, or null when nothing should be written now. */
export interface RecoveryCapture {
  readonly generation: number;
  readonly revision: number;
  readonly text: string;
}

export type RecoveryStatus =
  | { state: 'none' }
  | { state: 'written'; generation: number; revision: number }
  | { state: 'failed'; reason: string };

export interface RecoveryWriterOptions {
  io: Pick<DocumentIo, 'recoveryWrite' | 'recoveryRetire' | 'recoveryDiscard'>;
  /** Settles and serializes the current document; null when it is clean or a gesture is active. */
  capture(): RecoveryCapture | null;
  log(kind: string, data: Record<string, unknown>): void;
  onStatus(status: RecoveryStatus): void;
  now(): number;
  delayMs?: number;
}

/**
 * Serializes recovery writes and eligibility changes. Writes are debounced, captured from the
 * settled document, and skipped once their generation is discarded or their revision retired, so
 * a stale queued write can never resurrect saved or discarded work.
 */
export class RecoveryWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private last: { generation: number; revision: number } | null = null;
  private readonly retired = new Map<number, number>();
  status: RecoveryStatus = { state: 'none' };
  /** Main-thread time of each capture (settle + snapshot + serialize), for the M2 stall gate. */
  readonly captureMs: number[] = [];

  constructor(private readonly o: RecoveryWriterOptions) {}

  /** Requests a write after the debounce interval; repeated requests coalesce. */
  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, this.o.delayMs ?? 500);
  }

  /** Captures and queues a write immediately; resolves when that write has been acknowledged or refused. */
  writeNow(): Promise<void> {
    const start = this.o.now();
    const capture = this.o.capture();
    const captureMs = this.o.now() - start;
    if (!capture) return this.chain;
    this.captureMs.push(captureMs);
    if (this.isRetired(capture.generation, capture.revision) || this.isWritten(capture)) return this.chain;
    this.chain = this.chain.then(async () => {
      // Eligibility may have changed while this write waited its turn.
      if (this.isRetired(capture.generation, capture.revision) || this.isWritten(capture)) return;
      const sent = this.o.now();
      try {
        await this.o.io.recoveryWrite(capture.generation, capture.revision, capture.text);
        this.last = { generation: capture.generation, revision: capture.revision };
        this.setStatus({ state: 'written', generation: capture.generation, revision: capture.revision });
        this.o.log('recovery', { action: 'write', generation: capture.generation, revision: capture.revision, bytes: capture.text.length, captureMs: round(captureMs), ackMs: round(this.o.now() - sent) });
      } catch (error) {
        const failure = error as IoFailure;
        if (failure.kind === 'stale') {
          this.o.log('recovery', { action: 'write', outcome: 'stale', generation: capture.generation, revision: capture.revision, message: failure.message });
          return;
        }
        this.setStatus({ state: 'failed', reason: describeFailure(failure) });
        this.o.log('recovery', { action: 'write', outcome: 'failed', generation: capture.generation, revision: capture.revision, kind: failure.kind, stage: failure.stage, message: failure.message });
      }
    });
    return this.chain;
  }

  /** After an explicit save of `revision`: retire recovery at or before it in its generation. */
  retireThrough(generation: number, revision: number): Promise<void> {
    this.retired.set(generation, Math.max(this.retired.get(generation) ?? -1, revision));
    const done = this.chain.then(() => this.o.io.recoveryRetire(generation, revision));
    this.chain = done.then(
      () => this.o.log('recovery', { action: 'retire', generation, through: revision }),
      (failure: IoFailure) => {
        this.setStatus({ state: 'failed', reason: describeFailure(failure) });
        this.o.log('recovery', { action: 'retire', outcome: 'failed', generation, through: revision, kind: failure.kind, message: failure.message });
      },
    );
    return this.chain;
  }

  /**
   * An accepted Discard: retires written and queued snapshots of `generation`. Rejects if the
   * native store could not retire them, so the caller can abort instead of leaving them eligible.
   */
  discard(generation: number): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const done = this.chain.then(() => this.o.io.recoveryDiscard(generation));
    this.chain = done.then(
      () => {
        this.retired.set(generation, Number.MAX_SAFE_INTEGER);
        this.setStatus({ state: 'none' });
        this.o.log('recovery', { action: 'discard', generation });
      },
      (failure: IoFailure) => this.o.log('recovery', { action: 'discard', outcome: 'failed', generation, kind: failure.kind, message: failure.message }),
    );
    return done;
  }

  /** Waits for every queued write and eligibility change. */
  settled(): Promise<void> {
    return this.chain;
  }

  private isRetired(generation: number, revision: number): boolean {
    return revision <= (this.retired.get(generation) ?? -1);
  }

  private isWritten(capture: RecoveryCapture): boolean {
    const last = this.last;
    return last !== null && (capture.generation < last.generation || (capture.generation === last.generation && capture.revision <= last.revision));
  }

  private setStatus(status: RecoveryStatus): void {
    this.status = status;
    this.o.onStatus(status);
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;

const FAILURE_TEXT: Record<string, string> = {
  permission: 'permission was denied',
  'disk-full': 'the disk is full',
  'read-only': 'the disk is read-only',
  'not-found': 'the location no longer exists',
  'too-large': 'it is larger than 5 MB',
  'not-utf8': 'it is not UTF-8 text',
  'not-a-file': 'it is not a regular file',
  uncertain: 'completion could not be confirmed',
  'unknown-destination': 'the destination is no longer available',
};

export function describeFailure(failure: IoFailure): string {
  return FAILURE_TEXT[failure.kind] ?? failure.message ?? 'an unknown error occurred';
}
