import { useEffect, useState } from "react";
import { Button, Slider } from "@heroui/react";
import { type AmpAssignment, type AmpCapability_Serialize as AmpCapability, type Limiter } from "../lib/bindings";
import type { ConfigureActions, ConfigureCapabilities } from "../lib/configureActions";
import { DEFAULT_LEVEL_GRADIENT, VuMeter, type VuMeterMark, type VuMeterZone } from "./VuMeter";
import { limiterThresholdToDb, type ChannelTelemetry } from "../lib/channelTelemetry";
import { useIsTight } from "../lib/breakpoints";
import { FIELD_INPUT } from "./fieldClasses";

const EDITOR_MAX_WIDTH = 640;
const SLIDER_HEIGHT = 220;
/** Bottom of the Out dB / Limit dB scale. Also the value a `null` reading
 * renders at, so a channel with no telemetry sits unlit on both columns. */
const LIMITER_METER_FLOOR = -40;

/** Threshold marker colors on the Out dB column — the vivid ends of
 * `DEFAULT_LEVEL_GRADIENT` (its yellow and red stops run through
 * `vibrantColor`), so the lines read as belonging to the same scale they're
 * drawn on rather than as arbitrary UI accents. */
const RMS_THRESHOLD_COLOR = "rgb(255, 237, 31)";
const PEAK_THRESHOLD_COLOR = "rgb(255, 28, 28)";
/** Shaded operating bands sit under the fill, so they have to stay readable
 * through the unlit track without competing with the bar itself. */
const THRESHOLD_ZONE_OPACITY = 0.5;
/** Left/right halves of the Out dB track, used only while the two threshold
 * lines would otherwise occlude each other (see `thresholdsCollide`). */
const RMS_MARK_SPAN = [0, 0.5] as const;
const PEAK_MARK_SPAN = [0.5, 1] as const;
/** Vertical gap, in px, below which the two threshold lines are treated as
 * overlapping. A touch more than the 2px line height, so a near-miss splits
 * rather than rendering as one thick smear with a sliver of gap. */
const MARK_COLLISION_PX = 3;

/** Scale for the Out dB/Limit dB columns. `0` means rated max output on the
 * Out column and *no* gain reduction on the Limit column. */
const LIMITER_METER_MARKS: VuMeterMark[] = [0, -8, -16, -24, -32, -40].map((value) => ({
  value,
  label: String(value),
}));

/** `AmpChannel.limiter` is typed optional in TS (specta marks any
 * `#[serde(default = ...)]` field optional) even though the backend's
 * default constructor always populates it. Mirrors `default_limiter` in
 * `src-tauri/src/data/project.rs` so the editor never has to handle a
 * missing struct. */
const FALLBACK_LIMITER: Limiter = {
  rms: { enabled: false, thresholdVrms: 100, attackMs: 5, releaseMultiplier: 4 },
  peak: { enabled: false, thresholdVp: 140, holdMs: 10, releaseMs: 50 },
};

/** RMS power into `ohms` from an RMS voltage threshold — `P = V^2 / R`. */
function rmsPowerWatts(vrms: number, ohms: number): number {
  return (vrms * vrms) / ohms;
}

/** Instantaneous peak power into `ohms` from a peak voltage threshold —
 * `P = Vp^2 / R` (not divided by 2: "peak power" is the power at the
 * waveform's peak voltage, not a time-averaged/RMS-equivalent figure — for a
 * sine wave this is exactly 2x the RMS power at the corresponding RMS
 * voltage, e.g. 60 Vrms / 84.85 Vpeak into 8 Ω is 450 W RMS / 900 W peak). */
function peakPowerWatts(vp: number, ohms: number): number {
  return (vp * vp) / ohms;
}

/** Inverse of both `rmsPowerWatts`/`peakPowerWatts` (both are `P = V^2 / R`,
 * so both invert the same way) — lets the Prms/Ppeak fields be edited
 * directly and back-solved to a voltage threshold, interchangeable with the
 * Threshold field rather than a read-only readout. */
