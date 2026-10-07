import { useEffect, useRef, useState } from "react";
import { commands, type ChannelEq, type EqStageRef } from "./bindings";

export type { EqStageRef };

/** specta types the command's f64s as `number | null`; the math never
 * produces null, so the curve is handled as plain numbers from here on. */
export interface ResponsePoint {
  freqHz: number;
  db: number;
}

/** What `useResponseCurves` hands back: both curves and the exact chain and
 * stage they were computed for, so a caller can draw everything else (the
 * graph's handles) from the same snapshot and never be a frame ahead of it. */
export interface ResponseCurves {
  eq: ChannelEq;
  stage: EqStageRef | null;
  total: ResponsePoint[];
  /** `stage` on its own; `null` without a stage. */
  isolated: ResponsePoint[] | null;
}

/** EQ chain response from core's `filter_response` (shared with mobile) —
 * the whole chain and, when `stage` is given, that stage isolated. Both arrive
 * in one state update. Async over IPC, so the last curves stay drawn while the
 * next are in flight, and a slower stale reply never overwrites a newer one. */
export function useResponseCurves(eq: ChannelEq, stage: EqStageRef | null, points: number): ResponseCurves | null {
  const [curves, setCurves] = useState<ResponseCurves | null>(null);
  const seq = useRef(0);
  const applied = useRef(0);
  const key = JSON.stringify([eq, stage, points]);
  useEffect(() => {
    const mine = ++seq.current;
    void Promise.all([
      commands.eqResponseCurve(eq, null, points),
      stage ? commands.eqResponseCurve(eq, stage, points) : null,
    ]).then(([total, isolated]) => {
      // Newer than what's drawn, not "the very latest": during a fast drag
      // every reply is already superseded by the time it lands.
      if (mine < applied.current) return;
      applied.current = mine;
      setCurves({ eq, stage, total: total as ResponsePoint[], isolated: isolated as ResponsePoint[] | null });
    });
    // `key` stands in for eq/stage: callers rebuild these objects every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return curves;
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
