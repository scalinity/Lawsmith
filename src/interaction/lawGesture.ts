// Direct manipulation of laws (SPEC §10.3). TransformControls moves a proxy object for translation
// and rotation; spatial handles slide along rails for extent, fade, strength and core radius. Each
// change becomes a complete validated law value submitted through the document controller. The
// proxy is never physics state, and a law is picked by its semantic support, not its mesh.
import { Matrix4, Quaternion, Raycaster, Vector2, Vector3, type Object3D, type PerspectiveCamera } from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { FieldDefinition, Validated, Vec3 } from '../domain/scene';
import { regionDescriptor } from '../fields/registry';
import { handlePoint, lawHandles, railParameter, worldPoint, worldRail, type LawHandle } from './handles';

/** Translate and rotate drive TransformControls; `scale` shows the spatial handles instead. */
export type TransformMode = 'translate' | 'rotate' | 'scale';

/** A press that moves less than this (CSS px) before release is a click (selection). */
const CLICK_SLOP_PX = 4;
/** A press within this distance (CSS px) of a handle's projected center grabs it. */
const HANDLE_PICK_PX = 14;

export interface LawInteractionOptions {
  canvas: HTMLCanvasElement;
  /** The invisible native window-drag element over the top of the canvas. */
  dragRegion: HTMLElement;
  camera: PerspectiveCamera;
  gizmo: TransformControls;
  orbit: OrbitControls;
  proxy: Object3D;
  /** A law as the host last applied it: its last valid semantic value. */
  appliedField(id: string): FieldDefinition | undefined;
  /** The laws that can be picked in the viewport: applied and visible. */
  pickable(): readonly FieldDefinition[];
  /** Submits a complete law value through the document controller. */
  submit(candidate: FieldDefinition): Validated<{ revision: number; field: FieldDefinition }>;
  /** A gesture ended: a commit carries its accepted endpoints (one undo entry); a cancel restored `start`. */
  onGestureEnd(end: GestureEnd): void;
  onSelectionChange(id: string | null): void;
  /** Stops residual camera motion when a handle takes the pointer. */
  haltCamera(): void;
  /** False while edits are frozen (the close guard, launch recovery). */
  editable(): boolean;
  log(kind: string, data: Record<string, unknown>): void;
}

export interface GestureEnd {
  readonly mode: TransformMode;
  /** Undo label of the whole gesture. */
  readonly label: string;
  /** The handle dragged, or null for a TransformControls gesture. */
  readonly handle: string | null;
  readonly start: FieldDefinition;
  /** The last accepted value, or null if no preview was accepted. */
  readonly latest: FieldDefinition | null;
  readonly cancelled: boolean;
  /** The final submitted revision (the restore, for a cancel). */
  readonly revision: number | null;
}

interface Gesture {
  readonly mode: TransformMode;
  readonly label: string;
  readonly handle: LawHandle | null;
  /** Rail offset between the grabbed handle and the pointer's first projection, so a grab never jumps. */
  readonly grab: number;
  /** A handle drag's first and latest pointer positions (CSS px), for the log. */
  pointer: number[] | null;
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

const TRANSFORM_LABEL = { translate: 'Move law', rotate: 'Rotate law', scale: 'Resize law' } as const;

const summary = (f: FieldDefinition) => ({
  enabled: f.enabled,
  position: f.pose.position,
  rotation: f.pose.rotation,
  region: f.region,
  edgeFade: f.edgeFade,
  expression: f.expression,
});

export class LawInteraction {
  /** The selected law's ID; the gizmo or handles show only while one is selected and applied. */
  selectedId: string | null;
  gesture: Gesture | null = null;
  mode: TransformMode = 'translate';
  /** The handle under the pointer in handle mode, for the view's highlight. */
  hoverHandle: string | null = null;
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
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly one = new Vector3(1, 1, 1);
  private readonly projected = new Vector3();

