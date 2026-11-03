import type { AmpChannelState, Limiter, Telemetry } from "./bindings";
import type { VuMeterMark, VuMeterZone } from "../components/VuMeter";

/** One channel's slice of a heartbeat, with every field `null` when there's
 * no telemetry at all, when this channel is past the end of the packet's
 * arrays, or when the backend couldn't compute the value (`outputLevelDb`
 * stays `null` for a model with no known rated voltage — see
 * `telemetry.rs`). Callers render `null` as unlit/"—", never as `0`: a
 * fabricated zero reads as a real "silent, cold, 0V" measurement. */
export interface ChannelTelemetry {
  /** Input level in dB relative to 1V (NOT true dBFS — the wire adapter has
   * no calibrated full-scale reference, see `telemetry_v118.rs`). Labeled
   * "dBV" in the UI for that reason. */
  inputDbv: number | null;
  /** Output level in dB relative to the device's rated RMS voltage, so
   * `0dB` = rated max output. */
  outputLevelDb: number | null;
  outputVoltage: number | null;
  outputCurrent: number | null;
  /** The output has voltage but its current is too low for the amp to
   * measure, so `outputCurrent`'s 0 is not a real reading. */
  outputCurrentBelowRange: boolean;
  temperatureC: number | null;
  /** Limiter gain reduction, as a non-positive dB value (the wire carries
   * the magnitude; the reference implementation negates it the same way).
   * `0` means "not limiting" and is a real reading, not a placeholder. */
  gainReductionDb: number | null;
  /** This channel's output operating state, decoded by the backend. `null`
   * when there is no reading for this channel at all — see
   * `ChannelStateBadge`, which renders that as a dash rather than "Normal". */
  outputState: AmpChannelState | null;
  /** Raw wire value behind `outputState`, for the badge's tooltip. */
  outputStateRaw: number | null;
  /** Whether this input is clipping. Inputs have no operating state — the
   * heartbeat's per-input byte is the vendor's two-value `InputChState`, not
   * the output states' enum (see `Telemetry::input_clipping`). `null` when
   * there is no reading. */
  inputClipping: boolean | null;
  /** Raw `InStates` byte behind `inputClipping`, for the pill's tooltip. */
  inputStateRaw: number | null;
}

const NO_CHANNEL_TELEMETRY: ChannelTelemetry = {
  inputDbv: null,
  outputLevelDb: null,
  outputVoltage: null,
  outputCurrent: null,
  outputCurrentBelowRange: false,
  temperatureC: null,
  gainReductionDb: null,
  outputState: null,
  outputStateRaw: null,
  inputClipping: null,
  inputStateRaw: null,
};

function at(values: (number | null)[] | undefined, index: number): number | null {
  return values?.[index] ?? null;
}

/** Same "short array degrades to null" rule as `at`, for the decoded state
 * arrays — whose elements are already nullable when the backend had no state
 * table for the device's firmware. */
function stateAt(
  values: (AmpChannelState | null)[] | undefined,
  index: number,
): AmpChannelState | null {
  return values?.[index] ?? null;
}

/** `20*log10(v / reference)`, mirroring `live/dsp.rs`'s `voltage_to_db` —
 * including its refusal to produce a number for a non-positive voltage or
 * reference (log of zero is `-Infinity`, which would peg a meter at the
 * floor as if it were a real reading). */
function voltageToDb(voltage: number | null, referenceVolts: number | null): number | null {
  if (voltage === null || referenceVolts === null) return null;
  if (voltage <= 0 || referenceVolts <= 0) return null;
  return 20 * Math.log10(voltage / referenceVolts);
}

/** `ratedRmsVoltage` is the fallback dB reference for `outputLevelDb`, taken
 * from `capability.topology.ratedRmsVoltage` — i.e. the datasheet rating of
 * the model the user actually assigned to this device. The backend fills
 * `Telemetry.output_level_db` itself only when the device's factory firmware
 * string embeds a recognizable model designation
 * (`rated_rms_voltage_from_firmware_string`), which plenty of real units
 * don't; without this fallback their output meters sit dead at the floor
 * while V and A read fine. Both paths use the same datasheet table, so this
 * is a second route to a real rating, not a guessed default — with no model
 * assigned it stays `null` and the meter stays honestly unlit. */
