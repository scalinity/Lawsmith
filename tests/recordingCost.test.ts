// A headless measurement of what recording and replay cost, opt-in because it measures rather than checks:
//
//   VITE_LAWSMITH_MEASURE=1 npx vitest run tests/recordingCost.test.ts
//
// It prints: the P1 host step with and without a recorder attached (three runs of 1,200 steps each, a
// put every 12 steps as a drag at 10 Hz would make); one command's preflight and append, through the
// real settle, for a one-leaf law and a 64-node law; a 1,000-command same-boundary batch replayed in
// 64-command chunks; and the exact export of a full 16 MiB record. This is Node's V8, not WKWebView's
// JavaScriptCore: a headless figure kept apart from packaged measurement (SPEC §18.2).
import { beforeAll, describe, expect, it } from 'vitest';
import p1Workshop from '../scripts/verify/scenes/p1-workshop.lawsmith.json?raw';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen, type FieldDefinition, type FieldExpression } from '../src/domain/scene';
import { RUN_LIMITS } from '../src/persistence/runFile';
import { parseScene } from '../src/persistence/sceneFile';
import { RunCoordinator } from '../src/simulation/contexts';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import { exportRun } from '../src/simulation/recorder';
import { LinearReplay } from '../src/simulation/replay';
import { TEST_IDENTITY } from './support/run';

const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
const summary = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: +percentile(s, 0.5).toFixed(4), p95: +percentile(s, 0.95).toFixed(4), p99: +percentile(s, 0.99).toFixed(4) };
};

function p1() {
  const parsed = parseScene(p1Workshop);
  if (!parsed.ok) throw parsed.error;
  return parsed.document;
}

/** A 61-node law: fifteen triangle gains over two nested masks each, under one sum. */
function heavy(id: string, x: number): FieldDefinition {
  const terms: FieldExpression[] = Array.from({ length: 15 }, (_, k) => ({
    kind: 'gain',
    gain: { kind: 'triangle', min: 0, max: 2, periodTicks: 30 + k, phaseTicks: k },
    child: { kind: 'mask', pose: { position: [0.1 * k, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'box', halfExtents: [1, 1, 1] }, edgeFade: 0.1, child: { kind: 'mask', pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'sphere', radius: 2 }, edgeFade: 0.2, child: { kind: 'directional', direction: [1, 0, 0], strength: 1 + k } } },
  }));
  return { id, enabled: true, pose: { position: [x, 1, 0], rotation: [0, 0, 0, 1] }, region: { kind: 'box', halfExtents: [2, 2, 2] }, edgeFade: 0.25, expression: { kind: 'sum', terms } };
}

function session(recording: boolean) {
  const document = p1();
  const host = new SimulationHost(cloneFrozen(document.semantic));
  const controller = new DocumentController(document, host);
  const runs = new RunCoordinator({ controller, identity: () => TEST_IDENTITY });
  if (recording) runs.startRecording();
  return { document, host: () => controller.liveHost, controller, runs };
}

describe.skipIf(!import.meta.env.VITE_LAWSMITH_MEASURE)('headless recording and replay cost', () => {
  beforeAll(async () => {
    await initSimulation();
  });

  it('measures recorder overhead, per-command preflight and append, batch replay and export', () => {
    console.log(JSON.stringify({ environment: navigator.userAgent }));
    for (const recording of [false, true]) {
      const s = session(recording);
      const law = s.document.semantic.fields[0]!;
      const tx = s.controller.newTransaction();
      const step = (i: number) => {
        if (i % 12 === 0) s.controller.putField({ ...law, pose: { ...law.pose, position: [law.pose.position[0] + (i % 24 ? 0.25 : 0), law.pose.position[1], law.pose.position[2]] } }, tx);
        const t0 = performance.now();
        s.host().settleBoundary();
        s.host().step();
        const ms = performance.now() - t0;
        s.controller.sync();
        return ms;
      };
      for (let i = 0; i < 600; i++) step(i);
      for (let run = 1; run <= 3; run++) {
        const ms = Array.from({ length: 1200 }, (_, i) => step(i));
        console.log(JSON.stringify({ workload: 'P1', recording, run, steps: 1200, stepMs: summary(ms), commands: s.runs.recorder?.count ?? 0 }));
      }
    }

    // One command through the real settle: validation is the document's, before it; this is preflight, apply and append.
    for (const [name, make] of [['one-leaf', (x: number) => ({ ...p1().semantic.fields[0]!, pose: { position: [x, 1, 0], rotation: [0, 0, 0, 1] } }) as FieldDefinition], ['61-node', (x: number) => heavy(p1().semantic.fields[0]!.id, x)]] as const) {
      const s = session(true);
      const ms: number[] = [];
      const startBytes = s.runs.recorder!.bytes;
      for (let i = 0; i < 2000; i++) {
        s.controller.putField(make(i % 2 ? 0.5 : -0.5));
        const t0 = performance.now();
        s.host().settleBoundary();
        ms.push(performance.now() - t0);
        s.controller.sync();
      }
      console.log(JSON.stringify({ measure: 'settle one recorded put', law: name, commands: 2000, ms: summary(ms), bytesPerCommand: Math.round((s.runs.recorder!.bytes - startBytes) / 2000) }));
    }

    // A 1,000-command batch at one boundary, replayed in 64-command chunks as the app's frames do.
    const batch = session(true);
    const field = batch.document.semantic.fields[0]!;
    for (let i = 0; i < 1000; i++) batch.controller.editField(field.id, 'Move', (f) => ({ ...f, pose: { ...f.pose, position: [(i % 50) * 0.1 - 2, 1, 0] } }));
    batch.runs.stopRecording();
    return batch.runs.settled().then((record) => {
      const replay = new LinearReplay(record!);
      const chunks: number[] = [];
      while (replay.unsettled) {
        const t0 = performance.now();
        replay.settle(64);
        chunks.push(performance.now() - t0);
      }
      replay.dispose();
      console.log(JSON.stringify({ measure: 'replay a same-boundary batch', commands: 1000, chunk: 64, chunkMs: summary(chunks), chunks: chunks.length }));

      // A full record: fill to the byte limit with 61-node puts, then export it exactly.
      const full = session(true);
      let k = 0;
      while (full.runs.recordingState === 'recording') full.controller.editField(field.id, 'Fill', () => heavy(field.id, (k++ % 9) * 0.5));
      return full.runs.settled().then((filled) => {
        const t0 = performance.now();
        const { bytes } = exportRun(filled!);
        const exportMs = performance.now() - t0;
        console.log(JSON.stringify({ measure: 'export a full record', commands: filled!.commands.length, bytes, limit: RUN_LIMITS.fileBytes, exportMs: +exportMs.toFixed(1), stopped: filled!.stopped }));
        expect(bytes).toBeLessThanOrEqual(RUN_LIMITS.fileBytes);
      });
    });
  }, 600_000);
});
