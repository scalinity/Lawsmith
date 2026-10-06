// Direct manipulation of the law (SPEC §10.3). TransformControls moves a proxy object; each
// change becomes a complete validated law value submitted through the document controller.
// The proxy is never physics state, and the law is picked by its semantic box, not its mesh.
import { Box3, Matrix4, Quaternion, Raycaster, Vector2, Vector3, type Object3D, type PerspectiveCamera } from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { FieldDefinition, Validated } from '../domain/scene';

export type TransformMode = 'translate' | 'rotate' | 'scale';

/** A press that moves less than this (CSS px) before release is a click (selection). */
const CLICK_SLOP_PX = 4;

export interface LawInteractionOptions {
  canvas: HTMLCanvasElement;
  /** The invisible native window-drag element over the top of the canvas. */
  dragRegion: HTMLElement;
  camera: PerspectiveCamera;
  gizmo: TransformControls;
  orbit: OrbitControls;
  proxy: Object3D;
  /** The law as the host last applied it: the last valid semantic value. */
  appliedField(): FieldDefinition;
  /** Submits a complete law value through the document controller. */
  submit(candidate: FieldDefinition): Validated<{ revision: number }>;
  /** A gesture ended; `revision` is its final submitted value (a restore, for a cancel). */
  onGestureEnd(revision: number | null): void;
  onSelectionChange(selected: boolean): void;
  log(kind: string, data: Record<string, unknown>): void;
}

interface Gesture {
  readonly mode: TransformMode;
  /** The applied value when the gesture began; a cancel restores it. */
  readonly start: FieldDefinition;
  latest: FieldDefinition | null;
  samples: number;
  rejected: number;
  firstRevision: number | null;
  lastRevision: number | null;
  /** Set when the gesture ends by cancellation rather than release. */
  cancelReason: string | null;
  endReason: string;
}

const summary = (f: FieldDefinition) => ({
  enabled: f.enabled,
  position: f.pose.position,
  rotation: f.pose.rotation,
  halfExtents: f.region.halfExtents,
});

export class LawInteraction {
  selected = true;
  gesture: Gesture | null = null;
  /** True between OrbitControls `start` and `end` for a pointer drag (wheel zoom is not a gesture). */
  private cameraActive = false;
  /** A primary press is down; seen in the capture phase, before either control handles it. */
  private pressed = false;
  /** Last known pointer position, so the drag strip's routing can be recomputed without a move. */
  private lastPointer: { x: number; y: number } | null = null;
  /** Set when an owner releases the pointer; resolved on the next frame, once the law is re-applied. */
  private routingStale = false;
  private pointerId: number | null = null;
  private press: { x: number; y: number; onGizmo: boolean } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly inverse = new Matrix4();
  private readonly box = new Box3();
  private readonly hit = new Vector3();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly one = new Vector3(1, 1, 1);

