/** Power into `ohms` at voltage `v`: `P = V^2 / R`. Fed an RMS threshold it
 * is RMS power; fed a peak threshold, instantaneous peak power (not halved —
 * for a sine that is 2x the RMS power at the matching RMS voltage, e.g.
 * 60 Vrms / 84.85 Vpeak into 8 Ω is 450 W RMS / 900 W peak). */
export function powerWatts(v: number, ohms: number): number {
  return (v * v) / ohms;
}

/** Inverse of `powerWatts` — lets the Prms/Ppeak fields be edited
 * directly and back-solved to a voltage threshold, interchangeable with the
 * Threshold field rather than a read-only readout. */
export function voltageForPowerWatts(watts: number, ohms: number): number {
  return Math.sqrt(Math.max(0, watts) * ohms);
}

/** The Peak threshold's floor: at least double the RMS threshold's *power*,
 * capped at `peakMax` so the floor itself never exceeds what the model/range
 * allows. Since power scales with voltage squared (`P = V^2 / R`), doubling
 * power only requires the peak voltage to be `√2×` the RMS voltage, not
 * `2×` — `Vp = Vrms·√2` gives `Vp^2/R = 2·Vrms^2/R`, i.e. exactly double
 * the power, at any `R` (the load cancels out of the ratio). Matches the
 * original reference software's actual behavior (e.g. 63.25 Vrms / 500 W ↔
 * 89.44 Vpeak / 1000 W — a √2 voltage ratio, 2x power ratio) — an earlier
 * version of this floor used a literal 2x *voltage* multiplier, which
 * produces 4x power, not 2x. Shared by `patch()`'s async enforcement and
 * the sliders'/fields' `min` props so dragging or typing can't dip below
 * the floor in the first place, rather than only correcting it after the
 * fact. */
export function requiredPeakFloor(rmsVoltage: number, peakMax: number): number {
  return Math.min(rmsVoltage * PEAK_HEADROOM_FACTOR, peakMax);
}

/** Peak voltage capability assumed relative to an amp's rated RMS voltage —
 * used to auto-derive the Peak stage's max threshold from the same
 * per-model rating that caps the RMS stage, and shared by `requiredPeakFloor`
 * for the "Peak power must be at least double RMS power" floor (see its own
 * doc comment for why √2 — not 2 — is the correct voltage-domain factor for
 * a power-domain doubling). */
export const PEAK_HEADROOM_FACTOR = Math.SQRT2;
