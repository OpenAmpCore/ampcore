import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Slider, Switch } from "@heroui/react";
import { TriangleAlert, Volume2, VolumeX } from "lucide-react";
import { Hint } from "../Hint";
import type { ConfigurableTabProps } from "./parts";
import { ChannelStateBadge } from "../ChannelStateBadge";
import { CommitNumberInput } from "../CommitNumberInput";
import { SECTION_TITLE } from "../fieldClasses";
import { StatToggle } from "../StatTiles";
import type { VuMeterMark } from "../VuMeter";
import { NO_AMP_GAIN, type AmpGainReading } from "../../lib/ampGain";
import { VOLUME_EQUAL_DB, writeAll } from "../../lib/channelLinks";
import type { ActionResult } from "../../lib/actionResult";
import type { AmpChannel, AmpChannelState, DiscoveredDevice } from "../../lib/bindings";
import { channelTelemetry, FALLBACK_LIMITER, outputLetter, OUTPUT_METER_FLOOR_DB, OUTPUT_METER_MARKS, outputMeterScale, rmsCeilingVolts, type ChannelTelemetry, type OutputMeterScale, INPUT_METER_FLOOR_DB, INPUT_METER_MARKS } from "../../lib/channelTelemetry";
import { channelStateTone } from "../../lib/channelState";
import { usePreference } from "../../lib/preferences";
import { Cell, ChannelHeader, Column, HEADER_H, Led, LevelMeter, ROW_H, STRIP_H, Scale, Section, SideText, ValueCell } from "./overviewParts";

/* The vendor app's Main page, rebuilt from this app's own parts: every
 * channel's level and gain on one screen for quick adjustments, with routing
 * left to the Matrix tab and the per-channel editors to the Input / Output tab.
 *
 * Three cards side by side, as on the vendor page — Volume, Source, Output —
 * each a row of fixed-width channel columns between a label column and (for
 * Volume and Output) a units/legend column. Columns stack fixed-height rows
 * rather than sharing one CSS grid, so a channel's cells can share state (a
 * fader's drag value feeds the dB field under it); the matching heights below
 * are what keep the side labels level with them. */

/** How far inside its box a vertical HeroUI slider's thumb stops at either
 * end: the slider grid's 0.5rem row gap plus the track's 0.75rem transparent
 * border (`@heroui/styles` slider.css). The fader scale is inset to match, so
 * a label sits level with the thumb at that value.
 * ponytail: copied from @heroui/styles 3.2.5's vertical slider (`gap-2` +
 * `border-y-[0.75rem]`); re-check after a HeroUI upgrade, or measure the
 * thumb's travel at runtime if it ever drifts. */
const FADER_THUMB_INSET = 20;

/** A held volume write is released after this, and its result flashed for
 * this long (`EqEditor`'s timings). */
const VOLUME_HOLD_MS = 3000;
const VOLUME_FLASH_MS = 700;

const FILL_BY_STATUS = {
  pending: "var(--amp-color-dimmed)",
  ok: "var(--amp-color-green-6)",
  fail: "var(--amp-color-red-6)",
} as const;

/** `StatToggle`'s fixed height — the Mute row. */
const TOGGLE_H = 52;

/** Label/scale columns, and the Output card's LED legend. */
const SIDE_W = 44;

const LEGEND_W = 56;

const LED_ROW_H = 16;

/** The vendor fader's scale (+18 … −80), kept to whatever range the model
 * actually allows. */
function faderMarks(min: number, max: number): VuMeterMark[] {
  return [max, 0, -18, -36, -54, min]
    .filter((value, i, all) => value >= min && value <= max && all.indexOf(value) === i)
    .map((value) => ({ value, label: value > 0 ? `+${value}` : String(value) }));
}

/** What one output's LED column reports. `state` is `null` without a
 * reading, which leaves every state LED dark rather than claiming Normal. */
interface OutputStatus {
  state: AmpChannelState | null;
  hiZ: boolean;
  bridged: boolean;
}

interface StatusLed {
  label: string;
  color: string;
  lit: (status: OutputStatus) => boolean;
}

/** One LED per state the amp can report, coloured like `ChannelStateBadge`.
 * The heartbeat carries a single state per output, so at most one of these
 * is ever lit; states that mean the same thing to a user share a LED. */
function stateLed(label: string, states: AmpChannelState[]): StatusLed {
  return {
    label,
    color: `var(--amp-color-${channelStateTone(states[0])}-5)`,
    lit: (status) => status.state !== null && states.includes(status.state),
  };
}

