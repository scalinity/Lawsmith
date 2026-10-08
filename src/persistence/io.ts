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
export type ChooseOutcome = { outcome: 'canceled' } | { outcome: 'chosen'; token: number; name: string } | { outcome: 'refused'; name: string };
export type RecoverySlot = { state: 'absent' } | { state: 'unreadable'; reason: string } | { state: 'present'; text: string };

/** Operations reject with an `IoFailure`. */
export interface DocumentIo {
  openScene(): Promise<OpenOutcome>;
  /** Reads a dialog-chosen file again (bounded, strict UTF-8). */
  readScene(token: number): Promise<{ text: string; readMs: number }>;
  chooseDestination(suggestedName: string): Promise<ChooseOutcome>;
  writeScene(token: number, text: string): Promise<{ writeMs: number }>;
  recoveryLoad(): Promise<{ current: RecoverySlot; previous: RecoverySlot }>;
  recoveryWrite(generation: number, revision: number, text: string): Promise<void>;
  recoveryRetire(generation: number, through: number): Promise<void>;
  /** Reports that launch validation accepted the earlier session's current snapshot, so it is kept as the previous one. */
  recoveryCurrentValid(): Promise<void>;
  recoveryDiscard(generation: number): Promise<void>;
  /** Deletes only the snapshots an earlier session left. */
  recoveryDiscardEarlier(): Promise<void>;
  askUnsaved(title: string): Promise<'save' | 'discard' | 'cancel'>;
  /** Recordings (SPEC §15.3): the same narrow path with the `.lawsmith-run.json` kind and its 16 MiB bound. */
  openRun(): Promise<OpenOutcome>;
  readRun(token: number): Promise<{ text: string; readMs: number }>;
  chooseRunDestination(suggestedName: string): Promise<ChooseOutcome>;
  writeRun(token: number, text: string): Promise<{ writeMs: number }>;
  /** The guard's question for an unsaved recording, naming it: Save Recording, Don't Save or Cancel. */
  askUnsavedRecording(title: string, detail: string): Promise<'save' | 'discard' | 'cancel'>;
  exit(): Promise<void>;
}

export const nativeIo: DocumentIo = {
  openScene: () => invoke('open_scene'),
  readScene: (token) => invoke('read_scene', { token }),
  chooseDestination: (suggestedName) => invoke('choose_scene_destination', { suggestedName }),
  writeScene: (token, text) => invoke('write_scene', { token, text }),
  recoveryLoad: () => invoke('recovery_load'),
  recoveryWrite: (generation, revision, text) => invoke('recovery_write', { generation, revision, text }),
  recoveryRetire: (generation, through) => invoke('recovery_retire', { generation, through }),
  recoveryCurrentValid: () => invoke('recovery_current_valid'),
  recoveryDiscard: (generation) => invoke('recovery_discard', { generation }),
  recoveryDiscardEarlier: () => invoke('recovery_discard_earlier'),
  askUnsaved: (title) => invoke('ask_unsaved', { title }),
  openRun: () => invoke('open_run'),
  readRun: (token) => invoke('read_run', { token }),
  chooseRunDestination: (suggestedName) => invoke('choose_run_destination', { suggestedName }),
  writeRun: (token, text) => invoke('write_run', { token, text }),
  askUnsavedRecording: (title, detail) => invoke('ask_unsaved_recording', { title, detail }),
  exit: () => invoke('exit_app'),
};
