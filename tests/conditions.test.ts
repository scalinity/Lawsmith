// M8 R17: the conditions SPEC §5.4 and §16 require on screen (births skipped at the live-body limit, the
// acceleration limiter acting, sustained slowdown while playing) stay visible with the developer readout
// closed. The counters come from real hosts on bundled or accepted QA scenes, the pacing from the
// production scheduler, and the rendering from the production refresh in src/main.ts (not a copy).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import limiterScene from '../scripts/verify/scenes/m4-limiter.lawsmith.json?raw';
import { cloneFrozen } from '../src/domain/scene';
import { parseScene } from '../src/persistence/sceneFile';
import { EXAMPLES, exampleDocument } from '../src/scenes/examples';
import { FixedStepScheduler } from '../src/simulation/scheduler';
import { SimulationHost, initSimulation } from '../src/simulation/host';
import { PlayPace, SLOW_RATIO, conditionLines } from '../src/ui/conditions';

const STEP_MS = 1000 / 120;

beforeAll(async () => {
  await initSimulation();
});

/** Presents `seconds` of frames `every` ms apart through the real scheduler, feeding the pace as main.ts does. */
function present(scheduler: FixedStepScheduler, pace: PlayPace, clock: { t: number }, seconds: number, every: number) {
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += every) {
    clock.t += every;
    const { steps } = scheduler.frame(clock.t, clock.t);
    pace.frame(every, steps, scheduler.playing);
  }
}

describe('sustained slowdown, from the production scheduler', () => {
  it('real-time play never reads as slow, and a ratio exists only after a full window of play', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    const pace = new PlayPace(STEP_MS);
    const clock = { t: 0 };
    scheduler.play();
    present(scheduler, pace, clock, 1, 1000 / 60);
    expect(pace.ratio()).toBeNull();
    present(scheduler, pace, clock, 3, 1000 / 60);
    expect(pace.ratio()).toBeGreaterThan(0.99);
    expect(conditionLines({ skippedBirths: 0, newlyLimited: 0, pace: pace.ratio() })).toEqual([]);
  });

  it('frames longer than eight steps can cover slow simulated time, and the line says by how much', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    const pace = new PlayPace(STEP_MS);
    const clock = { t: 0 };
    scheduler.play();
    present(scheduler, pace, clock, 3, 100); // 8 steps (66.7 ms) per 100 ms frame
    expect(pace.ratio()).toBeCloseTo(2 / 3, 3);
    expect(conditionLines({ skippedBirths: 0, newlyLimited: 0, pace: pace.ratio() })).toEqual(['Running at 0.67× real time: the scene needs more than this Mac can compute each frame.']);
  });

  it('pausing is not overload: a paused scene has no ratio, and resuming needs a fresh full window', () => {
    const scheduler = new FixedStepScheduler(STEP_MS);
    const pace = new PlayPace(STEP_MS);
    const clock = { t: 0 };
    scheduler.play();
    present(scheduler, pace, clock, 3, 100);
    expect(pace.ratio()!).toBeLessThan(SLOW_RATIO);
    scheduler.pause();
    present(scheduler, pace, clock, 5, 1000 / 60);
    expect(pace.ratio()).toBeNull();
    expect(conditionLines({ skippedBirths: 0, newlyLimited: 0, pace: pace.ratio() })).toEqual([]);
    scheduler.play();
    present(scheduler, pace, clock, 1, 1000 / 60);
    expect(pace.ratio()).toBeNull();
    present(scheduler, pace, clock, 2, 1000 / 60);
    expect(pace.ratio()).toBeGreaterThan(0.99);
  });
});

