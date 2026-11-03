import { useEffect, useState, type ReactNode } from "react";
import { Slider } from "@heroui/react";
import { Volume2, VolumeX } from "lucide-react";
import type { ConfigurableTabProps } from "./configure/parts";
import { ChannelStateBadge } from "./ChannelStateBadge";
import { CommitNumberInput } from "./CommitNumberInput";
import { SECTION_TITLE } from "./fieldClasses";
import { Hint } from "./Hint";
import { StatToggle } from "./StatTiles";
import { DEFAULT_LEVEL_GRADIENT, VuMeter, type VuMeterMark } from "./VuMeter";
import { NO_AMP_GAIN, type AmpGainReading } from "../lib/ampGain";
import type { ActionResult } from "../lib/actionResult";
import type { AmpChannel, AmpChannelState, DiscoveredDevice } from "../lib/bindings";
import { channelTelemetry, FALLBACK_LIMITER, outputLetter, OUTPUT_METER_FLOOR_DB, OUTPUT_METER_MARKS, outputMeterScale, rmsCeilingVolts, type ChannelTelemetry, type OutputMeterScale, INPUT_METER_FLOOR_DB, INPUT_METER_MARKS } from "../lib/channelTelemetry";
import { channelStateTone } from "../lib/channelState";
import { usePreference } from "../lib/preferences";

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

/** Every channel column is the strip tile's own width, so the Mute toggle
 * fills its column exactly and the three cards read as one grid. */
const COLUMN_W = 72;
/** Faders and meters share one height and all start right under the header,
 * so their ends line up across cards. */
const STRIP_H = 200;
/** How far inside its box a vertical HeroUI slider's thumb stops at either
 * end: the slider grid's 0.5rem row gap plus the track's 0.75rem transparent
 * border (`@heroui/styles` slider.css). The fader scale is inset to match, so
 * a label sits level with the thumb at that value.
 * ponytail: copied from @heroui/styles 3.2.5's vertical slider (`gap-2` +
 * `border-y-[0.75rem]`); re-check after a HeroUI upgrade, or measure the
 * thumb's travel at runtime if it ever drifts. */
const FADER_THUMB_INSET = 20;
/** A value row: the dB/Gain/SEN fields and the V/A/°C readouts. */
const ROW_H = 30;
/** A column's channel number or letter, with its name under it. */
const HEADER_H = 36;
/** `StatToggle`'s fixed height — the Mute row. */
const TOGGLE_H = 52;
/** Label/scale columns, and the Output card's LED legend. */
const SIDE_W = 44;
const LEGEND_W = 56;
const GAP = 8;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className={SECTION_TITLE}>{title}</h3>
      {/* `flex-1`: the card row stretches its sections, so every card ends on
       * the same bottom edge. */}
      <div
        className="flex min-w-0 flex-1 overflow-x-auto rounded-xl border border-[var(--amp-color-default-border)] p-3"
        style={{ gap: GAP }}
      >
        {children}
      </div>
    </section>
  );
}

function Column({ width = COLUMN_W, children }: { width?: number; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col" style={{ width, gap: GAP }}>
      {children}
    </div>
  );
}

/** One fixed-height row of a column. `align` places side labels against the
 * channel columns they describe. */
function Cell({
  height,
  align = "center",
  children,
}: {
  height: number;
  align?: "start" | "center" | "end";
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center" style={{ height, justifyContent: align }}>
      {children}
    </div>
  );
}

function SideText({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function ChannelHeader({ label, name }: { label: string; name: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center" style={{ height: HEADER_H }}>
      <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 600, color: "var(--amp-color-dimmed)" }}>
        {label}
      </span>
      <Hint text={name} className="w-full min-w-0">
        <span className="block truncate text-center text-[length:var(--amp-font-size-xs)]">{name}</span>
      </Hint>
    </div>
  );
}

/** The name the amp holds for an input, or its default label. */
const inputName = (channel: AmpChannel) => channel.inputName?.trim() || `In${channel.channelIndex + 1}`;

/** Same for an output, without the legacy `_XXXX` speaker-hash suffix (core's
 * `split_hash_suffix`). */
const outputName = (channel: AmpChannel) =>
  channel.outputName?.trim().replace(/_[0-9a-fA-F]{4}$/, "") || `Out${outputLetter(channel.channelIndex)}`;

