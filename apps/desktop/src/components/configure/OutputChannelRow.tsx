import { useState, type CSSProperties, type ReactNode } from "react";
import { Switch, Tooltip } from "@heroui/react";
import { Activity, FlipVertical2, ShieldAlert, ListPlus, Volume2, VolumeX, Waves } from "lucide-react";
import { CommitNumberInput } from "../CommitNumberInput";
import { SimpleSelect } from "../SimpleSelect";
import { ChannelStateBadge } from "../ChannelStateBadge";
import { StatEditorTile, StatReadout, StatToggle } from "../StatTiles";
import { useActionFeedback } from "../../hooks/useActionFeedback";
import type { ActionResult } from "../../lib/actionResult";
import type { AmpAssignment, ChannelSpeakerState, PowerMode } from "../../lib/bindings";
import { FALLBACK_LIMITER, outputLetter, OUTPUT_METER_FLOOR_DB, OUTPUT_METER_MARKS, outputMeterScale, rmsCeilingVolts, type ChannelTelemetry } from "../../lib/channelTelemetry";
import { Hint } from "../Hint";
import { StatusChip } from "../SpeakerBench";
import { usePreference } from "../../lib/preferences";
import { ChannelLevelMeter } from "./meters";
import { LinkTarget, RenameableLabel, TilePopover, activeFilterCount } from "./parts";

const POWER_MODE_LABELS: Record<PowerMode, string> = {
  lowOhm: "Low-Ω",
  v70: "70V",
  v100: "100V",
};

/** A thread through the centre of every wrapped line of 52px tiles (8px
 * gap): the Speaker Library's "pearl necklace". CSS only, so it follows
 * `flex-wrap` without measuring anything. */
const PEARL_THREAD: CSSProperties = {
  backgroundImage:
    "linear-gradient(to bottom, transparent 25px, var(--amp-color-default-border) 25px, var(--amp-color-default-border) 27px, transparent 27px)",
  backgroundSize: "100% 60px",
  backgroundRepeat: "repeat-y",
};

/** The pearls: tiles are see-through, so each one gets the page behind it,
 * or the thread would run across its face. Every child of the cluster is
 * exactly one tile's box (see `TilePopover`'s `flex` wrapper). */
const PEARLS = "[&>*]:rounded-md [&>*]:bg-[var(--background)]";

