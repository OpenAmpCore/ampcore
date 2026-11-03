import { Button, ButtonGroup, Modal } from "@heroui/react";
import { EqEditor } from "../EqEditor";
import { LimiterEditor } from "../LimiterEditor";
import { channelTelemetry, outputLetter } from "../../lib/channelTelemetry";
import { FirPanel } from "../FirPanel";
import { useIsCompact } from "../../lib/breakpoints";
import type { ConfigurableTabProps } from "./parts";

/** Which per-channel editor the Main tab has open in its dialog. */
export type EditorTarget = { kind: "inputEq" | "outputEq" | "fir" | "limiter"; channelIndex: number };

const EDITOR_TITLES: Record<EditorTarget["kind"], string> = {
  inputEq: "Input EQ",
  outputEq: "Output EQ",
  fir: "FIR filter",
  limiter: "Limiter",
};

/** How wide the dialog may get per editor; its height follows the content. The
 * EQ's is its ten strips at a comfortable width, the FIR's keeps its two
 * stacked graphs short enough to fit, the limiter's is its own content cap. */
const EDITOR_MAX_WIDTH: Record<EditorTarget["kind"], string> = {
  inputEq: "max-w-[1180px]",
  outputEq: "max-w-[1180px]",
  fir: "max-w-[900px]",
  limiter: "max-w-[720px]",
};

/** The EQ, FIR and limiter editors, opened from a channel row's tile as in the
 * old app. The channel switcher at the top keeps each axis's convention —
 * inputs numbered, outputs lettered — and leaves out a bridged follower. */
export function ChannelEditorModal({
  target,
  onTargetChange,
  assignment,
  capability,
  actions,
  telemetry,
  deviceId,
  locked,
  channelLabel,
  limiterMeters,
}: Pick<ConfigurableTabProps, "assignment" | "capability" | "actions" | "telemetry" | "deviceId" | "locked"> & {
  target: EditorTarget | null;
  onTargetChange: (target: EditorTarget | null) => void;
  /** The switcher's and title's name for a channel, in place of the usual
   * number or letter (the Speaker Library names its ways). */
  channelLabel?: (channelIndex: number) => string;
  /** `LimiterEditor`'s sliders and meters; off in the Speaker Library. */
  limiterMeters?: boolean;
}) {
  const compact = useIsCompact();
  const isInput = target?.kind === "inputEq";
  const channel = assignment.channels.find((c) => c.channelIndex === target?.channelIndex) ?? assignment.channels[0];
  const label = (channelIndex: number) =>
    channelLabel?.(channelIndex) ?? (isInput ? String(channelIndex + 1) : outputLetter(channelIndex));
  const channels = isInput
    ? assignment.channels
    : assignment.channels.filter(
        (c) => !(c.channelIndex % 2 === 1 && assignment.channels[c.channelIndex - 1]?.outputBridged),
      );
  return (
    <Modal.Backdrop isOpen={target !== null} onOpenChange={(open) => !open && onTargetChange(null)}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog className={!compact && target ? EDITOR_MAX_WIDTH[target.kind] : undefined}>
          <Modal.Header>
            {/* Title and channel switcher on one line: every row of height here
                is a row the editor below doesn't get. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <Modal.Heading>{target ? `${EDITOR_TITLES[target.kind]} · ${label(channel.channelIndex)}` : ""}</Modal.Heading>
              {target && (
                <ButtonGroup size="sm">
                  {channels.map((c) => (
                    <Button
                      key={c.channelIndex}
                      variant={c.channelIndex === channel.channelIndex ? "primary" : "ghost"}
                      onPress={() => onTargetChange({ kind: target.kind, channelIndex: c.channelIndex })}
                    >
                      {label(c.channelIndex)}
                    </Button>
                  ))}
                </ButtonGroup>
              )}
            </div>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            {target && (
              // A dialog renders outside the tab's own locked fieldset.
              <fieldset disabled={locked} className="min-w-0" style={{ border: 0, margin: 0, padding: 0 }}>
                <div className="flex min-w-0 flex-col">
                  {target.kind === "fir" ? (
                    <FirPanel
                      key={channel.channelIndex}
                      deviceId={deviceId}
                      channelIndex={channel.channelIndex}
                      label={label(channel.channelIndex)}
                      capability={capability}
                      eq={channel.outputEq}
                      bypassed={channel.firBypassed ?? false}
                      stored={channel.fir}
                      onBypassChange={(next) => actions.setChannelFirBypass(channel.channelIndex, next)}
                      onImportData={
                        actions.setChannelFirData
                          ? (name, coefficients) => actions.setChannelFirData!(channel.channelIndex, name, coefficients)
                          : undefined
                      }
                      onClearData={
                        actions.clearChannelFirData ? () => actions.clearChannelFirData!(channel.channelIndex) : undefined
                      }
                    />
                  ) : target.kind === "limiter" ? (
                    <LimiterEditor
                      key={channel.channelIndex}
                      assignment={assignment}
                      channelIndex={channel.channelIndex}
                      telemetry={channelTelemetry(telemetry, channel.channelIndex, capability.topology.ratedRmsVoltage)}
                      capability={capability}
                      actions={actions}
                      meters={limiterMeters}
                    />
                  ) : (
                    <EqEditor
                      key={`${target.kind}:${channel.channelIndex}`}
                      assignment={assignment}
                      channelIndex={channel.channelIndex}
                      direction={isInput ? "input" : "output"}
                      capability={capability}
                      actions={actions}
                    />
                  )}
                </div>
              </fieldset>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
