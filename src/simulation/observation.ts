// Selected-body transition observations (SPEC §9.1, §12): what the host submitted for one body
// over one transition n → n+1, kept to explain it. An observation is telemetry. It never enters the
// canonical state, the engine, a run root, a scene file or command scheduling.
import type { FieldDefinition, Vec3 } from '../domain/scene';

/** One law's part of a submitted external acceleration, under the transition's shared β and λ. */
export interface LawContribution {
  readonly id: string;
  /** The law's sampled drive A_i at the body's center, m/s². */
  readonly drive: Vec3;
  /** The law's sampled drag rate K_i, s⁻¹. */
  readonly drag: number;
  /** λβ(A_i − K_i·v), m/s². An algebraic share of the total, not the effect of removing the law. */
  readonly applied: Vec3;
}

export interface TransitionObservation {
  /** `applied`: retained from a completed transition. `preview`: what the next transition would submit now. */
  readonly kind: 'applied' | 'preview';
  readonly bodyId: string;
  readonly fromTick: number;
  readonly toTick: number;
  /** Command cursor at boundary fromTick, after its commands settled: `laws` are exactly the ones applied. */
  readonly cursor: number;
  readonly laws: readonly FieldDefinition[];
  /** The body's center x and velocity v at fromTick, as the host read them before sampling. */
  readonly center: Vec3;
  readonly velocity: Vec3;
  /** Engine-reported mass, kg. */
  readonly mass: number;
  /** Ambient gravity g, m/s². */
  readonly gravity: Vec3;
  /** A = g + ΣA_i, m/s², and K = ΣK_i, s⁻¹. */
  readonly drive: Vec3;
  readonly drag: number;
  /** β(Kh) and λ, shared by every contribution. */
  readonly beta: number;
  readonly lambda: number;
  readonly maxApplied: number;
  /** A − K·v: the instantaneous external acceleration, before β and λ, m/s². */
  readonly instantaneous: Vec3;
  /** λ·a*: the submitted external acceleration, m/s². */
  readonly submitted: Vec3;
  /** mass·λ·a*, the force the host added for the step, N. */
  readonly force: Vec3;
  /** λβ·g, m/s². */
  readonly gravityApplied: Vec3;
  /** In stable law order. Together with `gravityApplied` they sum to `submitted`. */
  readonly contributions: readonly LawContribution[];
  /** Applied only: center and velocity at toTick, after the engine step, contacts included. */
  readonly after: { readonly center: Vec3; readonly velocity: Vec3 } | null;
  /** Applied only: stable IDs of the bodies whose contact with this one carried a normal impulse in the step. */
  readonly contacts: readonly string[] | null;
}

/** What the host read and computed for one body at one boundary. */
export interface SampledTransition {
  readonly kind: TransitionObservation['kind'];
  readonly bodyId: string;
  readonly fromTick: number;
  readonly cursor: number;
  readonly laws: readonly FieldDefinition[];
  readonly gravity: Vec3;
  readonly maxApplied: number;
  /** Center [0..2], velocity [3..5]. */
  readonly state: ArrayLike<number>;
  /** A_i in [4i..4i+2] and K_i in [4i+3], one entry per law in `laws`. */
  readonly samples: ArrayLike<number>;
  /** The adapter's output: λ·a* in [0..2], β in [3], λ in [4]. */
  readonly adapted: ArrayLike<number>;
  readonly mass: number;
  /** The force exactly as submitted. */
  readonly force: Vec3;
  readonly after: TransitionObservation['after'];
  readonly contacts: TransitionObservation['contacts'];
}

const v3 = (a: ArrayLike<number>, i: number): Vec3 => [a[i]!, a[i + 1]!, a[i + 2]!];

/** Builds an observation from one boundary's samples, decomposing it with that boundary's own β and λ. */
export function observeTransition(s: SampledTransition): TransitionObservation {
  const center = v3(s.state, 0);
  const velocity = v3(s.state, 3);
  const beta = s.adapted[3]!;
  const lambda = s.adapted[4]!;
  const factor = lambda * beta;
  const drive = [...s.gravity];
  let drag = 0;
  const contributions = s.laws.map((law, i): LawContribution => {
    const a = v3(s.samples, 4 * i);
    const k = s.samples[4 * i + 3]!;
    for (let c = 0; c < 3; c++) drive[c]! += a[c]!;
    drag += k;
    return { id: law.id, drive: a, drag: k, applied: [factor * (a[0] - k * velocity[0]), factor * (a[1] - k * velocity[1]), factor * (a[2] - k * velocity[2])] };
  });
  return {
    kind: s.kind,
    bodyId: s.bodyId,
    fromTick: s.fromTick,
    toTick: s.fromTick + 1,
    cursor: s.cursor,
    laws: s.laws,
    center,
    velocity,
    mass: s.mass,
    gravity: s.gravity,
    drive: drive as unknown as Vec3,
    drag,
    beta,
    lambda,
    maxApplied: s.maxApplied,
    instantaneous: [drive[0]! - drag * velocity[0], drive[1]! - drag * velocity[1], drive[2]! - drag * velocity[2]],
    submitted: v3(s.adapted, 0),
    force: s.force,
    gravityApplied: [factor * s.gravity[0], factor * s.gravity[1], factor * s.gravity[2]],
    contributions,
    after: s.after,
    contacts: s.contacts,
  };
}
