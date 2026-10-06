// The only module that reads three.js renderer internals (`renderer.backend` and its
// flags), checked against the pinned three@0.186.1 source. `isWebGPURenderer` names
// the class even after an automatic WebGL 2 fallback, so it proves nothing here.
import {
  Camera,
  RenderTarget,
  Scene,
  WebGPUCoordinateSystem,
  type WebGPURenderer,
} from 'three/webgpu';

interface GPUAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GPUDeviceLike {
  features: Iterable<string>;
  adapterInfo?: GPUAdapterInfoLike;
  addEventListener(type: 'uncapturederror', listener: (event: { error?: { message?: string } }) => void): void;
}

interface BackendInternals {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  compatibilityMode?: boolean | null;
  device?: GPUDeviceLike | null;
}

export interface BackendReport {
  backend: 'WebGPU' | 'WebGL 2 fallback' | 'unknown';
  coordinateSystemIsWebGPU: boolean;
  /** WebGPU feature-level compatibility mode; still WebGPU, unlike the WebGL 2 fallback. */
  compatibilityMode: boolean | null;
  /** Effective MSAA samples; three forces 0 in compatibility mode. */
  samples: number;
  adapter: GPUAdapterInfoLike | 'unavailable';
  features: string[];
}

function internals(renderer: WebGPURenderer): BackendInternals {
  return renderer.backend as unknown as BackendInternals;
}

/** Reads the backend three.js actually selected. Call only after `await renderer.init()`. */
export function identifyBackend(renderer: WebGPURenderer): BackendReport {
  const backend = internals(renderer);
  const device = backend.device ?? null;
  const info = device?.adapterInfo;
  return {
    backend:
      backend.isWebGPUBackend === true
        ? 'WebGPU'
        : backend.isWebGLBackend === true
          ? 'WebGL 2 fallback'
          : 'unknown',
    coordinateSystemIsWebGPU: renderer.coordinateSystem === WebGPUCoordinateSystem,
    compatibilityMode: backend.compatibilityMode ?? null,
    samples: renderer.samples,
    adapter:
      info && (info.vendor || info.architecture || info.device || info.description)
        ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
        : 'unavailable',
    features: device ? [...device.features].sort() : [],
  };
}

/** The gate passes only when both the backend flag and the public coordinate system agree. */
export function isQualifiedWebGPU(report: BackendReport): boolean {
  return report.backend === 'WebGPU' && report.coordinateSystemIsWebGPU;
}

/**
 * Collects WebGPU validation/uncaptured errors. Uses addEventListener because three.js
 * assigns `device.onuncapturederror` itself.
 */
export function watchGPUErrors(renderer: WebGPURenderer, onError: (message: string) => void): void {
  internals(renderer).device?.addEventListener('uncapturederror', (event) => {
    onError(event.error?.message ?? 'uncaptured GPU error');
  });
}

/**
 * Renders the scene once into a small target and reads it back through the active
 * backend, so "frames were rendered" rests on GPU output rather than API presence.
 * Returns the number of distinct colors in the 64×64 readback.
 */
export async function probeRenderedPixels(renderer: WebGPURenderer, scene: Scene, camera: Camera): Promise<number> {
  const size = 64;
  const target = new RenderTarget(size, size);
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size)) as ArrayLike<number>;
    const colors = new Set<number>();
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      colors.add(((pixels[i] ?? 0) << 16) | ((pixels[i + 1] ?? 0) << 8) | (pixels[i + 2] ?? 0));
    }
    return colors.size;
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
  }
}
