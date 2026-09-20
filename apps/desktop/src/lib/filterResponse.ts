import type { ChannelEq, CrossoverFilterType, CrossoverSlot, EqBand } from "./bindings";

/** Rendering-only — freq/gain/Q are sample-rate-independent as persisted;
 * this only affects the digital-biquad math used to draw the curve. */
const SAMPLE_RATE_HZ = 48000;

/** Fixed Q for a 2nd-order Butterworth stage (maximally flat passband). */
const BUTTERWORTH_2ND_ORDER_Q = Math.SQRT1_2;
/** Fixed Q for a 2nd-order Bessel stage (maximally flat group delay). */
const BESSEL_2ND_ORDER_Q = 0.5773502691896258;

type BiquadCoeffs = { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number };

/** RBJ "Audio EQ Cookbook" 2nd-order low-pass biquad. */
function lpfCoeffs(freqHz: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: (1 - cosw0) / 2,
    b1: 1 - cosw0,
    b2: (1 - cosw0) / 2,
    a0: 1 + alpha,
    a1: -2 * cosw0,
    a2: 1 - alpha,
  };
}

/** RBJ "Audio EQ Cookbook" 2nd-order high-pass biquad. */
function hpfCoeffs(freqHz: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: (1 + cosw0) / 2,
    b1: -(1 + cosw0),
    b2: (1 + cosw0) / 2,
    a0: 1 + alpha,
    a1: -2 * cosw0,
    a2: 1 - alpha,
  };
}

/** RBJ "Audio EQ Cookbook" peaking EQ biquad. */
function peakingCoeffs(freqHz: number, gainDb: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a = 10 ** (gainDb / 40);
  return {
    b0: 1 + alpha * a,
    b1: -2 * cosw0,
    b2: 1 - alpha * a,
    a0: 1 + alpha / a,
    a1: -2 * cosw0,
    a2: 1 - alpha / a,
  };
}

/** RBJ "Audio EQ Cookbook" low-shelf biquad, Q-parameterized (RBJ's
 * alpha = sin(w0)/(2Q) form, valid whenever Q is given instead of the
 * shelf-slope parameter S). */
function lowShelfCoeffs(freqHz: number, gainDb: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a = 10 ** (gainDb / 40);
  const sqrtA = Math.sqrt(a);
  const twoSqrtAAlpha = 2 * sqrtA * alpha;
  return {
    b0: a * (a + 1 - (a - 1) * cosw0 + twoSqrtAAlpha),
    b1: 2 * a * (a - 1 - (a + 1) * cosw0),
    b2: a * (a + 1 - (a - 1) * cosw0 - twoSqrtAAlpha),
    a0: a + 1 + (a - 1) * cosw0 + twoSqrtAAlpha,
    a1: -2 * (a - 1 + (a + 1) * cosw0),
    a2: a + 1 + (a - 1) * cosw0 - twoSqrtAAlpha,
  };
}

/** RBJ "Audio EQ Cookbook" high-shelf biquad, Q-parameterized (see
 * `lowShelfCoeffs`). */
function highShelfCoeffs(freqHz: number, gainDb: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a = 10 ** (gainDb / 40);
  const sqrtA = Math.sqrt(a);
  const twoSqrtAAlpha = 2 * sqrtA * alpha;
  return {
    b0: a * (a + 1 + (a - 1) * cosw0 + twoSqrtAAlpha),
    b1: -2 * a * (a - 1 + (a + 1) * cosw0),
    b2: a * (a + 1 + (a - 1) * cosw0 - twoSqrtAAlpha),
    a0: a + 1 - (a - 1) * cosw0 + twoSqrtAAlpha,
    a1: 2 * (a - 1 - (a + 1) * cosw0),
    a2: a + 1 - (a - 1) * cosw0 - twoSqrtAAlpha,
  };
}