  constructor(
    private readonly o: LawInteractionOptions,
    initial: string | null,
  ) {
    this.selectedId = initial;
    const { gizmo, orbit, canvas } = o;
    gizmo.addEventListener('mouseDown', () => this.beginTransform());
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
        // In the capture phase, before either control sees the press: a handle takes it from the camera.
        if (event.button === 0 && event.target === canvas && this.mode === 'scale' && !this.gesture && o.editable()) {
          const handle = this.handleAt(event.clientX, event.clientY);
          if (handle) this.beginHandle(handle, event);
        }
      },
      { capture: true },
    );
    window.addEventListener('focus', () => (this.routingStale = true));
    window.addEventListener(
      'pointerup',
      (event) => {
        this.pressed = false;
        if (this.gesture?.handle && event.pointerId === this.pointerId) this.finishDrag();
      },
      { capture: true },
    );
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
      this.press = { x: event.clientX, y: event.clientY, onGizmo: gizmo.dragging || this.gesture !== null };
    });
    canvas.addEventListener('pointerup', (event) => {
      const press = this.press;
      this.press = null;
      if (!press || press.onGizmo || event.button !== 0) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) return;
      this.select(this.pickLaw(event.clientX, event.clientY)?.id ?? null);
    });
    canvas.addEventListener('pointercancel', () => this.cancel('pointercancel'));
    // Capture also ends normally inside TransformControls' own pointerup, just before it finishes
    // the drag, and after a handle's release; only a loss that leaves a drag running cancels it.
    canvas.addEventListener('lostpointercapture', () =>
      queueMicrotask(() => {
        if (this.gesture && (gizmo.dragging || this.gesture.handle)) this.cancel('lostpointercapture');
      }),
    );
    window.addEventListener('pointermove', (event) => this.onPointerMove(event), { capture: true });
  }

  setMode(mode: TransformMode): void {
    if (this.gesture) return;
    this.mode = mode;
    if (mode !== 'scale') this.o.gizmo.setMode(mode);
    this.hoverHandle = null;
    this.o.canvas.style.cursor = '';
    this.attachGizmo();
  }

  get selected(): boolean {
    return this.selectedId !== null;
  }

  select(id: string | null): void {
    if (id === this.selectedId || this.gesture) return;
    this.selectedId = id;
    this.attachGizmo();
    this.o.onSelectionChange(id);
    this.o.log('selection', { selected: id !== null, field: id });
  }

  /** Ends an active gesture as a release would, at its last accepted value (file workflows, guards). */
  release(reason: string): boolean {
    if (!this.gesture) return false;
    this.gesture.endReason = reason;
    this.finishDrag();
    return true;
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

  /** The handle being dragged, if any. */
  get activeHandle(): string | null {
    return this.gesture?.handle?.name ?? null;
  }

  /** The selected law's spatial handles, shown in handle mode; none otherwise. */
  handles(): { field: FieldDefinition; handles: LawHandle[] } | null {
    if (this.mode !== 'scale' || this.selectedId === null) return null;
    const field = this.gesture?.latest ?? this.gesture?.start ?? this.o.appliedField(this.selectedId);
    return field ? { field, handles: lawHandles(field) } : null;
  }

  /** Where each shown handle appears on screen (CSS px), for the layout readback. */
  handlesOnScreen(): { name: string; role: string; point: number[]; world: Vec3 }[] {
    const shown = this.handles();
    if (!shown) return [];
    return shown.handles.map((h) => {
      const world = worldPoint(shown.field, handlePoint(h));
      return { name: h.name, role: h.role, point: this.toScreen(world), world };
    });
  }

  /**
   * Keeps the proxy on the applied law whenever no gesture owns it. Runs each frame after the
   * host's acknowledgments, so a cancelled gesture's restored value is already in place here.
   */
  syncProxy(): void {
    if (this.gesture) return;
    const f = this.selectedId === null ? undefined : this.o.appliedField(this.selectedId);
    this.attachGizmo(f !== undefined);
    if (!f) return;
    this.o.proxy.position.set(...f.pose.position);
    this.o.proxy.quaternion.set(...f.pose.rotation);
    this.o.proxy.scale.set(1, 1, 1);
    if (this.routingStale && !this.cameraActive) {
      this.routingStale = false;
      this.refreshDragRegion();
    }
  }

  /** The nearest pickable law whose semantic support the view ray enters, or null on a miss. */
  pickLaw(clientX: number, clientY: number): { id: string; distance: number } | null {
    this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.ndc, this.o.camera);
    let nearest: { id: string; distance: number } | null = null;
    for (const f of this.o.pickable()) {
      this.position.set(...f.pose.position);
      this.inverse.compose(this.position, this.rotation.set(...f.pose.rotation), this.one).invert();
      // Rotation is rigid, so the local ray parameter is the world distance.
      const ray = this.raycaster.ray.clone().applyMatrix4(this.inverse);
      const distance = regionDescriptor(f.region.kind).rayEntry(f.region, ray.origin.toArray() as unknown as Vec3, ray.direction.toArray() as unknown as Vec3);
      if (distance === null) continue;
      if (!nearest || distance < nearest.distance) nearest = { id: f.id, distance };
    }
    return nearest;
  }

  /** The handle whose projected center is nearest the pointer within the pick radius; nearer the camera wins a tie. */
  private handleAt(clientX: number, clientY: number): LawHandle | null {
    const shown = this.handles();
    if (!shown) return null;
    let best: { handle: LawHandle; pixels: number; depth: number } | null = null;
    for (const handle of shown.handles) {
      const [x, y, depth] = this.toScreen(worldPoint(shown.field, handlePoint(handle)));
      const pixels = Math.hypot(x! - clientX, y! - clientY);
      if (depth! > 1 || pixels > HANDLE_PICK_PX) continue;
      if (!best || pixels < best.pixels - 0.5 || (Math.abs(pixels - best.pixels) <= 0.5 && depth! < best.depth)) best = { handle, pixels, depth: depth! };
    }
    return best?.handle ?? null;
  }

  /** The gizmo shows in translate and rotate modes while a law is selected and applied. */
  private attachGizmo(present = true): void {
    const attach = this.selectedId !== null && present && this.mode !== 'scale';
    if (attach && this.o.gizmo.object !== this.o.proxy) this.o.gizmo.attach(this.o.proxy);
    if (!attach && this.o.gizmo.object) this.o.gizmo.detach();
  }

  private beginTransform(): void {
    const start = this.selectedId === null ? undefined : this.o.appliedField(this.selectedId);
    if (!start) return;
    const mode = this.o.gizmo.mode as TransformMode;
    this.gesture = { mode, label: TRANSFORM_LABEL[mode], handle: null, grab: 0, pointer: null, start, latest: null, samples: 0, rejected: 0, firstRevision: null, lastRevision: null, cancelReason: null, endReason: 'pointerup' };
    this.o.log('gesture', { phase: 'begin', transformMode: mode, field: summary(start), camera: this.cameraPosition() });
  }

  private beginHandle(handle: LawHandle, event: PointerEvent): void {
    const start = this.selectedId === null ? undefined : this.o.appliedField(this.selectedId);
    if (!start) return;
    const { canvas, orbit } = this.o;
    orbit.enabled = false;
    this.o.haltCamera();
    canvas.setPointerCapture(event.pointerId);
    this.pointerId = event.pointerId;
    const first = this.railAt(start, handle, event.clientX, event.clientY);
    this.gesture = { mode: 'scale', label: handle.label, handle, grab: first === null ? 0 : handle.t - first, pointer: [event.clientX, event.clientY, event.clientX, event.clientY], start, latest: null, samples: 0, rejected: 0, firstRevision: null, lastRevision: null, cancelReason: null, endReason: 'pointerup' };
    canvas.style.cursor = 'grabbing';
    this.refreshDragRegion();
    this.o.log('gesture', { phase: 'begin', transformMode: 'scale', handle: handle.name, role: handle.role, field: summary(start), camera: this.cameraPosition() });
  }

  /** A TransformControls change: the proxy's new pose as a complete law value. */
  private preview(): void {
    const g = this.gesture;
    if (!g || g.cancelReason || g.handle) return;
    const { proxy } = this.o;
    const { start } = g;
    const candidate: FieldDefinition =
      g.mode === 'rotate'
        ? { ...start, pose: { ...start.pose, rotation: [proxy.quaternion.x, proxy.quaternion.y, proxy.quaternion.z, proxy.quaternion.w] } }
        : { ...start, pose: { ...start.pose, position: [proxy.position.x, proxy.position.y, proxy.position.z] } };
    this.accept(g, candidate);
  }

  /** A handle drag sample: the rail parameter under the pointer, held within the control's range. */
  private previewHandle(clientX: number, clientY: number): void {
    const g = this.gesture;
    if (!g?.handle || g.cancelReason) return;
    g.pointer![2] = clientX;
    g.pointer![3] = clientY;
    const t = this.railAt(g.start, g.handle, clientX, clientY);
    if (t === null) return;
    this.accept(g, g.handle.at(t + g.grab));
  }

  private accept(g: Gesture, candidate: FieldDefinition): void {
    const result = this.o.submit(candidate);
    g.samples += 1;
    if (result.ok) {
      g.latest = result.value.field;
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
    if (g.handle) {
      this.o.orbit.enabled = true;
      this.o.canvas.style.cursor = '';
    }
    const handle = g.handle?.name ?? null;
    if (g.cancelReason) {
      const restored = this.o.submit(g.start);
      const revision = restored.ok ? restored.value.revision : null;
      this.o.log('gesture', { phase: 'cancel', reason: g.cancelReason, transformMode: g.mode, handle, samples: g.samples, restoredRevision: revision, field: summary(g.start), camera: this.cameraPosition() });
      this.o.onGestureEnd({ mode: g.mode, label: g.label, handle, start: g.start, latest: g.latest, cancelled: true, revision });
      return;
    }
    this.o.log('gesture', {
      phase: 'commit',
      reason: g.endReason,
      transformMode: g.mode,
      handle,
      samples: g.samples,
      rejected: g.rejected,
      pointer: g.pointer,
      firstRevision: g.firstRevision,
      lastRevision: g.lastRevision,
      field: summary(g.latest ?? g.start),
      lawId: g.start.id,
      camera: this.cameraPosition(),
    });
    this.o.onGestureEnd({ mode: g.mode, label: g.label, handle, start: g.start, latest: g.latest, cancelled: false, revision: g.lastRevision });
  }

  /** Ends the drag in progress: a handle's here, TransformControls' through its public pointerUp. */
  private finishDrag(): void {
    const { canvas, gizmo } = this.o;
    if (this.pointerId !== null && canvas.hasPointerCapture(this.pointerId)) canvas.releasePointerCapture(this.pointerId);
    if (!this.gesture?.handle) gizmo.pointerUp(null);
    if (this.gesture) this.end();
  }

  private onPointerMove(event: PointerEvent): void {
    const { gizmo, canvas } = this.o;
    // A press whose release never arrived (M0 finding 1): the pointer reports no buttons while
    // a drag still holds it. End it the way a release would have, so nothing keeps dragging.
    if (event.buttons === 0 && event.pointerType !== 'touch') {
      this.pressed = false;
      if (this.gesture && (gizmo.dragging || this.gesture.handle)) {
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
    if (this.gesture?.handle) this.previewHandle(event.clientX, event.clientY);
    else if (this.mode === 'scale' && !this.gesture && !this.cameraActive && event.target === canvas) {
      const hover = this.handleAt(event.clientX, event.clientY)?.name ?? null;
      if (hover !== this.hoverHandle) {
        this.hoverHandle = hover;
        canvas.style.cursor = hover ? 'grab' : '';
      }
    }
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.refreshDragRegion();
  }

  /** The handle's rail parameter nearest the view ray through a pointer position, in the law's start pose. */
  private railAt(field: FieldDefinition, handle: LawHandle, clientX: number, clientY: number): number | null {
    this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.ndc, this.o.camera);
    const { origin, direction } = this.raycaster.ray;
    const rail = worldRail(field, handle);
    return railParameter(rail.origin, rail.axis, [origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z]);
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
    if (this.selected && this.o.gizmo.object) {
      // Place the handle pickers at the proxy's current pose; three otherwise updates them only when rendering.
      gizmo.getHelper().updateMatrixWorld(true);
      this.toNdc(clientX, clientY);
      // The pinned implementation (TransformControls.js, pointerHover) feeds its argument to
      // Raycaster.setFromCamera, i.e. NDC {x, y}; the bundled typing's PointerEvent is wrong.
      gizmo.pointerHover({ x: this.ndc.x, y: this.ndc.y, button: -1 } as unknown as PointerEvent);
      if (gizmo.axis !== null) return true;
    }
    return this.handleAt(clientX, clientY) !== null || this.pickLaw(clientX, clientY) !== null;
  }

  /** Full-precision camera position, so a log can show the camera did not move during a gesture. */
  private cameraPosition(): number[] {
    return this.o.camera.position.toArray();
  }

  /** A world point in CSS pixels, with its NDC depth (beyond 1 is behind the camera or the far plane). */
  private toScreen(point: Vec3): number[] {
    const rect = this.o.canvas.getBoundingClientRect();
    this.projected.set(...point).project(this.o.camera);
    return [rect.left + ((this.projected.x + 1) / 2) * rect.width, rect.top + ((1 - this.projected.y) / 2) * rect.height, this.projected.z];
  }

  private toNdc(clientX: number, clientY: number): void {
    const rect = this.o.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }
}
