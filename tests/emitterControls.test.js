// M8 owner feedback (F5): the Emitter controls in src/main.ts (not a copy), with stand-ins for the page
// and the document controller. Rates and lifetimes are quantized to whole ticks before the document
// command, invalid input is refused before any mutation, and the controls lock in every context where
// a reset is not allowed. The command's own semantics are in emitterSchedule.test.ts.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const TICKS_PER_SECOND = 1000 / STEP_MS;');
const end = source.indexOf("  emitterApply.addEventListener('click', applyEmitter);\n", start) + "  emitterApply.addEventListener('click', applyEmitter);\n".length;

function page({ recording = false, comparison = false, frozen = false, busy = null, seek = null, ok = true, emitter = { id: 'stream', intervalTicks: 8, lifetimeTicks: 512 } } = {}) {
  const calls = [];
  const el = (id) => ({ id, value: '', hidden: false, disabled: false, textContent: '', title: '', attrs: {}, toggleAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} });
  const nodes = Object.fromEntries(['emitter', 'emitter-rate', 'emitter-life', 'emitter-apply', 'emitter-error', 'emitter-now', 'sim-error'].map((id) => [id, el(id)]));
  const authoring = {
    scene: { emitters: emitter ? [emitter] : [], simulation: { maxLiveBodies: 256 } },
    setEmitterSchedule: (id, s) => { calls.push(['set', id, s]); return ok ? { ok: true, value: { revision: 2 } } : { ok: false, reason: 'refused' }; },
  };
  const context = createContext({
    $: (id) => nodes[id], STEP_MS: 1000 / 120, document: { activeElement: null }, authoring,
    blocked: () => frozen, comparing: () => comparison, runs: { recordingState: recording ? 'recording' : 'idle' }, workflow: { busy }, pendingSeek: seek,
    setPlaying: (p, r) => calls.push(['play', p, r]), settleNow: () => {}, edited: () => calls.push(['edited']), renderPanel: () => {},
    report: () => {}, runIndex: 0, editsSinceReset: 0, p0: null, host: { tick: 0 },
  });
  runInContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.applyEmitter = applyEmitter; globalThis.renderEmitter = renderEmitter;`, context);
  return { nodes, calls, context };
}

describe('Emitter controls', () => {
  it('shows the current schedule in per-second terms and its exact ticks', () => {
    const p = page();
    p.context.renderEmitter();
    expect(p.nodes['emitter-rate'].value).toBe('15');
    expect(p.nodes['emitter-life'].value).toBe('4.2667');
    expect(p.nodes['emitter-now'].textContent).toBe('Now: a body every 8 ticks (15 per second), each kept for 512 ticks (4.27 s).');
  });

  it('quantizes to whole ticks and applies through the document command, paused', () => {
    const p = page();
    p.nodes['emitter-rate'].value = '7';
    p.nodes['emitter-life'].value = '12';
    p.context.applyEmitter();
    expect(p.calls).toContainEqual(['set', 'stream', { intervalTicks: 17, lifetimeTicks: 1440 }]);
    expect(p.calls.findIndex((c) => c[0] === 'play')).toBeLessThan(p.calls.findIndex((c) => c[0] === 'set'));
    expect(p.calls).toContainEqual(['edited']);
  });

  it.each([['', '12'], ['abc', '12'], ['0', '12'], ['121', '12'], ['15', ''], ['15', '0.01'], ['15', '4000'], ['Infinity', '12']])(
    'refuses rate %j and lifetime %j before any change', (rate, life) => {
      const p = page();
      p.nodes['emitter-rate'].value = rate;
      p.nodes['emitter-life'].value = life;
      p.context.applyEmitter();
      expect(p.calls.filter((c) => c[0] === 'set')).toEqual([]);
      expect(p.nodes['emitter-error'].hidden).toBe(false);
      expect(p.nodes['emitter-error'].textContent).toMatch(/Nothing changed\.$/);
    });

  it.each([['recording', { recording: true }], ['comparison', { comparison: true }], ['a replay or guard (frozen)', { frozen: true }], ['a busy file workflow', { busy: 'save' }], ['a pending seek', { seek: {} }]])(
    'locks during %s: disabled and never applied', (_, state) => {
      const p = page(state);
      p.context.renderEmitter();
      expect(p.nodes['emitter-apply'].disabled).toBe(true);
      expect(p.nodes['emitter-rate'].disabled).toBe(true);
      p.nodes['emitter-rate'].value = '10';
      p.nodes['emitter-life'].value = '5';
      p.context.applyEmitter();
      expect(p.calls.filter((c) => c[0] === 'set')).toEqual([]);
    });

  it('says honestly when the rate and lifetime would exceed the live-body limit', () => {
    const p = page({ emitter: { id: 'stream', intervalTicks: 2, lifetimeTicks: 3600 } });
    p.context.renderEmitter();
    expect(p.nodes['emitter-now'].textContent).toContain('Up to 1800 bodies would be alive at once, but the scene allows 256: later births will be skipped and counted.');
  });

  it('a refused command reports why and changes nothing', () => {
    const p = page({ ok: false });
    p.nodes['emitter-rate'].value = '10';
    p.nodes['emitter-life'].value = '5';
    p.context.applyEmitter();
    expect(p.nodes['emitter-error'].textContent).toBe('Not applied: refused. Nothing changed.');
    expect(p.calls).not.toContainEqual(['edited']);
  });

  it('no emitter: the section is hidden', () => {
    const p = page({ emitter: null });
    p.context.renderEmitter();
    expect(p.nodes.emitter.hidden).toBe(true);
  });
});