/** |H(e^jw)| in dB for a digital biquad, evaluated directly on the unit
 * circle — no a0 pre-normalization needed, since num/den are both evaluated
 * with the same (possibly unnormalized) coefficients and the ratio is
 * invariant to that. */
function biquadMagnitudeDb(coeffs: BiquadCoeffs, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const numRe = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2;
  const numIm = -coeffs.b1 * sin1 - coeffs.b2 * sin2;
  const denRe = coeffs.a0 + coeffs.a1 * cos1 + coeffs.a2 * cos2;
  const denIm = -coeffs.a1 * sin1 - coeffs.a2 * sin2;

  const magNum = Math.hypot(numRe, numIm);
  const magDen = Math.hypot(denRe, denIm);
  return 20 * Math.log10(magNum / magDen);
}

/** Simple analog-approximation magnitude for a 1st-order (6dB/oct) stage —
 * used only by `butterworth18` (odd order: one real-pole stage + one 2nd
 * order stage) and `linkwitzRiley12` (two cascaded real-pole stages). No
 * digital bilinear transform needed for a monotonic 1st-order shape at
 * these low orders; analog and digital responses coincide closely enough
 * for graphing purposes here. */
function firstOrderLpfDb(cutoffHz: number, freqHz: number): number {
  const ratio = freqHz / cutoffHz;
  return -10 * Math.log10(1 + ratio * ratio);
}
function firstOrderHpfDb(cutoffHz: number, freqHz: number): number {
  const ratio = freqHz / cutoffHz;
  return 20 * Math.log10(ratio) - 10 * Math.log10(1 + ratio * ratio);
}

type Stage = { order: 1 } | { order: 2; q: number };

/** Standard Butterworth pole-pair Q formula for an even order N:
 * Q_k = 1 / (2*cos((2k-1)*pi / (2N))), k = 1..N/2. Odd order 3 (only
 * `butterworth18`) uses the tabulated one-real-pole + one Q=1.0 stage
 * decomposition instead of the even-order formula. */
function butterworthStages(order: number): Stage[] {
  if (order === 1) return [{ order: 1 }];
  if (order === 3) return [{ order: 1 }, { order: 2, q: 1.0 }];
  if (order % 2 !== 0) throw new Error(`unsupported odd butterworth order ${order}`);
  const stages: Stage[] = [];
  for (let k = 1; k <= order / 2; k++) {
    const q = 1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order)));
    stages.push({ order: 2, q });
  }
  return stages;
}

/** Published per-stage Q approximations for Bessel filters (maximally-flat
 * group delay) — different references normalize Bessel poles slightly
 * differently; these are commonly-published values, worth a second look
 * against a canonical Bessel pole table if the crossover shape looks off. */
const BESSEL_STAGE_QS: Record<number, number[]> = {
  2: [0.5773],
  4: [0.5219, 0.8055],
  8: [0.506, 0.5596, 0.7109, 1.2258],
};
function besselStages(order: number): Stage[] {
  const qs = BESSEL_STAGE_QS[order];
  if (!qs) throw new Error(`unsupported bessel order ${order}`);
  return qs.map((q): Stage => ({ order: 2, q }));
}

/** Linkwitz-Riley LR-N = cascade of two identical Butterworth filters, each
 * half the total order — the defining construction (phase-coherent, flat
 * sum at the crossover point). This is why the enum only has 12/24/48 (an
 * even total order), never 18/36. */
function linkwitzRileyStages(totalOrder: number): Stage[] {
  const half = butterworthStages(totalOrder / 2);
  return [...half, ...half];
}

function crossoverStages(filterType: CrossoverFilterType): Stage[] {
  switch (filterType) {
    case "butterworth12":
      return butterworthStages(2);
    case "butterworth18":
      return butterworthStages(3);
    case "butterworth24":
      return butterworthStages(4);
    case "butterworth36":
      return butterworthStages(6);
    case "butterworth48":
      return butterworthStages(8);
    case "bessel12":
      return besselStages(2);
    case "bessel24":
      return besselStages(4);
    case "bessel48":
      return besselStages(8);
    case "linkwitzRiley12":
      return linkwitzRileyStages(2);
    case "linkwitzRiley24":
      return linkwitzRileyStages(4);
    case "linkwitzRiley48":
      return linkwitzRileyStages(8);
  }
}

