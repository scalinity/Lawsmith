// A headless measurement of what checkpoints and seeking cost, opt-in because it measures rather than checks:
//
//   VITE_LAWSMITH_MEASURE=1 npx vitest run tests/seekCost.test.ts
//
// On a P1 recording of the full 60 s (a drag every 12 ticks, as at 10 Hz), it prints: one checkpoint's
// capture and restore and its size; an uncached seek to the end (from the root, capturing every 240th
// tick); and 100 seeded cached seeks with the coordinator's batches run back to back, as the app's task
// pump runs them. Node's V8, not WKWebView's JavaScriptCore: a headless figure kept apart from packaged
// measurement (SPEC §18.2).
import { beforeAll, describe, expect, it } from 'vitest';
import p1Workshop from '../scripts/verify/scenes/p1-workshop.lawsmith.json?raw';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen } from '../src/domain/scene';
import { RUN_LIMITS, type RunRecord } from '../src/persistence/runFile';
import { parseScene } from '../src/persistence/sceneFile';
import { RestoredReplay } from '../src/simulation/checkpoints';
import { RunCoordinator } from '../src/simulation/contexts';
import { SimulationHost, initSimulation, xorshift32 } from '../src/simulation/host';
import { TEST_IDENTITY } from './support/run';

const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
const summary = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: +percentile(s, 0.5).toFixed(2), p95: +percentile(s, 0.95).toFixed(2), p99: +percentile(s, 0.99).toFixed(2), max: +s[s.length - 1]!.toFixed(2) };
};

describe.skipIf(!import.meta.env.VITE_LAWSMITH_MEASURE)('headless checkpoint and seek cost', () => {
  let runs: RunCoordinator;
  let record: RunRecord;

  beforeAll(async () => {
    await initSimulation();
    const parsed = parseScene(p1Workshop);
    if (!parsed.ok) throw parsed.error;
    const document = parsed.document;
    const controller = new DocumentController(document, new SimulationHost(cloneFrozen(document.semantic)));
    runs = new RunCoordinator({ controller, identity: () => TEST_IDENTITY, runId: () => 'run-seek-cost' });
    runs.startRecording();
    const law = document.semantic.fields[0]!.id;
    while (runs.recordingState === 'recording') {
      const host = controller.liveHost;
      if (host.tick % 12 === 0) {
        const field = controller.lawState(law)!.field;
        controller.putField({ ...field, pose: { ...field.pose, position: [field.pose.position[0] + (host.tick % 24 === 0 ? 0.05 : -0.05), field.pose.position[1], field.pose.position[2]] } });
      }
      host.settleBoundary();
      controller.sync();
      host.step();
      controller.sync();
    }
    record = (await runs.settled())!;
    expect(record.finalTick).toBe(RUN_LIMITS.ticks);
  }, 300_000);

  it('prints capture, restore, uncached and cached seek costs', { timeout: 300_000 }, () => {
    runs.enterReplay();
    const now = () => performance.now();
    const finish = () => {
      for (;;) {
        const status = runs.seekWork(now() + 8, now);
        if (status.kind !== 'working') return status;
      }
    };
    const t0 = now();
    runs.seek({ tick: record.finalTick, cursor: record.lastAppliedSequence });
    const uncached = finish();
    const uncachedMs = now() - t0;
    expect(uncached.kind).toBe('committed');
    const held = runs.checkpoints.list();
    const sample = held[held.length - 1]!;
    const restoreMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r0 = now();
      const restored = new RestoredReplay(record, sample);
      restoreMs.push(now() - r0);
      restored.dispose();
    }
    let seed = 0x5eed1234;
    const latency: number[] = [];
    const steps: number[] = [];
    for (let i = 0; i < 100; i++) {
      seed = xorshift32(seed);
      const tick = seed % (record.finalTick + 1);
      const cursor = record.commands.filter((c) => c.atTick <= tick).length;
      const s0 = now();
      const job = runs.seek({ tick, cursor });
      if (!job) continue;
      const status = finish();
      expect(status.kind).toBe('committed');
      latency.push(now() - s0);
      steps.push(job.steps);
    }
    console.log(
      JSON.stringify({
        record: { finalTick: record.finalTick, commands: record.commands.length },
        checkpoint: { count: held.length, bytes: sample.bytes, engineBytes: sample.engineBytes.byteLength, bodies: sample.bodyIdentityMap.length, cacheBytes: runs.checkpoints.bytes },
        restoreMs: summary(restoreMs),
        uncached: { ms: +uncachedMs.toFixed(1), steps: uncached.kind === 'committed' ? uncached.job.steps : null, batches: uncached.kind === 'committed' ? uncached.job.batches : null },
        cachedSeekMs: summary(latency),
        cachedSteps: summary(steps),
      }),
    );
    runs.returnToAuthoring();
  });
});
