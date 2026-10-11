// M8 owner feedback: three examples did not work out of the box. Catch and Release only caught bodies
// once its pull was moved up to the emitter, Drag Pocket needed a larger coefficient before bodies
// visibly slowed, and Storm Bottle had to be found under the stream. Their tuned M8 copies engage as
// soon as Play is pressed. These runs check that on a real Rapier host, with accepted primitives only.
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../src/domain/scene';
import { EXAMPLES, exampleDocument } from '../src/scenes/examples';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

const scene = (key: string) => exampleDocument(EXAMPLES.find((e) => e.key === key)!).semantic;
const field = (host: SimulationHost, id: string) => host.appliedFields().find((f) => f.id === id)!;
const setEnabled = (host: SimulationHost, id: string, enabled: boolean, revision: number) =>
  host.submit({ kind: 'putField', field: { ...field(host, id), enabled } as FieldDefinition }, revision);

describe('tuned M8 examples engage on Play', () => {
  it('Catch and Release holds the stream in the pull, and lets it fall when Pull is switched off', () => {
    const host = new SimulationHost(scene('catch-and-release'));
    const center = field(host, 'pull').pose.position;
    const [cx, cy, cz] = center as readonly [number, number, number];
    const inside = () => host.canonicalState().bodies.filter((b) => Math.hypot(b.translation[0]! - cx, b.translation[1]! - cy, b.translation[2]! - cz) < 1.6);
    for (let i = 0; i < 1200; i++) host.step();
    const held = host.canonicalState().bodies.length;
    expect(held).toBeGreaterThan(100);
    expect(inside().length / held).toBeGreaterThan(0.95);
    setEnabled(host, 'pull', false, 1);
    for (let i = 0; i < 240; i++) host.step();
    const fallen = host.canonicalState().bodies.filter((b) => b.translation[1]! < 1).length;
    expect(fallen / host.canonicalState().bodies.length).toBeGreaterThan(0.8);
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    expect(host.skippedEmissions).toBe(0);
    host.dispose();
  });

  it('Drag Pocket at least halves the speed of bodies passing through it, against the pocket switched off', () => {
    const meanSpeed = (on: boolean) => {
      const host = new SimulationHost(scene('drag-pocket'));
      if (!on) setEnabled(host, 'pocket', false, 1);
      const [bx, by, bz] = field(host, 'pocket').pose.position as readonly [number, number, number];
      let n = 0;
      let total = 0;
      for (let t = 1; t <= 1440; t++) {
        host.step();
        if (t <= 480 || t % 6) continue;
        for (const b of host.canonicalState().bodies) {
          const [x = 0, y = 0, z = 0] = b.translation;
          if (Math.abs(x - bx) < 1.2 && Math.abs(y - by) < 1.2 && Math.abs(z - bz) < 1.2) { n++; total += Math.hypot(...b.linvel); }
        }
      }
      expect(host.fault).toBeNull();
      expect(host.skippedEmissions).toBe(0);
      host.dispose();
      return total / n;
    };
    const on = meanSpeed(true);
    const off = meanSpeed(false);
    expect(on).toBeLessThan(off / 2);
  });

  it('Storm Bottle circulates the stream it sits under, without ejecting it', () => {
    const host = new SimulationHost(scene('storm-bottle'));
    const [ax, ay, az] = field(host, 'storm-bottle').pose.position as readonly [number, number, number];
    for (let i = 0; i < 1440; i++) host.step();
    const bodies = host.canonicalState().bodies;
    let inside = 0;
    let ejected = 0;
    let tangential = 0;
    for (const b of bodies) {
      const rx = b.translation[0]! - ax;
      const rz = b.translation[2]! - az;
      const rh = Math.hypot(rx, rz);
      if (rh < 1.4 && Math.abs(b.translation[1]! - ay) < 1.8) {
        inside++;
        if (rh > 0.05) tangential += Math.abs((rz * b.linvel[0]! - rx * b.linvel[2]!) / rh);
      }
      if (rh > 2.2) ejected++;
    }
    expect(inside / bodies.length).toBeGreaterThan(0.85);
    expect(ejected).toBe(0);
    expect(tangential / inside).toBeGreaterThan(1);
    expect(host.fault).toBeNull();
    expect(host.limitedSteps).toBe(0);
    expect(host.skippedEmissions).toBe(0);
    host.dispose();
  });
});
