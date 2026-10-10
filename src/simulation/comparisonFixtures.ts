// Packaged-runtime qualification, invoked explicitly with Shift+J. These disposable worlds use
// the actual host and CPU kernel, and compare against an original forward world, never a shared
// checkpoint restore on both sides. No test server, native I/O or scene replacement is involved.
import { DocumentController } from '../domain/document';
import { cloneFrozen, type SceneDocument } from '../domain/scene';
import { defaultDocument } from '../persistence/defaultScene';
import { createDocument, parseScene } from '../persistence/sceneFile';
import type { QualificationIdentity } from '../persistence/runFile';
import twoFutures from '../../examples/two-futures.lawsmith.json?raw';
import { Comparison, COMPARISON_LIMITS, preflightComparison } from './comparison';
import { SimulationHost, worldCounts } from './host';
import { firstDivergence, observe } from './replay';
import { RunCoordinator } from './contexts';
import { pairedBody } from '../observation/comparison';

export function twoFuturesDocument(): SceneDocument {
  const result = parseScene(twoFutures);
  if (!result.ok) throw result.error;
  return result.document;
}
/** P3: exactly 100 authored dynamic spheres, four active laws, no automatic births or deaths. */
export function p3Document(): SceneDocument {
  const example = twoFuturesDocument();
  const body = example.semantic.bodies[0]!;
  const law = example.semantic.fields[0]!;
  const fields = Array.from({ length: 4 }, (_, n) => ({ ...law, id: `push-${n}`, region: { kind: 'box' as const, halfExtents: [100, 100, 100] as const }, expression: { kind: 'directional' as const, direction: [0, 1, 0] as const, strength: 0.1 } }));
  return cloneFrozen(createDocument({ ...example.semantic, simulation: { ...example.semantic.simulation, ambientAcceleration: [0, -0.4, 0] }, bodies: Array.from({ length: 100 }, (_, n) => ({ ...body, id: `body-${String(n).padStart(3, '0')}`, initialPose: { position: [(n % 10) * 0.5 - 2.25, Math.floor(n / 10) * 0.5 - 2.25, 0] as const, rotation: [0, 0, 0, 1] as const }, initialLinearVelocity: [0, 0, 0] as const })), fields }, { title: 'P3 — Two Futures' }, { ...example.presentation, camera: { position: [9, 7, 15], target: [0, 0, 0] }, laws: fields.map((f) => ({ id: f.id, label: f.id, color: '#55aaa4', visible: true })) }));
}
const yieldFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function computeBaseline(c: Comparison, ticks: number): Promise<void> {
  const job = c.begin(ticks);
  while (c.batch(job) === 'working') await yieldFrame();
}

