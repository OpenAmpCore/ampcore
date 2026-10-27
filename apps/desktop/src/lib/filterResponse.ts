import { useEffect, useState } from "react";
import { commands, type EqStageRef } from "./bindings";

export type { EqStageRef };

/** specta types the command's f64s as `number | null`; the math never
 * produces null, so the curve is handled as plain numbers from here on. */
export interface ResponsePoint {
  freqHz: number;
  db: number;
}

/** An FIR filter's magnitude response from core (`fir_response_curve`), on
 * the EQ curve's frequency axis so the two can be summed point by point.
 * `null` until the first reply. */
export function useFirResponseCurve(
  taps: number[] | null,
  sampleRateHz: number,
  floorDb: number,
  points: number,
): ResponsePoint[] | null {
  const [curve, setCurve] = useState<ResponsePoint[] | null>(null);
  useEffect(() => {
    if (!taps) return setCurve(null);
    let cancelled = false;
    void commands.firResponseCurve(taps, sampleRateHz, floorDb, points).then((reply) => {
      if (!cancelled) setCurve(reply as ResponsePoint[]);
    });
    return () => {
      cancelled = true;
    };
  }, [taps, sampleRateHz, floorDb, points]);
  return curve;
}
