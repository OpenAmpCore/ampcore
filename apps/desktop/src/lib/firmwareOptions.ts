import type { AmpProtocol } from "./bindings";

// Known firmware versions per protocol — determines which parameter
// ranges/units the (future, not-yet-built) Configure UI should use, since
// that can differ between firmware revisions of the same protocol (e.g.
// noise gate threshold range). Offline planning has no live device to sniff
// this from, so the user picks it explicitly when adding an amp.
export const FIRMWARE_OPTIONS_BY_PROTOCOL: Record<AmpProtocol, string[]> = {
  cvrUdp: ["1.1.9", "1.1.8"],
};

export function firmwareOptionsFor(protocol: AmpProtocol | undefined): string[] {
  return protocol ? (FIRMWARE_OPTIONS_BY_PROTOCOL[protocol] ?? []) : [];
}
