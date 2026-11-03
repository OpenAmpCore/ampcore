import { Fragment, useRef, useState } from "react";
import { Popover, Button } from "@heroui/react";
import { CommitNumberInput } from "../CommitNumberInput";
import { useConfirm } from "../ConfirmDialog";
import { SECTION_TITLE } from "../fieldClasses";
import { InputClipPill } from "../InputClipPill";
import { StatEditorTile } from "../StatTiles";
import { useActionFeedback } from "../../hooks/useActionFeedback";
import { ACTION_UNAVAILABLE, type ActionResult } from "../../lib/actionResult";
import type { AmpAssignment, BackupPriority, SourceKind, SourceTrims } from "../../lib/bindings";
import { channelTelemetry, outputLetter } from "../../lib/channelTelemetry";
import { Hint } from "../Hint";
import { usePreference } from "../../lib/preferences";
import { MainSection } from "./MainTab";
import { SourcePicker } from "./SourcePicker";
import { ChannelLevelMeter, RoutingOutputMeter } from "./meters";
import { type ConfigurableTabProps, POPOVER_SLOTS } from "./parts";

/** `AmpChannel.sourceTrims`/`backupPriority` are `#[serde(default)]` on the
 * Rust side, so a channel from a project file written before they existed
 * arrives without them. */
const DEFAULT_SOURCE_TRIMS: SourceTrims = {
  analog: { trimDb: 0, delayMs: 0 },
  dante: { trimDb: 0, delayMs: 0 },
};

const DEFAULT_BACKUP_PRIORITY: BackupPriority = { enabled: false, first: 0, second: 1, thresholdDb: -80 };