export function channelTelemetry(
  telemetry: Telemetry | undefined,
  channelIndex: number,
  ratedRmsVoltage: number | null,
): ChannelTelemetry {
  if (!telemetry) return NO_CHANNEL_TELEMETRY;
  const gr = at(telemetry.limiters, channelIndex);
  const outputVoltage = at(telemetry.outputVoltages, channelIndex);
  return {
    inputDbv: at(telemetry.inputDbfs, channelIndex),
    outputLevelDb:
      at(telemetry.outputLevelDb, channelIndex) ??
      voltageToDb(outputVoltage, telemetry.ratedRmsVoltage ?? ratedRmsVoltage),
    outputVoltage,
    outputCurrent: at(telemetry.outputCurrents, channelIndex),
    outputCurrentBelowRange: telemetry.outputCurrentBelowRange[channelIndex] ?? false,
    // `temperatures` is 5 long: [0-3] per-channel, [4] PSU — a channel index
    // past 3 has no reading of its own rather than borrowing the PSU's.
    temperatureC: channelIndex < 4 ? at(telemetry.temperatures, channelIndex) : null,
    // The firmware's reading looks like an after/before signal ratio, which
    // means nothing at noise level, so at 0 V it isn't limiting. The raw value
    // stays in `telemetry.limiters` for the debug panel.
    gainReductionDb: gr === null ? null : outputVoltage === 0 ? 0 : -Math.abs(gr),
    outputState: stateAt(telemetry.outputChannelStates, channelIndex),
    outputStateRaw: at(telemetry.outputStates, channelIndex),
    inputClipping: telemetry.inputClipping[channelIndex] ?? null,
    inputStateRaw: at(telemetry.inputStates, channelIndex),
  };
}


/** Peak-to-RMS voltage ratio for a sine wave. Mirrors
 * `PEAK_HEADROOM_FACTOR` in `LimiterEditor.tsx`, which documents why √2 —
 * not 2 — is the voltage-domain factor for a power-domain doubling. */
const PEAK_TO_RMS_FACTOR = Math.SQRT2;

/** This channel's maximum RMS voltage: what the amp itself reports (the
 * firmware clamps every threshold to it), else the assigned model's rating,
 * else the generic range. Same order as core's `validation::limiter_ceiling`. */
export function rmsCeilingVolts(
  limiter: Limiter,
  ratedRmsVoltage: number | null,
  rangeMax: number | null | undefined,
): number {
  const reported = limiter.rms.maxVrms;
  return (reported != null && Number.isFinite(reported) && reported > 0 ? reported : null) ??
    ratedRmsVoltage ??
    rangeMax ??
    200;
}

/** The dB scale of every output level meter: Output row, Matrix, Overview,
 * Limiter. Inputs keep their own, longer one. */
export const OUTPUT_METER_FLOOR_DB = -40;
export const OUTPUT_METER_MARKS: VuMeterMark[] = [0, -8, -16, -24, -32, -40].map((value) => ({
  value,
  label: String(value),
}));

/** The dB scale of every input level meter (Input row, Routing, Overview),
 * where `0` is 1 V (`inputDbv`). The floor is also where a `null` reading
 * renders. */
export const INPUT_METER_FLOOR_DB = -60;
export const INPUT_METER_MARKS: VuMeterMark[] = [-60, -48, -36, -24, -12, 0].map((value) => ({
  value,
  label: String(value),
}));

/** What an output level meter draws: dB re rated output, or, behind the
 * "Show output meters in volts" setting, the amp's own volts on a linear
 * `0..max` scale with no conversion at all. Thresholds go through `fromVolts`
 * so they land on whichever scale the bar is using. */