function voltageForPowerWatts(watts: number, ohms: number): number {
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
function requiredPeakFloor(rmsVoltage: number, peakMax: number): number {
  return Math.min(rmsVoltage * PEAK_HEADROOM_FACTOR, peakMax);
}

/** Peak voltage capability assumed relative to an amp's rated RMS voltage —
 * used to auto-derive the Peak stage's max threshold from the same
 * per-model rating that caps the RMS stage, and shared by `requiredPeakFloor`
 * for the "Peak power must be at least double RMS power" floor (see its own
 * doc comment for why √2 — not 2 — is the correct voltage-domain factor for
 * a power-domain doubling). */
const PEAK_HEADROOM_FACTOR = Math.SQRT2;

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
  capabilities: ConfigureCapabilities;
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
  capabilities,
  telemetry,
}: LimiterEditorProps) {
  const tight = useIsTight();
  const channel = assignment.channels.find((c) => c.channelIndex === channelIndex) ?? assignment.channels[0];
  const limiter = channel.limiter ?? FALLBACK_LIMITER;
  const ohms = channel.ohms ?? 8;
  const ranges = capability.paramRanges;

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

  // The assigned model's actual rated RMS voltage (`capability.topology.ratedRmsVoltage`,
  // resolved per-model in `capability::cvr::rated_rms_voltage` — `None` for
  // models with no known electrical datasheet, e.g. user-defined) caps the
  // threshold sliders/fields automatically, tighter than the generic
  // cross-model `AmpParamRanges` bound when it's the smaller of the two.
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const rmsThresholdMax =
    ratedRmsVoltage != null ? Math.min(rmsRange.max ?? ratedRmsVoltage, ratedRmsVoltage) : (rmsRange.max ?? 200);
  const peakThresholdMax =
    ratedRmsVoltage != null
      ? Math.min(peakRange.max ?? ratedRmsVoltage * PEAK_HEADROOM_FACTOR, ratedRmsVoltage * PEAK_HEADROOM_FACTOR)
      : (peakRange.max ?? 280);
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
  const partnerLetter = String.fromCharCode(65 + partnerIndex);

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
  const rmsThresholdDb = limiterThresholdToDb(rmsThresholdVrms, "rms", ratedRmsVoltage);
  const peakThresholdDb = limiterThresholdToDb(peakThresholdVp, "peak", ratedRmsVoltage);
  // A threshold off the bottom of the scale is dropped rather than clamped —
  // a line pinned to the floor would read as a threshold *at* -40dB.
  const inScale = (db: number | null): db is number => db !== null && db >= LIMITER_METER_FLOOR && db <= 0;
  // Two bands under the bar: red from the peak threshold up to 0dB (past
  // peak protection), yellow between the two thresholds (RMS limiting, peak
  // still clear). Both need their own threshold in scale to have a defined
  // edge; the yellow band additionally needs the peak line, since that's
  // where it starts.
  //
  // Peak normally sits at or above RMS in dB, since the panel enforces
  // `peakVp >= rmsVrms * √2` on every edit — but only on edit. Stored data
  // can violate it (`FALLBACK_LIMITER`'s own 100Vrms/140Vp pair is 1.4V
  // short of the floor, putting peak 0.1dB *below* RMS), so the two can
  // cross. `VuMeter` orders each zone's ends itself rather than assuming
  // `from < to`, which is what keeps that case rendering as a thin band
  // instead of vanishing.
  const outMeterZones: VuMeterZone[] = [
    ...(inScale(peakThresholdDb)
      ? [{ from: peakThresholdDb, to: 0, color: PEAK_THRESHOLD_COLOR, opacity: THRESHOLD_ZONE_OPACITY }]
      : []),
    ...(inScale(peakThresholdDb) && inScale(rmsThresholdDb)
      ? [
          {
            from: rmsThresholdDb,
            to: peakThresholdDb,
            color: RMS_THRESHOLD_COLOR,
            opacity: THRESHOLD_ZONE_OPACITY,
          },
        ]
      : []),
  ];
  // Peak lands on exactly the same dB as RMS whenever it sits at its
  // enforced floor of `rmsVrms * √2` — the panel's default state — so the
  // collision test is measured in rendered pixels rather than in dB, and
  // tracks the meter's real height and scale instead of a guessed epsilon.
  const meterPxPerDb = SLIDER_HEIGHT / (0 - LIMITER_METER_FLOOR);
  const thresholdsCollide =
    inScale(rmsThresholdDb) &&
    inScale(peakThresholdDb) &&
    Math.abs(peakThresholdDb - rmsThresholdDb) * meterPxPerDb < MARK_COLLISION_PX;

  const outMeterMarks: VuMeterMark[] = [
    ...LIMITER_METER_MARKS,
    // Full-width normally; half-width lanes only while the two lines would
    // land on top of each other. Neither is ever nudged off its true value —
    // the split is what makes a genuine tie readable as one yellow/red line.
    ...(inScale(rmsThresholdDb)
      ? [
          {
            value: rmsThresholdDb,
            color: RMS_THRESHOLD_COLOR,
            glow: true,
            span: thresholdsCollide ? RMS_MARK_SPAN : undefined,
          },
        ]
      : []),
    ...(inScale(peakThresholdDb)
      ? [
          {
            value: peakThresholdDb,
            color: PEAK_THRESHOLD_COLOR,
            glow: true,
            span: thresholdsCollide ? PEAK_MARK_SPAN : undefined,
          },
        ]
      : []),
  ];

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
          value={rmsPowerWatts(rmsThresholdVrmsDisplay, effectiveOhms)}
          min={rmsRangeMinDisplay != null ? rmsPowerWatts(rmsRangeMinDisplay, effectiveOhms) : 0}
          max={rmsPowerWatts(rmsThresholdMaxDisplay, effectiveOhms)}
          step={SLIDER_WATT_STEP}
          disabled={!limiter.rms.enabled}
          onChangeEnd={(watts) => {
            const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
            patch({ rmsThresholdVrms: Math.min(rawVoltage, rmsThresholdMax) });
          }}
        />
        <LimiterMeterColumn
          label="Out dB"
          gradient
          peakHold
          levelDb={telemetry?.outputLevelDb ?? null}
          valueText={fmtDb(telemetry?.outputLevelDb ?? null)}
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
          value={peakPowerWatts(peakThresholdVpDisplay, effectiveOhms)}
          min={peakRangeMinDisplay != null ? peakPowerWatts(peakRangeMinDisplay, effectiveOhms) : 0}
          max={peakPowerWatts(peakThresholdMaxDisplay, effectiveOhms)}
          floor={peakPowerWatts(peakThresholdMinDisplay, effectiveOhms)}
          step={SLIDER_WATT_STEP}
          disabled={!limiter.peak.enabled}
          onChangeEnd={(watts) => {
            const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
            patch({ peakThresholdVp: Math.min(rawVoltage, peakThresholdMax) });
          }}
        />
      </div>

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
        <OnOffButton enabled={limiter.rms.enabled} onClick={() => patch({ rmsEnabled: !limiter.rms.enabled })} />
        <div style={{ gridColumn: tight ? "span 1" : "span 2" }}>
          <LiveNumberField
            label="Load"
            suffix=" Ω"
            min={isBridged ? 4 : 0.5}
            value={effectiveOhms}
            disabled={!capabilities.ohmsEditable}
            onChange={(value) => handleOhmsChange(value)}
          />
        </div>
        <OnOffButton enabled={limiter.peak.enabled} onClick={() => patch({ peakEnabled: !limiter.peak.enabled })} />
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
            onChange={(value) => patch({ rmsThresholdVrms: Math.min(fromDisplay(value), rmsThresholdMax) })}
          />
          <LimiterFieldRow
            label="Prms"
            unit="W"
            value={rmsPowerWatts(rmsThresholdVrmsDisplay, effectiveOhms)}
            min={rmsRangeMinDisplay != null ? rmsPowerWatts(rmsRangeMinDisplay, effectiveOhms) : undefined}
            max={rmsPowerWatts(rmsThresholdMaxDisplay, effectiveOhms)}
            disabled={!limiter.rms.enabled}
            integer
            onChange={(watts) => {
              const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
              patch({ rmsThresholdVrms: Math.min(rawVoltage, rmsThresholdMax) });
            }}
          />
          <LimiterFieldRow
            label="Attack"
            unit="ms"
            value={limiter.rms.attackMs ?? 0}
            min={ranges.rmsLimiterAttackMs.min ?? undefined}
            max={ranges.rmsLimiterAttackMs.max ?? undefined}
            disabled={!limiter.rms.enabled}
            onChange={(value) => patch({ rmsAttackMs: value })}
          />
          <LimiterFieldRow
            label="Release"
            unit="xAtk"
            step={0.5}
            value={limiter.rms.releaseMultiplier ?? 0}
            min={ranges.rmsLimiterReleaseMultiplier.min ?? undefined}
            max={ranges.rmsLimiterReleaseMultiplier.max ?? undefined}
            disabled={!limiter.rms.enabled}
            onChange={(value) => patch({ rmsReleaseMultiplier: value })}
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
            onChange={(value) => patch({ peakThresholdVp: Math.min(fromDisplay(value), peakThresholdMax) })}
          />
          <LimiterFieldRow
            label="Ppeak"
            unit="W"
            value={peakPowerWatts(peakThresholdVpDisplay, effectiveOhms)}
            min={peakPowerWatts(peakThresholdMinDisplay, effectiveOhms)}
            max={peakPowerWatts(peakThresholdMaxDisplay, effectiveOhms)}
            disabled={!limiter.peak.enabled}
            integer
            onChange={(watts) => {
              const rawVoltage = fromDisplay(voltageForPowerWatts(watts, effectiveOhms));
              patch({ peakThresholdVp: Math.min(rawVoltage, peakThresholdMax) });
            }}
          />
          <LimiterFieldRow
            label="Hold"
            unit="ms"
            value={limiter.peak.holdMs ?? 0}
            min={ranges.peakLimiterHoldMs.min ?? undefined}
            max={ranges.peakLimiterHoldMs.max ?? undefined}
            disabled={!limiter.peak.enabled}
            onChange={(value) => patch({ peakHoldMs: value })}
          />
          <LimiterFieldRow
            label="Release"
            unit="ms"
            value={limiter.peak.releaseMs ?? 0}
            min={ranges.peakLimiterReleaseMs.min ?? undefined}
            max={ranges.peakLimiterReleaseMs.max ?? undefined}
            disabled={!limiter.peak.enabled}
            onChange={(value) => patch({ peakReleaseMs: value })}
          />
        </div>
      </div>
    </div>
  );
}

