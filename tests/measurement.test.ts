// Edit-latency measurement (SPEC §18.2): accepted edit → first submitted frame that contains its
// applied revision. A superseded (coalesced) edit never appears in a frame, so it is counted
// separately; an absent measurement is reported as absent, never as zero.
import { describe, expect, it } from 'vitest';
import { EditLatency, percentiles } from '../src/measurement';

describe('edit latency', () => {
  it('measures acknowledged revisions only; a revision coalesced away is counted as superseded', () => {
    const latency = new EditLatency();
    latency.accept(1, 100);
    latency.accept(2, 105); // the host replaces revision 1 with 2 before the boundary
    latency.acknowledge(2);
    expect(latency.frameSubmitted(2, 120)).toEqual([15]);
    expect(latency.superseded).toBe(1);
  });

  it('waits for the frame that contains the applied revision', () => {
    const latency = new EditLatency();
    latency.accept(1, 100);
    expect(latency.frameSubmitted(0, 110)).toEqual([]);
    latency.acknowledge(1);
    expect(latency.frameSubmitted(1, 125)).toEqual([25]);
    expect(latency.frameSubmitted(1, 140)).toEqual([]);
    expect(latency.superseded).toBe(0);
  });

  it('keeps later edits pending while an earlier one is applied', () => {
    const latency = new EditLatency();
    latency.accept(1, 100);
    latency.accept(2, 112);
    latency.acknowledge(1);
    expect(latency.frameSubmitted(1, 118)).toEqual([18]);
    latency.acknowledge(2);
    expect(latency.frameSubmitted(2, 134)).toEqual([22]);
  });
});

describe('percentiles', () => {
  it('reports p50, p95, p99 and max of a sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(values)).toEqual([51, 96, 100, 100]);
  });

  it('reports an empty sample as absent, distinct from readings of zero', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([0, 0])).toEqual([0, 0, 0, 0]);
  });
});