/** The vendor page's LED column — Fault, Load, Open, Temp, Clip, Standby,
 * Hi Z, Bridged — plus Limit, a state this app decodes and the vendor shows
 * nowhere. Hi Z and Bridged are settings rather than states, so they read
 * the channel's power mode and bridge flag and take the accent. */
const STATUS_LEDS: StatusLed[] = [
  stateLed("Fault", ["fault", "dcp", "powerError"]),
  stateLed("Overload", ["overload"]),
  stateLed("Open", ["open"]),
  stateLed("Temp", ["temp"]),
  stateLed("Clip", ["clip"]),
  stateLed("Limit", ["limit"]),
  stateLed("Standby", ["standby", "sleep"]),
  { label: "Hi Z", color: "var(--accent)", lit: (status) => status.hiZ },
  { label: "Bridged", color: "var(--accent)", lit: (status) => status.bridged },
];

const fmt = (value: number | null, digits: number) => (value === null ? "—" : value.toFixed(digits));

interface OutputTotals {
  currentA: number | null;
  /** An output's current is too low to measure, so the sum is a lower bound. */
  belowRange: boolean;
}

/** What the outputs deliver between them: summed current. There is no mains
 * reading, so this is the load side, not what the amp draws from the wall.
 * `null` when no output has a reading. */
function outputTotals(readings: ChannelTelemetry[]): OutputTotals {
  let currentA: number | null = null;
  let belowRange = false;
  for (const reading of readings) {
    if (reading.outputCurrent === null) continue;
    currentA = (currentA ?? 0) + reading.outputCurrent;
    belowRange ||= reading.outputCurrentBelowRange;
  }
  return { currentA, belowRange };
}

const LOW_CURRENT = "Low";

const LOW_CURRENT_HINT = "Current is below what the amp can measure";

function totalCurrentText({ currentA, belowRange }: OutputTotals): string {
  if (!belowRange) return fmt(currentA, 1);
  return currentA ? `≥ ${fmt(currentA, 1)}` : LOW_CURRENT;
}

/** The name the amp holds for an input, or its default label. */
const inputName = (channel: AmpChannel) => channel.inputName?.trim() || `In${channel.channelIndex + 1}`;

/** Same for an output, without the legacy `_XXXX` speaker-hash suffix (core's
 * `split_hash_suffix`). */
const outputName = (channel: AmpChannel) =>
  channel.outputName?.trim().replace(/_[0-9a-fA-F]{4}$/, "") || `Out${outputLetter(channel.channelIndex)}`;

/** One channel of the Volume card: fader, its value, and the amp gain with
 * the sensitivity it implies. The fader commits on release, not per tick —
 * the same reason as `LimiterEditor`'s threshold sliders. Output volume is
 * linked across every output by default (the Together switch), so the drag is the tab's,
 * not the strip's: every fader shows its own value plus the step being
 * dragged (`shown`), and moves with the thumb. */
