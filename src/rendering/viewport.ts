import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

/** Render-resolution cap from SPEC §18.2; CSS layout and pointer math stay in CSS pixels. */
export const MAX_PIXEL_RATIO = 1.5;

/** SPEC §2.2 initial view. */
const DEFAULT_CAMERA = new Vector3(9, 7, 11);
const DEFAULT_TARGET = new Vector3(0, 1, 0);

export type ViewportLog = (kind: string, data: Record<string, unknown>) => void;

/** Reads a `:root` color token from src/style.css, so scene colors share the UI palette. */
export function tokenColor(name: string): Color {
  return new Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

export interface FrameHooks {
  /** Simulation and view updates for this presentation frame, before rendering. */
  before(timeMs: number): void;
  /** Called after the frame is submitted; `intervalMs` is undefined on the first frame. */
  after(intervalMs: number | undefined, workMs: number): void;
}

export interface Viewport {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  /** The TransformControls target. It is not a law: gestures read it and submit commands. */
  proxy: Object3D;
  /** Points the camera at `center`, far enough back to show a sphere of `radius`. */
  frame(center: readonly [number, number, number], radius: number): void;
  resetView(): void;
  start(hooks: FrameHooks): void;
}

/** Creates the renderer and waits for its backend; the caller identifies which backend it got. */
export async function createRenderer(host: HTMLElement, forceWebGL: boolean): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  host.append(renderer.domElement);
  await renderer.init();
  return renderer;
}

/** Scene frame, lights, camera and controls. Law, bodies and fixed geometry belong to the world view. */
export function createViewport(renderer: WebGPURenderer, log: ViewportLog): Viewport {
  const shell = tokenColor('--shell');
  const scene = new Scene();
  scene.background = shell;
  scene.fog = new Fog(shell, 22, 60);

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);

  scene.add(new HemisphereLight(tokenColor('--text'), tokenColor('--card'), 1.1));
  const sun = new DirectionalLight(tokenColor('--text'), 2.4);
  sun.position.set(6, 12, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -9;
  sun.shadow.camera.right = sun.shadow.camera.top = 9;
  scene.add(sun);

  // Construction order is pointer ownership (M0 finding 6). Both controls listen for
  // `pointerdown` on the canvas, and listeners run in registration order. TransformControls
  // registers first, so a press on a handle starts the gizmo drag, whose `dragging-changed`
  // disables orbit before OrbitControls sees the press. Orbit then neither captures the
  // pointer nor fires `end` on release.
  const gizmo = new TransformControls(camera, renderer.domElement);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  const proxy = new Object3D();
  proxy.name = 'law-proxy';
  scene.add(proxy);
  gizmo.attach(proxy);
  scene.add(gizmo.getHelper());

  function resetView() {
    camera.position.copy(DEFAULT_CAMERA);
    orbit.target.copy(DEFAULT_TARGET);
    orbit.update();
  }
  resetView();

  const offset = new Vector3();
  function frame(center: readonly [number, number, number], radius: number) {
    const distance = radius / Math.sin((Math.PI * camera.fov) / 360) + 1;
    offset.subVectors(camera.position, orbit.target).normalize().multiplyScalar(distance);
    orbit.target.set(center[0], center[1], center[2]);
    camera.position.copy(orbit.target).add(offset);
    orbit.update();
  }

  function fit() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  // The window may have been resized during startup, before this listener existed.
  fit();

  let resizeLog: number | undefined;
  window.addEventListener('resize', () => {
    fit();
    clearTimeout(resizeLog);
    resizeLog = window.setTimeout(() => {
      log('resize', {
        css: [window.innerWidth, window.innerHeight],
        devicePixelRatio: window.devicePixelRatio,
        pixelRatio: renderer.getPixelRatio(),
        canvas: [renderer.domElement.width, renderer.domElement.height],
        aspect: Math.round(camera.aspect * 10000) / 10000,
      });
    }, 300);
  });

  return {
    renderer,
    scene,
    camera,
    orbit,
    gizmo,
    proxy,
    frame,
    resetView,
    start(hooks) {
      let last: number | undefined;
      renderer.setAnimationLoop((time: number) => {
        const begin = performance.now();
        hooks.before(time);
        orbit.update();
        renderer.render(scene, camera);
        hooks.after(last === undefined ? undefined : time - last, performance.now() - begin);
        last = time;
      });
    },
  };
}
