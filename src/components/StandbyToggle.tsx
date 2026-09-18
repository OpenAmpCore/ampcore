import { useState } from "react";
import { Button, Spinner, Tooltip } from "@heroui/react";
import { notifications } from "../lib/notify";
import { Power, PowerOff } from "lucide-react";
import { commands } from "../lib/bindings";

/** Amp standby (FC=15), the amp-level sibling of `RotaryLockToggle`: green
 * power icon when the amp is running, orange when it is in standby. Reads the
 * amp's own state from FC=27 (`standby`), so the icon follows the hardware
 * rather than the click — including when someone uses the amp's front panel.
 *
 * No confirmation step and no optimistic update. The write is delivery-
 * confirmed by the driver's ACK-with-refires path (see `write.rs`), and the
 * ~200ms FC=27 poll then moves the icon; that is a stronger guarantee than the
 * reference web app's fire-and-forget plus 5-second heartbeat watch, so there
 * is nothing left for a verify loop here to add. */
export function StandbyToggle({
  deviceId,
  standby,
  standbyLocked,
}: {
  /** Online network amp to control; `undefined` renders the toggle disabled. */
  deviceId?: string;
  standby: boolean | null | undefined;
  /** The amp is refusing standby writes (FC=27 header value 2) — the control
   * is disabled rather than sending something the amp will drop. */
  standbyLocked: boolean | null | undefined;
}) {
  const [pending, setPending] = useState(false);
  const known = deviceId !== undefined && typeof standby === "boolean";
  const lockedOut = standbyLocked === true;
  const canToggle = known && !lockedOut;

  async function toggle() {
    if (!canToggle) return;
    setPending(true);
    const result = await commands.liveControlSetStandby(deviceId, !standby);
    setPending(false);
    if (result.status === "error") {
      notifications.show({ color: "red", title: "Standby failed", message: result.error.message });
    }
  }

  const label = !known
    ? "Standby unavailable"
    : lockedOut
      ? "Standby is locked out on this amp"
      : standby
        ? "Wake amp from standby"
        : "Put amp into standby";

  const color = !canToggle
    ? "var(--amp-color-dimmed)"
    : standby
      ? "var(--amp-color-orange-6)"
      : "var(--amp-color-green-6)";

  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="ghost"
          size="lg"
          className="mt-2 self-center"
          style={{ color }}
          aria-label={label}
          isDisabled={!canToggle}
          onPress={toggle}
        >
          {pending ? <Spinner size="sm" /> : standby ? <PowerOff size={18} /> : <Power size={18} />}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content placement="right" showArrow>
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