function VolumeStrip({
  channel,
  header,
  min,
  max,
  shown,
  status,
  gain,
  locked,
  onDrag,
  onVolume,
  onGain,
}: {
  channel: AmpChannel;
  /** Replaces the channel's own letter and name: the one master strip. */
  header?: { label: string; name: string };
  min: number;
  max: number;
  /** This fader's value: its own, or with the step being dragged. */
  shown: number;
  /** The volume write's state: see `OverviewTab`'s held writes. */
  status?: "pending" | "ok" | "fail";
  gain: AmpGainReading;
  /** The slider drags through pointer handlers on a `div`, which the tab's
   * disabled fieldset doesn't reach — so it is disabled explicitly. */
  locked: boolean;
  onDrag: (volumeDb: number) => void;
  onVolume: (volumeDb: number) => void;
  /** Absent without a live write path — Gain is then a readout. */
  onGain?: (gainDb: number) => Promise<ActionResult>;
}) {
  const [gainDraft, setGainDraft] = useState(gain.gainDb);
  useEffect(() => {
    setGainDraft(gain.gainDb);
  }, [gain.gainDb]);
  const letter = outputLetter(channel.channelIndex);

  function commitGain(value: number) {
    if (!onGain) return;
    setGainDraft(value);
    void onGain(value).then((result) => {
      if (!result.ok) setGainDraft(gain.gainDb);
    });
  }

  return (
    <Column>
      <ChannelHeader label={header?.label ?? letter} name={header?.name ?? outputName(channel)} />
      <Cell height={STRIP_H}>
        <Slider
          orientation="vertical"
          aria-label={header ? "Output volume, all outputs" : `Output ${letter} volume`}
          minValue={min}
          maxValue={max}
          step={0.5}
          value={shown}
          isDisabled={locked}
          // The fill, the thumb and the track's end cap all paint the accent,
          // so the status recolours the slider's accent, not one part of it —
          // and with colour transitions off in every part (only the thumb's
          // transform still animates), since HeroUI fades each at its own
          // speed, which lit the ends and the middle at different moments.
          className={`[&_*]:[transition-property:transform] ${status === "pending" ? "eq-write-pending" : ""}`}
          style={{
            height: STRIP_H,
            ...(status && ({ "--accent": FILL_BY_STATUS[status], "--color-accent": FILL_BY_STATUS[status] } as CSSProperties)),
          }}
          onChange={(value) => onDrag(value as number)}
          onChangeEnd={(value) => onVolume(value as number)}
        >
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </Cell>
      <CommitNumberInput
        aria-label={header ? "Output volume, all outputs" : `Output ${letter} volume`}
        value={shown}
        min={min}
        max={max}
        step={0.1}
        onCommit={onVolume}
      />
      {/* Editable only with a write path, a reading to start from, and a
       * known range — the backend refuses anything outside it. */}
      {onGain && gain.gainDb !== null && gainDraft !== null && gain.range ? (
        <CommitNumberInput
          aria-label={`Output ${letter} amp gain (${gain.range.min}–${gain.range.max} dB)`}
          value={gainDraft}
          min={gain.range.min}
          max={gain.range.max}
          step={1}
          format={(value) => value.toFixed(1)}
          onCommit={commitGain}
        />
      ) : (
        <ValueCell value={fmt(gain.gainDb, 1)} />
      )}
      <ValueCell value={fmt(gain.sensitivityV, 2)} />
    </Column>
  );
}

function SourceStrip({
  channel,
  reading,
  peakHold,
}: {
  channel: AmpChannel;
  reading: ChannelTelemetry;
  peakHold: boolean;
}) {
  return (
    <Column>
      <ChannelHeader label={String(channel.channelIndex + 1)} name={inputName(channel)} />
      <Cell height={STRIP_H}>
        <LevelMeter level={reading.inputDbv} peakHold={peakHold} disabled={channel.inputMuted ?? false} />
      </Cell>
      <Cell height={LED_ROW_H}>
        <Led color="var(--amp-color-red-5)" lit={reading.inputClipping === true} label="Clip" />
      </Cell>
    </Column>
  );
}

function OutputStrip({
  channel,
  reading,
  peakHold,
  scale,
  onMute,
}: {
  channel: AmpChannel;
  reading: ChannelTelemetry;
  peakHold: boolean;
  scale: OutputMeterScale;
  onMute: () => Promise<ActionResult>;
}) {
  const muted = channel.outputMuted ?? false;
  const status: OutputStatus = {
    state: reading.outputState,
    hiZ: channel.powerMode === "v70" || channel.powerMode === "v100",
    bridged: channel.outputBridged ?? false,
  };

  return (
    <Column>
      <ChannelHeader label={outputLetter(channel.channelIndex)} name={outputName(channel)} />
      <Cell height={STRIP_H}>
        <div className="flex h-full items-end gap-2.5">
          <LevelMeter
            level={scale.reading(reading)}
            min={scale.min}
            max={scale.max}
            peakHold={peakHold}
            disabled={muted}
          />
          <div className="flex flex-col">
            {STATUS_LEDS.map((led) => (
              <Cell key={led.label} height={LED_ROW_H}>
                <Led color={led.color} lit={led.lit(status)} label={led.label} />
              </Cell>
            ))}
          </div>
        </div>
      </Cell>
      <StatToggle
        label="Mute"
        engaged={muted}
        visualValidation
        onClick={onMute}
        icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      />
      <ValueCell value={fmt(reading.outputVoltage, 1)} />
      {reading.outputCurrentBelowRange ? (
        <ValueCell value={LOW_CURRENT} hint={LOW_CURRENT_HINT} />
      ) : (
        <ValueCell value={fmt(reading.outputCurrent, 1)} />
      )}
      <ValueCell value={fmt(reading.temperatureC, 0)} />
    </Column>
  );
}

function InfoItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={SECTION_TITLE}>{label}</span>
      <span style={{ fontSize: "var(--amp-font-size-sm)", fontVariantNumeric: "tabular-nums" }}>{children}</span>
    </div>
  );
}

