// The five bundled examples (SPEC §19, MILESTONES M8): ordinary editable scenes, read through the
// same validation as an opened file. Each opens paused at tick 0 with its first law selected, its own
// camera (or the default framing), and a one-line invitation that is app content, not scene data.
import sidewaysRain from './sideways-rain.lawsmith.json?raw';
import catchAndRelease from '../../examples/catch-and-release.lawsmith.json?raw';
import dragPocket from './drag-pocket.lawsmith.json?raw';
import stormBottle from '../../examples/storm-bottle.lawsmith.json?raw';
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
  { key: 'catch-and-release', title: 'Catch and Release', invitation: 'Press Play, drag the pull into the stream to catch bodies, then drag it away to let them go.', text: catchAndRelease },
  { key: 'drag-pocket', title: 'Drag Pocket', invitation: 'Press Play, then switch Drag pocket off and on to see the motion it takes away.', text: dragPocket },
  { key: 'storm-bottle', title: 'Storm Bottle', invitation: 'Press Play, then drag the bottle under the falling stream to catch a storm.', text: stormBottle },
  { key: 'two-futures', title: 'Two Futures', invitation: 'Press Compare from here, set Strength to 2, then Play to watch one future split from the other.', text: twoFutures },
];

export function exampleDocument(example: Example): SceneDocument {
  const result = parseScene(example.text);
  if (!result.ok) throw new Error(`The bundled example ${example.title} is invalid: ${result.error.message}`);
  return result.document;
}
