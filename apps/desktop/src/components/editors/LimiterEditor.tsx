import type { AmpAssignment, AmpCapability_Serialize as AmpCapability } from "../../lib/bindings";
import type { ConfigureActions } from "../../lib/configureActions";
import { ClipboardButtons } from "../ClipboardButtons";
import type { VuMeterMark } from "../VuMeter";
import { buildLimiterThresholdVisuals, FALLBACK_LIMITER, outputLetter, outputMeterScale, rmsCeilingVolts, type ChannelTelemetry } from "../../lib/channelTelemetry";
import { useIsTight } from "../../lib/breakpoints";
import { usePreference } from "../../lib/preferences";
import { LIMITER_METER_FLOOR, LIMITER_METER_MARKS, LimiterFieldRow, LimiterMeterColumn, LimiterNumberField, SLIDER_HEIGHT, StageToggle, ThresholdSliderColumn, fmtDb } from "./limiterParts";
import { PEAK_HEADROOM_FACTOR, powerWatts, requiredPeakFloor, voltageForPowerWatts } from "../../lib/limiterPower";

const EDITOR_MAX_WIDTH = 640;

/** Threshold sliders operate in the Watt domain (not Volts) so dragging
 * snaps to whole 10 W steps — a voltage-domain step would translate to
 * uneven, non-round Watt increments once squared through `P = V^2 / R`. */
const SLIDER_WATT_STEP = 10;

interface LimiterEditorProps {
  assignment: AmpAssignment;
  channelIndex: number;
  /** This channel's live heartbeat slice — drives the Out dB / Limit dB
   * columns. Absent for a Project source and before the first heartbeat,
   * which leaves both meters unlit and their readouts at "—". */
  telemetry?: ChannelTelemetry;
  capability: AmpCapability;
  actions: ConfigureActions;
  /** The threshold sliders and level meters above the fields. Off for a
   * Speaker Library way: nothing is live there, and the fields below set the
   * same thresholds. */
  meters?: boolean;
}

/** Output protection editor for one channel — independent RMS and Peak
 * limiter stages, ported from the old app's `limiter-panel.tsx`: vertical
 * threshold sliders flanking a pair of decorative level meters, a shared
 * Load (ohms) field, and an ON/OFF pill per stage above the numeric fields.
 * Both stages can be engaged simultaneously. Derived power readouts and the
 * meters are display-only, computed from the channel's existing `ohms`
 * field — never persisted. The Out dB/Limit dB columns are fed by live
 * heartbeat telemetry (`telemetry`); the derived power readouts remain
 * display-only. */