/** The vendor page's header strip, plus the outputs' total current and power.
 * Name, Display Lock and Standby are left out: the name sits above the tabs
 * and the other two in the rail. */
function InfoBar({
  device,
  modelLabel,
  presetName,
  psuTempC,
  totals,
}: {
  device: DiscoveredDevice;
  modelLabel?: string;
  presetName?: string | null;
  psuTempC: number | null;
  totals: OutputTotals;
}) {
  const statusColor = device.online ? "var(--amp-color-green-5)" : "var(--amp-color-gray-5)";
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1.5">
      {modelLabel && <InfoItem label="Model">{modelLabel}</InfoItem>}
      <InfoItem label="IP">{device.ip}</InfoItem>
      <InfoItem label="Firmware">{device.firmwareVersion || "—"}</InfoItem>
      <InfoItem label="Preset">{presetName || "—"}</InfoItem>
      <InfoItem label="Total">
        {totals.currentA === null || (totals.belowRange && !totals.currentA)
          ? totalCurrentText(totals)
          : `${totalCurrentText(totals)} A`}
      </InfoItem>
      <InfoItem label="PSU">{psuTempC === null ? "—" : `${psuTempC.toFixed(0)} °C`}</InfoItem>
      <InfoItem label="Status">
        <span className="inline-flex items-center gap-1.5">
          <span className="block rounded-full" style={{ width: 8, height: 8, background: statusColor }} />
          {device.online ? "Online" : "Offline"}
          <ChannelStateBadge state={device.machineStateDecoded} hideNominal />
        </span>
      </InfoItem>
    </div>
  );
}

