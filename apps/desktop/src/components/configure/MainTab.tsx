import { Fragment, useState, type ReactNode } from "react";
import { useConfirm } from "../ConfirmDialog";
import { SECTION_TITLE } from "../fieldClasses";
import { ACTION_UNAVAILABLE } from "../../lib/actionResult";
import type { AmpAssignment, PowerMode } from "../../lib/bindings";
import { channelTelemetry, outputLetter } from "../../lib/channelTelemetry";
import { linkedChannels, NO_LINKS, type LinkScope } from "../../lib/channelLinks";
import { ChannelEditorModal, type EditorTarget } from "./ChannelEditorModal";
import { InputChannelRow } from "./InputChannelRow";
import { BridgePairSidebar, OutputChannelRow } from "./OutputChannelRow";
import type { ConfigurableTabProps } from "./parts";

/* Channel-strip column caps. Both the Input and Output panes render a
 * centred column of channel rows; without a cap a row's `wrap="wrap"` Group
 * simply grows to whatever the window gives it, which is why the Output tab
 * stretched edge-to-edge on a wide window while Input did not.
 *
 * The two values differ because the rows genuinely differ: an input row is a
 * meter plus 4 tiles, an output row a meter plus up to 12 (V, °C, Mute, Vol,
 * Trim, EQ, FIR, Delay, Pol, LIM, Gate, Mode). Each cap is that row's
 * natural one-line width — 72px per tile, a 10px `gap="xs"` between them,
 * plus the meter's 200px flex basis — so the row fills its cap exactly and
 * wraps below it rather than stranding a gutter or stretching. */
const INPUT_ROW_MAX_WIDTH = 760;

const OUTPUT_ROW_MAX_WIDTH = 1180;

/** One titled card of the Main tab. Both cards span the pane; `maxWidth` caps
 * the rows inside at their natural one-line width (see `INPUT_ROW_MAX_WIDTH`). */
