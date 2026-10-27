import { commands, type ChannelEq, type CrossoverFilterType, type CrossoverSlot, type EqBand, type EqStageRef } from "./bindings";
import type { ResponsePoint } from "./filterResponse";

/* The EQ chain's magnitude response, computed in the frame that draws it.
 *
 * ponytail: a line-for-line mirror of core's `data/filter_response.rs`, which
 * stays the reference (mobile draws from it, its unit tests cover the math).
 * It exists because a drag needs the curve every frame, and a Rust round
 * trip per frame is what made the graph trail the pointer. In dev builds
 * `checkAgainstCore` compares every committed chain with core and warns on
 * drift. Upgrade path if the two ever need to be one: compile the DSP into
 * WASM (split `filter_response` into a small crate core re-exports). */

const SAMPLE_RATE_HZ = 48000;
const BUTTERWORTH_2ND_ORDER_Q = Math.SQRT1_2;
const BESSEL_2ND_ORDER_Q = 0.5773502691896258;

type Biquad = { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number };

function w0Alpha(freqHz: number, q: number): [number, number] {
  const w0 = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  return [Math.cos(w0), Math.sin(w0) / (2 * q)];
}

/** RBJ "Audio EQ Cookbook" 2nd-order low-pass. */
function lpf(freqHz: number, q: number): Biquad {
  const [c, alpha] = w0Alpha(freqHz, q);
  return { b0: (1 - c) / 2, b1: 1 - c, b2: (1 - c) / 2, a0: 1 + alpha, a1: -2 * c, a2: 1 - alpha };
}

function hpf(freqHz: number, q: number): Biquad {
  const [c, alpha] = w0Alpha(freqHz, q);
  return { b0: (1 + c) / 2, b1: -(1 + c), b2: (1 + c) / 2, a0: 1 + alpha, a1: -2 * c, a2: 1 - alpha };
}

function peaking(freqHz: number, gainDb: number, q: number): Biquad {
  const [c, alpha] = w0Alpha(freqHz, q);
  const a = 10 ** (gainDb / 40);
  return { b0: 1 + alpha * a, b1: -2 * c, b2: 1 - alpha * a, a0: 1 + alpha / a, a1: -2 * c, a2: 1 - alpha / a };
}

/** RBJ shelves, Q-parameterized. */
function lowShelf(freqHz: number, gainDb: number, q: number): Biquad {
  const [c, alpha] = w0Alpha(freqHz, q);
  const a = 10 ** (gainDb / 40);
  const k = 2 * Math.sqrt(a) * alpha;
  return {
    b0: a * (a + 1 - (a - 1) * c + k),
    b1: 2 * a * (a - 1 - (a + 1) * c),
    b2: a * (a + 1 - (a - 1) * c - k),
    a0: a + 1 + (a - 1) * c + k,
    a1: -2 * (a - 1 + (a + 1) * c),
    a2: a + 1 + (a - 1) * c - k,
  };
}

function highShelf(freqHz: number, gainDb: number, q: number): Biquad {
  const [c, alpha] = w0Alpha(freqHz, q);
  const a = 10 ** (gainDb / 40);
  const k = 2 * Math.sqrt(a) * alpha;
  return {
    b0: a * (a + 1 + (a - 1) * c + k),
    b1: -2 * a * (a - 1 + (a + 1) * c),
    b2: a * (a + 1 + (a - 1) * c - k),
    a0: a + 1 - (a - 1) * c + k,
    a1: 2 * (a - 1 - (a + 1) * c),
    a2: a + 1 - (a - 1) * c - k,
  };
}

/** |H(e^jw)| in dB on the unit circle. */
function biquadDb(f: Biquad, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;
  const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  const num = Math.hypot(f.b0 + f.b1 * c1 + f.b2 * c2, -f.b1 * s1 - f.b2 * s2);
  const den = Math.hypot(f.a0 + f.a1 * c1 + f.a2 * c2, -f.a1 * s1 - f.a2 * s2);
  return 20 * Math.log10(num / den);
}

/** Analog 1st-order (6 dB/oct) magnitude; only `butterworth18` uses it. */
function firstOrderDb(hp: boolean, cutoffHz: number, freqHz: number): number {
  const r = freqHz / cutoffHz;
  const lp = -10 * Math.log10(1 + r * r);
  return hp ? 20 * Math.log10(r) + lp : lp;
}

/** `null` = a 1st-order stage, a number = a 2nd-order stage's Q. */
type Stage = number | null;

function butterworth(order: number): Stage[] {
  if (order === 1) return [null];
  if (order === 3) return [null, 1];
  return Array.from({ length: order / 2 }, (_, i) => 1 / (2 * Math.cos(((2 * (i + 1) - 1) * Math.PI) / (2 * order))));
}