/** Magnitude in dB of one HP or LP crossover slot at `freqHz`. Bypassed
 * slots (`active: false`) contribute 0dB. Otherwise sums every cascaded
 * stage's own magnitude — exact for a series cascade (see
 * `compositeResponseDb`). No per-slot `q`: Q is entirely implied by
 * `filterType` (baked into each stage by `crossoverStages`), never an
 * independent user-settable value — confirmed against the old app's
 * reference UI. */
function crossoverMagnitudeDb(slot: CrossoverSlot, kind: "hp" | "lp", freqHz: number): number {
  if (!slot.active) return 0;
  const cutoffHz = slot.freqHz ?? (kind === "hp" ? 20 : 20000);

  const stages = crossoverStages(slot.filterType);
  let totalDb = 0;
  for (const stage of stages) {
    if (stage.order === 1) {
      totalDb += kind === "hp" ? firstOrderHpfDb(cutoffHz, freqHz) : firstOrderLpfDb(cutoffHz, freqHz);
    } else {
      const coeffs = kind === "hp" ? hpfCoeffs(cutoffHz, stage.q) : lpfCoeffs(cutoffHz, stage.q);
      totalDb += biquadMagnitudeDb(coeffs, freqHz);
    }
  }
  return totalDb;
}

/** Magnitude in dB of one parametric band at `freqHz`. Inactive bands
 * contribute 0dB (bypassed). All-pass filters are always exactly 0dB at
 * every frequency by definition (unity magnitude, phase-only) — no biquad
 * evaluation needed. */
function eqBandMagnitudeDb(band: EqBand, freqHz: number): number {
  if (!band.active) return 0;
  const bandFreqHz = band.freqHz ?? 1000;
  const gainDb = band.gainDb ?? 0;
  const q = band.q ?? 1;
  switch (band.filterType) {
    case "peaking":
      return biquadMagnitudeDb(peakingCoeffs(bandFreqHz, gainDb, q), freqHz);
    case "lowShelf":
      return biquadMagnitudeDb(lowShelfCoeffs(bandFreqHz, gainDb, q), freqHz);
    case "highShelf":
      return biquadMagnitudeDb(highShelfCoeffs(bandFreqHz, gainDb, q), freqHz);
    case "allPass1st":
    case "allPass2nd":
      return 0;
    case "generalLow":
      return biquadMagnitudeDb(lpfCoeffs(bandFreqHz, q), freqHz);
    case "generalHigh":
      return biquadMagnitudeDb(hpfCoeffs(bandFreqHz, q), freqHz);
    case "butterworthLow":
      return biquadMagnitudeDb(lpfCoeffs(bandFreqHz, BUTTERWORTH_2ND_ORDER_Q), freqHz);
    case "butterworthHigh":
      return biquadMagnitudeDb(hpfCoeffs(bandFreqHz, BUTTERWORTH_2ND_ORDER_Q), freqHz);
    case "besselLow":
      return biquadMagnitudeDb(lpfCoeffs(bandFreqHz, BESSEL_2ND_ORDER_Q), freqHz);
    case "besselHigh":
      return biquadMagnitudeDb(hpfCoeffs(bandFreqHz, BESSEL_2ND_ORDER_Q), freqHz);
  }
}

/** Composite response in dB at `freqHz` for a full HP -> 8 bands -> LP
 * chain. Exact, not approximate: the signal path is a series cascade, so
 * the total transfer function is the *product* of each stage's linear
 * response, and 20*log10|A*B| = 20*log10|A| + 20*log10|B| — summing each
 * stage's dB value directly is mathematically equivalent to multiplying the
 * linear magnitudes first. (Would not be valid for a parallel-mix
 * topology, which this isn't.) */
