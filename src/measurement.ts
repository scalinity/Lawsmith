// SPEC §18.2 measurement helpers. Performance timestamps are never simulation inputs.

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The value at rank floor(p·n) of an ascending sample. */
export const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

/** p50, p95, p99 and max of a sample; null when nothing was measured, so absence never reads as zero. */
export function percentiles(values: readonly number[]): number[] | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return [0.5, 0.95, 0.99].map((p) => round3(percentile(sorted, p))).concat(round3(sorted[sorted.length - 1]!));
}

/**
 * Accepted edit → first submitted frame containing its applied revision. Only revisions the host
 * acknowledged are measured. A revision a newer put replaced before its boundary never appears in
 * a frame, so it is counted as superseded instead of being timed against someone else's frame.
 */
export class EditLatency {
  /** Revisions coalesced away before reaching the host's laws. */
  superseded = 0;
  private readonly pending: { revision: number; acceptedAt: number }[] = [];
  private readonly acknowledged = new Set<number>();

  accept(revision: number, acceptedAt: number): void {
    this.pending.push({ revision, acceptedAt });
  }

  acknowledge(revision: number): void {
    this.acknowledged.add(revision);
  }

  /** A frame containing every revision up to `appliedRevision` was submitted; returns the new latencies. */
  frameSubmitted(appliedRevision: number, submittedAt: number): number[] {
    const samples: number[] = [];
    while (this.pending.length && this.pending[0]!.revision <= appliedRevision) {
      const { revision, acceptedAt } = this.pending.shift()!;
      if (this.acknowledged.delete(revision)) samples.push(submittedAt - acceptedAt);
      else this.superseded += 1;
    }
    return samples;
  }
}