/** The Overview tab — see the note at the top of this file. */
export function OverviewTab({
  assignment,
  capability,
  actions,
  telemetry,
  ampGains,
  locked,
  device,
  modelLabel,
  presetName,
  volumeTogether = true,
  onVolumeTogetherChange,
}: ConfigurableTabProps) {
  const channels = assignment.channels;
  const volumeMin = capability.paramRanges.outputVolumeDb.min ?? -80;
  const volumeMax = capability.paramRanges.outputVolumeDb.max ?? 18;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");
  const outputMeterVolts = usePreference("outputMeterVolts");
  // One scale column serves every output, so all of them use the highest max.
  const outScale = outputMeterScale(
    outputMeterVolts,
    Math.max(
      ...channels.map((c) =>
        rmsCeilingVolts(c.limiter ?? FALLBACK_LIMITER, ratedRmsVoltage, capability.paramRanges.rmsLimiterThresholdVrms.max),
      ),
    ),
    ratedRmsVoltage,
    OUTPUT_METER_FLOOR_DB,
    OUTPUT_METER_MARKS,
  );
  const readings = channels.map((c) => channelTelemetry(telemetry, c.channelIndex, ratedRmsVoltage));
  const psuTempC = telemetry?.temperatures[4] ?? null;
  const totals = outputTotals(readings);

  const { setChannelAmpGain } = actions;

  // Faders follow `EqEditor`'s writes: the step being dragged is preview only;
  // a committed volume is held per output — pending (greyed, breathing) until
  // acknowledged, then until that output's reading shows it (or 3 s), with a
  // green flash — or dropped at once on failure, with a red one. The linked
  // write reaches the outputs one after another, so releasing on the first
  // reading is what made the last faders snap back for a moment.
  const [drag, setDrag] = useState<{ channel: number; step: number } | null>(null);
  const [writes, setWrites] = useState<Record<number, { target: number; acked: boolean; token: number }>>({});
  const [flash, setFlash] = useState<Record<number, "ok" | "fail">>({});
  const writeToken = useRef(0);
  const volumeOf = (c: AmpChannel) => c.outputVolumeDb ?? 0;
  const clampVolume = (v: number) => Math.min(volumeMax, Math.max(volumeMin, v));
  const shownVolume = (c: AmpChannel) =>
    writes[c.channelIndex]?.target ??
    (drag && (volumeTogether || drag.channel === c.channelIndex) ? clampVolume(volumeOf(c) + drag.step) : volumeOf(c));
  const volumesKey = channels.map(volumeOf).join();
  useEffect(() => {
    setWrites((current) => {
      const next = { ...current };
      let changed = false;
      for (const c of channels) {
        const w = next[c.channelIndex];
        if (w?.acked && Math.abs(volumeOf(c) - w.target) < VOLUME_EQUAL_DB) {
          delete next[c.channelIndex];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // `volumesKey` stands for `channels`' volumes, which is all this reads.
  }, [volumesKey, writes]);
  /** One output's write state: only outputs a write touched show one. */
  const statusOf = (c: AmpChannel) =>
    writes[c.channelIndex] && !writes[c.channelIndex].acked ? ("pending" as const) : flash[c.channelIndex];
  // Every output at one volume and one amp gain: the card shows the single
  // master it is (the volume link moves all outputs anyway), not four faders
  // that look as if each could go its own way. Differing outputs (edited
  // singly) get a strip each, so the gaps stay visible.
  const gainOf = (c: AmpChannel) => ampGains?.[c.channelIndex] ?? NO_AMP_GAIN;
  const single =
    volumeTogether &&
    channels.length > 1 &&
    // Shown values, not readings: mid-write some outputs have moved and some
    // not, and the card mustn't split into strips for that moment.
    channels.every(
      (c) =>
        Math.abs(shownVolume(c) - shownVolume(channels[0])) < VOLUME_EQUAL_DB &&
        gainOf(c).gainDb === gainOf(channels[0]).gainDb &&
        gainOf(c).sensitivityV === gainOf(channels[0]).sensitivityV,
    );
  // Every output's amp gain, for the master strip.
  const setAllGains = (gainDb: number) => writeAll(channels.map((c) => c.channelIndex), (c) => setChannelAmpGain!(c, gainDb));

  /** Together, one write for every output: the volume link fans it out, by
   * the same clamped step this computes for the held values. */
  function commitVolume(channel: AmpChannel, value: number) {
    const step = value - volumeOf(channel);
    const token = ++writeToken.current;
    // Singly, only this output moves; other outputs' writes carry on.
    const moved = (volumeTogether ? channels : [channel]).map((c) => c.channelIndex);
    setWrites((current) => ({
      ...current,
      ...Object.fromEntries(
        (volumeTogether ? channels : [channel]).map((c) => [
          c.channelIndex,
          { target: clampVolume(volumeOf(c) + step), acked: false, token },
        ]),
      ),
    }));
    setDrag(null);
    // Each output's entry belongs to the newest write that touched it.
    const settle = (keep: boolean) =>
      setWrites((current) => {
        const next = { ...current };
        for (const i of moved) {
          if (next[i]?.token !== token) continue;
          if (keep) next[i] = { ...next[i], acked: true };
          else delete next[i];
        }
        return next;
      });
    const setFlashFor = (kind: "ok" | "fail" | null) =>
      setFlash((current) => {
        const next = { ...current };
        for (const i of moved) {
          if (kind) next[i] = kind;
          else delete next[i];
        }
        return next;
      });
    void actions.setChannelOutput(channel.channelIndex, null, value, null).then((result) => {
      settle(result.ok);
      if (result.ok) window.setTimeout(() => settle(false), VOLUME_HOLD_MS);
      setFlashFor(result.ok ? "ok" : "fail");
      window.setTimeout(() => setFlashFor(null), VOLUME_FLASH_MS);
    });
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      {/* `safe` centring: a card wider than a narrow pane starts at the left
       * edge and scrolls, instead of overflowing both sides out of reach. */}
      <div className="flex min-h-full min-w-0 flex-col gap-5 p-4" style={{ justifyContent: "safe center" }}>
        {device && (
          <InfoBar
            device={device}
            modelLabel={modelLabel}
            presetName={presetName}
            psuTempC={psuTempC}
            totals={totals}
          />
        )}
        <div className="flex flex-wrap items-stretch gap-4" style={{ justifyContent: "safe center" }}>
          <Section
            title="Volume"
            action={
              onVolumeTogetherChange && (
                <Switch size="sm" isSelected={volumeTogether} isDisabled={locked} onChange={onVolumeTogetherChange}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-[length:var(--amp-font-size-xs)]">Together</span>
                  </Switch.Content>
                </Switch>
              )
            }
            footer={
              !volumeTogether && (
                <Hint text="To balance outputs, use Trim: output volume isn't saved in hardware or speaker presets." className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1 text-[10px] text-[var(--amp-color-orange-6)] opacity-75">
                    <TriangleAlert size={11} className="shrink-0" />
                    <span className="truncate">Balance outputs with Trim: volume isn't in hardware or speaker presets.</span>
                  </span>
                </Hint>
              )
            }
          >
            <Column width={SIDE_W}>
              <Cell height={HEADER_H} />
              <Scale
                min={volumeMin}
                max={volumeMax}
                marks={faderMarks(volumeMin, volumeMax)}
                inset={FADER_THUMB_INSET}
              />
              <Cell height={ROW_H} align="end">
                <SideText>Vol</SideText>
              </Cell>
              <Cell height={ROW_H} align="end">
                <SideText>Gain</SideText>
              </Cell>
              <Cell height={ROW_H} align="end">
                <SideText>SEN</SideText>
              </Cell>
            </Column>
            {single ? (
              <VolumeStrip
                channel={channels[0]}
                header={{
                  label: "All",
                  name: `Outputs ${outputLetter(0)}–${outputLetter(channels.length - 1)}`,
                }}
                min={volumeMin}
                max={volumeMax}
                shown={shownVolume(channels[0])}
                gain={gainOf(channels[0])}
                locked={locked ?? false}
                status={statusOf(channels[0])}
                onDrag={(value) => setDrag({ channel: channels[0].channelIndex, step: value - volumeOf(channels[0]) })}
                onVolume={(value) => commitVolume(channels[0], value)}
                onGain={setChannelAmpGain ? setAllGains : undefined}
              />
            ) : channels.map((channel) => (
              <VolumeStrip
                key={channel.channelIndex}
                channel={channel}
                min={volumeMin}
                max={volumeMax}
                shown={shownVolume(channel)}
                gain={ampGains?.[channel.channelIndex] ?? NO_AMP_GAIN}
                locked={locked ?? false}
                status={statusOf(channel)}
                onDrag={(value) => setDrag({ channel: channel.channelIndex, step: value - volumeOf(channel) })}
                onVolume={(value) => commitVolume(channel, value)}
                onGain={
                  setChannelAmpGain ? (gainDb) => setChannelAmpGain(channel.channelIndex, gainDb) : undefined
                }
              />
            ))}
            <Column width={20}>
              <Cell height={HEADER_H} />
              <Cell height={STRIP_H} />
              <Cell height={ROW_H} align="start">
                <SideText>dB</SideText>
              </Cell>
              <Cell height={ROW_H} align="start">
                <SideText>dB</SideText>
              </Cell>
              <Cell height={ROW_H} align="start">
                <SideText>V</SideText>
              </Cell>
            </Column>
          </Section>

          <Section title="Source">
            <Column width={SIDE_W}>
              <Cell height={HEADER_H} />
              <Scale min={INPUT_METER_FLOOR_DB} max={0} marks={INPUT_METER_MARKS} />
              <Cell height={LED_ROW_H} align="end">
                <SideText>Clip</SideText>
              </Cell>
            </Column>
            {channels.map((channel, i) => (
              <SourceStrip
                key={channel.channelIndex}
                channel={channel}
                reading={readings[i]}
                peakHold={peakHoldSurfaces.includes("input")}
              />
            ))}
          </Section>

          <Section title="Output">
            <Column width={SIDE_W}>
              <Cell height={HEADER_H} />
              <Scale min={outScale.min} max={outScale.max} marks={outScale.marks} />
              <Cell height={TOGGLE_H} />
              <Cell height={ROW_H} align="end">
                <SideText>V</SideText>
              </Cell>
              <Cell height={ROW_H} align="end">
                <SideText>A</SideText>
              </Cell>
              <Cell height={ROW_H} align="end">
                <SideText>°C</SideText>
              </Cell>
            </Column>
            {channels.map((channel, i) => (
              <OutputStrip
                key={channel.channelIndex}
                channel={channel}
                reading={readings[i]}
                peakHold={peakHoldSurfaces.includes("output")}
                scale={outScale}
                onMute={() => actions.setChannelOutputMute(channel.channelIndex, !(channel.outputMuted ?? false))}
              />
            ))}
            {/* Legend for the LED column, bottom-aligned with it; below it,
             * the A row's total under a label in the V row, where a sum would
             * mean nothing. */}
            <Column width={LEGEND_W}>
              <Cell height={HEADER_H} />
              <div className="flex flex-col justify-end" style={{ height: STRIP_H }}>
                {STATUS_LEDS.map((led) => (
                  <Cell key={led.label} height={LED_ROW_H} align="start">
                    <SideText>{led.label}</SideText>
                  </Cell>
                ))}
              </div>
              <Cell height={TOGGLE_H} />
              <Cell height={ROW_H} align="center">
                <SideText>Total</SideText>
              </Cell>
              <ValueCell value={totalCurrentText(totals)} hint={totals.belowRange ? LOW_CURRENT_HINT : undefined} />
            </Column>
          </Section>
        </div>
      </div>
    </div>
  );
}