export function OutputChannelRow({
  preset,
  rmsThresholdRangeMax,
  channel,
  speaker,
  onOpenSpeakers,
  telemetry,
  ratedRmsVoltage,
  trimMin,
  trimMax,
  volumeMin,
  volumeMax,
  delayMin,
  delayMax,
  noiseGateThresholdMin,
  noiseGateThresholdMax,
  noiseGateThresholdAdjustable,
  nameMaxLength,
  powerModes,
  onChange,
  onOpenFir,
  onOpenEq,
  onOpenLimiter,
  onNoiseGateChange,
  onPhaseInvertToggle,
  onPowerModeChange,
  onMuteToggle,
  onRename,
}: {
  /** A speaker way in the Speaker Library rather than a live output: no
   * meter, readouts, Mute or Vol (volume is never part of a speaker), LIM
   * lit while a limiter stage is on, and the tiles strung on a thread. */
  preset?: { defaultLabel: string; trailing: ReactNode };
  channel: AmpAssignment["channels"][number];
  /** The library speaker this output was set up from, if any. */
  speaker?: ChannelSpeakerState;
  onOpenSpeakers?: () => void;
  telemetry: ChannelTelemetry;
  /** For the limiter threshold lines on this row's meter — see
   * `capability.topology.ratedRmsVoltage` at the call site. */
  ratedRmsVoltage: number | null;
  /** Generic ceiling for the volt meter, when neither amp nor model gives one. */
  rmsThresholdRangeMax: number | null | undefined;
  trimMin: number | null;
  trimMax: number | null;
  volumeMin: number | null;
  volumeMax: number | null;
  delayMin: number | null;
  delayMax: number | null;
  noiseGateThresholdMin: number | null;
  noiseGateThresholdMax: number | null;
  noiseGateThresholdAdjustable: boolean;
  nameMaxLength: number;
  /** Which power/impedance modes the assigned model actually offers — read
   * from `capability.topology.powerModes`, not hardcoded, so a future model
   * that restricts modes is respected automatically. */
  powerModes: PowerMode[];
  onChange: (
    field: "trim" | "volume" | "delay",
    value: number,
  ) => Promise<ActionResult>;
  onOpenFir: () => void;
  onOpenEq: () => void;
  onOpenLimiter: () => void;
  onNoiseGateChange: (
    enabled: boolean,
    thresholdDbu: number,
  ) => Promise<ActionResult>;
  onPhaseInvertToggle: () => Promise<ActionResult>;
  onPowerModeChange: (mode: PowerMode) => Promise<ActionResult>;
  onMuteToggle: () => Promise<ActionResult>;
  onRename: (name: string | null) => void;
}) {
  const [openPopover, setOpenPopover] = useState<
    "trim" | "volume" | "delay" | "gate" | "mode" | null
  >(null);
  // One controller per tile whose request is committed from a popover rather
  // than fired by the tile's own click (see `VisualValidation`). Tiles whose
  // click *is* the request (Mute, Pol, the direct Gate toggle) track
  // themselves via `visualValidation`. LIM/FIR/EQ only navigate, so they have
  // nothing to validate.
  const volumeFeedback = useActionFeedback();
  const trimFeedback = useActionFeedback();
  const delayFeedback = useActionFeedback();
  const modeFeedback = useActionFeedback();
  const gateFeedback = useActionFeedback();
  const trimDb = channel.outputTrimDb ?? 0;
  const volumeDb = channel.outputVolumeDb ?? 0;
  const delayMs = channel.delayOutMs ?? 0;
  const noiseGateEnabled = channel.noiseGateEnabled ?? false;
  const noiseGateThresholdDbu = channel.noiseGateThresholdDbu ?? 0;
  const phaseInverted = channel.outputPhaseInverted ?? false;
  const muted = channel.outputMuted ?? false;
  // Unset only on a live amp that reported a mode this app can't decode —
  // shown as such rather than as the Low-Ω it would otherwise read as.
  const powerMode = channel.powerMode ?? null;
  const eqActive = activeFilterCount(channel.outputEq);
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");
  const limiterThresholdSurfaces = usePreference("limiterThresholdSurfaces");
  const showLimiterThresholds = limiterThresholdSurfaces.includes("output");
  const limiter = channel.limiter ?? FALLBACK_LIMITER;
  const outputMeterVolts = usePreference("outputMeterVolts");
  const scale = outputMeterScale(
    outputMeterVolts,
    rmsCeilingVolts(limiter, ratedRmsVoltage, rmsThresholdRangeMax),
    ratedRmsVoltage,
    OUTPUT_METER_FLOOR_DB,
    OUTPUT_METER_MARKS,
  );

  return (
    <div>
      <RenameableLabel
        defaultLabel={preset?.defaultLabel ?? `Out${outputLetter(channel.channelIndex)}`}
        name={channel.outputName}
        maxLength={nameMaxLength}
        onRename={onRename}
        trailing={
          preset ? preset.trailing : <>
            {speaker && (
              <div className="flex min-w-0 items-center gap-1.5">
                <Hint text="Open in the Speakers tab" className="min-w-0">
                  <button
                    type="button"
                    className="block min-w-0 max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]"
                    onClick={onOpenSpeakers}
                  >
                    {speaker.speaker.label}
                  </button>
                </Hint>
                <StatusChip state={speaker} />
              </div>
            )}
            <ChannelStateBadge
              state={telemetry.outputState}
              raw={telemetry.outputStateRaw}
              hideNominal
            />
          </>
        }
      />
      <div className="flex items-center gap-2">
        {!preset && <ChannelLevelMeter
          level={scale.reading(telemetry)}
          scale={scale}
          disabled={muted}
          wide
          peakHold={peakHoldSurfaces.includes("output")}
          limiterThresholds={
            showLimiterThresholds
              ? {
                  rmsThresholdVrms: limiter.rms.enabled ? (limiter.rms.thresholdVrms ?? 0) : null,
                  peakThresholdVp: limiter.peak.enabled ? (limiter.peak.thresholdVp ?? 0) : null,
                }
              : undefined
          }
        />}
        {/* The tiles wrap as their own cluster, never mixed in with the meter.
         * Every tile is exactly `STAT_TILE_W`, so a wrapped line starts a new
         * row of the same columns — a grid, rather than the single orphan tile
         * stranded under the meter that one shared `flex-wrap` row produced.
         * (`flex-wrap` and not `grid` + `repeat(auto-fit, …)`: auto-fit
         * resolves to one column inside a shrink-to-fit flex item, which
         * would stack all twelve tiles vertically.)
         *
         * Grouped by role, left to right in rough order of how often each is
         * touched: live readouts beside the meter, then level (Mute/Vol/Trim),
         * speaker tuning (EQ/FIR/Delay/Pol), dynamics (LIM/Gate), and the amp
         * hardware setting (Mode) last. Deliberately not a signal-flow order —
         * the CVR DSP chain order is not confirmed. */}
        <div
          className={`flex min-w-0 flex-wrap items-center gap-2 ${preset ? PEARLS : ""}`}
          style={preset ? PEARL_THREAD : undefined}
        >
          {!preset && <>
          <StatReadout
            value={
              telemetry.outputVoltage === null
                ? "—"
                : telemetry.outputVoltage.toFixed(1)
            }
            label="V"
          />
          <StatReadout
            value={
              telemetry.temperatureC === null
                ? "—"
                : telemetry.temperatureC.toFixed(1)
            }
            label="°C"
          />
          {/* Same slot as on the input strip — see the note in InputChannelRow. */}
          <LinkTarget scope="muteOut" channel={channel.channelIndex}>
          <StatToggle
            label="Mute"
            engaged={muted}
            visualValidation
            onClick={onMuteToggle}
            icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          />
          </LinkTarget>
          <LinkTarget scope="volumeOut" channel={channel.channelIndex}>
          <TilePopover
            opened={openPopover === "volume"}
            onOpenChange={(o) => setOpenPopover(o ? "volume" : null)}
            width={200}
            trigger={
              <StatEditorTile
                value={volumeDb.toFixed(1)}
                label="Vol dB"
                modified={volumeDb !== 0}
                visualValidation={volumeFeedback}
                onClick={() =>
                  setOpenPopover((o) => (o === "volume" ? null : "volume"))
                }
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
                Output Volume
              </span>
              <CommitNumberInput
                value={volumeDb}
                min={volumeMin ?? undefined}
                max={volumeMax ?? undefined}
                step={0.1}
                suffix=" dB"
                onCommit={(value) => void volumeFeedback.track(onChange("volume", value))}
              />
            </div>
          </TilePopover>
          </LinkTarget>
          </>}
          <LinkTarget scope="trimOut" channel={channel.channelIndex}>
          <TilePopover
            opened={openPopover === "trim"}
            onOpenChange={(o) => setOpenPopover(o ? "trim" : null)}
            width={200}
            trigger={
              <StatEditorTile
                value={trimDb.toFixed(1)}
                label="Trim dB"
                modified={trimDb !== 0}
                visualValidation={trimFeedback}
                onClick={() =>
                  setOpenPopover((o) => (o === "trim" ? null : "trim"))
                }
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
                Output Trim
              </span>
              <CommitNumberInput
                value={trimDb}
                min={trimMin ?? undefined}
                max={trimMax ?? undefined}
                step={0.1}
                suffix=" dB"
                onCommit={(value) => void trimFeedback.track(onChange("trim", value))}
              />
            </div>
          </TilePopover>
          </LinkTarget>
          <LinkTarget scope="outputEq" channel={channel.channelIndex}>
          <StatEditorTile
            label="EQ Out"
            opens="view"
            modified={eqActive > 0}
            icon={<Activity size={16} />}
            onClick={onOpenEq}
          />
          </LinkTarget>
          {/* Wrapped like its neighbours: `PEARLS` paints a direct child, and a
              tile's own inline `background` would win over it. */}
          <div className="flex">
          <StatEditorTile
            label="FIR"
            opens="view"
            modified={!(channel.firBypassed ?? false)}
            icon={<Waves size={16} />}
            onClick={onOpenFir}
          />
          </div>
          <LinkTarget scope="delayOut" channel={channel.channelIndex}>
          <TilePopover
            opened={openPopover === "delay"}
            onOpenChange={(o) => setOpenPopover(o ? "delay" : null)}
            width={200}
            trigger={
              <StatEditorTile
                value={delayMs.toFixed(1)}
                label="Delay ms"
                modified={delayMs !== 0}
                visualValidation={delayFeedback}
                onClick={() =>
                  setOpenPopover((o) => (o === "delay" ? null : "delay"))
                }
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
                Output Delay
              </span>
              <CommitNumberInput
                value={delayMs}
                min={delayMin ?? undefined}
                max={delayMax ?? undefined}
                step={0.01}
                suffix=" ms"
                onCommit={(value) => void delayFeedback.track(onChange("delay", value))}
              />
            </div>
          </TilePopover>
          </LinkTarget>
          {/* Amber, not red: an inverted polarity is a deliberate setting, and
           * red is reserved for "this channel's audio is cut". */}
          <LinkTarget scope="polarityOut" channel={channel.channelIndex}>
          <StatToggle
            label="Pol"
            engaged={phaseInverted}
            accent="var(--accent)"
            visualValidation
            onClick={onPhaseInvertToggle}
            icon={<FlipVertical2 size={16} />}
          />
          </LinkTarget>
          <div className="flex">
          <StatEditorTile
            label="LIM"
            opens="view"
            onClick={onOpenLimiter}
            // Accented only while the limiter is actually pulling gain down, so
            // the tile doubles as a live "limiting now" indicator instead of a
            // permanently-highlighted button. Icon-only now — the live gain
            // reduction dB reads as a precise measurement when it's really a
            // momentary number that stops mattering the instant you look away;
            // the accent alone answers "is it limiting right now."
            modified={
              preset
                ? limiter.rms.enabled || limiter.peak.enabled
                : telemetry.gainReductionDb !== null && telemetry.gainReductionDb < 0
            }
            accent={preset ? "var(--accent)" : "var(--amp-color-red-6)"}
            icon={<ListPlus size={16} />}
          />
          </div>
          {/* Firmware without an adjustable threshold (1.1.8) has nothing to
           * put in a dropdown but the same on/off state the pill already
           * shows — a popover there was a second click to reach a switch that
           * duplicates the pill itself. That firmware gets a direct toggle;
           * only firmware with a real threshold field (`noiseGateThresholdAdjustable`)
           * gets the popover. */}
          <LinkTarget scope="noiseGateOut" channel={channel.channelIndex}>
          {noiseGateThresholdAdjustable ? (
            <TilePopover
              opened={openPopover === "gate"}
              onOpenChange={(o) => setOpenPopover(o ? "gate" : null)}
              width={200}
              trigger={
                <StatToggle
                  label="Gate"
                  engaged={noiseGateEnabled}
                  accent="var(--accent)"
                  visualValidation={gateFeedback}
                  onClick={() =>
                    setOpenPopover((o) => (o === "gate" ? null : "gate"))
                  }
                  icon={<ShieldAlert size={16} />}
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
                  Noise Gate
                </span>
                <Switch
                  isSelected={noiseGateEnabled}
                  onChange={(isSelected) =>
                    void gateFeedback.track(onNoiseGateChange(isSelected, noiseGateThresholdDbu))
                  }
                >
                  {/* `Switch.Content` (React Aria's `SwitchButton`) is the actual
                      clickable/checked element — `Switch` itself is just the
                      field wrapper, so a control rendered as its direct child
                      (as this was) has nothing to click. */}
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span style={{ fontSize: "var(--amp-font-size-sm)" }}>Enabled</span>
                  </Switch.Content>
                </Switch>
                <CommitNumberInput
                  value={noiseGateThresholdDbu}
                  min={noiseGateThresholdMin ?? undefined}
                  max={noiseGateThresholdMax ?? undefined}
                  step={1}
                  integer
                  suffix=" dBu"
                  onCommit={(value) => void gateFeedback.track(onNoiseGateChange(noiseGateEnabled, value))}
                />
              </div>
            </TilePopover>
          ) : (
            <StatToggle
              label="Gate"
              engaged={noiseGateEnabled}
              accent="var(--accent)"
              visualValidation
              onClick={() =>
                onNoiseGateChange(!noiseGateEnabled, noiseGateThresholdDbu)
              }
              icon={<ShieldAlert size={16} />}
            />
          )}
          </LinkTarget>
          {/* Last, and as far from Mute as the row allows: power mode is rarely
           * changed, and switching Low-Ω/70V/100V on a live system is not a
           * click that should sit next to one people make quickly. */}
          <TilePopover
            opened={openPopover === "mode"}
            onOpenChange={(o) => setOpenPopover(o ? "mode" : null)}
            width={180}
            trigger={
              <StatEditorTile
                value={powerMode ? POWER_MODE_LABELS[powerMode] : "Unknown"}
                label="Mode"
                visualValidation={modeFeedback}
                onClick={() =>
                  setOpenPopover((o) => (o === "mode" ? null : "mode"))
                }
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
                Power Mode
              </span>
              <SimpleSelect
                data={powerModes.map((mode) => ({
                  value: mode,
                  label: POWER_MODE_LABELS[mode],
                }))}
                value={powerMode}
                placeholder="Unknown"
                onChange={(value) => {
                  if (value) void modeFeedback.track(onPowerModeChange(value as PowerMode));
                }}
              />
            </div>
          </TilePopover>
        </div>
      </div>
    </div>
  );
}

/** Shown on the bridge controls when the active source has no
 * `setOutputBridge`. Direct Edit mode is the case that matters: the write
 * command exists, but nothing reads bridge state back off the device (it is
 * absent from FC=27 — see `liveConfigureAdapter`'s `outputBridged` note), so
 * offering the toggle would mean changing a power amp's output topology with
 * no way to confirm or even display that it happened. */
const BRIDGE_UNAVAILABLE_REASON =
  "Bridging isn't available for a live device yet — the amp doesn't report bridge state back, so the app can't show whether it took effect.";

/** Colored sidebar spanning a bridged output pair's two rows — matches the
 * reference hardware view's rotated `{A}/{B}` `ON`/`OFF` bar. This app has
 * no live status distinct from planned config the way real hardware does,
 * so the sidebar doubles as the toggle control itself (click to flip
 * `output_bridged`) as well as the status display, unlike the reference
 * where the equivalent control lives elsewhere. */
export function BridgePairSidebar({
  leaderLetter,
  followerLetter,
  bridged,
  disabled,
  onClick,
}: {
  leaderLetter: string;
  followerLetter: string;
  bridged: boolean;
  /** No `setOutputBridge` for this source. Rendered visibly dead with a
   * reason rather than accepting the click and dropping it — see
   * `BRIDGE_UNAVAILABLE_REASON`. */
  disabled?: boolean;
  onClick: () => void;
}) {
  const bar = (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={`appearance-none border-0 bg-transparent p-0 font-inherit rounded-md ${disabled ? "cursor-not-allowed opacity-[0.45]" : "cursor-pointer"}`}
      style={{
        width: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${bridged ? "var(--amp-color-green-6)" : "var(--amp-color-default-border)"}`,
        backgroundColor: bridged
          ? "color-mix(in srgb, var(--amp-color-green-light) 50%, transparent)"
          : undefined,
      }}
    >
      <span
        style={{
          fontSize: "var(--amp-font-size-xs)",
          fontWeight: 700,
          color: bridged ? "var(--amp-color-green-6)" : "var(--amp-color-dimmed)",
          // A single rotation of ordinary horizontal text, not
          // `writing-mode: vertical-rl` + `transform: rotate()` stacked —
          // that compound rotation (the writing-mode itself already
          // reorients the glyph run, then the transform rotates it again)
          // is what Chromium/WebView2 renders through a blur-prone
          // rasterize-then-rotate path under non-100% OS display scaling.
          // One plain `rotate()` on horizontal text avoids that path
          // entirely and stays crisp regardless of the button's height.
          display: "inline-block",
          transform: "rotate(-90deg)",
          whiteSpace: "nowrap",
        }}
      >
        {leaderLetter}/{followerLetter} {bridged ? "ON" : "OFF"}
      </span>
    </button>
  );
  return disabled ? (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <div style={{ display: "flex" }}>{bar}</div>
      </Tooltip.Trigger>
      <Tooltip.Content placement="right" showArrow className="max-w-[240px]">
        {BRIDGE_UNAVAILABLE_REASON}
      </Tooltip.Content>
    </Tooltip>
  ) : (
    bar
  );
}
