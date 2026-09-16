import { Tooltip } from "@heroui/react";
import type { AmpChannelState } from "../lib/bindings";
import { CHANNEL_STATE_LABEL, channelStateTone, isNominalChannelState } from "../lib/channelState";

/** `color-mix` tint, the same way `StatTiles.tsx` builds its tile washes. */
function wash(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** A state pill, shaped after the reference app's `ChannelFlagPills`: a small
 * rounded-full chip tinted in its state's colour — border at 60%, background
 * at 15%, text at full — rather than a stock Mantine `Badge`, whose default
 * uppercase turned `Standby` into `STANDBY`.
 *
 * Lives in the channel row's *header*, beside the channel name, never in the
 * tile row: the reference app floats it over the card's top-left corner for
 * the same reason, and our tile rows have a fixed width budget (see
 * `OUTPUT_ROW_MAX_WIDTH`) that an extra item wraps.
 *
 * `null` means genuinely unknown — no telemetry yet, a channel past the end of
 * the packet's state array, or a firmware family with no state table — and
 * renders as a dash rather than defaulting to "Normal". `raw` is the wire value
 * it decoded from, shown in the tooltip so a surprising `Unknown` can be traced
 * to an actual byte without a rebuild. */
export function ChannelStateBadge({
  state,
  raw,
  hideNominal,
}: {
  state: AmpChannelState | null;
  raw?: number | null;
  /** Render nothing while the state is Normal/Run — for the channel rows,
   * where a pill appearing is the point, and which is what the reference app
   * does too. Diagnostic tables leave this off so their State column always
   * has a value. */
  hideNominal?: boolean;
}) {
  if (state !== null && hideNominal && isNominalChannelState(state)) return null;

  const label = state === null ? "—" : CHANNEL_STATE_LABEL[state];
  const tone = state === null ? "gray" : channelStateTone(state);
  const color = `var(--amp-color-${tone}-5)`;
  const tooltip =
    state === null
      ? "No state reading from this amp"
      : raw === null || raw === undefined
        ? label
        : `${label} (wire value ${raw})`;

  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <span
          className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[9px] font-semibold leading-tight"
          style={{
            borderColor: wash(color, 60),
            background: wash(color, 15),
            color,
            opacity: state === null ? 0.5 : undefined,
          }}
        >
          {label}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>{tooltip}</Tooltip.Content>
    </Tooltip>
  );
}