function MatrixCrosspointCell({
  active,
  gainDb,
  min,
  max,
  onGainChange,
  onActiveChange,
  onHoverChange,
}: {
  active: boolean;
  gainDb: number;
  min: number | null;
  max: number | null;
  onGainChange: (gainDb: number) => Promise<ActionResult>;
  onActiveChange: (active: boolean) => Promise<ActionResult>;
  onHoverChange: (hovering: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  // Both writes — gain and enable/disable — are committed from the popover,
  // so the tile follows this controller rather than its own click.
  const feedback = useActionFeedback();

  return (
    <>
      {/* The wrapper carries the hover tracking that lights up this cell's
       * row and column headers, since the tile itself takes no mouse
       * handlers. `triggerRef` anchors the standalone HeroUI popover below
       * without needing a DialogTrigger-wrapped Aria button here. `flex`
       * keeps it exactly the tile's height — see the note in `TilePopover`. */}
      <div
        ref={triggerRef}
        className="flex"
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
      >
        <StatEditorTile
          // An unrouted cell stays quiet, so the active routes are what the
          // eye lands on.
          value={active ? `${gainDb.toFixed(1)} dB` : <span style={{ color: "var(--amp-color-dimmed)", fontWeight: 400 }}>—</span>}
          label={active ? "On" : "Off"}
          // An active crosspoint is routing engaged, which is what the
          // accent colour means on every other tile.
          modified={active}
          visualValidation={feedback}
          onClick={() => setOpened((o) => !o)}
        />
      </div>
      <Popover.Content
        className={POPOVER_SLOTS.base()}
        triggerRef={triggerRef}
        isOpen={opened}
        onOpenChange={setOpened}
        placement="bottom"
      >
        <Popover.Dialog className={`${POPOVER_SLOTS.dialog()} w-[200px]`}>
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
              Matrix Gain
            </span>
            {/* Commit-on-blur/Enter like every other tile's popover, rather than
             * a write per keystroke — see `CommitNumberInput`. */}
            <CommitNumberInput
              value={gainDb}
              min={min ?? undefined}
              max={max ?? undefined}
              step={0.1}
              suffix=" dB"
              onCommit={(value) => void feedback.track(onGainChange(value))}
            />
            <Button
              fullWidth
              variant={active ? "primary" : "outline"}
              onPress={() => void feedback.track(onActiveChange(!active))}
            >
              {active ? "Disable" : "Enable"}
            </Button>
            {min != null && max != null && (
              <span
                style={{
                  fontSize: "var(--amp-font-size-xs)",
                  color: "var(--amp-color-dimmed)",
                  textAlign: "center",
                }}
              >
                Range: {min.toFixed(1)} to {max > 0 ? "+" : ""}
                {max.toFixed(1)} dB
              </span>
            )}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </>
  );
}

/** Combines Source Selection and Matrix into one page: each channel row
 * picks its physical source and sets its matrix crosspoints side by side,
 * since both are "what feeds this channel" decisions a user makes together
 * when wiring up a routing scheme. */
export function RoutingTab({
  assignment,
  capability,
  actions,
  telemetry,
}: ConfigurableTabProps) {
  const { min, max } = capability.paramRanges.matrixGainDb;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const sourceCount = capability.topology.matrixInputCount;
  const sourceCounts = capability.topology.sourceCounts;
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");
  const [hoveredCell, setHoveredCell] = useState<{
    channelIndex: number;
    sourceIndex: number;
  } | null>(null);

  async function handleSourceChange(
    channelIndex: number,
    kind: SourceKind,
    index: number,
  ) {
    if (!actions.setChannelSource) return ACTION_UNAVAILABLE;
    return actions.setChannelSource(channelIndex, kind, index);
  }

  async function handleSourceTrimChange(
    channelIndex: number,
    kind: SourceKind,
    trimDb: number,
    delayMs: number,
  ) {
    if (!actions.setSourceTrim) return ACTION_UNAVAILABLE;
    return actions.setSourceTrim(channelIndex, kind, trimDb, delayMs);
  }

  async function handleBackupChange(
    channelIndex: number,
    first: number,
    second: number,
    enabled: boolean,
    thresholdDb: number,
  ) {
    if (!actions.setBackupPriority) return ACTION_UNAVAILABLE;
    return actions.setBackupPriority(channelIndex, first, second, enabled, thresholdDb);
  }

  async function handleGainChange(
    channelIndex: number,
    sourceIndex: number,
    gainDb: number,
  ) {
    if (!actions.setMatrixCrosspoint) return ACTION_UNAVAILABLE;
    return actions.setMatrixCrosspoint(channelIndex, sourceIndex, gainDb, null);
  }

  async function handleActiveChange(
    channelIndex: number,
    sourceIndex: number,
    active: boolean,
  ) {
    if (!actions.setMatrixCrosspoint) return ACTION_UNAVAILABLE;
    return actions.setMatrixCrosspoint(channelIndex, sourceIndex, null, active);
  }

  const { confirm, dialog: confirmDialog } = useConfirm();
  const [bulkBusy, setBulkBusy] = useState(false);
  const isFollower = (channelIndex: number) =>
    channelIndex % 2 === 1 && (assignment.channels[channelIndex - 1]?.outputBridged ?? false);
  const crosspointAt = (channel: AmpAssignment["channels"][number], sourceIndex: number) =>
    channel.matrixCrosspoints?.find((c) => c.sourceIndex === sourceIndex) ?? { sourceIndex, gainDb: 0, active: false };

  /** Sets every crosspoint's on/off to `want(output, input)`, writing only the
   * cells that change. Sequential, and stops at the first failure (whose toast
   * the action layer already shows). */
  async function applyMatrix(
    title: string,
    description: string,
    want: (channelIndex: number, sourceIndex: number) => boolean,
  ) {
    const set = actions.setMatrixCrosspoint;
    if (!set || !(await confirm({ title, description, confirmLabel: "Apply" }))) return;
    setBulkBusy(true);
    try {
      for (const channel of assignment.channels) {
        if (isFollower(channel.channelIndex)) continue;
        for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex++) {
          const active = want(channel.channelIndex, sourceIndex);
          if (crosspointAt(channel, sourceIndex).active === active) continue;
          if (!(await set(channel.channelIndex, sourceIndex, null, active)).ok) return;
        }
      }
    } finally {
      setBulkBusy(false);
    }
  }

  /** A row or column header, lit while a cell on its line is hovered. */
  const headerTone = (highlighted: boolean) =>
    `rounded-md px-1.5 py-1 transition-colors duration-150 ${
      highlighted ? "bg-accent-soft text-[var(--amp-color-text)]" : "text-[var(--amp-color-dimmed)]"
    }`;

  return (
    <div className="h-full min-h-0 overflow-auto">
      {confirmDialog}
      <div className="mx-auto flex w-full min-w-0 flex-col gap-4 p-4" style={{ maxWidth: 980 }}>
        <MainSection title="Input sources" maxWidth={760}>
          {assignment.channels.map((channel) => {
            const t = channelTelemetry(telemetry, channel.channelIndex, ratedRmsVoltage);
            return (
              <div key={channel.channelIndex} className="flex min-w-0 items-center gap-3">
                <div className="flex w-[100px] min-w-0 shrink-0 flex-col">
                  <span className="text-[length:var(--amp-font-size-sm)] font-semibold">
                    Input {channel.channelIndex + 1}
                  </span>
                  {channel.inputName && (
                    <Hint text={channel.inputName} className="min-w-0">
                      <span className="block truncate text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">
                        {channel.inputName}
                      </span>
                    </Hint>
                  )}
                </div>
                <SourcePicker
                  source={channel.source}
                  sourceCounts={sourceCounts}
                  channelIndex={channel.channelIndex}
                  sourceTrims={channel.sourceTrims ?? DEFAULT_SOURCE_TRIMS}
                  backupPriority={channel.backupPriority ?? DEFAULT_BACKUP_PRIORITY}
                  paramRanges={capability.paramRanges}
                  onSelect={(kind, index) => handleSourceChange(channel.channelIndex, kind, index)}
                  onTrimChange={(kind, trimDb, delayMs) =>
                    handleSourceTrimChange(channel.channelIndex, kind, trimDb, delayMs)
                  }
                  onBackupChange={(first, second, enabled, thresholdDb) =>
                    handleBackupChange(channel.channelIndex, first, second, enabled, thresholdDb)
                  }
                />
                <ChannelLevelMeter
                  level={t.inputDbv}
                  disabled={channel.inputMuted ?? false}
                  peakHold={peakHoldSurfaces.includes("input")}
                />
                <InputClipPill clipping={t.inputClipping} raw={t.inputStateRaw} />
              </div>
            );
          })}
        </MainSection>

        <MainSection
          title="Matrix"
          maxWidth={980}
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!actions.setMatrixCrosspoint || bulkBusy}
                onPress={() =>
                  void applyMatrix(
                    "Route straight through?",
                    "Each output gets only its own input (1 to A, 2 to B, …). Gains are kept.",
                    (channelIndex, sourceIndex) => channelIndex === sourceIndex,
                  )
                }
              >
                Straight
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!actions.setMatrixCrosspoint || bulkBusy}
                onPress={() =>
                  void applyMatrix(
                    "Clear the matrix?",
                    "Every crosspoint is switched off, so no output receives any input. Gains are kept.",
                    () => false,
                  )
                }
              >
                Clear all
              </Button>
            </>
          }
        >
          {/* The matrix has an irreducible width (one tile-wide column per source),
           * so it scrolls sideways in its own container on a narrow window rather
           * than squeezing columns to illegibility. */}
          <div className="min-w-0 max-w-full overflow-auto">
            <div
              style={{
                display: "grid",
                // Crosspoint columns match `StatEditorTile`'s default 72px.
                gridTemplateColumns: `minmax(90px, 140px) repeat(${sourceCount}, 72px) minmax(150px, 1fr)`,
                alignItems: "center",
                columnGap: 12,
                rowGap: 10,
                // `width: 100%` lets the meter track give way first; once every
                // track is at its floor the container scrolls.
                width: "100%",
              }}
            >
              <span className={`${SECTION_TITLE} self-end pb-1`}>Out \ In</span>
              {Array.from({ length: sourceCount }).map((_, i) => {
                const name = assignment.channels[i]?.inputName;
                return (
                  <div
                    key={i}
                    className={`flex min-w-0 flex-col items-center ${headerTone(hoveredCell?.sourceIndex === i)}`}
                  >
                    <span className="text-[length:var(--amp-font-size-sm)] font-semibold">{i + 1}</span>
                    {name ? (
                      <Hint text={name} className="w-full min-w-0">
                        <span className="block truncate text-center text-[length:var(--amp-font-size-xs)]">{name}</span>
                      </Hint>
                    ) : (
                      <span className="text-[length:var(--amp-font-size-xs)]">In{i + 1}</span>
                    )}
                  </div>
                );
              })}
              <span className={`${SECTION_TITLE} self-end pb-1`}>Level</span>
              <div
                className="h-px bg-[var(--amp-color-default-border)]"
                style={{ gridColumn: `1 / span ${sourceCount + 2}` }}
              />

              {assignment.channels.map((channel) => {
                const follower = isFollower(channel.channelIndex);
                const highlighted = hoveredCell?.channelIndex === channel.channelIndex;
                // A bridged follower mirrors its leader, as on the Input / Output tab.
                const dim = follower
                  ? { opacity: 0.4, pointerEvents: "none" as const, filter: "grayscale(1)" }
                  : undefined;
                return (
                  <Fragment key={channel.channelIndex}>
                    <div className={`flex min-w-0 flex-col ${headerTone(highlighted)}`} style={dim}>
                      <span className="text-[length:var(--amp-font-size-sm)] font-semibold">
                        Output {outputLetter(channel.channelIndex)}
                      </span>
                      <span className="block truncate text-[length:var(--amp-font-size-xs)]">
                        {follower ? `Bridged to ${outputLetter(channel.channelIndex - 1)}` : (channel.outputName ?? "")}
                      </span>
                    </div>
                    {/* Indexed by column (sourceCount), not by the raw stored
                     * array — keeps the grid's column count authoritative even
                     * if a project's stored crosspoints haven't been
                     * reconciled to the current topology yet. */}
                    {Array.from({ length: sourceCount }).map((_, sourceIndex) => {
                      const crosspoint = crosspointAt(channel, sourceIndex);
                      return (
                        <div key={sourceIndex} className="flex justify-center" style={dim}>
                          <MatrixCrosspointCell
                            active={crosspoint.active}
                            gainDb={crosspoint.gainDb ?? 0}
                            min={min}
                            max={max}
                            onGainChange={(value) => handleGainChange(channel.channelIndex, sourceIndex, value)}
                            onActiveChange={(value) => handleActiveChange(channel.channelIndex, sourceIndex, value)}
                            onHoverChange={(hovering) =>
                              setHoveredCell(hovering ? { channelIndex: channel.channelIndex, sourceIndex } : null)
                            }
                          />
                        </div>
                      );
                    })}
                    <div className="flex min-w-0" style={dim}>
                      <RoutingOutputMeter
                        channel={channel}
                        reading={channelTelemetry(telemetry, channel.channelIndex, ratedRmsVoltage)}
                        ratedRmsVoltage={ratedRmsVoltage}
                        rangeMax={capability.paramRanges.rmsLimiterThresholdVrms.max}
                        peakHold={peakHoldSurfaces.includes("output")}
                      />
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
        </MainSection>
      </div>
    </div>
  );
}
