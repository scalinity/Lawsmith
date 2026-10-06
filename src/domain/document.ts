// The document controller (SPEC §4): owns the authored scene, turns accepted edits into
// validated commands for the host, and adopts acknowledged changes so a later reset uses them.
import type { CommandAck, SimulationHost } from '../simulation/host';
import { cloneFrozen, validateField, type FieldDefinition, type SceneDefinition, type Validated } from './scene';

export class DocumentController {
  private authored: SceneDefinition;
  /** Revision of the last accepted edit. */
  revision = 0;
  /** Revision of the last edit the host acknowledged, i.e. the one its laws now include. */
  appliedRevision = 0;

  constructor(
    scene: SceneDefinition,
    private readonly host: SimulationHost,
  ) {
    this.authored = cloneFrozen(scene);
  }

  get scene(): SceneDefinition {
    return this.authored;
  }

  /** Validates a complete law value and queues it for the next boundary. Invalid input never reaches the host. */
  putField(candidate: FieldDefinition): Validated<{ revision: number; field: FieldDefinition }> {
    const result = validateField(candidate);
    if (!result.ok) return result;
    this.revision += 1;
    this.host.submit({ kind: 'putField', field: result.value }, this.revision);
    return { ok: true, value: { revision: this.revision, field: result.value } };
  }

  /** Adopts the host's acknowledgments into the authored scene; the current run root is untouched (SPEC §10.2). */
  sync(): CommandAck[] {
    const acks = this.host.takeAcks();
    if (!acks.length) return acks;
    const fields = [...this.authored.fields];
    for (const { payload, documentRevision } of acks) {
      const index = fields.findIndex((f) => f.id === payload.field.id);
      if (index >= 0) fields[index] = payload.field;
      else fields.push(payload.field);
      this.appliedRevision = documentRevision;
    }
    this.authored = Object.freeze({ ...this.authored, fields: Object.freeze(fields) });
    return acks;
  }

  /**
   * SPEC §13.2 reset: settle pending edits, freeze a new run root from the authored scene and
   * rebuild the world at tick 0. It restarts the current configuration; it never replays a drag.
   */
  reset(): SceneDefinition {
    this.host.settleBoundary();
    this.sync();
    const root = cloneFrozen(this.authored);
    this.host.reset(root);
    return root;
  }
}
