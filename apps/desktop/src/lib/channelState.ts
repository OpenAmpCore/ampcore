import type { AmpChannelState } from "./bindings";

/** Display text for each decoded amp/channel state. Follows the labels the
 * vendor software itself shows (`fromat_machineState.cs`) rather than its
 * internal enum identifiers, so a reading here matches what a user sees on the
 * original software and on the amp — including the two cases where the vendor's
 * own identifier and label disagree (`Warning`->"Open", `None`->"Run", see
 * `channel_state_v118.rs`). `PowerError` is the one spelled out rather than
 * copied verbatim: the vendor's "PowerEr" is a truncation, not a term. */
export const CHANNEL_STATE_LABEL: Record<AmpChannelState, string> = {
  offline: "Offline",
  normal: "Normal",
  standby: "Standby",
  fault: "Fault",
  open: "Open",
  overload: "Overload",
  clip: "Clip",
  dcp: "Dcp",
  powerError: "Power Err",
  run: "Run",
  temp: "Temp",
  limit: "Limit",
  sleep: "Sleep",
  unknown: "Unknown",
};

/** States that mean "running, nothing to report". A channel row hides its
 * badge for these (see `ChannelStateBadge`'s `hideNominal`) so the badge's
 * presence is itself the signal, instead of four rows of "Normal" that a user
 * learns to stop reading. */
const NOMINAL_STATES: ReadonlySet<AmpChannelState> = new Set<AmpChannelState>(["normal", "run"]);

export function isNominalChannelState(state: AmpChannelState): boolean {
  return NOMINAL_STATES.has(state);
}

/** Colour per state, as a palette name (see `--amp-color-*` in
 * design-tokens.css).
 *
 * The five the prior web implementation actually renders come straight from
 * its `FLAG_DEFS` (`heartbeat-controls.tsx`): fault red, open orange, temp
 * red, clip yellow, standby blue. Note it disagrees with the vendor's own
 * converter (`fromat_machineState_color.cs`) on temp, which the vendor paints
 * orange — the reference wins, since that is the app these amps were run from.
 *
 * The reference renders *no pill at all* for the remaining five, which leaves
 * real fault conditions invisible. Those are filled in here instead: overload
 * takes the vendor converter's orange, dcp and powerError take red on
 * severity, limit takes yellow to match the row's own LIM tile accent, and
 * sleep takes standby's blue since it is the same kind of state. */
export function channelStateTone(state: AmpChannelState): "red" | "orange" | "yellow" | "blue" | "gray" {
  switch (state) {
    // --- the reference app's own palette ---
    case "fault":
      return "red";
    case "open":
      return "orange";
    case "temp":
      return "red";
    case "clip":
      return "yellow";
    case "standby":
      return "blue";
    // --- ours: states the reference app never shows ---
    case "overload":
      return "orange";
    case "dcp":
    case "powerError":
      return "red";
    case "limit":
      return "yellow";
    case "sleep":
      return "blue";
    // --- nominal, and honestly-unknown ---
    case "normal":
    case "run":
    case "offline":
    case "unknown":
      return "gray";
  }
}
