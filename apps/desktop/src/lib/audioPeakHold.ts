/** Peak-hold ("peak indicator") state for a level meter — the slow-falling
 * marker that catches a transient the fast bar has already dropped away
 * from, so a brief overshoot stays readable for a moment instead of
 * flickering past between two frames.
 *
 * Values are in **dB** throughout: the hold ceiling, the decay rate, and the
 * floor. That matters for the decay, which is measured in dB (the way
 * hardware PPM ballistics are specified) rather than in amplitude — an
 * amplitude-linear fall looks like it drops instantly at the top of the
 * scale and crawls at the bottom.
 *
 * The fall is a constant rate — a straight line in dB, no easing.
 *
 * This is the classic hold-then-decay meter ballistic, NOT an exact
 * sliding-window maximum. The difference shows only while the peak is
 * decaying: a true windowed max would snap down to the highest value still
 * inside the window the instant the old peak aged out, whereas this ramps
 * down from wherever it was. The ramp is the point (an instant snap is what
 * the peak indicator exists to avoid), and it buys O(1) time and zero
 * allocation per update — an exact windowed max needs a monotonic deque of
 * every sample still in the window, allocating and scanning per push, per
 * meter, per frame.
 */

/** Deliberately >= the CVR heartbeat interval (~2s, see `driver.rs`): the
 * hold has to outlast the gap between readings or it expires in every gap,
 * and the indicator spends the tail of each one sliding to the floor before
 * the next reading snaps it back up. A meter fed from a packet every 2s can
 * only hold a peak *across* refreshes, never between frames. Raise this
 * alongside any change to the poll rate. */
export const DEFAULT_HOLD_MS = 2000;
/** ≈ the IEC 60268-10 PPM return rate (20 dB in ~1.7s), and slow enough to
 * stay readable next to a bar that redraws every frame. */
export const DEFAULT_DECAY_DB_PER_SECOND = 20;
/** Matches the meter floor used across the Configure tabs. */
export const DEFAULT_FLOOR_DB = -60;

export interface PeakHoldOptions {
  /** How long the peak sits still before it starts falling. */
  holdMs?: number;
  /** Constant fall rate once the hold expires. */
  decayDbPerSecond?: number;
  /** Bottom of the scale — the peak never decays below this. */
  floorDb?: number;
}

export interface PeakHold {
  /** Feeds a new reading and returns the peak-hold value for `nowMs`. A
   * `null` reading (no signal, or no telemetry at all) doesn't re-arm the
   * hold — it just lets the existing peak keep decaying, so the indicator
   * finishes its fall instead of freezing where the signal stopped. */
  push(valueDb: number | null, nowMs: number): number;
  /** Advances decay to `nowMs` and returns the peak-hold value, without
   * feeding a reading. This is what an animation frame calls. */
  read(nowMs: number): number;
  /** Drops the peak back to the floor and disarms the hold. */
  reset(): void;
  readonly floorDb: number;
}

/** Creates one meter's peak-hold tracker. Stateful and single-owner: each
 * meter needs its own, since the state is that meter's peak.
 *
 * Both `push` and `read` are O(1) with no allocation, and the caller drives
 * the clock (`nowMs`) rather than the tracker reading it — so the animation
 * frame's own timestamp can be passed straight through, and the behaviour is
 * deterministic to test.
 */
export function createPeakHold(options: PeakHoldOptions = {}): PeakHold {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  const decayDbPerMs = (options.decayDbPerSecond ?? DEFAULT_DECAY_DB_PER_SECOND) / 1000;
  const floorDb = options.floorDb ?? DEFAULT_FLOOR_DB;

  let peakDb = floorDb;
  /** Timestamp the hold expires at — also the instant the fall starts from,
   * so the hold window is never charged as fall time. */
  let holdUntilMs = 0;
  /** Height the current fall began at. Fixed when the hold is armed, so the
   * fall always has a stable origin to interpolate from. */
  let fallFromDb = floorDb;

  function read(nowMs: number): number {
    if (nowMs <= holdUntilMs) {
      peakDb = fallFromDb;
      return peakDb;
    }
    const distanceDb = fallFromDb - floorDb;
    if (distanceDb <= 0) {
      peakDb = floorDb;
      return peakDb;
    }
    // Position is a pure function of (origin, start time, now) rather than a
    // running subtraction, so calling this twice for the same instant — which
    // `push` and the animation frame routinely do — can't advance the fall
    // twice, and no error accumulates over a long fall.
    const durationMs = distanceDb / decayDbPerMs;
    const progress = Math.min(1, (nowMs - holdUntilMs) / durationMs);
    peakDb = fallFromDb - distanceDb * progress;
    return peakDb;
  }

  return {
    floorDb,
    read,
    push(valueDb, nowMs) {
      // Decay first, then compare: a reading that merely matches the
      // already-decayed peak still re-arms the hold, which is what makes a
      // sustained signal hold its indicator steady rather than letting it
      // creep down underneath the bar.
      read(nowMs);
      if (valueDb !== null && valueDb >= peakDb) {
        peakDb = valueDb;
        fallFromDb = valueDb;
        holdUntilMs = nowMs + holdMs;
      }
      return peakDb;
    },
    reset() {
      peakDb = floorDb;
      fallFromDb = floorDb;
      holdUntilMs = 0;
    },
  };
}