export interface OutputMeterScale {
  min: number;
  max: number;
  marks: VuMeterMark[];
  unit: "dB" | "V";
  reading(telemetry: ChannelTelemetry | undefined): number | null;
  fromVolts(volts: number | null): number | null;
}

export function outputMeterScale(
  volts: boolean,
  maxVolts: number,
  ratedRmsVoltage: number | null,
  floorDb: number,
  dbMarks: VuMeterMark[],
): OutputMeterScale {
  if (volts) {
    return {
      min: 0,
      max: maxVolts,
      marks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: f * maxVolts, label: String(Math.round(f * maxVolts)) })),
      unit: "V",
      reading: (t) => t?.outputVoltage ?? null,
      fromVolts: (v) => v,
    };
  }
  return {
    min: floorDb,
    max: 0,
    marks: dbMarks,
    unit: "dB",
    reading: (t) => t?.outputLevelDb ?? null,
    fromVolts: (v) => voltageToDb(v, ratedRmsVoltage),
  };
}

/** A limiter threshold in the volts the meter's bar reads, which are RMS.
 *
 * `"peak"` thresholds are divided by √2 first: `thresholdVp` is a *peak*
 * voltage, and putting it on an RMS scale unconverted reads ~3dB hot. Note
 * that conversion is exact only for a sine — against real program material,
 * whose crest factor is whatever it happens to be, this is "the level of a
 * sine that would just touch this threshold", which is the right thing for a
 * scale marker but not a claim about the audio. */
function thresholdRmsVolts(thresholdVolts: number | null, kind: "rms" | "peak"): number | null {
  if (thresholdVolts === null) return null;
  return kind === "peak" ? thresholdVolts / PEAK_TO_RMS_FACTOR : thresholdVolts;
}

/** `AmpChannel.limiter` is typed optional in TS (specta marks any
 * `#[serde(default = ...)]` field optional) even though the backend's
 * default constructor always populates it. Mirrors `default_limiter` in
 * `src-tauri/src/data/project.rs` so a missing struct still has something
 * sensible to show/draw. Shared by `LimiterEditor` (the editor itself) and
 * `AmpConfigureView`'s Output tab (the threshold lines on its level meter),
 * so both agree on what an unset channel's limiter looks like. */
export const FALLBACK_LIMITER: Limiter = {
  rms: { enabled: false, thresholdVrms: 100, attackMs: 5, releaseMultiplier: 4 },
  peak: { enabled: false, thresholdVp: 140, holdMs: 10, releaseMs: 50 },
};

/** Threshold marker colors on a level meter's dB column — the vivid ends of
 * `DEFAULT_LEVEL_GRADIENT` (its yellow and red stops run through
 * `vibrantColor`), so the lines read as belonging to the same scale they're
 * drawn on rather than as arbitrary UI accents. Fixed regardless of the
 * user's accent colour, like every other status colour in this app. */
const RMS_THRESHOLD_COLOR = "rgb(255, 237, 31)";
const PEAK_THRESHOLD_COLOR = "rgb(255, 28, 28)";
/** Shaded operating bands sit under the fill, so they have to stay readable
 * through the unlit track without competing with the bar itself. */
const THRESHOLD_ZONE_OPACITY = 0.5;
/** Left/right halves of the track, used only while the two threshold lines
 * would otherwise occlude each other (see `buildLimiterThresholdVisuals`'s
 * `pixelsPerUnit` parameter). */
const RMS_MARK_SPAN = [0, 0.5] as const;
const PEAK_MARK_SPAN = [0.5, 1] as const;
/** Gap, in px, below which the two threshold lines are treated as
 * overlapping. A touch more than the 2px line height, so a near-miss splits
 * rather than rendering as one thick smear with a sliver of gap. */
const DEFAULT_MARK_COLLISION_PX = 3;