/** A passive value, recessed like `StatReadout` but one row high. */
function ValueCell({ value, hint }: { value: string; hint?: string }) {
  const cell = (
    <div
      className="flex w-full items-center justify-center"
      style={{
        height: ROW_H,
        borderRadius: "var(--radius-md)",
        background: "var(--amp-color-default)",
        fontSize: "var(--amp-font-size-sm)",
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
  );
  return hint ? (
    <Hint text={hint} className="w-full">
      {cell}
    </Hint>
  ) : (
    cell
  );
}

function Led({ color, lit, label }: { color: string; lit: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${lit ? "on" : "off"}`}
      className="block shrink-0 rounded-full"
      style={{
        width: 8,
        height: 8,
        background: lit ? color : "var(--amp-color-default)",
        border: `1px solid ${lit ? color : "var(--amp-color-default-border)"}`,
        boxShadow: lit ? `0 0 6px ${color}` : undefined,
      }}
    />
  );
}

/** A meter scale on its own: a `VuMeter` with no track, so its labels sit at
 * exactly the positions a real meter of the same size puts them. `inset`
 * shortens it at both ends, for a fader whose thumb stops short of its box. */
function Scale({ min, max, marks, inset = 0 }: { min: number; max: number; marks: VuMeterMark[]; inset?: number }) {
  return (
    <Cell height={STRIP_H} align="end">
      <VuMeter
        orientation="vertical"
        min={min}
        max={max}
        value={min}
        marks={marks}
        thickness={0}
        size={STRIP_H - 2 * inset}
      />
    </Cell>
  );
}

function LevelMeter({
  level,
  peakHold,
  disabled,
  min = INPUT_METER_FLOOR_DB,
  max = 0,
}: {
  level: number | null;
  peakHold: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <VuMeter
      orientation="vertical"
      min={min}
      max={max}
      value={level ?? min}
      gradient={DEFAULT_LEVEL_GRADIENT}
      thickness={14}
      size={STRIP_H}
      peakHold={peakHold}
      disabled={disabled}
    />
  );
}

/** One channel of the Volume card: fader, its value, and the amp gain with
 * the sensitivity it implies. The fader commits on release, not per tick —
 * the same reason as `LimiterEditor`'s threshold sliders — and its drag
 * value drives the field below it, so the number follows the thumb. */
function VolumeStrip({
  channel,
  min,
  max,
  gain,
  locked,
  onVolume,
  onGain,
}: {
  channel: AmpChannel;
  min: number;
  max: number;
  gain: AmpGainReading;
  /** The slider drags through pointer handlers on a `div`, which the tab's
   * disabled fieldset doesn't reach — so it is disabled explicitly. */
  locked: boolean;
  onVolume: (volumeDb: number) => Promise<ActionResult>;
  /** Absent without a live write path — Gain is then a readout. */
  onGain?: (gainDb: number) => Promise<ActionResult>;
}) {
  const volumeDb = channel.outputVolumeDb ?? 0;
  const [drag, setDrag] = useState(volumeDb);
  useEffect(() => {
    setDrag(volumeDb);
  }, [volumeDb]);
  const [gainDraft, setGainDraft] = useState(gain.gainDb);
  useEffect(() => {
    setGainDraft(gain.gainDb);
  }, [gain.gainDb]);
  const letter = outputLetter(channel.channelIndex);

  // A refused write leaves the amp's value where it was, so the effects above
  // never fire; without the reset the fader and fields would keep showing a
  // value the amp never took. Setting the draft first is what makes the reset
  // a change the fields see, and moves the fader to a typed value at once.
  function commit(value: number) {
    setDrag(value);
    void onVolume(value).then((result) => {
      if (!result.ok) setDrag(volumeDb);
    });
  }

  function commitGain(value: number) {
    if (!onGain) return;
    setGainDraft(value);
    void onGain(value).then((result) => {
      if (!result.ok) setGainDraft(gain.gainDb);
    });
  }

  return (
    <Column>
      <ChannelHeader label={letter} name={outputName(channel)} />
      <Cell height={STRIP_H}>
        <Slider
          orientation="vertical"
          aria-label={`Output ${letter} volume`}
          style={{ height: STRIP_H }}
          minValue={min}
          maxValue={max}
          step={0.5}
          value={drag}
          isDisabled={locked}
          onChange={(value) => setDrag(value as number)}
          onChangeEnd={(value) => commit(value as number)}
        >
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </Cell>
      <CommitNumberInput
        aria-label={`Output ${letter} volume`}
        value={drag}
        min={min}
        max={max}
        step={0.1}
        onCommit={commit}
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
          <Section title="Volume">
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
            {channels.map((channel) => (
              <VolumeStrip
                key={channel.channelIndex}
                channel={channel}
                min={volumeMin}
                max={volumeMax}
                gain={ampGains?.[channel.channelIndex] ?? NO_AMP_GAIN}
                locked={locked ?? false}
                onVolume={(volumeDb) => actions.setChannelOutput(channel.channelIndex, null, volumeDb, null)}
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
