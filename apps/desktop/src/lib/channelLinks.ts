import { ACTION_OK, type ActionResult } from "./actionResult";
import type { AmpChannel } from "./bindings";
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

/** Below this, two output volumes count as equal (the amp's step is 0.1 dB). */
export const VOLUME_EQUAL_DB = 0.05;

/** Output volumes move together on every amp unless turned off app-wide
 * (`outputVolumesTogether`, the Overview's Together switch), as the amp's
 * encoder moves them: it is the amp's master, ways are Trim's. Off, an amp's
 * own Volume links (Linking tab) apply. */
export function withVolumeTogether(config: LinkConfig, channelCount: number, together: boolean): LinkConfig {
  return together ? { ...config, volumeOut: [Array.from({ length: channelCount }, (_, c) => c)] } : config;
}

/** The channel itself first, then the rest of its group. */
export function linkedChannels(config: LinkConfig, scope: LinkScope, channel: number): number[] {
  const group = config[scope]?.find((g) => g.includes(channel));
  return group ? [channel, ...group.filter((c) => c !== channel)] : [channel];
}

/** One after another, not in parallel: every project write answers with the
 * whole `Project`, so overlapping answers could overwrite each other. Stops
 * nothing on a failure — the other channels still get the value — and reports
 * the first one. */
export async function writeAll(channels: number[], write: (channel: number) => Promise<ActionResult>): Promise<ActionResult> {
  let outcome = ACTION_OK;
  for (const channel of channels) {
    const result = await write(channel);
    if (outcome.ok) outcome = result;
  }
  return outcome;
}

/** Routes the linkable setters through their groups. Optional members stay
 * absent, so an edit-locked amp's controls still render disabled.
 *
 * Volume moves relatively: every linked output by the step asked of the one
 * changed, each clamped to `volumeRange`, so outputs left unequal (edited
 * singly before) keep their differences. Equal outputs
 * get the same value, exactly as an absolute link would give them. */
export function linkConfigureActions(
  actions: ConfigureActions,
  config: LinkConfig,
  channels: AmpChannel[],
  volumeRange: { min: number; max: number },
): ConfigureActions {
  const channelCount = channels.length;
  const volumeOf = (c: number) => channels.find((ch) => ch.channelIndex === c)?.outputVolumeDb ?? 0;
  const targets = (scope: LinkScope, channel: number) =>
    linkedChannels(config, scope, channel).filter((c) => c < channelCount);
  const eqScope = (direction: "input" | "output"): LinkScope => (direction === "input" ? "inputEq" : "outputEq");
  const { setEqBand, setCrossoverSlot, setChannelNoiseGate, setOutputVolumes } = actions;

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
      const step = volumeDb === null ? 0 : volumeDb - volumeOf(channel);
      const volumeFor = (c: number) => Math.min(volumeRange.max, Math.max(volumeRange.min, volumeOf(c) + step));
      // Volume alone on a live amp: one write for every output, so no poll
      // lands between them (`setOutputVolumes`).
      if (setOutputVolumes && volumeDb !== null && trimDb === null && delayOutMs === null) {
        return setOutputVolumes(volume.map((c) => ({ channelIndex: c, volumeDb: volumeFor(c) })));
      }
      return writeAll([...new Set([...trim, ...volume, ...delay])], (c) =>
        actions.setChannelOutput(
          c,
          trim.includes(c) ? trimDb : null,
          volume.includes(c) ? volumeFor(c) : null,
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