function bessel(order: number): Stage[] {
  if (order === 2) return [0.5773];
  if (order === 4) return [0.5219, 0.8055];
  return [0.506, 0.5596, 0.7109, 1.2258];
}

function linkwitzRiley(order: number): Stage[] {
  const half = butterworth(order / 2);
  return [...half, ...half];
}

const CROSSOVER_STAGES: Record<CrossoverFilterType, Stage[]> = {
  butterworth12: butterworth(2),
  butterworth18: butterworth(3),
  butterworth24: butterworth(4),
  butterworth36: butterworth(6),
  butterworth48: butterworth(8),
  bessel12: bessel(2),
  bessel24: bessel(4),
  bessel48: bessel(8),
  linkwitzRiley12: linkwitzRiley(2),
  linkwitzRiley24: linkwitzRiley(4),
  linkwitzRiley48: linkwitzRiley(8),
};

/** One stage as a function of frequency, its coefficients computed once. */
type StageFn = (freqHz: number) => number;
const FLAT: StageFn = () => 0;

function crossoverFn(slot: CrossoverSlot, hp: boolean): StageFn {
  if (!slot.active) return FLAT;
  const cutoff = slot.freqHz ?? (hp ? 20 : 20000);
  const parts: StageFn[] = CROSSOVER_STAGES[slot.filterType].map((q) => {
    if (q === null) return (f) => firstOrderDb(hp, cutoff, f);
    const biquad = hp ? hpf(cutoff, q) : lpf(cutoff, q);
    return (f) => biquadDb(biquad, f);
  });
  return (f) => parts.reduce((sum, part) => sum + part(f), 0);
}

function bandFn(b: EqBand): StageFn {
  if (!b.active) return FLAT;
  const [freq, gain, q] = [b.freqHz ?? 1000, b.gainDb ?? 0, b.q ?? 1];
  let biquad: Biquad;
  switch (b.filterType) {
    case "peaking":
      biquad = peaking(freq, gain, q);
      break;
    case "lowShelf":
      biquad = lowShelf(freq, gain, q);
      break;
    case "highShelf":
      biquad = highShelf(freq, gain, q);
      break;
    case "allPass1st":
    case "allPass2nd":
      return FLAT;
    case "generalLow":
      biquad = lpf(freq, q);
      break;
    case "generalHigh":
      biquad = hpf(freq, q);
      break;
    case "butterworthLow":
      biquad = lpf(freq, BUTTERWORTH_2ND_ORDER_Q);
      break;
    case "butterworthHigh":
      biquad = hpf(freq, BUTTERWORTH_2ND_ORDER_Q);
      break;
    case "besselLow":
      biquad = lpf(freq, BESSEL_2ND_ORDER_Q);
      break;
    case "besselHigh":
      biquad = hpf(freq, BESSEL_2ND_ORDER_Q);
      break;
  }
  return (f) => biquadDb(biquad, f);
}

function stageFn(eq: ChannelEq, stage: EqStageRef | null): StageFn {
  if (stage?.kind === "hp") return crossoverFn(eq.hp, true);
  if (stage?.kind === "lp") return crossoverFn(eq.lp, false);
  if (stage?.kind === "band") {
    const band = eq.bands[stage.bandIndex];
    return band ? bandFn(band) : FLAT;
  }
  // A series cascade multiplies linear magnitudes, which is summing dB.
  const all = [crossoverFn(eq.hp, true), ...eq.bands.map(bandFn), crossoverFn(eq.lp, false)];
  return (f) => all.reduce((sum, fn) => sum + fn(f), 0);
}

/** `points` log-spaced samples over 20 Hz-20 kHz — the whole chain with
 * `stage: null`, one stage isolated otherwise (core's `response_curve`). */
export function responseCurve(eq: ChannelEq, stage: EqStageRef | null, points: number): ResponsePoint[] {
  const fn = stageFn(eq, stage);
  const n = Math.max(points, 2);
  const [lo, hi] = [Math.log10(20), Math.log10(20000)];
  return Array.from({ length: n }, (_, i) => {
    const freqHz = 10 ** (lo + ((hi - lo) * i) / (n - 1));
    return { freqHz, db: fn(freqHz) };
  });
}

/** Dev only: warns when this copy and core disagree on `eq` by more than
 * 0.01 dB anywhere — the guard that keeps the two from drifting apart. */
export function checkAgainstCore(eq: ChannelEq): void {
  if (!import.meta.env.DEV) return;
  const points = 120;
  const local = responseCurve(eq, null, points);
  void commands.eqResponseCurves(eq, null, points).then((core) => {
    const worst = core.total.reduce((max, p, i) => Math.max(max, Math.abs((p.db ?? 0) - local[i].db)), 0);
    if (worst > 0.01) console.warn(`EQ curve differs from core by ${worst.toFixed(3)} dB`, eq);
  });
}
