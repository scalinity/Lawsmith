import type { StoredFrame } from '../simulation/comparison';
/** Equal-tick comparison by stable identity; an absent counterpart has no invented position. */
export function pairedBody(id: string, a: StoredFrame | null, b: { readonly tick: number; readonly ids: readonly string[]; readonly positions: Float32Array }) {
  if (a && a.tick !== b.tick) throw new Error('Body comparison requires equal ticks.');
  const ai = a?.ids.indexOf(id) ?? -1;
  const bi = b.ids.indexOf(id);
  const position = (v: Float32Array, at: number) => Object.freeze([v[at]!, v[at + 1]!, v[at + 2]!]);
  const baseline = ai < 0 ? null : position(a!.poses, ai * 7);
  const alternate = bi < 0 ? null : position(b.positions, bi * 3);
  return Object.freeze({ id, tick: b.tick, baseline, alternate, separation: baseline && alternate ? Math.hypot(...baseline.map((v, i) => v - alternate[i]!)) : null });
}
