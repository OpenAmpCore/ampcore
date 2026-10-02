import type { AmpProtocol } from "./bindings";

// Known firmware versions per protocol — determines which parameter
// ranges/units the (future, not-yet-built) Configure UI should use, since
// that can differ between firmware revisions of the same protocol (e.g.
// noise gate threshold range). Offline planning has no live device to sniff
// this from, so the user picks it explicitly when adding an amp.
export function firmwareOptionsFor(protocol: AmpProtocol | undefined): string[] {
  return protocol ? ["1.1.9", "1.1.8"] : [];
}
