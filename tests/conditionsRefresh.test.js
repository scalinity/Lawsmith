// M8 R17: executes the production condition refresh in src/main.ts (not a copy) with stand-ins for the
// world and the page: a condition shows with the developer readout closed, is absent when irrelevant,
// is reported once per change, and a context switch is not a limiter event. tests/conditions.test.ts
// derives the counters from real hosts and the pacing from the production scheduler.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { conditionLines } from '../src/ui/conditions';

// The production refresh, executed with stand-ins for the world and the page.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf("  const conditionsBox = $('conditions');");
const end = source.indexOf('\n  };\n', start) + 5;

function production(initialHost, ratio) {
  const box = { textContent: '', hidden: true };
  const readout = { textContent: '', hidden: true };
  const reports = [];
  const context = createContext({
    $: (id) => (id === 'conditions' ? box : readout),
    host: initialHost, pace: { ratio }, conditionLines, round3: (v) => Math.round(v * 1000) / 1000,
    report: (...args) => reports.push(args),
  });
  runInContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.refresh = refreshConditions;`, context);
  return { box, readout, reports, context, refresh: () => context.refresh() };
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
    let ratio = null;
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
    expect(page.reports.map((r) => r[1].shown.length)).toEqual([1, 0, 1, 0]);
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
