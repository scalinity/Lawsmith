// LawInteraction's release at a recording limit (SPEC §13.3; AC7): the gesture ends at the value the
// host applied, the pointer is released, and nothing more is submitted. The controls are stubs shaped
// like the parts LawInteraction touches; the document, host and recorder are real.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Object3D, PerspectiveCamera } from 'three';
import { LawInteraction, type GestureEnd } from '../src/interaction/lawGesture';
import { RUN_LIMITS } from '../src/persistence/runFile';
import { initSimulation } from '../src/simulation/host';
import { moveTo, session } from './support/run';

beforeAll(async () => {
  await initSimulation();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** TransformControls' events and its public pointerUp, as the pinned three.js implements them. */
class GizmoStub extends EventTarget {
  mode = 'translate';
  dragging = false;
  axis: string | null = null;
  setMode(mode: string) {
    this.mode = mode;
  }
  drag() {
    this.dragging = true;
    this.axis = 'X';
    this.dispatchEvent(new Event('mouseDown'));
  }
  change() {
    this.dispatchEvent(new Event('objectChange'));
  }
  pointerUp(pointer: { button: number } | null) {
    if (pointer !== null && pointer.button !== 0) return;
    if (this.dragging && this.axis !== null) this.dispatchEvent(new Event('mouseUp'));
    this.dragging = false;
    this.axis = null;
  }
}

function interaction() {
  // LawInteraction listens on window. Rapier's WASM reads `performance` from window when one exists,
  // so the stand-in carries the real one.
  (globalThis as { window?: EventTarget }).window ??= Object.assign(new EventTarget(), { performance: globalThis.performance });
  const s = session();
  const canvas = Object.assign(new EventTarget(), {
    style: {} as Record<string, string>,
    hasPointerCapture: () => true,
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  const gizmo = new GizmoStub();
  const proxy = { position: { x: 0, y: 1, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  const ends: GestureEnd[] = [];
  const submit = vi.fn((candidate, transactionId: string) => s.controller.putField(candidate, transactionId));
  const law = new LawInteraction(
    {
      canvas: canvas as unknown as HTMLCanvasElement,
      dragRegion: {} as HTMLElement,
      camera: { position: { toArray: () => [0, 0, 10] } } as unknown as PerspectiveCamera,
      gizmo: gizmo as unknown as TransformControls,
      orbit: Object.assign(new EventTarget(), { enabled: true }) as unknown as OrbitControls,
      proxy: proxy as unknown as Object3D,
      appliedField: (id) => s.controller.lawState(id)?.field,
      pickable: () => s.controller.scene.fields,
      submit,
      transaction: () => s.controller.newTransaction(),
      // As main.ts's gestureEnded: the controller ends it at what the host applied.
      onGestureEnd: (end) => {
        ends.push(end);
        s.controller.endGesture(end.label, end.start, end.transactionId);
      },
      onSelectionChange: () => {},
      clickBody: () => false,
      haltCamera: () => {},
      editable: () => true,
      focus: () => null,
      log: () => {},
    },
    null,
  );
  law.selectedId = 'push';
  /** A TransformControls drag as the browser starts it: the canvas press, then the gizmo's own. */
  const press = () => {
    canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 7, clientX: 0, clientY: 0, button: 0 }));
    gizmo.drag();
  };
  const sample = (x: number) => {
    proxy.position.x = x;
    gizmo.change();
  };
  return { s, law, canvas, submit, ends, press, sample };
}

describe('LawInteraction.release at a recording limit (SPEC §13.3; AC7)', () => {
  it('ends at the applied value, releases the pointer and submits nothing more', { timeout: 120_000 }, async () => {
    const { s, law, canvas, submit, ends, press, sample } = interaction();
    s.coordinator.startRecording();
    s.steps(3);
    for (let k = 0; k < RUN_LIMITS.commands - 1; k++) expect(s.controller.setAmbient([0, k % 2 ? -9.8 : -9.81, 0]).ok).toBe(true);
    press();
    sample(-1);
    s.boundary(); // the 50,000th command
    sample(-0.5);
    s.boundary(); // the 50,001st: refused, and the limit closes the recording
    await flush();
    expect(s.limits).toEqual(['commands']);
    // main.ts's limit handler: release the gesture at the value the host applied.
    const applied = s.controller.lawState('push')!.field;
    const submitted = submit.mock.calls.length;
    expect(law.release('recording-commands', applied)).toBe(true);
    expect(law.gesture).toBeNull();
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(submit.mock.calls.length).toBe(submitted);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.cancelled).toBe(false);
    expect(ends[0]!.latest).toBe(applied);
    // One undo entry, from the start to the applied value.
    expect(applied.pose.position[0]).toBe(-1);
    const undone = s.controller.undo();
    expect(undone.ok && undone.value.transactionId).toBe(ends[0]!.transactionId);
    expect(s.controller.lawState('push')!.field.pose.position[0]).toBe(-1.5);
    expect(s.controller.redo().ok).toBe(true);
    expect(s.controller.lawState('push')!.field).toEqual(applied);
  });

  it('without a limit, a release ends the drag at its last sample', () => {
    const { s, law, ends, press, sample } = interaction();
    press();
    sample(-1);
    s.boundary();
    sample(-0.5);
    expect(law.release('quiesce')).toBe(true);
    expect(ends).toHaveLength(1);
    expect(s.controller.lawState('push')!.field).toEqual(moveTo(-0.5)(ends[0]!.start));
  });
});
