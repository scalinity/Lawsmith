// The bundled, editable default scene (MILESTONES M2 deliverables): the starting recipe as a
// canonical `.lawsmith.json`, read through the same validation as any opened file.
import text from '../scenes/falling-stream.lawsmith.json?raw';
import type { SceneDocument } from '../domain/scene';
import { parseScene } from './sceneFile';

export const DEFAULT_SCENE_TEXT: string = text;

export function defaultDocument(): SceneDocument {
  const result = parseScene(DEFAULT_SCENE_TEXT);
  if (!result.ok) throw new Error(`The bundled scene is invalid: ${result.error.message}`);
  return result.document;
}