export async function comparisonQualification(identity: QualificationIdentity, log: (data: Record<string, unknown>) => void): Promise<void> {
  const outside = worldCounts().allocated;
  const check = (name: string, pass: boolean, facts: Record<string, unknown> = {}) => {
    log({ case: name, pass, ...facts });
    if (!pass) throw new Error(`M7 ${name} failed`);
  };
  const root = defaultDocument();
  const first = root.semantic.fields[0]!;
  const contacts = cloneFrozen(createDocument({ ...root.semantic, fields: [{ ...first, expression: { kind: 'gain', gain: { kind: 'triangle', min: 0.1, max: 1, periodTicks: 240, phaseTicks: 13 }, child: first.expression } }, ...root.semantic.fields.slice(1)] }, root.metadata, root.presentation));
  const source = new SimulationHost(contacts.semantic);
  let c: Comparison | null = null;
  try {
    for (let n = 0; n < 519; n++) source.step();
    c = new Comparison(source, contacts, 'qualification-contacts');
    check('A common fork', firstDivergence(observe(source), observe(c.host)) === null, { address: c.address });
    const job = c.begin();
    let divergence = null;
    for (let n = 0; n < 600; n++) {
      source.step();
      c.batch(job, Infinity, () => performance.now(), 1);
      const a = c.observeBaselineWork();
      if (a) divergence ??= firstDivergence(observe(source), a);
      if (n % 30 === 0) await yieldFrame();
    }
    const endpoint = new SimulationHost(c.root.semantic, c.endpointCheckpoint()!);
    try { divergence ??= firstDivergence(observe(source), observe(endpoint)); } finally { endpoint.dispose(); }
    check('B/F/G/H actual baseline through contacts, modulation, births and deaths', divergence === null, { divergence, metrics: c.metrics });
    source.dispose();
    const reference = new SimulationHost(c.root.semantic, c.forkCheckpoint());
    try {
      divergence = null;
      let poses = true;
      for (let n = 0; n < 600; n++) {
        reference.step(); c.advance(); divergence ??= firstDivergence(observe(reference), observe(c.host));
        const frame = c.frame(reference.tick)!;
        const actual = new Float32Array(reference.count * 7); reference.writePoses(actual, 0);
        poses &&= JSON.stringify(frame.ids) === JSON.stringify(reference.ids) && actual.every((v, i) => Object.is(v, frame.poses[i]));
        if (n % 30 === 0) await yieldFrame();
      }
      check('B no-op alternate and actual pose samples', divergence === null && poses, { divergence, poses });
    } finally { reference.dispose(); }
    const old = c.frame(c.horizon)!.poses;
    await computeBaseline(c, 1200);
    check('N/O real extension preserves old samples', old.every((v, i) => Object.is(v, c!.frame(c!.address.tick + 600)!.poses[i])) && c.frame(c.horizon + 1) === null, { horizon: c.horizon, bytes: c.bytes });
    c.dispose(); c = null;
  } finally { c?.dispose(); source.dispose(); }

  const simple = twoFuturesDocument();
  const original = new SimulationHost(simple.semantic);
  c = new Comparison(original, simple, 'qualification-analytic');
  try {
    await computeBaseline(c, 600);
    c.controller.editField('sideways', 'Upward', (f) => ({ ...f, expression: { kind: 'directional', direction: [0, 1, 0], strength: 2 } }));
    for (let n = 0; n < 120; n++) c.advance();
    const y = c.host.positions[1]!;
    const separation = pairedBody('traveler', c.frame(120), c.host).separation!;
    check('C independent analytic intervention', separation >= 0.5 && Math.abs(y - 1) <= 2 / 120 + 1e-4 && c.host.limitedSteps === 0, { y, expectedY: 1, tolerance: 2 / 120 + 1e-4, separation, limitedSteps: c.host.limitedSteps });
    const end = observe(c.host), suffix = JSON.stringify(c.suffix), baseline = c.frame(120)!.poses.slice();
    c.replayAlternate(); while (c.replaying) c.advance();
    check('I retained suffix replay', firstDivergence(end, observe(c.host)) === null && JSON.stringify(c.suffix) === suffix);
    const fork = c.forkCheckpoint(); fork.engineBytes.fill(0);
    c.frame(120)!.poses.fill(999);
    c.newAlternate();
    check('J/K new alternate and private buffers', c.suffixCount === 0 && !c.controller.canUndo && firstDivergence(observe(original), observe(c.host)) === null && baseline.every((v, i) => Object.is(v, c!.frame(120)!.poses[i])));
    const canceled = c.begin(1200); c.cancel(); check('P late commit refusal', c.batch(canceled) === 'canceled' && c.horizon === 600);
    let refused = false; try { preflightComparison(COMPARISON_LIMITS.bytes + 1); } catch { refused = true; }
    preflightComparison(COMPARISON_LIMITS.bytes);
    check('Q memory boundary', refused, { bytes: c.bytes, limit: COMPARISON_LIMITS.bytes });
  } finally { c.dispose(); original.dispose(); }

  const live = new SimulationHost(simple.semantic);
  const controller = new DocumentController(simple, live);
  const runs = new RunCoordinator({ controller, identity: () => identity, runId: () => 'm7-source-tail-fixture' });
  try {
    runs.startRecording(); for (let n = 0; n < 60; n++) live.step();
    controller.editField('sideways', 'First at 60', (f) => ({ ...f, enabled: false }));
    controller.editField('sideways', 'Second at 60', (f) => ({ ...f, enabled: true }));
    for (let n = 0; n < 120; n++) live.step();
    await runs.stopRecording();
    runs.enterReplay(); runs.seek({ tick: 60, cursor: 1 }); while (runs.seekWork(Infinity, () => 0).kind === 'working') {}
    const source = observe(runs.shown), main = observe(live), text = JSON.stringify(runs.record);
    const branch = runs.enterComparison(); await computeBaseline(branch, 600);
    for (let n = 0; n < 600; n++) branch.advance();
    check('D/E source tail and inner same-tick cursor excluded', branch.host.lastAppliedSequence === 1 && branch.host.appliedFields()[0]!.enabled === false && JSON.stringify(runs.record) === text && firstDivergence(source, observe(runs.replay!.host)) === null && firstDivergence(main, observe(live)) === null, { fork: branch.address, cursor: branch.host.lastAppliedSequence, sourceCommands: runs.record!.commands.length });
    runs.closeComparison(); runs.returnToAuthoring();
    const before = observe(live); const cycles: ReturnType<Comparison['counts']>[] = [];
    for (let n = 0; n < 20; n++) {
      const branch = runs.enterComparison(); await computeBaseline(branch, 20); branch.advance(); branch.replayAlternate(); while (branch.replaying) branch.advance(); branch.newAlternate();
      cycles.push(branch.counts()); runs.closeComparison();
      if (firstDivergence(before, observe(live))) throw new Error('Source changed during comparison cycles.');
    }
    check('R twenty cycles', cycles.every((v) => v.bytes === cycles[0]!.bytes) && worldCounts().allocated === outside + 1, { cycles, worlds: worldCounts() });
  } finally { runs.closeComparison(); runs.returnToAuthoring(); live.dispose(); }
  check('resources released', worldCounts().allocated === outside, { outside, after: worldCounts() });
}
