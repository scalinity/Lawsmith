// The native document-I/O boundary (SPEC §15.3). The frontend holds opaque destination tokens
// issued by native dialogs, never paths; tests substitute an in-memory implementation.
import { invoke } from '@tauri-apps/api/core';

/** A failed native operation: `kind` names what happened (permission, disk-full, stale, …). */
export interface IoFailure {
  readonly kind: string;
  readonly stage: string;
  readonly message: string;
}

export type OpenOutcome = { outcome: 'canceled' } | { outcome: 'opened'; token: number; name: string; text: string; readMs: number };
export type ChooseOutcome = { outcome: 'canceled' } | { outcome: 'chosen'; token: number; name: string };
export type RecoverySlot = { state: 'absent' } | { state: 'unreadable'; reason: string } | { state: 'present'; text: string };

/** Operations reject with an `IoFailure`. */
export interface DocumentIo {
  openScene(): Promise<OpenOutcome>;
  chooseDestination(suggestedName: string): Promise<ChooseOutcome>;
  writeScene(token: number, text: string): Promise<{ writeMs: number }>;
  recoveryLoad(): Promise<{ current: RecoverySlot; previous: RecoverySlot }>;
  recoveryWrite(generation: number, revision: number, text: string): Promise<void>;
  recoveryRetire(generation: number, through: number): Promise<void>;
  recoveryDiscard(generation: number): Promise<void>;
  recoveryDiscardAll(): Promise<void>;
  askUnsaved(title: string): Promise<'save' | 'discard' | 'cancel'>;
  exit(): Promise<void>;
}

export const nativeIo: DocumentIo = {
  openScene: () => invoke('open_scene'),
  chooseDestination: (suggestedName) => invoke('choose_scene_destination', { suggestedName }),
  writeScene: (token, text) => invoke('write_scene', { token, text }),
  recoveryLoad: () => invoke('recovery_load'),
  recoveryWrite: (generation, revision, text) => invoke('recovery_write', { generation, revision, text }),
  recoveryRetire: (generation, through) => invoke('recovery_retire', { generation, through }),
  recoveryDiscard: (generation) => invoke('recovery_discard', { generation }),
  recoveryDiscardAll: () => invoke('recovery_discard_all'),
  askUnsaved: (title) => invoke('ask_unsaved', { title }),
  exit: () => invoke('exit_app'),
};
