import { useEffect, useState } from "react";
import { Button, Slider } from "@heroui/react";
import { DEFAULT_LEVEL_GRADIENT, VuMeter, type VuMeterMark, type VuMeterZone } from "../VuMeter";
import { OUTPUT_METER_FLOOR_DB, OUTPUT_METER_MARKS } from "../../lib/channelTelemetry";
import { CommitNumberInput } from "../CommitNumberInput";

export const SLIDER_HEIGHT = 220;

/** Bottom of the Out dB / Limit dB scale. Also the value a `null` reading
 * renders at, so a channel with no telemetry sits unlit on both columns. */
export const LIMITER_METER_FLOOR = OUTPUT_METER_FLOOR_DB;

/** Scale for the Out dB/Limit dB columns. `0` means rated max output on the
 * Out column and *no* gain reduction on the Limit column. */
export const LIMITER_METER_MARKS = OUTPUT_METER_MARKS;

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
export function ThresholdSliderColumn({
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

export function fmtDb(db: number | null): string {
  return db === null ? "—" : `${db.toFixed(1)} dB`;
}

/** `Out dB`/`Limit dB` columns — `Out dB` is an output level meter on the
 * shared gradient, `Limit dB` is a gain-reduction meter on a flat track
 * hanging from the top (see `fillFrom`). "Empty" is a different number for
 * each: the scale's floor for a level meter, but `0` for a reduction meter,
 * where the floor would mean 40dB of gain reduction. A `null` reading uses
 * whichever of the two leaves the track unlit, so no data never reads as a
 * pinned meter. */
export function LimiterMeterColumn({
  label,
  gradient,
  levelDb,
  valueText,
  fillFrom,
  peakHold,
  marks = LIMITER_METER_MARKS,
  zones,
  min = LIMITER_METER_FLOOR,
  max = 0,
}: {
  label: string;
  min?: number;
  max?: number;
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
        min={min}
        max={max}
        value={levelDb ?? (fillFrom === "max" ? max : min)}
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
/** A stage's ON/OFF button, named above it when the slider column that
 * would name it isn't shown (`meters` off). */
export function StageToggle({ label, enabled, onClick }: { label: string | null; enabled: boolean; onClick: () => void }) {
  if (!label) return <OnOffButton enabled={enabled} onClick={onClick} />;
  return (
    <div className="flex flex-col gap-1">
      <span
        style={{
          fontSize: "var(--amp-font-size-sm)",
          fontWeight: 700,
          color: "var(--amp-color-dimmed)",
          textTransform: "uppercase",
          textAlign: "center",
        }}
      >
        {label}
      </span>
      <OnOffButton enabled={enabled} onClick={onClick} />
    </div>
  );
}

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

/** A labelled `CommitNumberInput`: the value is written once, on blur or
 * Enter, never per keystroke.
 *
 * This used to commit on every keystroke, from a field whose text was
 * re-rendered from the committed number each time, which made it impossible
 * to edit by typing: clearing it parsed as NaN and snapped back, the first
 * digit of a multi-digit value was clamped to `min` before the second could
 * be typed, and a decimal point vanished as soon as it was typed ("2." is 2).
 * On a live amp each of those keystrokes was also a limiter write — typing
 * 150 set the threshold to 1, then 15, on the way. */
export function LimiterNumberField({
  label,
  suffix,
  value,
  min,
  max,
  disabled,
  integer,
  onCommit,
}: {
  label?: string;
  suffix?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  integer?: boolean;
  onCommit?: (value: number) => void;
}) {
  // Rounded for display only; min/max stay exact so a clamp lands on the true
  // floor/ceiling. Leaving the shown figure as is never writes, even when it
  // sits just outside an un-round bound — see `CommitNumberInput`'s commit.
  const round = (n: number) => (integer ? Math.round(n) : Number(n.toFixed(2)));
  const displayValue = round(value);
  return (
    <div className="flex flex-col gap-1" style={{ flex: "0 1 140px", minWidth: 92 }}>
      {label && <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 500 }}>{label}</span>}
      <CommitNumberInput
        value={displayValue}
        min={min}
        max={max}
        step={integer ? 1 : 0.1}
        suffix={suffix}
        integer={integer}
        disabled={disabled || !onCommit}
        format={(n) => String(round(n))}
        onCommit={(value) => onCommit?.(value)}
      />
    </div>
  );
}

export function LimiterFieldRow({
  label,
  unit,
  value,
  min,
  max,
  disabled,
  integer,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Restricts this field to whole numbers: a typed fraction is rounded when
   * it is committed. Used for the Wattage fields, which read as round Watt
   * figures rather than the more precise (and more naturally fractional)
   * voltage thresholds, and for the times and the Release multiplier, which
   * the amp stores as whole numbers (`u16` ms, `u8` multiplier — see
   * `merge_rms`/`merge_peak` in `write_helpers.rs`). A fraction there would
   * be truncated on the wire while the field went on showing it. */
  integer?: boolean;
  onCommit?: (value: number) => void;
}) {
  return (
    <div className="flex flex-nowrap items-center justify-between gap-2" style={{ opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>{label}</span>
      <LimiterNumberField
        suffix={` ${unit}`}
        min={min}
        max={max}
        integer={integer}
        value={value}
        disabled={disabled || !onCommit}
        onCommit={onCommit}
      />
    </div>
  );
}
