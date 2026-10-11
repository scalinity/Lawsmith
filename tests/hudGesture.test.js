// M8 review R-HUD2: hiding the HUD disables TransformControls, and a disabled control ignores its pointer
// release (pinned three.js onPointerUp returns when disabled), so H mid-drag would leave the drag without
// its commit. Runs the production setHudHidden from src/main.ts against a real LawInteraction, document
// controller and host; the gizmo is a stub shaped like the parts LawInteraction touches, as in
// lawGesture.test.ts, which also ignores a release while disabled.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LawInteraction } from '../src/interaction/lawGesture';
import { initSimulation } from '../src/simulation/host';
import { session } from './support/run';

beforeAll(async () => {
  await initSimulation();
});

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const from = source.indexOf('  let hudFocus: HTMLElement | null = null;');
const to = source.indexOf("  $('hud-hide').addEventListener", from);

class GizmoStub extends EventTarget {
  mode = 'translate';
  enabled = true;
  dragging = false;
  axis = null;
  setMode(mode) { this.mode = mode; }
  drag() { this.dragging = true; this.axis = 'X'; this.dispatchEvent(new Event('mouseDown')); }
  change() { this.dispatchEvent(new Event('objectChange')); }
  pointerUp(pointer) {
    if (!this.enabled) return;
    if (pointer !== null && pointer.button !== 0) return;
    if (this.dragging && this.axis !== null) this.dispatchEvent(new Event('mouseUp'));
    this.dragging = false;
    this.axis = null;
  }
}

function drag() {
  // Rapier's WASM reads `performance` from window when one exists, so the stand-in carries the real one.
  globalThis.window ??= Object.assign(new EventTarget(), { performance: globalThis.performance });
  const s = session();
  const canvas = Object.assign(new EventTarget(), { style: {}, hasPointerCapture: () => true, setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  const gizmo = new GizmoStub();
  const proxy = { position: { x: 0, y: 1, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  const ends = [];
  const law = new LawInteraction(
    {
      canvas, dragRegion: {}, camera: { position: { toArray: () => [0, 0, 10] } }, gizmo,
      orbit: Object.assign(new EventTarget(), { enabled: true }), proxy,
      appliedField: (id) => s.controller.lawState(id)?.field, pickable: () => s.controller.scene.fields,
      submit: (candidate, transactionId) => s.controller.putField(candidate, transactionId),
      transaction: () => s.controller.newTransaction(),
      // As main.ts's gestureEnded: the controller ends it at what the host applied.
      onGestureEnd: (end) => { ends.push(end); s.controller.endGesture(end.label, end.start, end.transactionId); },
      onSelectionChange: () => {}, clickBody: () => false, haltCamera: () => {}, editable: () => true, focus: () => null, log: () => {},
    },
    null,
  );
  law.selectedId = 'push';
  // The production setHudHidden; its applyFreeze stand-in does what the production one does to the gizmo.
  const shell = { contains: () => false };
  const view = createContext({
    interaction: law, viewport: { gizmo }, frozen: false, hudHidden: false, report: () => {},
    $: () => shell, document: { activeElement: null, documentElement: { dataset: {} } }, HTMLElement: class {},
    applyFreeze: () => { gizmo.enabled = !view.hudHidden; },
  });
  runInContext(`${stripTypeScriptTypes(source.slice(from, to))}\nglobalThis.setHudHidden = setHudHidden;`, view);
  const press = () => {
    canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 7, clientX: 0, clientY: 0, button: 0 }));
    gizmo.drag();
  };
  const sample = (x) => { proxy.position.x = x; gizmo.change(); };
  return { s, law, gizmo, ends, view, press, sample };
}

describe('the immersive view during a transform drag (M8 review R-HUD2)', () => {
  it('H mid-drag is refused; the release commits one undo entry; H after it hides', () => {
    const { s, law, gizmo, ends, view, press, sample } = drag();
    press();
    sample(-1);
    s.boundary();
    view.setHudHidden(true, 'keyboard');
    expect([view.hudHidden, gizmo.enabled, law.gesture !== null]).toEqual([false, true, true]);
    gizmo.pointerUp({ button: 0 });
    expect(law.gesture).toBeNull();
    expect(ends).toHaveLength(1);
    expect(ends[0].cancelled).toBe(false);
    const undone = s.controller.undo();
    expect(undone.ok && undone.value.transactionId).toBe(ends[0].transactionId);
    expect(s.controller.redo().ok).toBe(true);
    view.setHudHidden(true, 'keyboard');
    expect([view.hudHidden, gizmo.enabled]).toEqual([true, false]);
  });
});
