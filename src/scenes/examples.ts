// The five bundled examples (SPEC §19, MILESTONES M8): ordinary editable scenes, read through the
// same validation as an opened file. Catch and Release, Drag Pocket and Storm Bottle are M8's own tuned
// copies (they engage on Play); the accepted files in examples/ stay as earlier milestones tested them. Each opens paused at tick 0 with its first law selected, its own
// camera (or the default framing), and a one-line invitation that is app content, not scene data.
import sidewaysRain from './sideways-rain.lawsmith.json?raw';
import catchAndRelease from './catch-and-release.lawsmith.json?raw';
import dragPocket from './drag-pocket.lawsmith.json?raw';
import stormBottle from './storm-bottle.lawsmith.json?raw';
import twoFutures from '../../examples/two-futures.lawsmith.json?raw';
import type { SceneDocument } from '../domain/scene';
import { parseScene } from '../persistence/sceneFile';

export interface Example {
  key: string;
  title: string;
  /** The next interaction, in ordinary language. */
  invitation: string;
  text: string;
}

export const EXAMPLES: readonly Example[] = [
  { key: 'sideways-rain', title: 'Sideways Rain', invitation: 'Press Play, then drag the box into the falling rain to push it sideways.', text: sidewaysRain },
  { key: 'catch-and-release', title: 'Catch and Release', invitation: 'Press Play: the pull catches the falling stream. Switch Pull off to let the bodies fall.', text: catchAndRelease },
  { key: 'drag-pocket', title: 'Drag Pocket', invitation: 'Press Play: bodies slow in the pocket. Switch Drag pocket off and on to compare.', text: dragPocket },
  { key: 'storm-bottle', title: 'Storm Bottle', invitation: 'Press Play: the bottle holds a storm. Drag it aside to let the stream fall past.', text: stormBottle },
  { key: 'two-futures', title: 'Two Futures', invitation: 'Press Compare from here, set Strength to 2, then Play to watch one future split from the other.', text: twoFutures },
];

export function exampleDocument(example: Example): SceneDocument {
  const result = parseScene(example.text);
  if (!result.ok) throw new Error(`The bundled example ${example.title} is invalid: ${result.error.message}`);
  return result.document;
}
