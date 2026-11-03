import { useState } from "react";
import { Activity, Volume2, VolumeX } from "lucide-react";
import { CommitNumberInput } from "../CommitNumberInput";
import { InputClipPill } from "../InputClipPill";
import { StatEditorTile, StatReadout, StatToggle } from "../StatTiles";
import { useActionFeedback } from "../../hooks/useActionFeedback";
import type { ActionResult } from "../../lib/actionResult";
import type { AmpAssignment } from "../../lib/bindings";
import type { ChannelTelemetry } from "../../lib/channelTelemetry";
import { usePreference } from "../../lib/preferences";
import { ChannelLevelMeter } from "./meters";
import { LinkTarget, RenameableLabel, TilePopover, activeFilterCount } from "./parts";

export function InputChannelRow({
  channel,
  telemetry,
  delayMin,
  delayMax,
  nameMaxLength,
  onDelayChange,
  onMuteToggle,
  onOpenEq,
  onRename,
}: {
  channel: AmpAssignment["channels"][number];
  telemetry: ChannelTelemetry;
  delayMin: number | null;
  delayMax: number | null;
  nameMaxLength: number;
  onDelayChange: (value: number) => Promise<ActionResult>;
  onMuteToggle: () => Promise<ActionResult>;
  onOpenEq: () => void;
  onRename: (name: string | null) => void;
}) {
  const [delayOpened, setDelayOpened] = useState(false);
  // The delay tile only opens its editor; the write is committed from the
  // popover, so the tile follows this controller rather than its own click.
  const delayFeedback = useActionFeedback();
  const muted = channel.inputMuted ?? false;
  const delayInMs = channel.delayInMs ?? 0;
  const eqActive = activeFilterCount(channel.inputEq);
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");

  return (
    <div>
      <RenameableLabel
        defaultLabel={`In${channel.channelIndex + 1}`}
        name={channel.inputName}
        maxLength={nameMaxLength}
        onRename={onRename}
        trailing={<InputClipPill clipping={telemetry.inputClipping} raw={telemetry.inputStateRaw} />}
      />
      <div className="flex items-center gap-2">
        <ChannelLevelMeter
          level={telemetry.inputDbv}
          disabled={muted}
          peakHold={peakHoldSurfaces.includes("input")}
        />
        {/* Own wrapping cluster, same as the output strip — see the note
         * there on why the tiles don't share the meter's row. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatReadout
            value={
              telemetry.inputDbv === null ? "—" : telemetry.inputDbv.toFixed(1)
            }
            label="dBV"
          />
          {/* Mute is the first control after the meter and its live readouts on
           * both the input and the output strip, so the one control that
           * silences a channel is always in the same place rather than at the
           * end of a queue of editors. */}
          <LinkTarget scope="muteIn" channel={channel.channelIndex}>
          <StatToggle
            label="Mute"
            engaged={muted}
            visualValidation
            onClick={onMuteToggle}
            icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          />
          </LinkTarget>
          <TilePopover
            opened={delayOpened}
            onOpenChange={setDelayOpened}
            width={200}
            trigger={
              <StatEditorTile
                value={delayInMs.toFixed(1)}
                label="Delay ms"
                modified={delayInMs !== 0}
                visualValidation={delayFeedback}
                onClick={() => setDelayOpened((o) => !o)}
              />
            }
          >
            <div className="flex flex-col gap-2">
              <span
                style={{
                  fontSize: "var(--amp-font-size-xs)",
                  fontWeight: 700,
                  color: "var(--amp-color-dimmed)",
                  textTransform: "uppercase",
                  textAlign: "center",
                }}
              >
                Input Delay
              </span>
              <CommitNumberInput
                value={delayInMs}
                min={delayMin ?? undefined}
                max={delayMax ?? undefined}
                step={0.01}
                suffix=" ms"
                onCommit={(value) => void delayFeedback.track(onDelayChange(value))}
              />
            </div>
          </TilePopover>
          {/* Accented when the chain is doing anything at all. Deliberately
           * binary rather than a band count: a count says how many boxes are
           * ticked, not whether the channel is shaped — one band at +12 dB and
           * one at -0.5 dB both read as "2". */}
          <LinkTarget scope="inputEq" channel={channel.channelIndex}>
          <StatEditorTile
            label="EQ In"
            opens="view"
            modified={eqActive > 0}
            icon={<Activity size={16} />}
            onClick={onOpenEq}
          />
          </LinkTarget>
        </div>
      </div>
    </div>
  );
}