  constructor(private readonly o: LawInteractionOptions) {
    const { gizmo, orbit, canvas } = o;
    gizmo.addEventListener('mouseDown', () => this.begin());
    gizmo.addEventListener('objectChange', () => this.preview());
    gizmo.addEventListener('mouseUp', () => this.end());
    gizmo.addEventListener('dragging-changed', (event) => {
      orbit.enabled = event.value !== true;
    });
    window.addEventListener(
      'pointerdown',
      (event) => {
        this.pressed = true;
        this.lastPointer = { x: event.clientX, y: event.clientY };
      },
      { capture: true },
    );
    window.addEventListener('focus', () => (this.routingStale = true));
    window.addEventListener('pointerup', () => (this.pressed = false), { capture: true });
    orbit.addEventListener('start', () => {
      if (this.gesture || gizmo.dragging) o.log('ownership-conflict', { owner: 'law', intruder: 'orbit' });
      this.cameraActive = this.pressed;
    });
    orbit.addEventListener('end', () => {
      if (this.cameraActive) o.log('orbit', { camera: o.camera.position.toArray().map((v) => Math.round(v * 1000) / 1000) });
      this.cameraActive = false;
      this.routingStale = true;
    });

    // Registered after both controls, so these run once ownership is already decided.
    canvas.addEventListener('pointerdown', (event) => {
      this.pointerId = event.pointerId;
      this.press = { x: event.clientX, y: event.clientY, onGizmo: gizmo.dragging };
    });
    canvas.addEventListener('pointerup', (event) => {
      const press = this.press;
      this.press = null;
      if (!press || press.onGizmo || event.button !== 0) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) return;
      this.select(this.pickLaw(event.clientX, event.clientY) !== null);
    });
    canvas.addEventListener('pointercancel', () => this.cancel('pointercancel'));
    // Capture also ends normally inside TransformControls' own pointerup, just before it
    // finishes the drag; only a loss that leaves the drag running is a cancellation.
    canvas.addEventListener('lostpointercapture', () =>
      queueMicrotask(() => {
        if (this.gesture && gizmo.dragging) this.cancel('lostpointercapture');
      }),
    );
    window.addEventListener('pointermove', (event) => this.onPointerMove(event), { capture: true });
  }

  setMode(mode: TransformMode): void {
    if (this.gesture) return;
    this.o.gizmo.setMode(mode);
  }

  select(selected: boolean): void {
    if (selected === this.selected || this.gesture) return;
    this.selected = selected;
    if (selected) this.o.gizmo.attach(this.o.proxy);
    else this.o.gizmo.detach();
    this.o.onSelectionChange(selected);
    this.o.log('selection', { selected, field: this.o.appliedField().id });
  }

  /** Cancels an active gesture and restores its starting value through the command path. */
  cancel(reason: string): boolean {
    if (!this.gesture) return false;
    this.gesture.cancelReason = reason;
    this.finishDrag();
    return true;
  }

  /** The gesture's latest accepted value, for the preview outline. */
  previewField(): FieldDefinition | null {
    return this.gesture?.latest ?? null;
  }

  /**
   * Keeps the proxy on the applied law whenever no gesture owns it. Runs each frame after the
   * host's acknowledgments, so a cancelled gesture's restored value is already in place here.
   */
  syncProxy(): void {
    if (this.gesture) return;
    const f = this.o.appliedField();
    this.o.proxy.position.set(...f.pose.position);
    this.o.proxy.quaternion.set(...f.pose.rotation);
    this.o.proxy.scale.set(1, 1, 1);
    if (this.routingStale && !this.cameraActive) {
      this.routingStale = false;
      this.refreshDragRegion();
    }
  }

  /** Distance along the view ray to the law's semantic support box, or null on a miss. */
  pickLaw(clientX: number, clientY: number): number | null {
    const f = this.o.appliedField();
    this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.ndc, this.o.camera);
    this.position.set(...f.pose.position);
    this.inverse.compose(this.position, this.rotation.set(...f.pose.rotation), this.one).invert();
    const ray = this.raycaster.ray.clone().applyMatrix4(this.inverse);
    const [hx, hy, hz] = f.region.halfExtents;
    this.box.min.set(-hx, -hy, -hz);
    this.box.max.set(hx, hy, hz);
    return ray.intersectBox(this.box, this.hit) ? ray.origin.distanceTo(this.hit) : null;
  }

  private begin(): void {
    const start = this.o.appliedField();
    this.gesture = {
      mode: this.o.gizmo.mode as TransformMode,
      start,
      latest: null,
      samples: 0,
      rejected: 0,
      firstRevision: null,
      lastRevision: null,
      cancelReason: null,
      endReason: 'pointerup',
    };
    this.o.log('gesture', { phase: 'begin', transformMode: this.gesture.mode, field: summary(start) });
  }

  private preview(): void {
    const g = this.gesture;
    if (!g || g.cancelReason) return;
    const candidate = this.candidate(g);
    const result = this.o.submit(candidate);
    g.samples += 1;
    if (result.ok) {
      g.latest = candidate;
      g.firstRevision ??= result.value.revision;
      g.lastRevision = result.value.revision;
    } else {
      g.rejected += 1;
    }
  }

  private end(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.routingStale = true;
    if (g.cancelReason) {
      const restored = this.o.submit(g.start);
      const revision = restored.ok ? restored.value.revision : null;
      this.o.log('gesture', { phase: 'cancel', reason: g.cancelReason, transformMode: g.mode, samples: g.samples, restoredRevision: revision, field: summary(g.start) });
      this.o.onGestureEnd(revision);
      return;
    }
    this.o.log('gesture', {
      phase: 'commit',
      reason: g.endReason,
      transformMode: g.mode,
      samples: g.samples,
      rejected: g.rejected,
      firstRevision: g.firstRevision,
      lastRevision: g.lastRevision,
      field: summary(g.latest ?? g.start),
    });
    this.o.onGestureEnd(g.lastRevision);
  }

  /** Ends TransformControls' drag through its public pointerUp, then settles our gesture. */
  private finishDrag(): void {
    const { canvas, gizmo } = this.o;
    if (this.pointerId !== null && canvas.hasPointerCapture(this.pointerId)) canvas.releasePointerCapture(this.pointerId);
    gizmo.pointerUp(null);
    if (this.gesture) this.end();
  }

  /** Builds the complete law value implied by the proxy; translation, rotation and extent are separate. */
  private candidate(g: Gesture): FieldDefinition {
    const { proxy } = this.o;
    const { start } = g;
    switch (g.mode) {
      case 'translate':
        return { ...start, pose: { ...start.pose, position: [proxy.position.x, proxy.position.y, proxy.position.z] } };
      case 'rotate':
        return { ...start, pose: { ...start.pose, rotation: [proxy.quaternion.x, proxy.quaternion.y, proxy.quaternion.z, proxy.quaternion.w] } };
      case 'scale': {
        const [hx, hy, hz] = start.region.halfExtents;
        return { ...start, region: { kind: 'box', halfExtents: [hx * proxy.scale.x, hy * proxy.scale.y, hz * proxy.scale.z] } };
      }
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const { gizmo, canvas } = this.o;
    // A press whose release never arrived (M0 finding 1): the pointer reports no buttons while
    // a drag still holds it. End it the way a release would have, so nothing keeps dragging.
    if (event.buttons === 0 && event.pointerType !== 'touch') {
      this.pressed = false;
      if (this.gesture && gizmo.dragging) {
        this.o.log('pointer-reconcile', { owner: 'law', pointerType: event.pointerType });
        this.gesture.endReason = 'stale-buttons';
        this.finishDrag();
      }
      if (this.cameraActive) {
        this.o.log('pointer-reconcile', { owner: 'camera', pointerType: event.pointerType });
        // OrbitControls finishes its own drag on pointercancel: capture, listeners, `end`.
        canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: event.pointerId, bubbles: true }));
      }
    }
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.refreshDragRegion();
  }

  /**
   * The native drag region yields to scene content under the pointer (M0 finding 7), so a handle
   * or the law beneath the top band stays reachable; empty background still drags the window.
   * Any owned gesture keeps it yielded until that owner releases the pointer.
   */
  private refreshDragRegion(): void {
    const { dragRegion } = this.o;
    const p = this.lastPointer;
    let yieldBand = this.gesture !== null || this.cameraActive;
    if (!yieldBand && p) {
      const band = dragRegion.getBoundingClientRect();
      const overBand = p.y >= band.top && p.y <= band.bottom && p.x >= band.left && p.x <= band.right;
      yieldBand = overBand && this.sceneContentAt(p.x, p.y);
    }
    dragRegion.style.pointerEvents = yieldBand ? 'none' : '';
  }

  private sceneContentAt(clientX: number, clientY: number): boolean {
    const { gizmo } = this.o;
    if (this.selected) {
      // Place the handle pickers at the proxy's current pose; three otherwise updates them only when rendering.
      gizmo.getHelper().updateMatrixWorld(true);
      this.toNdc(clientX, clientY);
      // The pinned implementation (TransformControls.js, pointerHover) feeds its argument to
      // Raycaster.setFromCamera, i.e. NDC {x, y}; the bundled typing's PointerEvent is wrong.
      gizmo.pointerHover({ x: this.ndc.x, y: this.ndc.y, button: -1 } as unknown as PointerEvent);
      if (gizmo.axis !== null) return true;
    }
    return this.pickLaw(clientX, clientY) !== null;
  }

  private toNdc(clientX: number, clientY: number): void {
    const rect = this.o.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }
}
