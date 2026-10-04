import { useEffect, useRef, useState } from "react";
import { commands, type ChannelEq, type EqStageRef } from "./bindings";

export type { EqStageRef };

/** specta types the command's f64s as `number | null`; the math never
 * produces null, so the curve is handled as plain numbers from here on. */
export interface ResponsePoint {
  freqHz: number;
  db: number;
}

/** EQ chain response from core's `filter_response` (shared with mobile) —
 * the whole chain, or one stage isolated when `stage` is given; `null` eq or
 * stage-less isolation returns `null`. Async over IPC, so the last curve stays
 * drawn while the next is in flight, and a slower stale reply never overwrites
 * a newer one. */
export function useResponseCurve(
  eq: ChannelEq | null,
  stage: EqStageRef | null = null,
  points: number | null = null,
): ResponsePoint[] | null {
  const [curve, setCurve] = useState<ResponsePoint[] | null>(null);
  const seq = useRef(0);
  const key = eq ? JSON.stringify([eq, stage, points]) : null;
  useEffect(() => {
    const mine = ++seq.current;
    if (!eq) return setCurve(null);
    void commands.eqResponseCurve(eq, stage, points).then((pts) => {
      if (mine === seq.current) setCurve(pts as ResponsePoint[]);
    });
    // `key` stands in for eq/stage: callers rebuild these objects every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return eq ? curve : null;
}

/** Samples `numPoints` log-spaced frequencies across 20Hz-20kHz — the same
 * axis core's EQ curve uses, so FIR and EQ curves share one graph. */
function sampleLogCurve(fn: (freqHz: number) => number, numPoints: number): ResponsePoint[] {
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  const points: ResponsePoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);
    const freqHz = 10 ** (logMin + t * (logMax - logMin));
    points.push({ freqHz, db: fn(freqHz) });
  }
  return points;
}

/** Magnitude in dB at `freqHz` of an FIR filter given its tap array — the
 * DTFT `|H(e^jw)|` at `w = 2*pi*f/fs`, evaluated directly rather than via an
 * FFT. Direct evaluation is the whole reason this can share the biquad
 * curves' frequency axis: an FFT yields linearly-spaced bins that would have
 * to be resampled onto the log sweep, which is both more code and coarsest
 * exactly where the log axis is densest (the low end).
 *
 * Zero taps are skipped rather than accumulated. The array is fixed-size and
 * zero-padded (see `FIR_MAX_TAPS`), and an amp with no filter loaded holds a
 * unit impulse, so this commonly skips all but one term. */
function firMagnitudeDb(
  taps: number[],
  freqHz: number,
  sampleRateHz: number,
  floorDb: number,
): number {
  const w = (2 * Math.PI * freqHz) / sampleRateHz;
  let re = 0;
  let im = 0;
  for (let n = 0; n < taps.length; n++) {
    const tap = taps[n];
    if (tap === 0) continue;
    const angle = w * n;
    re += tap * Math.cos(angle);
    im -= tap * Math.sin(angle);
  }
  const magnitude = Math.hypot(re, im);
  // A true null is magnitude 0 -> -Infinity, which would poison the SVG path
  // it ends up in, so the floor is applied here rather than at the renderer.
  return magnitude > 0 ? Math.max(floorDb, 20 * Math.log10(magnitude)) : floorDb;
}

/** Magnitude-response curve for an FIR tap array, sampled at the same
 * log-spaced frequencies as the EQ curve so both can be drawn against one
 * frequency axis. `taps` must already be coalesced to numbers — specta types
 * the wire coefficients as `(number | null)[]`. */
export function buildFirResponseCurve(
  taps: number[],
  sampleRateHz: number,
  floorDb: number,
  numPoints = 800,
): ResponsePoint[] {
  return sampleLogCurve((freqHz) => firMagnitudeDb(taps, freqHz, sampleRateHz, floorDb), numPoints);
}