/** Vertical threshold slider — RMS/Peak columns either side of the meters.
 * Operates in Watts (see `SLIDER_WATT_STEP`), not Volts.
 *
 * `min`/`max` define the track's fixed scale (the hardware range) and must
 * stay constant — the Peak slider's floor (double the RMS threshold) moves
 * around as RMS changes, but feeding that into `min` directly rescales the
 * whole track, making the thumb jump to a different pixel position for the
 * same value every time RMS changes ("shouldn't change the scale"). Instead
 * `floor` (defaults to `min`) clamps only the live/committed *value*, so the
 * track's proportions never move and the thumb simply can't be dragged past
 * that point, sticking there instead of rescaling around it.
 *
 * Tracks the dragged position in local state and only commits to the
 * backend on release (`onChangeEnd`), not on every intermediate `onChange`
 * tick. Dragging fires `onChange` continuously — committing on every tick
 * fired a flood of concurrent `patch()` calls, each reading the RMS/Peak
 * floor-enforcement inputs from whatever render happened to be current when
 * that particular tick's closure was created. Since the backend round trip
 * is slower than the drag's tick rate, those calls landed out of order and
 * could stomp a just-applied Peak bump with a stale, smaller one — the
 * "sometimes doesn't pull peak up/down correctly" flakiness. Committing
 * once on release removes the flood entirely. */
