import { useEffect, useMemo, useState } from "react";
import {
  createPeakHold,
  DEFAULT_DECAY_DB_PER_SECOND,
  DEFAULT_FLOOR_DB,
  DEFAULT_HOLD_MS,
  type PeakHoldOptions,
} from "../lib/audioPeakHold";

/** Smaller changes than this aren't worth a re-render — well under one
 * pixel of travel on any meter in this app. */
const RENDER_EPSILON_DB = 0.05;

/** Drives a `createPeakHold` tracker from a changing level and returns the
 * value to draw the peak indicator at, or `null` when there is nothing to
 * draw — `enabled` is false, or the peak itself has settled at the floor.
 *
 * The "nothing to draw" test is on the **peak**, never on the incoming
 * level. Those come apart exactly when the indicator matters most: a
 * transient followed by silence puts the bar at the floor while the peak is
 * still up high with a fall to finish. Gating on the level there would
 * delete the line mid-fall, which is the one moment it exists for.
 *
 * The animation frame loop runs only while the peak is actually above the
 * bar and stops itself the moment it lands on it. A meter at a steady level,
 * a silent one whose peak has finished falling, and a disabled one all cost
 * nothing per frame — which matters because these meters are per-channel and
 * every amp on screen has several.
 */
export function usePeakHold(
  valueDb: number | null,
  enabled: boolean,
  {
    holdMs = DEFAULT_HOLD_MS,
    decayDbPerSecond = DEFAULT_DECAY_DB_PER_SECOND,
    floorDb = DEFAULT_FLOOR_DB,
  }: PeakHoldOptions = {},
): number | null {
  const peakHold = useMemo(
    () => createPeakHold({ holdMs, decayDbPerSecond, floorDb }),
    [holdMs, decayDbPerSecond, floorDb],
  );
  const [peakDb, setPeakDb] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      peakHold.reset();
      setPeakDb(null);
      return;
    }

    // The bar's own position — once the indicator has fallen to it there is
    // no longer a separate line to animate.
    const barDb = valueDb ?? floorDb;
    let frame = 0;

    // `requestAnimationFrame` hands its callback a `performance.now()`-based
    // timestamp, so seeding the tracker from the same clock keeps every
    // interval it measures on one timeline.
    setPeakDb(peakHold.push(valueDb, performance.now()));

    const tick = (nowMs: number) => {
      const next = peakHold.read(nowMs);
      setPeakDb((prev) => (prev === null || Math.abs(prev - next) > RENDER_EPSILON_DB ? next : prev));
      frame = next > barDb + RENDER_EPSILON_DB ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, valueDb, peakHold, floorDb]);

  // A peak sitting at the bottom of the scale has nothing left to show, so
  // it reports as absent — this is what switches the line off for a silent
  // channel, once the fall has actually completed rather than the instant
  // the level hit the floor.
  return peakDb === null || peakDb <= floorDb ? null : peakDb;
}
