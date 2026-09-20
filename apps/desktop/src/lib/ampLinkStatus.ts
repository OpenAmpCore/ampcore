import type { AmpAssignment, DiscoveredDevice } from "./bindings";

/** Whether a project amp is tied to real hardware, and if so whether that
 * hardware is currently reachable. */
export type AmpLinkStatus = "online" | "offline" | "unlinked";

export const AMP_LINK_STATUS_META: Record<AmpLinkStatus, { color: string; label: string }> = {
  online: { color: "green", label: "Online" },
  offline: { color: "red", label: "Offline" },
  unlinked: { color: "gray", label: "Unlinked" },
};

/** "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff" and "aabbccddeeff" all compare equal. */
function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

/** The discovered device whose MAC matches the assignment's linked MAC, if any. */
export function linkedDeviceFor(
  assignment: AmpAssignment,
  devices: DiscoveredDevice[],
): DiscoveredDevice | undefined {
  if (!assignment.mac) return undefined;
  const mac = normalizeMac(assignment.mac);
  return devices.find((d) => normalizeMac(d.mac) === mac);
}

/** No MAC = unlinked; linked but not currently discovered/online = offline. */
export function ampLinkStatus(assignment: AmpAssignment, devices: DiscoveredDevice[]): AmpLinkStatus {
  if (!assignment.mac) return "unlinked";
  return linkedDeviceFor(assignment, devices)?.online ? "online" : "offline";
}
