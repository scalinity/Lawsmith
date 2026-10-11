// M8 bundled examples (SPEC §19): five canonical editable scenes that open paused at tick 0 with
// their intended law first, run without faults, and keep accepted physics. One shows law
// contributions and contacts apart. T06: opening an example takes the same guard as New.
import { beforeAll, describe, expect, it } from 'vitest';
import whyItMoves from '../examples/why-it-moves.lawsmith.json?raw';
import { defaultDocument } from '../src/persistence/defaultScene';
import { parseScene, semanticDigest, serializeScene } from '../src/persistence/sceneFile';
import { EXAMPLES, exampleDocument } from '../src/scenes/examples';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

const INTENDED: Record<string, string> = {
  'sideways-rain': 'sideways',
  'catch-and-release': 'pull',
  'drag-pocket': 'pocket',
  'storm-bottle': 'storm-bottle',
  'two-futures': 'sideways',
};

describe('M8 bundled examples', () => {
  it('are the five SPEC §19 experiments, in order, each with a one-line invitation', () => {
    expect(EXAMPLES.map((e) => e.title)).toEqual(['Sideways Rain', 'Catch and Release', 'Drag Pocket', 'Storm Bottle', 'Two Futures']);
    for (const e of EXAMPLES) {
      expect(e.invitation).not.toMatch(/\n/);
      expect(e.invitation.length).toBeLessThanOrEqual(110);
    }
  });

  it.each(EXAMPLES)('$title round-trips canonically, is titled as listed, and selects its intended law first', (example) => {
    const document = exampleDocument(example);
    const text = serializeScene(document);
    const again = parseScene(text);
    if (!again.ok) throw again.error;
    expect(serializeScene(again.document)).toBe(text);
    // The two scenes authored for M8 are stored canonically; the others are accepted files, read as they are.
    if (example.key === 'sideways-rain' || example.key === 'drag-pocket') expect(text).toBe(example.text);
    expect(document.metadata.title).toBe(example.title);
    expect(document.semantic.fields[0]!.id).toBe(INTENDED[example.key]);
    expect(document.presentation.laws.find((l) => l.id === INTENDED[example.key])!.visible).toBe(true);
  });

  it.each(EXAMPLES)('$title runs 20 s without a fault from a paused tick 0', { timeout: 60_000 }, (example) => {
    const host = new SimulationHost(exampleDocument(example).semantic);
    expect(host.tick).toBe(0);
    for (let i = 0; i < 2400; i++) host.step();
    expect(host.fault).toBeNull();
    host.dispose();
  });

  it('Sideways Rain is the accepted defining demonstration, renamed only', async () => {
    const rain = exampleDocument(EXAMPLES[0]!);
    expect(await semanticDigest(rain)).toBe(await semanticDigest(defaultDocument()));
    expect(rain.presentation).toEqual(defaultDocument().presentation);
  });

  it('Drag Pocket overlaps a pull and shows law shares apart from collisions', async () => {
    const pocket = exampleDocument(EXAMPLES[2]!);
    const source = parseScene(whyItMoves);
    if (!source.ok) throw source.error;
    expect(await semanticDigest(pocket)).toBe(await semanticDigest(source.document));
    const host = new SimulationHost(pocket.semantic);
    let explained: string | null = null;
    let dragged = false;
    let contactGap = 0;
    for (let n = 0; n < 1200 && !(dragged && contactGap > 0.5); n++) {
      host.step();
      if (explained === null && host.ids.length) host.explain((explained = host.ids[0]!));
      const o = host.explanation;
      if (!o) continue;
      if (o.drag > 0) dragged = true;
      if (o.contacts?.length) {
        // The contact is named separately; the law acceleration alone does not predict the step.
        const predicted = o.velocity.map((v, i) => v + o.submitted[i]! / 120);
        contactGap = Math.max(contactGap, ...o.after!.velocity.map((v, i) => Math.abs(v - predicted[i]!)));
      }
    }
    expect(dragged).toBe(true);
    expect(contactGap).toBeGreaterThan(0.5);
    host.dispose();
  });
});