/** The RMS/peak limiter threshold lines and shaded bands for a level meter,
 * shared by the Limiter tab's own meter and the Output tab's (behind the
 * "Display limiter threshold lines in output tab" preference) so both read
 * identically. A stage that is switched off passes `null` and draws nothing.
 *
 * `pixelsPerUnit` (px per dB or per volt), when given, enables collision-avoidance: two thresholds
 * closer than `collisionPx` (default `DEFAULT_MARK_COLLISION_PX`) apart on
 * screen split into side-by-side half-width lines instead of drawing on top
 * of each other — real stored data can put RMS and peak within a fraction of
 * a dB of each other (`FALLBACK_LIMITER`'s own 100Vrms/140Vp pair is 0.1dB
 * apart), and a fully overlapped 2px glowing line reads as a single blurred
 * smear in whichever color happens to paint last, not as "two limiters here".
 * Omit it to skip the check (unsplit lines) when the caller has no fixed
 * pixel size to measure against. */
export function buildLimiterThresholdVisuals(
  rmsThresholdVrms: number | null,
  peakThresholdVp: number | null,
  scale: OutputMeterScale,
  collision?: { pixelsPerUnit: number; collisionPx?: number },
): { zones: VuMeterZone[]; marks: VuMeterMark[] } {
  const rmsThreshold = scale.fromVolts(thresholdRmsVolts(rmsThresholdVrms, "rms"));
  const peakThreshold = scale.fromVolts(thresholdRmsVolts(peakThresholdVp, "peak"));
  // A threshold off the bottom of the scale is dropped rather than clamped —
  // a line pinned to the floor would read as a threshold *at* the floor.
  const inScale = (v: number | null): v is number => v !== null && v >= scale.min && v <= scale.max;

  // Two bands under the bar: red from the peak threshold up to the top of the
  // scale (past peak protection), yellow from the RMS threshold up to the peak
  // line, or to the top when the peak stage is off and nothing cuts it short.
  //
  // Peak normally sits at or above RMS in dB, since the editing panel
  // enforces `peakVp >= rmsVrms * √2` on every edit — but only on edit.
  // Stored data can violate it (`FALLBACK_LIMITER`'s own 100Vrms/140Vp pair
  // is 1.4V short of the floor, putting peak 0.1dB *below* RMS), so the two
  // can cross. `VuMeter` orders each zone's ends itself rather than assuming
  // `from < to`, which is what keeps that case rendering as a thin band
  // instead of vanishing.
  const zones: VuMeterZone[] = [
    ...(inScale(peakThreshold)
      ? [{ from: peakThreshold, to: scale.max, color: PEAK_THRESHOLD_COLOR, opacity: THRESHOLD_ZONE_OPACITY }]
      : []),
    ...(inScale(rmsThreshold)
      ? [
          {
            from: rmsThreshold,
            to: inScale(peakThreshold) ? peakThreshold : scale.max,
            color: RMS_THRESHOLD_COLOR,
            opacity: THRESHOLD_ZONE_OPACITY,
          },
        ]
      : []),
  ];

  // Peak lands on exactly the same dB as RMS whenever it sits at its
  // enforced floor of `rmsVrms * √2` — the Limiter tab's default state —
  // so the collision test is measured in rendered pixels rather than in dB,
  // tracking the meter's real scale instead of a guessed epsilon.
  const collides =
    collision !== undefined &&
    inScale(rmsThreshold) &&
    inScale(peakThreshold) &&
    Math.abs(peakThreshold - rmsThreshold) * collision.pixelsPerUnit <
      (collision.collisionPx ?? DEFAULT_MARK_COLLISION_PX);

  const marks: VuMeterMark[] = [
    ...(inScale(rmsThreshold)
      ? [{ value: rmsThreshold, color: RMS_THRESHOLD_COLOR, glow: true, span: collides ? RMS_MARK_SPAN : undefined }]
      : []),
    ...(inScale(peakThreshold)
      ? [{ value: peakThreshold, color: PEAK_THRESHOLD_COLOR, glow: true, span: collides ? PEAK_MARK_SPAN : undefined }]
      : []),
  ];

  return { zones, marks };
}

/** An output's letter — outputs are lettered A, B, C…, inputs numbered. */
export const outputLetter = (channelIndex: number) => String.fromCharCode(65 + channelIndex);
