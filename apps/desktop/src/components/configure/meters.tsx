import { DEFAULT_LEVEL_GRADIENT, VuMeter } from "../VuMeter";
import type { AmpAssignment } from "../../lib/bindings";
import { buildLimiterThresholdVisuals, FALLBACK_LIMITER, OUTPUT_METER_FLOOR_DB, OUTPUT_METER_MARKS, outputMeterScale, rmsCeilingVolts, type ChannelTelemetry, type OutputMeterScale, INPUT_METER_FLOOR_DB, INPUT_METER_MARKS } from "../../lib/channelTelemetry";
import { usePreference } from "../../lib/preferences";
import { useElementWidth } from "../../hooks/useElementWidth";

/** The one channel level meter used by every tab — Input, Output and
 * Routing all render this, so a meter reads identically wherever it appears
 * rather than each tab styling its own. `VuMeter` itself stays the generic
 * primitive (orientation, gradient, scale, thickness are all its props);
 * this fixes the single house style for a *channel level* reading, so those
 * choices live in one place instead of being re-decided per call site.
 *
 * `wide` drops the usual `maxWidth` cap — the Output tab's row wants the
 * meter to fill most of its width (matching the reference hardware view),
 * unlike the compact fixed-width meter every other tab uses.
 *
 * `level` is `null` for a Project source, before the first heartbeat, and
 * for a channel with no signal — all of which render fully unlit, the same
 * as a real reading at the floor. The neighbouring stat tile reads "—"
 * rather than a number, which is what keeps those cases distinguishable.
 *
 * `scale` puts an output on dB or, by the "Show output meters in volts"
 * setting, on the amp's own volts.
 *
 * `limiterThresholds`, when given (only the Output tab passes it, behind the
 * "limiter" option of "Enable limiter threshold lines in meters"), draws that
 * channel's RMS/peak limiter lines and bands on top of the plain scale —
 * see `buildLimiterThresholdVisuals` in `channelTelemetry.ts`. This
 * component measures its own rendered width (`useElementWidth`) to feed that
 * function's collision-avoidance, since it's a fluid flex item with no width
 * known at render time, unlike the Limiter tab's fixed-height meter.
 *
 * `peakHold` has no default here — every call site passes it explicitly from
 * "Enable peak hold in meters", so a new caller can't silently inherit an
 * on/off state meant for a different tab. */
export function ChannelLevelMeter({
  level,
  scale,
  disabled,
  wide,
  peakHold,
  limiterThresholds,
}: {
  level: number | null;
  /** The output scale; an input's meter omits it and stays on dB. */
  scale?: OutputMeterScale;
  disabled?: boolean;
  wide?: boolean;
  peakHold: boolean;
  limiterThresholds?: {
    /** `null` for a stage that is switched off: nothing is drawn for it. */
    rmsThresholdVrms: number | null;
    peakThresholdVp: number | null;
  };
}) {
  const [meterRef, meterWidth] = useElementWidth<HTMLDivElement>();
  const min = scale?.min ?? INPUT_METER_FLOOR_DB;
  const max = scale?.max ?? 0;
  const thresholds =
    limiterThresholds && scale
      ? buildLimiterThresholdVisuals(
          limiterThresholds.rmsThresholdVrms,
          limiterThresholds.peakThresholdVp,
          scale,
          meterWidth !== null ? { pixelsPerUnit: meterWidth / (max - min) } : undefined,
        )
      : null;
  const marks = scale?.marks ?? INPUT_METER_MARKS;

  return (
    <div
      ref={meterRef}
      className="min-w-0"
      style={{
        // Basis `0`, not a width: the meter claims only what is left after
        // its row's fixed-width tiles, so a tight row narrows the meter
        // instead of wrapping a tile off the end. It renders identically
        // whenever the row fits (a lone growing item absorbs all free space
        // regardless of its basis) — the difference only shows under
        // pressure, which is exactly where a 200px basis used to push the
        // last tile onto a line of its own.
        flex: "1 1 0%",
        minWidth: 120,
        maxWidth: wide ? undefined : 260,
      }}
    >
      <VuMeter
        orientation="horizontal"
        min={min}
        max={max}
        value={level ?? min}
        gradient={DEFAULT_LEVEL_GRADIENT}
        thickness={24}
        marks={thresholds ? [...marks, ...thresholds.marks] : marks}
        zones={thresholds?.zones}
        peakHold={peakHold}
        disabled={disabled}
      />
    </div>
  );
}

/** An output's meter on the Matrix tab: plain, no limiter lines. */
export function RoutingOutputMeter({
  channel,
  reading,
  ratedRmsVoltage,
  rangeMax,
  peakHold,
}: {
  channel: AmpAssignment["channels"][number];
  reading: ChannelTelemetry;
  ratedRmsVoltage: number | null;
  rangeMax: number | null | undefined;
  peakHold: boolean;
}) {
  const outputMeterVolts = usePreference("outputMeterVolts");
  const scale = outputMeterScale(
    outputMeterVolts,
    rmsCeilingVolts(channel.limiter ?? FALLBACK_LIMITER, ratedRmsVoltage, rangeMax),
    ratedRmsVoltage,
    OUTPUT_METER_FLOOR_DB,
    OUTPUT_METER_MARKS,
  );
  return <ChannelLevelMeter level={scale.reading(reading)} scale={scale} peakHold={peakHold} />;
}