export function compositeResponseDb(eq: ChannelEq, freqHz: number): number {
  let db = crossoverMagnitudeDb(eq.hp, "hp", freqHz);
  for (const band of eq.bands) {
    db += eqBandMagnitudeDb(band, freqHz);
  }
  db += crossoverMagnitudeDb(eq.lp, "lp", freqHz);
  return db;
}

export interface ResponsePoint {
  freqHz: number;
  db: number;
}

/** Identifies one of the 10 chain stages a `ChannelEq` holds — `hp`/`lp`
 * (a `CrossoverSlot`, no gain/Q) or a parametric `band` by its 0-7 index
 * into `ChannelEq.bands` (an `EqBand`, the same index `setEqBand` takes).
 * `ChannelEq` is deliberately not a uniform 10-element array (unlike the old
 * app's `EqBand[]`) since crossover slots and parametric bands are
 * structurally different types — this ref lets callers name "which stage"
 * without re-deriving that branch at every call site. */
export type EqStageRef = { kind: "hp" } | { kind: "lp" } | { kind: "band"; bandIndex: number };

/** Samples `numPoints` log-spaced frequencies across the audible range
 * (20Hz-20kHz) and evaluates `fn` at each — shared by `buildResponseCurve`
 * (composite chain) and `buildBandResponseCurve` (one isolated stage). */
function sampleLogCurve(fn: (freqHz: number) => number, numPoints: number): ResponsePoint[] {
  const minHz = 20;
  const maxHz = 20000;
  const logMin = Math.log10(minHz);
  const logMax = Math.log10(maxHz);
  const points: ResponsePoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);
    const freqHz = 10 ** (logMin + t * (logMax - logMin));
    points.push({ freqHz, db: fn(freqHz) });
  }
  return points;
}

/** 800 points (not fewer) so steep slopes (e.g. a 48dB/oct 8th-order
 * crossover's transition, which can span under an octave) still render as a
 * crisp, mathematically faithful curve instead of visibly under-sampled
 * straight-line segments. */
export function buildResponseCurve(eq: ChannelEq, numPoints = 800): ResponsePoint[] {
  return sampleLogCurve((freqHz) => compositeResponseDb(eq, freqHz), numPoints);
}

/** Isolated single-stage response — the composite curve's one term for
 * `ref` evaluated alone, all other stages excluded. Lets the EQ graph
 * overlay "what is *this* band doing on its own" distinct from the summed
 * composite curve, which is hard to read apart once multiple bands overlap
 * in frequency. `crossoverMagnitudeDb`/`eqBandMagnitudeDb` stay
 * module-private — this is the only exported way to evaluate one stage. */
export function buildBandResponseCurve(eq: ChannelEq, ref: EqStageRef, numPoints = 800): ResponsePoint[] {
  const fn =
    ref.kind === "hp"
      ? (freqHz: number) => crossoverMagnitudeDb(eq.hp, "hp", freqHz)
      : ref.kind === "lp"
        ? (freqHz: number) => crossoverMagnitudeDb(eq.lp, "lp", freqHz)
        : (freqHz: number) => eqBandMagnitudeDb(eq.bands[ref.bandIndex], freqHz);
  return sampleLogCurve(fn, numPoints);
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
 * log-spaced frequencies as `buildResponseCurve` so both can be drawn against
 * one frequency axis. `taps` must already be coalesced to numbers — specta
 * types the wire coefficients as `(number | null)[]`. */
export function buildFirResponseCurve(
  taps: number[],
  sampleRateHz: number,
  floorDb: number,
  numPoints = 800,
): ResponsePoint[] {
  return sampleLogCurve((freqHz) => firMagnitudeDb(taps, freqHz, sampleRateHz, floorDb), numPoints);
}
