import {
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  IcosahedronGeometry,
  MathUtils,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

/** Render-resolution cap from SPEC §18.2; CSS layout and pointer math stay in CSS pixels. */
export const MAX_PIXEL_RATIO = 1.5;

const SHELL = 0x141311;
const DEFAULT_CAMERA = [5.5, 3.6, 6.5] as const;

export type TransformMode = 'translate' | 'rotate';
export type ViewportLog = (kind: string, data: Record<string, unknown>) => void;

export interface Viewport {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  setMode(mode: TransformMode): void;
  frameView(): void;
  start(onFrame: (intervalMs: number, workMs: number) => void): void;
}

const round = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000);

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

/** M0 qualification scene: a spatial frame, one node material with a TSL cue, one gizmo target. */
export function createViewport(renderer: WebGPURenderer, log: ViewportLog): Viewport {
  const scene = new Scene();
  scene.background = new Color(SHELL);
  scene.fog = new Fog(SHELL, 16, 42);

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);

  scene.add(new HemisphereLight(0xf3f0ea, 0x1a1917, 1.1));
  const sun = new DirectionalLight(0xf3f0ea, 2.4);
  sun.position.set(5, 10, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
  sun.shadow.camera.right = sun.shadow.camera.top = 6;
  scene.add(sun);

  const floor = new Mesh(new PlaneGeometry(80, 80), new MeshStandardNodeMaterial({ color: 0x1d1b18, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new GridHelper(30, 30, 0x454038, 0x2c2925);
  grid.position.y = 0.002;
  scene.add(grid);

  // Temporary gizmo target. The TSL cue is a local-space teal→lavender gradient, so it
  // turns with the object and makes rotation readable.
  const material = new MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.08, flatShading: true });
  material.colorNode = mix(color(0x55aaa4), color(0xc58ae5), smoothstep(-0.9, 0.9, positionLocal.y));
  const target = new Mesh(new IcosahedronGeometry(0.9, 0), material);
  target.position.set(0, 1.1, 0);
  target.castShadow = true;
  scene.add(target);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.addEventListener('end', () => log('orbit', { camera: round(camera.position.toArray()) }));
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.attach(target);
  scene.add(gizmo.getHelper());

  // TransformControls keeps a constant screen size: each frame it scales its handles by
  // `distance × screenFactor × size / 4` (pinned 0.186.1). Choosing `size` to cancel the
  // distance keeps the rotation rings (radius 0.5 handle units) a fixed world size just
  // outside the target as the camera zooms; the clamp keeps far views grabbable.
  const RING_WORLD_RADIUS = 1.2;
  function fitGizmo() {
    const screenFactor = Math.min((1.9 * Math.tan((Math.PI * camera.fov) / 360)) / camera.zoom, 7);
    const distance = camera.position.distanceTo(target.position);
    gizmo.size = MathUtils.clamp((RING_WORLD_RADIUS * 8) / (distance * screenFactor), 0.5, 8);
  }
  gizmo.addEventListener('dragging-changed', (event) => {
    const dragging = event.value === true;
    orbit.enabled = !dragging;
    if (!dragging) {
      log('gizmo', {
        transformMode: gizmo.mode,
        position: round(target.position.toArray()),
        rotation: round([target.rotation.x, target.rotation.y, target.rotation.z]),
      });
    }
  });

  function frameView() {
    camera.position.set(...DEFAULT_CAMERA);
    orbit.target.copy(target.position);
    orbit.update();
  }
  frameView();

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
    setMode: (mode) => gizmo.setMode(mode),
    frameView,
    start(onFrame) {
      let last: number | undefined;
      renderer.setAnimationLoop((time: number) => {
        const begin = performance.now();
        orbit.update();
        fitGizmo();
        renderer.render(scene, camera);
        if (last !== undefined) onFrame(time - last, performance.now() - begin);
        last = time;
      });
    },
  };
}
