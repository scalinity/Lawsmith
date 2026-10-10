import { afterEach, beforeAll, expect, it } from 'vitest';
import { Comparison } from '../src/simulation/comparison';
import { initSimulation } from '../src/simulation/host';
import { firstDivergence, observe } from '../src/simulation/replay';
import { driveScheduledFrame, FixedStepScheduler } from '../src/simulation/scheduler';
import { twoFuturesDocument } from '../src/simulation/comparisonFixtures';
import { session } from './support/run';

beforeAll(initSimulation);
const owned: { dispose(): void }[] = [];
afterEach(() => { while (owned.length) owned.pop()!.dispose(); });
const keep = <T extends { dispose(): void }>(v: T): T => { owned.push(v); return v; };
function setup(tick = 0) {
  const s = session(twoFuturesDocument()); keep(s.live()); s.steps(tick);
  const c = keep(s.coordinator.enterComparison());
  const job = c.begin(); while (c.batch(job, Infinity, () => 0) === 'working') {}
  return { s, c };
}

it.each([2, 8])('F1: application frame budget %i stops at the retained endpoint and rejects further implicit steps', (budget) => {
  const { c } = setup();
  c.advance();
  c.controller.editField('sideways', 'Terminal one', (f) => ({ ...f, enabled: false }));
  c.controller.editField('sideways', 'Terminal two', (f) => ({ ...f, enabled: true }));
  const endpoint = observe(c.host), suffix = JSON.stringify(c.suffix), undo = c.controller.canUndo;
  c.replayAlternate();
  const scheduler = new FixedStepScheduler(1000 / 120); scheduler.play(); scheduler.frame(0, 0);
  const frame = scheduler.frame(budget * 1000 / 120, budget * 1000 / 120);
  expect(frame.steps).toBe(budget);
  const samples: number[] = [];
  const steps = driveScheduledFrame(scheduler, frame.steps, () => {
    const stepped = c.advance();
    if (stepped) samples.push(c.host.tick);
    if (!c.replaying) scheduler.pause();
    return stepped;
  });
  expect(steps).toBe(1); expect(samples).toEqual([1]); expect(scheduler.playing).toBe(false);
  expect(firstDivergence(endpoint, observe(c.host))).toBeNull();
  expect(c.host.tick).toBe(1); expect(c.host.lastAppliedSequence).toBe(2);
  expect(JSON.stringify(c.suffix)).toBe(suffix); expect(c.controller.canUndo).toBe(undo);
  expect(c.advance()).toBe(false);
  expect(firstDivergence(endpoint, observe(c.host))).toBeNull();
  expect(c.controller.editField('sideways', 'Later explicit edit', (f) => ({ ...f, enabled: false })).ok).toBe(true);
  c.resumeAlternate(); expect(c.advance()).toBe(true); expect(c.host.tick).toBe(2);
});

it.each([0, 73])('F1: paused-boundary replay at tick %i stays at its exact cursor with no observation', (tick) => {
  const { c } = setup(tick);
  c.controller.editField('sideways', 'Paused one', (f) => ({ ...f, enabled: false }));
  c.controller.editField('sideways', 'Paused two', (f) => ({ ...f, enabled: true }));
  const end = observe(c.host);
  c.replayAlternate(); expect(c.replaying).toBe(false);
  let samples = 0;
  expect(c.advance()).toBe(false);
  const scheduler = new FixedStepScheduler(1000 / 120);
  expect(driveScheduledFrame(scheduler, 8, () => { if (c.advance()) { samples++; return true; } return false; })).toBe(0);
  expect(samples).toBe(0); expect(firstDivergence(end, observe(c.host))).toBeNull();
  expect(c.controller.liveHost).toBe(c.host);
});
