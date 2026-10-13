// M9: the capture's sleeping-body count reads the engine through SimulationHost.sleepingBodies(). Every
// body is built with sleeping disabled (SPEC §9.3), so bodies resting on the floor still report none asleep.
import { beforeAll, describe, expect, it } from 'vitest';
import { STARTING_RECIPE, cloneFrozen } from '../src/domain/scene';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

describe('SimulationHost.sleepingBodies', () => {
  it('reports no sleeping bodies at tick 0 and after 1,200 steps of the starting recipe', () => {
    const host = new SimulationHost(cloneFrozen(STARTING_RECIPE));
    try {
      expect(host.sleepingBodies()).toBe(0);
      for (let i = 0; i < 1200; i++) host.step();
      expect(host.count).toBeGreaterThan(0);
      expect(host.sleepingBodies()).toBe(0);
    } finally {
      host.dispose();
    }
  });
});
