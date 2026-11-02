import { ACTION_OK, type ActionResult } from "./actionResult";
import type { ConfigureActions } from "./configureActions";

/** Channel action linking, ported from the old app's `amp-action-linking.ts`:
 * per kind of action, groups of channels that move together, so changing one
 * channel writes the same value to the rest of its group. Local to this
 * machine (`channelLinks` in `preferences.ts`), never sent to the amp. */
export type LinkScope =
  | "muteIn"
  | "inputEq"
  | "muteOut"
  | "noiseGateOut"
  | "volumeOut"
  | "polarityOut"
  | "trimOut"
  | "delayOut"
  | "outputEq";

/** Groups per scope. A channel is in at most one group of a scope. */
export type LinkConfig = Partial<Record<LinkScope, number[][]>>;

export const NO_LINKS: LinkConfig = {};

/** The channel itself first, then the rest of its group. */
export function linkedChannels(config: LinkConfig, scope: LinkScope, channel: number): number[] {
  const group = config[scope]?.find((g) => g.includes(channel));
  return group ? [channel, ...group.filter((c) => c !== channel)] : [channel];
}

/** One after another, not in parallel: every project write answers with the
 * whole `Project`, so overlapping answers could overwrite each other. Stops
 * nothing on a failure — the other channels still get the value — and reports
 * the first one. */
async function writeAll(channels: number[], write: (channel: number) => Promise<ActionResult>): Promise<ActionResult> {
  let outcome = ACTION_OK;
  for (const channel of channels) {
    const result = await write(channel);
    if (outcome.ok) outcome = result;
  }
  return outcome;
}

/** Routes the linkable setters through their groups. Optional members stay
 * absent, so an edit-locked amp's controls still render disabled. */
export function linkConfigureActions(
  actions: ConfigureActions,
  config: LinkConfig,
  channelCount: number,
): ConfigureActions {
  const targets = (scope: LinkScope, channel: number) =>
    linkedChannels(config, scope, channel).filter((c) => c < channelCount);
  const eqScope = (direction: "input" | "output"): LinkScope => (direction === "input" ? "inputEq" : "outputEq");
  const { setEqBand, setCrossoverSlot, setChannelNoiseGate } = actions;

  return {
    ...actions,
    setChannelInputMute: (channel, muted) =>
      writeAll(targets("muteIn", channel), (c) => actions.setChannelInputMute(c, muted)),
    setChannelOutputMute: (channel, muted) =>
      writeAll(targets("muteOut", channel), (c) => actions.setChannelOutputMute(c, muted)),
    setChannelPhaseInvert: (channel, inverted) =>
      writeAll(targets("polarityOut", channel), (c) => actions.setChannelPhaseInvert(c, inverted)),
    // One command carries three separately linked values, so each channel gets
    // only the ones it is linked for.
    setChannelOutput: (channel, trimDb, volumeDb, delayOutMs) => {
      const trim = trimDb === null ? [] : targets("trimOut", channel);
      const volume = volumeDb === null ? [] : targets("volumeOut", channel);
      const delay = delayOutMs === null ? [] : targets("delayOut", channel);
      return writeAll([...new Set([...trim, ...volume, ...delay])], (c) =>
        actions.setChannelOutput(
          c,
          trim.includes(c) ? trimDb : null,
          volume.includes(c) ? volumeDb : null,
          delay.includes(c) ? delayOutMs : null,
        ),
      );
    },
    ...(setChannelNoiseGate && {
      setChannelNoiseGate: (channel, enabled, thresholdDbu) =>
        writeAll(targets("noiseGateOut", channel), (c) => setChannelNoiseGate(c, enabled, thresholdDbu)),
    }),
    ...(setEqBand && {
      setEqBand: (channel, direction, bandIndex, patch) =>
        writeAll(targets(eqScope(direction), channel), (c) => setEqBand(c, direction, bandIndex, patch)),
    }),
    ...(setCrossoverSlot && {
      setCrossoverSlot: (channel, direction, slot, patch) =>
        writeAll(targets(eqScope(direction), channel), (c) => setCrossoverSlot(c, direction, slot, patch)),
    }),
  };
}
