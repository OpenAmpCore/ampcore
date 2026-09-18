import { useMemo } from "react";
import { usePeakHold } from "../hooks/usePeakHold";
import { parseGradientStops, sampleGradient, vibrantColor } from "../lib/gradientColor";

/** A single scale position on a `VuMeter` — doubles as a plain tick label
 * (pass `label`) and/or a colored reference line drawn across the track
 * itself (pass `color`, e.g. a future clip-threshold marker). Both can be
 * combined, since they're really the same concept: "a position on the
 * scale, optionally labeled, optionally colored." */
export interface VuMeterMark {
  value: number;
  label?: string;
  color?: string;
  /** Adds a bloom around the line in its own color, so it reads as lit
   * rather than drawn. Needs `color`. The glow is clipped by the track's
   * bounds, so it spreads along the meter's thickness (which is where it's
   * wanted) and stops at the ends. */
  glow?: boolean;
  /** How much of the meter's *width* this line occupies, as `[start, end]`
   * fractions across the short axis. Defaults to the full width.
   *
   * Lets two marks share one scale position without hiding each other:
   * give them `[0, 0.5]` and `[0.5, 1]` and they sit side by side as one
   * split-color line. Whether to do that always or only when the marks
   * actually collide is the caller's call — this just draws what it's
   * given. */
  span?: readonly [start: number, end: number];
}

/** A shaded band across a span of the scale, drawn *under* the lit fill —
 * so it shows through the unlit part of the track and is covered as the bar
 * rises past it. Use it to mark a region (a limiter's operating zone, a
 * headroom warning), as opposed to a `VuMeterMark`, which marks a single
 * position. */
export interface VuMeterZone {
  /** Scale ends of the band, in either order. */
  from: number;
  to: number;
  color: string;
  /** Defaults to fully opaque; a band under the fill usually wants less. */
  opacity?: number;
}

export interface VuMeterProps {
  orientation: "horizontal" | "vertical";
  min: number;
  max: number;
  /** Current level, clamped to `[min, max]`. Fed by live heartbeat
   * telemetry in the Configure tabs (see `channelTelemetry` in
   * `AmpConfigureView.tsx`); a Project source — or a live device that
   * hasn't sent a heartbeat yet — passes `min`, rendering fully unlit. */
  value: number;
  marks?: VuMeterMark[];
  /** Shaded regions of the scale, painted between the backdrop and the fill
   * in array order. */
  zones?: VuMeterZone[];
  /** Ordered color stops for an evenly-distributed gradient. Omit for a
   * flat `trackColor` fill instead. */
  gradient?: string[];
  /** Color of the unlit shell. */
  trackColor?: string;
  /** Color of the lit fill on a non-gradient meter. Must differ from
   * `trackColor` or the fill is invisible — which is exactly what happened
   * while it defaulted to `trackColor` itself: the bug stayed hidden only
   * because every caller passed `value={min}` (nothing lit) until live
   * telemetry was wired up. Ignored when `gradient` is set. */
  fillColor?: string;
  /** Opacity of the always-visible backdrop (the "unlit shell"), separate
   * from the lit fill's opacity (always 1). The backdrop is always the flat
   * `trackColor` — never the `gradient`, which belongs to the lit fill
   * alone, so an unreached part of the scale never shows its color. */
  backdropOpacity?: number;
  /** Bar thickness in px — height if horizontal, width if vertical. */
  thickness?: number;
  /** Which end the lit fill grows from. `"min"` (default) is a level meter:
   * it fills from the bottom/left up to `value`. `"max"` is a gain-reduction
   * meter: it hangs from the top/right down to `value`, so `value === max`
   * reads as *nothing* (no reduction) and the lit length is the amount of
   * reduction — the opposite of what a level meter means by the same number.
   * The scale labels stay correct either way, since the fill still ends at
   * `value`'s real position. */
  fillFrom?: "min" | "max";
  /** Main-axis length — width if horizontal (default fills the wrapping
   * container, matching every current usage), height if vertical (default
   * 220, matching the Limiter panel's existing slider height). */
  size?: number | string;
  /** Draws a slow-falling peak indicator line alongside the fast bar, fed
   * by `value` through `usePeakHold`. Off by default: it only earns its
   * place on a meter showing a live, changing level — on a static one the
   * line just sits permanently on top of the bar. */
  peakHold?: boolean;
  /** Overrides the peak indicator's color. Left unset, a `gradient` meter
   * derives it per-frame from the gradient itself — a more saturated version
   * of the color at the line's own position, so it reads as the ramp it's
   * riding along, intensified — and a flat meter falls back to the theme's
   * text color. */
  peakColor?: string;
  /** Dims and desaturates the whole meter — same convention as every other
   * disabled control in this app (e.g. `ThresholdSliderColumn` in
   * `LimiterEditor.tsx`, the bridged-follower row wrapper in
   * `AmpConfigureView.tsx`). Use for a muted channel, a bypassed stage, or
   * any other "this reading doesn't currently apply" state. */
  disabled?: boolean;
}

function clampFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Shared VU-style meter — replaces every ad-hoc meter previously duplicated
 * across `AmpConfigureView.tsx` (`MockInputMeter`, `MockLevelMeter`) and
 * `LimiterEditor.tsx` (`MeterColumn`). Renders a dim full-length "unlit"
 * backdrop plus a real full-opacity "lit" fill from `min` up to `value`
 * (classic VU/LED-meter look), with `marks` positioned by actual value
 * (not array index) so unevenly-spaced scales stay correct. Orientation
 * switches both the gradient direction and the fill/mark axis: horizontal
 * fills left→right for the Input/Output/Routing row meters,
 * vertical fills bottom→top (max at the top, like a real meter) for the
 * Limiter panel's Out dB/Limit dB columns. */
export function VuMeter({
  orientation,
  min,
  max,
  value,
  marks = [],
  zones = [],
  gradient,
  trackColor = "var(--amp-color-dark-6)",
  fillColor = "var(--amp-color-teal-5)",
  backdropOpacity = 1,
  thickness = 8,
  size,
  fillFrom = "min",
  disabled = false,
  peakHold = false,
  peakColor,
}: VuMeterProps) {
  const horizontal = orientation === "horizontal";
  const fraction = clampFraction(value, min, max);
  const fromMax = fillFrom === "max";
  /** How much of the track is lit — the complement of `fraction` when the
   * fill hangs from the far end. */
  const litFraction = fromMax ? 1 - fraction : fraction;
  // Floored at `min` so the indicator decays to the bottom of *this* meter's
  // scale rather than some global default.
  // `min` is the peak's floor as well as the scale's: `usePeakHold` returns
  // null — no line, no animation frames — once the peak has *fallen* to it.
  // Deliberately not gated on `value` reaching the floor, which would cut
  // the line off mid-fall the moment a channel went silent.
  const peakDb = usePeakHold(value, peakHold, { floorDb: min });
  const peakFraction = peakDb === null ? null : clampFraction(peakDb, min, max);
  // The stop list is fixed while the sample position moves every frame, so
  // only the parse is memoized — sampling itself is a couple of lerps.
  const gradientStops = useMemo(() => (gradient ? parseGradientStops(gradient) : []), [gradient]);
  const sampledPeak = peakFraction === null ? null : sampleGradient(gradientStops, peakFraction);
  const resolvedPeakColor =
    peakColor ?? (sampledPeak ? vibrantColor(sampledPeak) : "var(--amp-color-text)");
  /** Gradient stops are laid out across the *whole* track and then clipped
   * to the lit width (see `backgroundSize` below), so a given color always
   * sits at the same scale position regardless of the current level —
   * rather than the whole ramp compressing into however much is lit. */
  const litBackground = gradient
    ? `linear-gradient(${horizontal ? "to right" : "to top"}, ${gradient.join(", ")})`
    : fillColor;
  const trackSize = size ?? (horizontal ? "100%" : 220);

  return (
    <div
      style={{
        display: "flex",
        // `row-reverse` puts a vertical meter's scale labels on the left of
        // the track while keeping the track first in the DOM, so the label
        // column stays purely decorative markup after the thing it labels.
        flexDirection: horizontal ? "column" : "row-reverse",
        gap: 4,
        alignItems: horizontal ? "stretch" : "center",
        opacity: disabled ? 0.4 : 1,
        filter: disabled ? "grayscale(1)" : undefined,
      }}
    >
      <div
        className="rounded-sm"
        style={{
          position: "relative",
          width: horizontal ? trackSize : thickness,
          height: horizontal ? thickness : trackSize,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div style={{ position: "absolute", inset: 0, background: trackColor, opacity: backdropOpacity }} />
        {zones.map((zone, i) => {
          // Ends are clamped independently and then ordered, so a band given
          // backwards, or one hanging off the end of the scale, still paints
          // the part of itself that's actually on the meter.
          const a = clampFraction(zone.from, min, max);
          const b = clampFraction(zone.to, min, max);
          const start = Math.min(a, b);
          const span = Math.abs(b - a);
          if (span <= 0) return null;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                background: zone.color,
                opacity: zone.opacity ?? 1,
                ...(horizontal
                  ? { left: `${start * 100}%`, width: `${span * 100}%`, top: 0, bottom: 0 }
                  : { bottom: `${start * 100}%`, height: `${span * 100}%`, left: 0, right: 0 }),
              }}
            />
          );
        })}
        {litFraction > 0 &&
          (horizontal ? (
            <div
              style={{
                position: "absolute",
                ...(fromMax ? { right: 0 } : { left: 0 }),
                top: 0,
                bottom: 0,
                width: `${litFraction * 100}%`,
                background: litBackground,
                // Sized against the lit portion so the gradient still spans
                // the whole track and gets clipped, keeping each color at a
                // fixed scale position; anchored at whichever end the fill
                // grows from so that stretch lands the right way round.
                backgroundSize: gradient ? `${100 / litFraction}% 100%` : undefined,
                backgroundPosition: fromMax ? "right" : "left",
              }}
            />
          ) : (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                ...(fromMax ? { top: 0 } : { bottom: 0 }),
                height: `${litFraction * 100}%`,
                background: litBackground,
                backgroundSize: gradient ? `100% ${100 / litFraction}%` : undefined,
                backgroundPosition: fromMax ? "top" : "bottom",
              }}
            />
          ))}
        {peakFraction !== null && peakFraction > 0 && (
          <div
            style={{
              position: "absolute",
              background: resolvedPeakColor,
              borderRadius: 1,
              // Centred on its own position, then pulled inside the track at
              // full scale so a pinned peak stays visible instead of being
              // clipped by the track's `overflow: hidden`.
              ...(horizontal
                ? { left: `min(calc(${peakFraction * 100}% - 1px), 100% - 2px)`, top: 0, bottom: 0, width: 2 }
                : { bottom: `min(calc(${peakFraction * 100}% - 1px), 100% - 2px)`, left: 0, right: 0, height: 2 }),
            }}
          />
        )}
        {marks
          .filter((mark) => mark.color)
          .map((mark, i) => {
            const t = clampFraction(mark.value, min, max);
            const [spanStart, spanEnd] = mark.span ?? [0, 1];
            const spanOffset = `${spanStart * 100}%`;
            const spanSize = `${(spanEnd - spanStart) * 100}%`;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  background: mark.color,
                  // Two shadows rather than one: a tight core that keeps the
                  // line's own edge crisp, and a wider bloom for the halo.
                  boxShadow: mark.glow ? `0 0 4px ${mark.color}, 0 0 10px ${mark.color}` : undefined,
                  // 2px, not a hairline: these mark real thresholds and
                  // have to stay legible across the fill they sit on.
                  ...(horizontal
                    ? {
                        left: `min(calc(${t * 100}% - 1px), 100% - 2px)`,
                        top: spanOffset,
                        height: spanSize,
                        width: 2,
                      }
                    : {
                        bottom: `min(calc(${t * 100}% - 1px), 100% - 2px)`,
                        left: spanOffset,
                        width: spanSize,
                        height: 2,
                      }),
                }}
              />
            );
          })}
      </div>
      {marks.length > 0 && (
        <div
          style={{
            position: "relative",
            width: horizontal ? trackSize : 20,
            height: horizontal ? 12 : trackSize,
            flexShrink: 0,
          }}
        >
          {marks.map((mark, i) => {
            const t = clampFraction(mark.value, min, max);
            return (
              <span
                key={i}
                style={{
                  fontSize: horizontal ? 8 : 9,
                  color: mark.color ?? "var(--amp-color-dimmed)",
                  position: "absolute",
                  whiteSpace: "nowrap",
                  // The shift scales with the mark's own position instead of
                  // being a flat 50%, so a label is centred on its tick in the
                  // middle of the scale but tucks fully inside the box at
                  // either end. A flat 50% left the end labels overhanging by
                  // half their width, and an absolutely positioned overhang
                  // still counts toward an ancestor's scrollable overflow —
                  // that was enough to raise a scrollbar on the whole Routing
                  // matrix and clip the "0" off the end of every meter.
                  ...(horizontal
                    ? { left: `${t * 100}%`, transform: `translateX(-${t * 100}%)` }
                    // Anchored right, since the column now sits to the left
                    // of the track — labels hug the scale they belong to
                    // rather than drifting away from it.
                    : { bottom: `${t * 100}%`, transform: `translateY(${t * 100}%)`, right: 0 }),
                }}
              >
                {mark.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The shared 5-stop green→amber→red gradient used by every level-style
 * meter (`MockLevelMeter`'s and the Limiter's "Out dB" gradient were
 * previously separate identical strings in two files). */
export const DEFAULT_LEVEL_GRADIENT = ["#0f6e5c 0%", "#2f9e6a 35%", "#d4c94a 65%", "#e0793a 82%", "#d64545 100%"];