export function LimiterEditor({
  assignment,
  channelIndex,
  capability,
  actions,
  telemetry,
  meters = true,
}: LimiterEditorProps) {
  const tight = useIsTight();
  const channel = assignment.channels.find((c) => c.channelIndex === channelIndex) ?? assignment.channels[0];
  const limiter = channel.limiter ?? FALLBACK_LIMITER;
  const ohms = channel.ohms ?? 8;
  const ranges = capability.paramRanges;
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");
  const limiterThresholdSurfaces = usePreference("limiterThresholdSurfaces");
  const outputMeterVolts = usePreference("outputMeterVolts");

  async function patch(fields: {
    rmsEnabled?: boolean;
    rmsThresholdVrms?: number;
    rmsAttackMs?: number;
    rmsReleaseMultiplier?: number;
    peakEnabled?: boolean;
    peakThresholdVp?: number;
    peakHoldMs?: number;
    peakReleaseMs?: number;
  }) {
    if (!actions.setChannelLimiter) return;
    // Peak threshold must always be at least double the RMS threshold's
    // *power* (a √2 voltage ratio — see `requiredPeakFloor`'s doc comment),
    // enforced centrally here so it holds regardless of which control
    // (slider, Threshold field, or the interchangeable Prms/Ppeak Wattage
    // fields) triggered the change. Editing RMS upward bumps Peak up to the
    // new floor if it's now too low; editing Peak below the current floor
    // clamps it back up to the floor instead of silently rejecting it.
    const effectiveRms = fields.rmsThresholdVrms ?? rmsThresholdVrms;
    const requiredPeak = requiredPeakFloor(effectiveRms, peakThresholdMax);
    const effectivePeak = Math.max(fields.peakThresholdVp ?? peakThresholdVp, requiredPeak);
    const peakNeedsUpdate = fields.peakThresholdVp !== undefined || effectivePeak !== peakThresholdVp;

    await actions.setChannelLimiter(channelIndex, {
      rmsEnabled: fields.rmsEnabled ?? null,
      rmsThresholdVrms: fields.rmsThresholdVrms ?? null,
      rmsAttackMs: fields.rmsAttackMs ?? null,
      rmsReleaseMultiplier: fields.rmsReleaseMultiplier ?? null,
      peakEnabled: fields.peakEnabled ?? null,
      peakThresholdVp: peakNeedsUpdate ? effectivePeak : null,
      peakHoldMs: fields.peakHoldMs ?? null,
      peakReleaseMs: fields.peakReleaseMs ?? null,
    });
  }

  const rmsThresholdVrms = limiter.rms.thresholdVrms ?? 0;
  const peakThresholdVp = limiter.peak.thresholdVp ?? 0;
  const rmsRange = ranges.rmsLimiterThresholdVrms;
  const peakRange = ranges.peakLimiterThresholdVp;

  // This channel's threshold ceiling — the same one core's
  // `validation::limiter_ceiling` gives, so the backend accepts whatever the
  // sliders reach. The amp's own reported maxima (`maxVrms`/`maxVp`) come
  // first: the firmware clamps every threshold to them. Without a report
  // (0, or a project amp never read from hardware), the assigned model's
  // rated RMS voltage (`capability.topology.ratedRmsVoltage`, `None` for
  // models with no known datasheet), ×√2 for peak; then the generic range.
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const reported = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
  const rmsThresholdMax = rmsCeilingVolts(limiter, ratedRmsVoltage, rmsRange.max);
  const peakThresholdMax =
    reported(limiter.peak.maxVp) ??
    (ratedRmsVoltage != null ? ratedRmsVoltage * PEAK_HEADROOM_FACTOR : null) ??
    peakRange.max ??
    400;
  // Peak's own min (slider drag range and NumberInput `min`) is raised to
  // this floor dynamically, so it's physically impossible to drag/type
  // below double the RMS threshold rather than relying solely on
  // after-the-fact correction in `patch()`.
  const peakThresholdMin = Math.max(peakRange.min ?? 0, requiredPeakFloor(rmsThresholdVrms, peakThresholdMax));

  // Mono-bridging (fixed adjacent pairing: floor(channel/2), e.g. (0,1),
  // (2,3)…) — Output tab. `output_bridged` lives only on the pair's leader
  // (even-indexed) channel; ported from the old app's bridging, where a
  // bridged pair's displayed threshold voltage/power doubles
  // (`bridgeVoltageMultiplier`) and the Load uses only the leader's ohms.
  // The *raw* stored threshold never changes across a bridge toggle — only
  // this display/edit conversion layer does, so un-bridging always reveals
  // the same per-channel value that was there before.
  const pairLeaderIndex = channelIndex - (channelIndex % 2);
  const pairFollowerIndex = pairLeaderIndex + 1;
  const leaderChannel = assignment.channels.find((c) => c.channelIndex === pairLeaderIndex);
  const hasFollower = assignment.channels.some((c) => c.channelIndex === pairFollowerIndex);
  const isBridged = hasFollower && (leaderChannel?.outputBridged ?? false);
  const voltageMultiplier = isBridged ? 2 : 1;
  const effectiveOhms = isBridged ? (leaderChannel?.ohms ?? 8) : ohms;
  const partnerIndex = channelIndex === pairLeaderIndex ? pairFollowerIndex : pairLeaderIndex;
  const partnerLetter = outputLetter(partnerIndex);

  function toDisplay(raw: number) {
    return raw * voltageMultiplier;
  }
  function fromDisplay(display: number) {
    return display / voltageMultiplier;
  }

  const rmsThresholdVrmsDisplay = toDisplay(rmsThresholdVrms);
  const peakThresholdVpDisplay = toDisplay(peakThresholdVp);
  const rmsThresholdMaxDisplay = toDisplay(rmsThresholdMax);
  const peakThresholdMaxDisplay = toDisplay(peakThresholdMax);
  const peakThresholdMinDisplay = toDisplay(peakThresholdMin);
  const rmsRangeMinDisplay = rmsRange.min != null ? toDisplay(rmsRange.min) : null;
  const peakRangeMinDisplay = peakRange.min != null ? toDisplay(peakRange.min) : null;

  // Threshold marker positions on the Out dB meter. Deliberately the *raw*
  // per-channel thresholds, not the bridge-doubled display values: the meter
  // shows this channel's own output level against its own rated voltage, so
  // a doubled threshold would sit ~6dB off on a bridged pair.
  //
  // `buildLimiterThresholdVisuals` (shared with the Output tab's meter, see
  // `channelTelemetry.ts`) builds the zones and marks, splitting the two
  // marks into side-by-side halves when they'd otherwise land on top of each
  // other — the `pixelsPerDb` this passes comes from this meter's fixed
  // 220px height, which is what makes that collision check meaningful here.
  // Gated on "limiter" in "Enable limiter threshold lines in meters" — off,
  // the Out dB column keeps its plain scale ticks and no bands.
  const showLimiterThresholds = limiterThresholdSurfaces.includes("limiter");
  const outScale = outputMeterScale(
    outputMeterVolts,
    rmsThresholdMax,
    ratedRmsVoltage,
    LIMITER_METER_FLOOR,
    LIMITER_METER_MARKS,
  );
  const outReading = outScale.reading(telemetry);
  const { zones: outMeterZones, marks: thresholdMarks } = showLimiterThresholds
    ? buildLimiterThresholdVisuals(
        limiter.rms.enabled ? rmsThresholdVrms : null,
        limiter.peak.enabled ? peakThresholdVp : null,
        outScale,
        { pixelsPerUnit: SLIDER_HEIGHT / (outScale.max - outScale.min) },
      )
    : { zones: [], marks: [] };
  const outMeterMarks: VuMeterMark[] = [...outScale.marks, ...thresholdMarks];

  async function handleOhmsChange(value: number) {
    if (!actions.setChannelOhms) return;
    const targetChannelIndex = isBridged ? pairLeaderIndex : channelIndex;
    await actions.setChannelOhms(targetChannelIndex, value);
  }

  return (
    <div
      className="flex min-w-0 flex-col items-center gap-4 p-4"
      style={{ maxWidth: EDITOR_MAX_WIDTH, margin: "0 auto" }}
    >
      {isBridged && (
        <span
          style={{
            fontSize: "var(--amp-font-size-xs)",
            fontWeight: 700,
            color: "var(--amp-color-green-6)",
            textAlign: "center",
          }}
        >
          Bridged with Out{partnerLetter} — showing combined values
        </span>
      )}
      <div className="flex w-full flex-wrap justify-between gap-2">
        {(["rmsLimiter", "peakLimiter"] as const).map((section) => (
          <ClipboardButtons
            key={section}
            actions={actions}
            channelIndex={channelIndex}
            section={section}
            label={`${assignment.deviceName ?? "Amp"} · Out ${outputLetter(channelIndex)} ${
              section === "rmsLimiter" ? "RMS" : "Peak"
            } limiter`}
          />
        ))}
      </div>
      {meters && (
        <>
      {/* `1fr` is `minmax(auto, 1fr)`, so four columns can't shrink below
       * their content and would push the window into a horizontal scroll.
       * Below `useIsTight` they fold to 2x2 — same order, two rows. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: tight ? "1fr 1fr" : "1fr 1fr 1fr 1fr",
          gap: 16,
          width: "100%",
        }}
      >
        <ThresholdSliderColumn
          label="RMS"
          value={powerWatts(rmsThresholdVrmsDisplay, effectiveOhms)}
          min={rmsRangeMinDisplay != null ? powerWatts(rmsRangeMinDisplay, effectiveOhms) : 0}
          max={powerWatts(rmsThresholdMaxDisplay, effectiveOhms)}
          step={SLIDER_WATT_STEP}
          disabled={!limiter.rms.enabled}
          onChangeEnd={(watts) => {
            const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
            patch({ rmsThresholdVrms: Math.min(rawVoltage, rmsThresholdMax) });
          }}
        />
        <LimiterMeterColumn
          label={`Out ${outScale.unit}`}
          gradient
          peakHold={peakHoldSurfaces.includes("limiter")}
          min={outScale.min}
          max={outScale.max}
          levelDb={outReading}
          valueText={
            outScale.unit === "V"
              ? `${outReading === null ? "—" : outReading.toFixed(1)} / ${Math.round(outScale.max)} V`
              : fmtDb(outReading)
          }
          marks={outMeterMarks}
          zones={outMeterZones}
        />
        <LimiterMeterColumn
          label="Limit dB"
          // Gain reduction, so the bar hangs from 0 downward: an idle
          // limiter reads as an empty track, and the lit length *is* the
          // reduction. Filling from the bottom like a level meter would
          // show a full bar whenever nothing is being limited.
          fillFrom="max"
          levelDb={telemetry?.gainReductionDb ?? null}
          valueText={fmtDb(telemetry?.gainReductionDb ?? null)}
        />
        <ThresholdSliderColumn
          label="Peak"
          value={powerWatts(peakThresholdVpDisplay, effectiveOhms)}
          min={peakRangeMinDisplay != null ? powerWatts(peakRangeMinDisplay, effectiveOhms) : 0}
          max={powerWatts(peakThresholdMaxDisplay, effectiveOhms)}
          floor={powerWatts(peakThresholdMinDisplay, effectiveOhms)}
          step={SLIDER_WATT_STEP}
          disabled={!limiter.peak.enabled}
          onChangeEnd={(watts) => {
            const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
            patch({ peakThresholdVp: Math.min(rawVoltage, peakThresholdMax) });
          }}
        />
      </div>
        </>
      )}

      {/* Folds to a single column rather than 2x2: the Load input's `span 2`
       * would strand an On/Off button on a row of its own in two columns, so
       * tight just stacks the three controls in DOM order. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: tight ? "1fr" : "1fr 1fr 1fr 1fr",
          gap: 16,
          width: "100%",
          alignItems: "end",
        }}
      >
        <StageToggle label={meters ? null : "RMS"} enabled={limiter.rms.enabled} onClick={() => patch({ rmsEnabled: !limiter.rms.enabled })} />
        <div style={{ gridColumn: tight ? "span 1" : "span 2" }}>
          <LimiterNumberField
            label="Load"
            suffix=" Ω"
            min={isBridged ? 4 : 0.5}
            value={effectiveOhms}
            disabled={!actions.setChannelOhms}
            onCommit={(value) => handleOhmsChange(value)}
          />
        </div>
        <StageToggle label={meters ? null : "Peak"} enabled={limiter.peak.enabled} onClick={() => patch({ peakEnabled: !limiter.peak.enabled })} />
      </div>

      <hr className="m-0 w-full border-t border-[var(--amp-color-default-border)]" />

      {/* RMS and Peak field columns sit side by side while both fit; below
       * `useIsTight` a label + 140px input pair per column no longer does,
       * so they stack into one column. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: tight ? "1fr" : "1fr 1fr",
          gap: tight ? 12 : 24,
          width: "100%",
        }}
      >
        <div className="flex flex-col gap-2">
          <LimiterFieldRow
            label="Threshold"
            unit="Vrms"
            value={rmsThresholdVrmsDisplay}
            min={rmsRangeMinDisplay ?? undefined}
            max={rmsThresholdMaxDisplay}
            disabled={!limiter.rms.enabled}
            onCommit={(value) => patch({ rmsThresholdVrms: Math.min(fromDisplay(value), rmsThresholdMax) })}
          />
          <LimiterFieldRow
            label="Prms"
            unit="W"
            value={powerWatts(rmsThresholdVrmsDisplay, effectiveOhms)}
            min={rmsRangeMinDisplay != null ? powerWatts(rmsRangeMinDisplay, effectiveOhms) : undefined}
            max={powerWatts(rmsThresholdMaxDisplay, effectiveOhms)}
            disabled={!limiter.rms.enabled}
            integer
            onCommit={(watts) => {
              const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
              patch({ rmsThresholdVrms: Math.min(rawVoltage, rmsThresholdMax) });
            }}
          />
          <LimiterFieldRow
            label="Attack"
            unit="ms"
            integer
            value={limiter.rms.attackMs ?? 0}
            min={ranges.rmsLimiterAttackMs.min ?? undefined}
            max={ranges.rmsLimiterAttackMs.max ?? undefined}
            disabled={!limiter.rms.enabled}
            onCommit={(value) => patch({ rmsAttackMs: value })}
          />
          <LimiterFieldRow
            label="Release"
            unit="xAtk"
            integer
            value={limiter.rms.releaseMultiplier ?? 0}
            min={ranges.rmsLimiterReleaseMultiplier.min ?? undefined}
            max={ranges.rmsLimiterReleaseMultiplier.max ?? undefined}
            disabled={!limiter.rms.enabled}
            onCommit={(value) => patch({ rmsReleaseMultiplier: value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <LimiterFieldRow
            label="Threshold"
            unit="Vpeak"
            value={peakThresholdVpDisplay}
            min={peakThresholdMinDisplay}
            max={peakThresholdMaxDisplay}
            disabled={!limiter.peak.enabled}
            onCommit={(value) => patch({ peakThresholdVp: Math.min(fromDisplay(value), peakThresholdMax) })}
          />
          <LimiterFieldRow
            label="Ppeak"
            unit="W"
            value={powerWatts(peakThresholdVpDisplay, effectiveOhms)}
            min={powerWatts(peakThresholdMinDisplay, effectiveOhms)}
            max={powerWatts(peakThresholdMaxDisplay, effectiveOhms)}
            disabled={!limiter.peak.enabled}
            integer
            onCommit={(watts) => {
              const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
              patch({ peakThresholdVp: Math.min(rawVoltage, peakThresholdMax) });
            }}
          />
          <LimiterFieldRow
            label="Hold"
            unit="ms"
            integer
            value={limiter.peak.holdMs ?? 0}
            min={ranges.peakLimiterHoldMs.min ?? undefined}
            max={ranges.peakLimiterHoldMs.max ?? undefined}
            disabled={!limiter.peak.enabled}
            onCommit={(value) => patch({ peakHoldMs: value })}
          />
          <LimiterFieldRow
            label="Release"
            unit="ms"
            integer
            value={limiter.peak.releaseMs ?? 0}
            min={ranges.peakLimiterReleaseMs.min ?? undefined}
            max={ranges.peakLimiterReleaseMs.max ?? undefined}
            disabled={!limiter.peak.enabled}
            onCommit={(value) => patch({ peakReleaseMs: value })}
          />
        </div>
      </div>
    </div>
  );
}