function ThresholdSliderColumn({
  label,
  value,
  min,
  max,
  floor,
  step,
  disabled,
  onChangeEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  floor?: number;
  step: number;
  disabled?: boolean;
  onChangeEnd: (value: number) => void;
}) {
  const effectiveFloor = floor ?? min;
  const [dragValue, setDragValue] = useState(value);
  useEffect(() => {
    setDragValue(value);
  }, [value]);
  const clamped = Math.min(Math.max(dragValue, effectiveFloor), max);

  return (
    <div className="flex flex-col items-center gap-2" style={{ opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 700, color: "var(--amp-color-dimmed)", textTransform: "uppercase" }}>
        {label}
      </span>
      <Slider
        orientation="vertical"
        style={{ height: SLIDER_HEIGHT }}
        minValue={min}
        maxValue={max}
        step={step}
        value={clamped}
        isDisabled={disabled}
        onChange={(v) => setDragValue(Math.max(v as number, effectiveFloor))}
        onChangeEnd={(v) => onChangeEnd(Math.max(v as number, effectiveFloor))}
      >
        <Slider.Track>
          <Slider.Fill />
          <Slider.Thumb />
        </Slider.Track>
      </Slider>
      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
        {Math.round(clamped)} W
      </span>
    </div>
  );
}

function fmtDb(db: number | null): string {
  return db === null ? "—" : `${db.toFixed(1)} dB`;
}

