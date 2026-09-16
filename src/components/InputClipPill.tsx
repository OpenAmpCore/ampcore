import { Tooltip } from "@heroui/react";

/** Input clip indicator — the heartbeat's `InStates` byte, whose vendor enum
 * is `InputChState { Clip = 0, None = 1 }`. Deliberately not a
 * `ChannelStateBadge`: inputs have no operating state, only this one flag, and
 * conflating the two is exactly the mistake this replaced.
 *
 * Renders nothing unless the input is actually clipping, matching how the
 * output state pill only appears when there is something to say. `null` (no
 * reading, or a byte outside the known set) also renders nothing rather than
 * claiming the input is clean.
 *
 * NOTE: the polarity here follows the vendor, which is not yet confirmed on
 * hardware — the prior web implementation reads the same `0` as "signal
 * present". See `Telemetry::input_clipping`. */
export function InputClipPill({ clipping, raw }: { clipping: boolean | null; raw?: number | null }) {
  if (clipping !== true) return null;

  const color = "var(--amp-color-red-5)";
  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <span
          className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[9px] font-semibold leading-tight"
          style={{
            borderColor: `color-mix(in srgb, ${color} 60%, transparent)`,
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
          }}
        >
          Clip
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>
        {raw === null || raw === undefined ? "Input clipping" : `Input clipping (wire value ${raw})`}
      </Tooltip.Content>
    </Tooltip>
  );
}