describe('the live-body limit and the limiter, from real hosts', () => {
  const sidewaysRain = exampleDocument(EXAMPLES.find((e) => e.key === 'sideways-rain')!).semantic;

  it('births skipped at the live-body limit are counted exactly as the host counts them', () => {
    const limited = cloneFrozen({ ...sidewaysRain, simulation: { ...sidewaysRain.simulation, maxLiveBodies: 8 } });
    const host = new SimulationHost(limited);
    for (let i = 0; i < 1200; i++) host.step();
    expect(host.count).toBeLessThanOrEqual(8);
    expect(host.skippedEmissions).toBeGreaterThan(1);
    expect(conditionLines({ skippedBirths: host.skippedEmissions, newlyLimited: 0, pace: null })).toEqual([
      `${host.skippedEmissions} births skipped: the scene already has as many moving bodies as it allows.`,
    ]);
    host.dispose();
  });

  it('the bundled Sideways Rain, as shipped, skips nothing and shows nothing', () => {
    const host = new SimulationHost(sidewaysRain);
    for (let i = 0; i < 1200; i++) host.step();
    expect(host.skippedEmissions).toBe(0);
    expect(conditionLines({ skippedBirths: host.skippedEmissions, newlyLimited: host.limitedSteps, pace: null })).toEqual([]);
    host.dispose();
  });

  it('the accepted limiter QA scene shows the limiter while it acts, refreshed as main.ts does', () => {
    const parsed = parseScene(limiterScene);
    if (!parsed.ok) throw parsed.error;
    const host = new SimulationHost(parsed.document.semantic);
    let before = host.limitedSteps;
    const shown: boolean[] = [];
    for (let refresh = 0; refresh < 4; refresh++) {
      for (let i = 0; i < 60; i++) host.step();
      const lines = conditionLines({ skippedBirths: host.skippedEmissions, newlyLimited: host.limitedSteps - before, pace: null });
      before = host.limitedSteps;
      shown.push(lines.includes('Acceleration limit reached: laws are scaled down. Click a body to see by how much.'));
    }
    expect(host.limitedSteps).toBeGreaterThan(0);
    expect(shown).toContain(true);
    host.dispose();
  });
});

// The production refresh, executed with stand-ins for the world and the page.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf("  const conditionsBox = $('conditions');");
const end = source.indexOf('\n  };\n', start) + 5;

function production(initialHost: { limitedSteps: number; skippedEmissions: number }, ratio: () => number | null) {
  const box = { textContent: '', hidden: true };
  const readout = { textContent: '', hidden: true };
  const reports: unknown[][] = [];
  const context = createContext({
    $: (id: string) => (id === 'conditions' ? box : readout),
    host: initialHost, pace: { ratio }, conditionLines, round3: (v: number) => Math.round(v * 1000) / 1000,
    report: (...args: unknown[]) => reports.push(args),
  });
  runInContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.refresh = refreshConditions;`, context);
  return { box, readout, reports, context, refresh: () => (context.refresh as () => void)() };
}

describe('the production condition refresh (src/main.ts)', () => {
  it('shows a skipped birth with the developer readout closed, and reports it once', () => {
    const world = { limitedSteps: 0, skippedEmissions: 0 };
    const page = production(world, () => null);
    page.refresh();
    expect(page.box.hidden).toBe(true);
    expect(page.reports).toEqual([]);
    world.skippedEmissions = 3;
    page.refresh();
    page.refresh();
    expect(page.box.hidden).toBe(false);
    expect(page.box.textContent).toBe('3 births skipped: the scene already has as many moving bodies as it allows.');
    expect(page.readout.hidden).toBe(true);
    expect(page.reports).toEqual([['conditions', { skippedBirths: 3, limiterActive: false, simWallRatio: null, shown: [page.box.textContent] }]]);
  });

  it('the limiter shows while its count grows and clears when it stops; overload shows only with a ratio', () => {
    const world = { limitedSteps: 0, skippedEmissions: 0 };
    let ratio: number | null = null;
    const page = production(world, () => ratio);
    world.limitedSteps = 40;
    page.refresh();
    expect(page.box.textContent).toBe('Acceleration limit reached: laws are scaled down. Click a body to see by how much.');
    page.refresh();
    expect(page.box.hidden).toBe(true);
    ratio = 0.5;
    page.refresh();
    expect(page.box.textContent).toBe('Running at 0.50× real time: the scene needs more than this Mac can compute each frame.');
    ratio = null;
    page.refresh();
    expect(page.box.hidden).toBe(true);
    expect(page.reports.map((r) => (r[1] as { shown: string[] }).shown.length)).toEqual([1, 0, 1, 0]);
  });

  it('switching to another context with a larger limiter count is not a limiter event', () => {
    const world = { limitedSteps: 0, skippedEmissions: 0 };
    const page = production(world, () => null);
    page.refresh();
    page.context.host = { limitedSteps: 500, skippedEmissions: 0 };
    page.refresh();
    expect(page.box.hidden).toBe(true);
    expect(page.reports).toEqual([]);
  });
});
