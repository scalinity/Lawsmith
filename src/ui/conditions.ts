// The conditions the instrument must show whether or not the developer readout is open (SPEC §5.4, §16):
// births skipped at the live-body limit, the acceleration limiter acting, and simulated time running
// slower than real time while playing. Each line is derived from the host's own counters and the frames
// actually played; nothing here changes the simulation.

/** Continuous play this long, measured in presented frames, before a slowdown counts as sustained. */
export const SUSTAINED_MS = 2000;
/** Below this simulated/wall ratio over that window, play is visibly slower than real time. */
export const SLOW_RATIO = 0.95;

/** Simulated time against wall time over the most recent continuous play; paused frames never count. */
export class PlayPace {
  private frames: { ms: number; steps: number }[] = [];
  private totalMs = 0;
  private totalSteps = 0;

  constructor(private readonly stepMs: number) {}

  /** One presented frame: its interval, the steps it advanced, and whether play was running through it. */
  frame(intervalMs: number, steps: number, playing: boolean): void {
    if (!playing) {
      this.frames = [];
      this.totalMs = this.totalSteps = 0;
      return;
    }
    this.frames.push({ ms: intervalMs, steps });
    this.totalMs += intervalMs;
    this.totalSteps += steps;
    while (this.frames.length > 1 && this.totalMs - this.frames[0]!.ms >= SUSTAINED_MS) {
      const old = this.frames.shift()!;
      this.totalMs -= old.ms;
      this.totalSteps -= old.steps;
    }
  }

  /** The ratio once a full window of continuous play exists; null before that and whenever paused. */
  ratio(): number | null {
    return this.totalMs >= SUSTAINED_MS ? (this.totalSteps * this.stepMs) / this.totalMs : null;
  }
}

export interface ConditionState {
  /** Scheduled births skipped at the live-body limit since the run's root (the host's counter). */
  skippedBirths: number;
  /** Body-steps the limiter scaled since the previous refresh. */
  newlyLimited: number;
  /** PlayPace.ratio(). */
  pace: number | null;
}

/** Ordinary-language lines for the conditions present now; empty when none is. */
export function conditionLines(s: ConditionState): string[] {
  const lines: string[] = [];
  if (s.skippedBirths > 0) {
    const n = s.skippedBirths;
    lines.push(`${n} ${n === 1 ? 'birth' : 'births'} skipped: the scene already has as many moving bodies as it allows.`);
  }
  if (s.newlyLimited > 0) lines.push('Acceleration limit reached: laws are scaled down. Click a body to see by how much.');
  if (s.pace !== null && s.pace < SLOW_RATIO) lines.push(`Running at ${s.pace.toFixed(2)}× real time: the scene needs more than this Mac can compute each frame.`);
  return lines;
}
