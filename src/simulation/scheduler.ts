// SPEC §10.1 live scheduler. It decides how many fixed steps a presentation frame runs; it
// never changes h. Wall-clock observations only detect absence; they never reach the simulation.

/** At most this much elapsed time is admitted per frame. */
export const MAX_ADMITTED_MS = 100;
/** Backlog and per-frame execution limit, in fixed steps. */
export const MAX_STEPS_PER_FRAME = 8;
/** A frame or wall-clock gap above this pauses before stepping (sleep, suspension, stalls). */
export const GAP_PAUSE_MS = 1000;
/** Steps within this fraction of h count as due, so 60 Hz frames run 2 steps rather than alternating 1 and 3. */
const STEP_SNAP = 1e-3;

export interface FrameAdvance {
  /** Fixed steps to execute this frame, 0–8. */
  steps: number;
  /** True when this frame detected a gap and paused the scheduler. */
  gap: boolean;
  /** Wall-time debt discarded this frame, in ms. */
  droppedMs: number;
}

const IDLE: FrameAdvance = Object.freeze({ steps: 0, gap: false, droppedMs: 0 });

/** Execute the already calculated budget; callers report whether a physics step completed. */
export function driveScheduledFrame(scheduler: FixedStepScheduler, steps: number, step: () => boolean): number {
  let completed = 0;
  for (let i = 0; i < steps; i++) {
    if (!scheduler.playing) break;
    if (!step()) break;
    completed++;
  }
  return completed;
}

export class FixedStepScheduler {
  playing = false;
  /** Total discarded wall-time debt since construction, in ms. */
  droppedMs = 0;
  private accumulator = 0;
  private lastFrame: number | undefined;
  private lastWall: number | undefined;

  constructor(private readonly stepMs: number) {}

  /** Starts advancing from a fresh presentation timestamp; no earlier interval becomes simulated time. */
  play(): void {
    this.playing = true;
    this.accumulator = 0;
    this.lastFrame = undefined;
    this.lastWall = undefined;
  }

  /** Stops advancing and clears scheduling debt. */
  pause(): void {
    this.playing = false;
    this.accumulator = 0;
  }

  /**
   * Called once per presentation frame with its timestamp and the wall clock. The wall clock
   * catches system sleep, during which macOS's monotonic presentation clock does not advance.
   */
  frame(frameMs: number, wallMs: number): FrameAdvance {
    const elapsed = this.lastFrame === undefined ? 0 : frameMs - this.lastFrame;
    const wallElapsed = this.lastWall === undefined ? 0 : wallMs - this.lastWall;
    this.lastFrame = frameMs;
    this.lastWall = wallMs;
    if (!this.playing) return IDLE;
    if (elapsed > GAP_PAUSE_MS || Math.abs(wallElapsed) > GAP_PAUSE_MS) {
      this.pause();
      return { steps: 0, gap: true, droppedMs: 0 };
    }
    const admitted = Math.min(Math.max(elapsed, 0), MAX_ADMITTED_MS);
    let dropped = elapsed - admitted;
    this.accumulator += admitted;
    const backlog = MAX_STEPS_PER_FRAME * this.stepMs;
    if (this.accumulator > backlog) {
      dropped += this.accumulator - backlog;
      this.accumulator = backlog;
    }
    const steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.accumulator / this.stepMs + STEP_SNAP));
    this.accumulator -= steps * this.stepMs;
    if (dropped > 0) this.droppedMs += dropped;
    return { steps, gap: false, droppedMs: Math.max(dropped, 0) };
  }
}