export function MainSection({
  title,
  maxWidth,
  actions,
  children,
}: {
  title: string;
  maxWidth: number;
  /** Small buttons beside the title, acting on the whole card. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className={SECTION_TITLE}>{title}</h3>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div className="min-w-0 rounded-xl border border-[var(--amp-color-default-border)] p-3">
        <div className="flex w-full min-w-0 flex-col gap-4" style={{ maxWidth }}>
          {children}
        </div>
      </div>
    </section>
  );
}

/** The Main tab: every input above every output in one scrolling view, as in
 * the old app. A row's EQ / FIR / LIM tile opens `ChannelEditorModal`. */
export function MainTab({
  assignment,
  capability,
  linkConfig = NO_LINKS,
  actions,
  telemetry,
  deviceId,
  speakerStates,
  onOpenSpeakers,
  locked,
}: ConfigurableTabProps) {
  const inputDelayRange = capability.paramRanges.delayInMs;
  const trimRange = capability.paramRanges.outputTrimDb;
  const volumeRange = capability.paramRanges.outputVolumeDb;
  const delayRange = capability.paramRanges.delayOutMs;
  const noiseGateThresholdRange = capability.paramRanges.noiseGateThresholdDbu;
  const nameMaxLength = capability.paramRanges.channelNameMaxLength;
  const noiseGateThresholdAdjustable = capability.firmware.noiseGateThreshold;
  const powerModes = capability.topology.powerModes;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  async function handleChange(
    channelIndex: number,
    field: "trim" | "volume" | "delay",
    value: number,
  ) {
    return actions.setChannelOutput(
      channelIndex,
      field === "trim" ? value : null,
      field === "volume" ? value : null,
      field === "delay" ? value : null,
    );
  }

  async function handleNoiseGateChange(
    channelIndex: number,
    enabled: boolean,
    thresholdDbu: number,
  ) {
    if (!actions.setChannelNoiseGate) return ACTION_UNAVAILABLE;
    return actions.setChannelNoiseGate(channelIndex, enabled, thresholdDbu);
  }

  async function handlePhaseInvertToggle(
    channelIndex: number,
    inverted: boolean,
  ) {
    return actions.setChannelPhaseInvert(channelIndex, inverted);
  }

  async function handleRename(channelIndex: number, direction: "input" | "output", name: string | null) {
    if (!actions.setChannelName) return;
    await actions.setChannelName(channelIndex, direction, name);
  }

  async function handleMuteToggle(channelIndex: number, muted: boolean) {
    return actions.setChannelOutputMute(channelIndex, muted);
  }

  async function handlePowerModeChange(channelIndex: number, mode: PowerMode) {
    return actions.setChannelPowerMode(channelIndex, mode);
  }

  async function handleBridgeToggle(
    pairLeaderChannelIndex: number,
    bridged: boolean,
    leaderLetter: string,
    followerLetter: string,
  ) {
    if (!actions.setOutputBridge) return;
    const ok = await confirm(
      bridged
        ? {
            title: `Bridge outputs ${leaderLetter} and ${followerLetter}?`,
            description: `${followerLetter} will follow ${leaderLetter} at combined power. Make sure it's wired for bridge mode first.`,
            image: { light: "/bridged_graphic_b.png", dark: "/bridged_graphic_w.png" },
            confirmLabel: "Bridge",
          }
        : {
            title: `Unbridge outputs ${leaderLetter} and ${followerLetter}?`,
            description: `${leaderLetter} and ${followerLetter} go back to driving separate speakers. Rewire them first.`,
            confirmLabel: "Unbridge",
          },
    );
    if (!ok) return;
    await actions.setOutputBridge(pairLeaderChannelIndex, bridged);
  }

  const letterLabel = (c: AmpAssignment["channels"][number]) =>
    outputLetter(c.channelIndex);

  // Fixed adjacent pairing (0,1), (2,3), … — mirrors the old app's bridging
  // convention. A trailing unpaired channel (odd total count) has no
  // partner and no bridge option, per `AmpChannel.output_bridged`'s doc
  // comment.
  const channelPairs: Array<
    [
      AmpAssignment["channels"][number],
      AmpAssignment["channels"][number] | undefined,
    ]
  > = [];
  for (let i = 0; i < assignment.channels.length; i += 2) {
    channelPairs.push([assignment.channels[i], assignment.channels[i + 1]]);
  }

  // Straight on the DOM: this tab re-renders at meter rate, and hovering must
  // not add to that. React leaves the attribute alone, it doesn't own it.
  function highlightLinked(root: HTMLElement, target: Element | null) {
    root.querySelectorAll("[data-link-hot]").forEach((el) => el.removeAttribute("data-link-hot"));
    const tile = target?.closest<HTMLElement>("[data-link-scope]");
    if (!tile) return;
    const scope = tile.dataset.linkScope as LinkScope;
    const group = linkedChannels(linkConfig, scope, Number(tile.dataset.linkChannel));
    if (group.length < 2) return;
    for (const channel of group) {
      root
        .querySelector(`[data-link-scope="${scope}"][data-link-channel="${channel}"]`)
        ?.setAttribute("data-link-hot", "");
    }
  }

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      onMouseOver={(e) => highlightLinked(e.currentTarget, e.target as Element)}
      onMouseLeave={(e) => highlightLinked(e.currentTarget, null)}
    >
      {confirmDialog}
      <ChannelEditorModal
        target={editor}
        onTargetChange={setEditor}
        assignment={assignment}
        capability={capability}
        actions={actions}
        telemetry={telemetry}
        deviceId={deviceId}
        locked={locked}
      />
      {/* Both cards share the wider (output) row's width, so their edges line up. */}
      <div className="mx-auto flex w-full min-w-0 flex-col gap-4 p-4" style={{ maxWidth: OUTPUT_ROW_MAX_WIDTH + 58 }}>
        <MainSection title="Input" maxWidth={INPUT_ROW_MAX_WIDTH}>
          {assignment.channels.map((channel) => (
            <InputChannelRow
              key={channel.channelIndex}
              channel={channel}
              telemetry={channelTelemetry(telemetry, channel.channelIndex, ratedRmsVoltage)}
              delayMin={inputDelayRange.min}
              delayMax={inputDelayRange.max}
              nameMaxLength={nameMaxLength}
              onDelayChange={(value) => actions.setChannelDelayIn(channel.channelIndex, value)}
              onMuteToggle={() => actions.setChannelInputMute(channel.channelIndex, !(channel.inputMuted ?? false))}
              onOpenEq={() => setEditor({ kind: "inputEq", channelIndex: channel.channelIndex })}
              onRename={(name) => handleRename(channel.channelIndex, "input", name)}
            />
          ))}
        </MainSection>
        <MainSection title="Output" maxWidth={OUTPUT_ROW_MAX_WIDTH}>
                {channelPairs.map(([leader, follower]) => {
                  const bridged = Boolean(
                    follower && (leader.outputBridged ?? false),
                  );
                  const row = (channel: AmpAssignment["channels"][number]) => (
                    <OutputChannelRow
                      key={channel.channelIndex}
                      channel={channel}
                      speaker={speakerStates?.get(channel.channelIndex)}
                      onOpenSpeakers={onOpenSpeakers}
                      telemetry={channelTelemetry(
                        telemetry,
                        channel.channelIndex,
                        ratedRmsVoltage,
                      )}
                      ratedRmsVoltage={ratedRmsVoltage}
                      rmsThresholdRangeMax={capability.paramRanges.rmsLimiterThresholdVrms.max}
                      trimMin={trimRange.min}
                      trimMax={trimRange.max}
                      volumeMin={volumeRange.min}
                      volumeMax={volumeRange.max}
                      delayMin={delayRange.min}
                      delayMax={delayRange.max}
                      noiseGateThresholdMin={noiseGateThresholdRange.min}
                      noiseGateThresholdMax={noiseGateThresholdRange.max}
                      noiseGateThresholdAdjustable={
                        noiseGateThresholdAdjustable
                      }
                      nameMaxLength={nameMaxLength}
                      powerModes={powerModes}
                      onChange={(field, value) =>
                        handleChange(channel.channelIndex, field, value)
                      }
                      onOpenFir={() => setEditor({ kind: "fir", channelIndex: channel.channelIndex })}
                      onOpenEq={() => setEditor({ kind: "outputEq", channelIndex: channel.channelIndex })}
                      onOpenLimiter={() => setEditor({ kind: "limiter", channelIndex: channel.channelIndex })}
                      onNoiseGateChange={(enabled, thresholdDbu) =>
                        handleNoiseGateChange(
                          channel.channelIndex,
                          enabled,
                          thresholdDbu,
                        )
                      }
                      onPhaseInvertToggle={() =>
                        handlePhaseInvertToggle(
                          channel.channelIndex,
                          !(channel.outputPhaseInverted ?? false),
                        )
                      }
                      onPowerModeChange={(mode) =>
                        handlePowerModeChange(channel.channelIndex, mode)
                      }
                      onMuteToggle={() =>
                        handleMuteToggle(
                          channel.channelIndex,
                          !(channel.outputMuted ?? false),
                        )
                      }
                      onRename={(name) => handleRename(channel.channelIndex, "output", name)}
                    />
                  );
                  if (!follower) {
                    return (
                      <Fragment key={leader.channelIndex}>
                        {row(leader)}
                      </Fragment>
                    );
                  }
                  return (
                    <div key={leader.channelIndex} className="flex flex-nowrap items-stretch gap-2">
                      <BridgePairSidebar
                        leaderLetter={letterLabel(leader)}
                        followerLetter={letterLabel(follower)}
                        bridged={bridged}
                        disabled={!actions.setOutputBridge}
                        onClick={() =>
                          handleBridgeToggle(
                            leader.channelIndex,
                            !bridged,
                            letterLabel(leader),
                            letterLabel(follower),
                          )
                        }
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-4">
                        {row(leader)}
                        <div
                          style={{
                            opacity: bridged ? 0.4 : 1,
                            pointerEvents: bridged ? "none" : "auto",
                            filter: bridged ? "grayscale(1)" : "none",
                          }}
                        >
                          {row(follower)}
                        </div>
                      </div>
                    </div>
                  );
                })}
        </MainSection>
      </div>
    </div>
  );
}