/** `Out dB`/`Limit dB` columns — `Out dB` is an output level meter on the
 * shared gradient, `Limit dB` is a gain-reduction meter on a flat track
 * hanging from the top (see `fillFrom`). "Empty" is a different number for
 * each: the scale's floor for a level meter, but `0` for a reduction meter,
 * where the floor would mean 40dB of gain reduction. A `null` reading uses
 * whichever of the two leaves the track unlit, so no data never reads as a
 * pinned meter. */
function LimiterMeterColumn({
  label,
  gradient,
  levelDb,
  valueText,
  fillFrom,
  peakHold,
  marks = LIMITER_METER_MARKS,
  zones,
}: {
  label: string;
  gradient?: boolean;
  levelDb: number | null;
  valueText: string;
  fillFrom?: "min" | "max";
  peakHold?: boolean;
  marks?: VuMeterMark[];
  zones?: VuMeterZone[];
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 700, color: "var(--amp-color-dimmed)", textTransform: "uppercase" }}>
        {label}
      </span>
      <VuMeter
        orientation="vertical"
        min={LIMITER_METER_FLOOR}
        max={0}
        value={levelDb ?? (fillFrom === "max" ? 0 : LIMITER_METER_FLOOR)}
        gradient={gradient ? DEFAULT_LEVEL_GRADIENT : undefined}
        thickness={22}
        size={SLIDER_HEIGHT}
        marks={marks}
        zones={zones}
        fillFrom={fillFrom}
        peakHold={peakHold}
      />
      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>{valueText}</span>
    </div>
  );
}

/** Green/gray ON-OFF pill for a limiter stage — same halved-green tint as
 * `EqEditor`'s `ActiveStateButton` for visual consistency across the app,
 * with "ON"/"OFF" wording matching the reference layout for this panel. */
function OnOffButton({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <Button
      size="sm"
      fullWidth
      variant="secondary"
      onPress={onClick}
      style={
        enabled
          ? {
              backgroundColor: "color-mix(in srgb, var(--amp-color-green-light) 50%, transparent)",
              color: "var(--amp-color-green-6)",
              border: "1px solid color-mix(in srgb, var(--amp-color-green-light) 50%, transparent)",
            }
          : undefined
      }
    >
      {enabled ? "ON" : "OFF"}
    </Button>
  );
}

/** Plain controlled number input matching Mantine `NumberInput`'s
 * instant-`onChange` behavior (fires on every keystroke/arrow-key change,
 * unlike `CommitNumberInput`'s blur/Enter commit) — kept as-is rather than
 * switched to the commit pattern, since that would be a behavior change
 * beyond this Mantine→HeroUI migration's scope. */
function LiveNumberField({
  label,
  suffix,
  value,
  min,
  max,
  disabled,
  integer,
  onChange,
}: {
  label?: string;
  suffix?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  integer?: boolean;
  onChange?: (value: number) => void;
}) {
  const displayValue = integer ? Math.round(value) : Number(value.toFixed(2));
  return (
    <div className="flex flex-col gap-1" style={{ flex: "0 1 140px", minWidth: 92 }}>
      {label && <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 500 }}>{label}</span>}
      <div className="relative">
        <input
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          className={FIELD_INPUT}
          style={{ paddingRight: suffix ? `${suffix.length * 7 + 12}px` : undefined }}
          value={displayValue}
          disabled={disabled || !onChange}
          onChange={(e) => {
            if (!onChange) return;
            const next = Number.parseFloat(e.currentTarget.value);
            if (!Number.isFinite(next)) return;
            const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
            onChange(clamped);
          }}
        />
        {suffix && (
          <span
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--amp-color-dimmed)",
              fontSize: "var(--amp-font-size-sm)",
              pointerEvents: "none",
            }}
          >
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function LimiterFieldRow({
  label,
  unit,
  value,
  min,
  max,
  disabled,
  integer,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Restricts this field to whole numbers only — no decimal point can be
   * typed at all (not just rounded after the fact). Used for the Wattage
   * fields, which read as round Watt figures rather than the more precise
   * (and more naturally fractional) voltage thresholds. */
  integer?: boolean;
  onChange?: (value: number) => void;
}) {
  return (
    <div className="flex flex-nowrap items-center justify-between gap-2" style={{ opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>{label}</span>
      <LiveNumberField
        suffix={` ${unit}`}
        min={min}
        max={max}
        integer={integer}
        value={value}
        disabled={disabled || !onChange}
        onChange={onChange}
      />
    </div>
  );
}
