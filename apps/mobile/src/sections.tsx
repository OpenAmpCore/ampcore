import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Block, Button, Card, Chip, Dialog, DialogButton, Preloader, Range, Segmented, SegmentedButton, Sheet } from "konsta/react";
import {
  applyScheme,
  chipColors,
  CROSSOVER_FILTER_TYPES,
  EQ_FILTER_TYPES,
  goEq,
  outputLabel,
  Row,
  savedScheme,
  useEqFilterCaps,
  useRanges,
  type CrossoverSlot,
  type Device,
  type EqBand,
  type Presets as PresetsData,
  type Ranges,
  type Scheme,
  type Snapshot,
  type Tab,
  type Telemetry,
  type Write,
} from "./lib";

interface Props {
  id: string;
  device: Device;
  config: Snapshot;
  telemetry: Telemetry | null;
  write: Write;
  disabled: boolean;
}

// Decoded AmpChannelState (core) → chip colour. Anything not listed is default.
const STATE_COLOR: Record<string, Parameters<typeof chipColors>[0]> = {
  normal: "success",
  run: "success",
  clip: "warning",
  limit: "warning",
  temp: "warning",
  fault: "danger",
  overload: "danger",
  dcp: "danger",
  powerError: "danger",
  open: "danger",
};
const StateChip = ({ state }: { state: string | null | undefined }) =>
  state ? (
    <Chip colors={chipColors(STATE_COLOR[state] ?? "default")}>{state}</Chip>
  ) : null;

const NORMAL = new Set(["normal", "run"]);

// Level meter. Scale and colours are desktop's verbatim (METER_FLOOR_DB and
// DEFAULT_LEVEL_GRADIENT in AmpConfigureView.tsx / VuMeter.tsx) so both apps
// read alike; desktop's own VuMeter isn't imported because the two apps share
// nothing but ampcore-core, and this uses a tenth of it.
const METER_FLOOR_DB = -60;
const METER_GRADIENT = "linear-gradient(to right, #0f6e5c 0%, #2f9e6a 35%, #d4c94a 65%, #e0793a 82%, #d64545 100%)";
const HOLD_MS = 2000;
const DECAY_DB_PER_S = 20;
const litFraction = (db: number | null) => (db === null ? 0 : Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)));

/** Peak that holds for 2s then falls at 20 dB/s (desktop's constants). Driven
 * by the ~200ms telemetry tick, so it marks the loudest recent poll — it can't
 * catch a transient between polls. */
function usePeakHold(db: number | null): number | null {
  const [peak, setPeak] = useState<{ db: number; at: number } | null>(null);
  useEffect(() => {
    if (db === null) return;
    setPeak((p) => {
      if (p === null || db >= p.db) return { db, at: Date.now() };
      const decayed = p.db - Math.max(0, Date.now() - p.at - HOLD_MS) * (DECAY_DB_PER_S / 1000);
      return decayed <= db ? { db, at: Date.now() } : p;
    });
  }, [db]);
  return peak && peak.db > METER_FLOOR_DB ? peak.db : null;
}

/** The bar alone says nothing about a missing reading: an unlit meter looks
 * exactly like silence, which is why every caller puts a readout beside it. */
function Meter({ db, muted }: { db: number | null; muted?: boolean }) {
  const peak = usePeakHold(db);
  return (
    <div className={`relative h-3 flex-1 overflow-hidden rounded-full bg-black/15 dark:bg-white/15 ${muted ? "opacity-40" : ""}`}>
      {/* Gradient spans the whole track and is clipped by the lit width, so a
          colour stays at a fixed scale position instead of sliding with level. */}
      <div
        className="absolute inset-y-0 left-0 overflow-hidden"
        style={{ width: `${litFraction(db) * 100}%` }}
      >
        <div className="h-full" style={{ width: `${100 / Math.max(litFraction(db), 0.001)}%`, background: METER_GRADIENT }} />
      </div>
      {peak !== null && <div className="absolute inset-y-0 w-0.5 bg-white/90" style={{ left: `${litFraction(peak) * 100}%` }} />}
    </div>
  );
}

/** Meter + its numeric readout, the pairing every channel row uses. */
const MeterRow = ({ db, unit, muted }: { db: number | null; unit: string; muted?: boolean }) => (
  <div className="flex items-center gap-2">
    <Meter db={db} muted={muted} />
    <span className="w-20 text-right text-sm tabular-nums opacity-60">{db === null ? "—" : `${db.toFixed(1)} ${unit}`}</span>
  </div>
);

/** Slider that writes on release only (one packet per gesture, not per pixel).
 * `log` maps the track to log10 of the value — a linear 20Hz-20kHz track puts
 * everything below 2kHz in the first 10% of the width, which is unusable.
 * ponytail: keeps the dragged value for 800ms after release so it doesn't snap
 * back before the next poll confirms; a rejected write then shows the amp's value. */
function Fader(p: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? p.value;
  const release = () => {
    if (drag === null) return;
    p.onCommit(drag);
    setTimeout(() => setDrag(null), 800);
  };
  const to = (v: number) => (p.log ? Math.log10(Math.max(v, 1e-6)) : v);
  const from = (v: number) => (p.log ? Math.round(10 ** v) : v);
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{p.label}</span>
        <span>{`${p.log ? Math.round(shown) : shown.toFixed(1)} ${p.unit}`}</span>
      </div>
      {/* Range has no release callback; pointer/touch end bubbles up from its <input> to this wrapper. */}
      <Range
        aria-label={p.label}
        min={to(p.min)}
        max={to(p.max)}
        step={p.step ?? (p.log ? 0.002 : 0.5)}
        value={to(shown)}
        disabled={p.disabled}
        onInput={(e) => setDrag(from(Number(e.currentTarget.value)))}
        onPointerUp={release}
        onTouchEnd={release}
      />
    </div>
  );
}

const FIELD =
  "w-full min-w-0 rounded-lg border border-black/20 bg-transparent px-3 py-2 disabled:opacity-50 dark:border-white/20";

/** Text field committed on blur; keyed by the amp's value so a poll refreshes it. */
function NameField(p: { label: string; value: string; max: number; disabled: boolean; onCommit: (v: string) => void }) {
  return (
    <input
      key={p.value}
      aria-label={p.label}
      placeholder={p.label}
      defaultValue={p.value}
      maxLength={p.max}
      disabled={p.disabled}
      className={FIELD}
      onBlur={(e) => e.target.value.trim() !== p.value && p.onCommit(e.target.value)}
    />
  );
}

export function Overview({ device, config, telemetry, write, disabled }: Props) {
  const t = telemetry;
  const temps = t?.temperatures ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Row
        name="Standby"
        extra={<StateChip state={t?.machineStateDecoded} />}
        checked={config.standby === true}
        disabled={disabled || config.standby === null || config.standbyLocked === true}
        onChange={(standby) => write("set_standby", { standby })}
      />
      {config.standbyLocked && <p className="-mt-3 text-xs opacity-60">Standby is locked on the amp.</p>}
      <Row
        name="Lock front knob"
        checked={config.rotaryLocked === true}
        disabled={disabled || config.rotaryLocked === null}
        onChange={(locked) => write("set_rotary_lock", { locked })}
      />
      {/* Amp-level health only — the per-channel meters live with their own
          controls on the Inputs/Outputs tabs. What stays here is the numbers
          those meters don't show, the role desktop gives DeviceTelemetryPanel. */}
      {!t ? (
        <div className="flex items-center justify-center gap-2">
          <Preloader className="size-5" />
          <span className="opacity-60">Waiting for meters…</span>
        </div>
      ) : (
        <>
          {temps.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              {temps.slice(0, 4).map((v, i) => (
                <StatRow key={i} label={`Temperature ${outputLabel(i)}`} value={`${Math.round(v)} °C`} />
              ))}
              {temps[4] !== undefined && <StatRow label="PSU" value={`${Math.round(temps[4])} °C`} />}
              {t.fanVoltage !== null && <StatRow label="Fan" value={`${t.fanVoltage.toFixed(1)} V`} />}
            </div>
          )}
          <div className="flex flex-col gap-1 text-sm">
            {t.outputLevelDb.map((_, i) => (
              <StatRow
                key={i}
                label={`Output ${outputLabel(i)}`}
                value={
                  [
                    t.outputVoltages[i] !== undefined && `${t.outputVoltages[i].toFixed(1)} V`,
                    t.outputCurrents[i] !== undefined && `${t.outputCurrents[i].toFixed(2)} A`,
                    t.outputImpedance[i] !== undefined && `${t.outputImpedance[i].toFixed(1)} Ω`,
                    // Limiter gain reduction; 0 means the limiter isn't working.
                    t.limiters[i] ? `lim ${t.limiters[i].toFixed(1)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"
                }
              />
            ))}
          </div>
        </>
      )}
      {/* Commissioning, not monitoring — kept last so it isn't in the way while
          working. ponytail: not in Settings because that route is global and has
          no amp in scope; move it there if Settings ever grows an amp picker.
          32 = core's DEVICE_NAME_FIELD_LEN; the backend rejects longer names. */}
      <h2 className="mt-2 font-semibold">Device</h2>
      <NameField label="Amp name" value={device.name} max={32} disabled={disabled} onCommit={(name) => write("set_device_name", { name })} />
    </div>
  );
}

const StatRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="opacity-60">{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

export function Outputs({ id, config, telemetry, write, disabled }: Props) {
  const ranges: Ranges | null = useRanges();
  return (
    <div className="flex flex-col gap-3">
      {config.channels.map((c) => {
        const i = c.channelIndex;
        const st = telemetry?.outputChannelStates[i];
        return (
          <Card key={i} className="!mx-0">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="w-5 text-lg font-semibold">{outputLabel(i)}</span>
                {ranges && (
                  <NameField
                    label="Name"
                    value={c.outputName ?? ""}
                    max={ranges.channelNameMaxLength}
                    disabled={disabled}
                    onCommit={(name) => write("set_channel_name", { channelIndex: i, output: true, name })}
                  />
                )}
                {st && !NORMAL.has(st) && <StateChip state={st} />}
              </div>
              {/* Meter leads the body, controls follow — same channel, same card,
                  so a fader move is visible on the meter without leaving the tab.
                  0 dB = the amp's rated output. */}
              <MeterRow db={telemetry?.outputLevelDb[i] ?? null} unit="dB" muted={c.outputMuted} />
              {ranges && (
                <>
                  <Fader
                    label="Volume"
                    unit="dB"
                    value={c.outputVolumeDb}
                    min={ranges.outputVolumeDb.min}
                    max={ranges.outputVolumeDb.max}
                    disabled={disabled}
                    onCommit={(db) => write("set_output_volume", { channelIndex: i, db })}
                  />
                  <Fader
                    label="Trim"
                    unit="dB"
                    value={c.outputTrimDb}
                    min={ranges.outputTrimDb.min}
                    max={ranges.outputTrimDb.max}
                    disabled={disabled}
                    onCommit={(db) => write("set_output_trim", { channelIndex: i, db })}
                  />
                  <NumField
                    label="Delay (ms)"
                    value={c.delayOutMs}
                    min={ranges.delayOutMs.min}
                    max={ranges.delayOutMs.max}
                    disabled={disabled}
                    onCommit={(ms) => write("set_output_delay", { channelIndex: i, ms })}
                  />
                </>
              )}
              <Row
                name="Invert polarity"
                checked={c.outputPhaseInverted}
                disabled={disabled}
                onChange={(inverted) => write("set_output_polarity", { channelIndex: i, inverted })}
              />
              <Row name="Mute" checked={c.outputMuted} disabled={disabled} onChange={(muted) => write("set_output_mute", { channelIndex: i, muted })} />
              <EqLink id={id} tab="outputs" channelIndex={i} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function Inputs({ id, config, telemetry, write, disabled }: Props) {
  const ranges = useRanges();
  return (
    <div className="flex flex-col gap-3">
      {config.channels.map((c) => (
        <Card key={c.channelIndex} className="!mx-0">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="w-5 text-lg font-semibold">{c.channelIndex + 1}</span>
              {ranges && (
                <NameField
                  label="Name"
                  value={c.inputName ?? ""}
                  max={ranges.channelNameMaxLength}
                  disabled={disabled}
                  onCommit={(name) => write("set_channel_name", { channelIndex: c.channelIndex, output: false, name })}
                />
              )}
              {/* Pill stays in the header: appearing inside the control row at
                  runtime would re-wrap it. ponytail: the vendor enum is
                  `Clip = 0` and core follows it, but the old web app read the
                  same byte as "signal present" — unconfirmed on hardware. */}
              {telemetry?.inputClipping[c.channelIndex] && (
                <Chip colors={chipColors("warning")}>clip</Chip>
              )}
            </div>
            {/* dBV, not dBFS: core converts against an honest 1.0V reference
                (telemetry_v118.rs), so 0 dB = 1 Vrms in, despite the field name. */}
            <MeterRow db={telemetry?.inputDbfs[c.channelIndex] ?? null} unit="dBV" muted={c.inputMuted} />
            {ranges && (
              <NumField
                label="Delay (ms)"
                value={c.delayInMs}
                min={ranges.delayInMs.min}
                max={ranges.delayInMs.max}
                disabled={disabled}
                onCommit={(ms) => write("set_input_delay", { channelIndex: c.channelIndex, ms })}
              />
            )}
            <Row
              name="Mute"
              checked={c.inputMuted}
              disabled={disabled}
              onChange={(muted) => write("set_input_mute", { channelIndex: c.channelIndex, muted })}
            />
            <EqLink id={id} tab="inputs" channelIndex={c.channelIndex} />
          </div>
        </Card>
      ))}
    </div>
  );
}

const EqLink = ({ id, tab, channelIndex }: { id: string; tab: Tab; channelIndex: number }) => (
  <Button outline onClick={() => goEq(id, tab, channelIndex)}>
    EQ
  </Button>
);

/** HP + 8 bands + LP for one channel's chain. Tapping a row opens the sheet;
 * every edit is a partial patch, so the amp keeps the fields left untouched. */
export function Eq({ config, write, disabled, tab, channelIndex }: Props & { tab: Tab; channelIndex: number }) {
  const ranges = useRanges();
  const caps = useEqFilterCaps();
  const [open, setOpen] = useState<number | "hp" | "lp" | null>(null);
  const channel = config.channels.find((c) => c.channelIndex === channelIndex);
  const output = tab === "outputs";
  const direction = output ? "output" : "input";
  const eq = output ? channel?.outputEq : channel?.inputEq;

  if (!channel || !eq || !ranges) return <p className="opacity-60">Waiting for EQ data…</p>;

  const slotRow = (kind: "hp" | "lp", slot: CrossoverSlot, name: string) => (
    <Card className="!mx-0" onClick={() => setOpen(kind)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{name}</span>
        <span className="text-sm opacity-60">
          {slot.active ? `${Math.round(slot.freqHz)} Hz · ${slot.filterType}` : "off"}
        </span>
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="opacity-60">
        {output ? `Output ${outputLabel(channelIndex)}` : `Input ${channelIndex + 1}`} EQ
      </p>
      {slotRow("hp", eq.hp, "High-pass")}
      {eq.bands.map((b, i) => (
        <Card key={i} className="!mx-0" onClick={() => setOpen(i)}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${b.active ? "bg-brand-primary" : "bg-black/25 dark:bg-white/25"}`} />
              <span className="font-semibold">Band {i + 1}</span>
            </span>
            <span className="text-sm opacity-60">
              {Math.round(b.freqHz)} Hz · {b.gainDb.toFixed(1)} dB · Q {b.q.toFixed(2)}
            </span>
          </div>
        </Card>
      ))}
      {slotRow("lp", eq.lp, "Low-pass")}

      <Sheet opened={open !== null} onBackdropClick={() => setOpen(null)}>
        <div className="flex flex-col gap-3 p-4 pb-safe">
          {typeof open === "number" && (
            <BandSheet
              band={eq.bands[open]}
              index={open}
              ranges={ranges}
              caps={caps}
              disabled={disabled}
              onPatch={(patch) => write("set_eq_band", { channelIndex, direction, bandIndex: open, patch })}
              onClose={() => setOpen(null)}
            />
          )}
          {(open === "hp" || open === "lp") && (
            <SlotSheet
              slot={open === "hp" ? eq.hp : eq.lp}
              name={open === "hp" ? "High-pass" : "Low-pass"}
              ranges={ranges}
              disabled={disabled}
              onPatch={(patch) => write("set_crossover_slot", { channelIndex, direction, slot: open, patch })}
              onClose={() => setOpen(null)}
            />
          )}
        </div>
      </Sheet>
    </div>
  );
}

/** A patch only carries the field that changed — the backend merges the rest
 * from the amp's last poll, so nothing untouched gets overwritten. */
function BandSheet(p: {
  band: EqBand;
  index: number;
  ranges: Ranges;
  caps: Record<string, { supportsGain: boolean; supportsQ: boolean }> | null;
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const cap = p.caps?.[p.band.filterType];
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Band {p.index + 1}</h2>
        <Button clear onClick={p.onClose}>
          Done
        </Button>
      </div>
      <TypePicker
        types={EQ_FILTER_TYPES}
        value={p.band.filterType}
        disabled={p.disabled}
        onChange={(filterType) => p.onPatch({ filterType })}
      />
      <Fader
        label="Frequency"
        unit="Hz"
        log
        value={p.band.freqHz}
        min={p.ranges.crossoverFreqHz.min}
        max={p.ranges.crossoverFreqHz.max}
        disabled={p.disabled}
        onCommit={(freqHz) => p.onPatch({ freqHz })}
      />
      {/* Gain/Q support is per filter type, resolved by core — an all-pass has neither. */}
      <Fader
        label="Gain"
        unit="dB"
        value={p.band.gainDb}
        min={p.ranges.eqBandGainDb.min}
        max={p.ranges.eqBandGainDb.max}
        disabled={p.disabled || cap?.supportsGain === false}
        onCommit={(gainDb) => p.onPatch({ gainDb })}
      />
      <Fader
        label="Q"
        unit=""
        step={0.01}
        value={p.band.q}
        min={p.ranges.eqBandQ.min}
        max={p.ranges.eqBandQ.max}
        disabled={p.disabled || cap?.supportsQ === false}
        onCommit={(q) => p.onPatch({ q })}
      />
      <Row name="Active" checked={p.band.active} disabled={p.disabled} onChange={(active) => p.onPatch({ active })} />
    </>
  );
}

function SlotSheet(p: {
  slot: CrossoverSlot;
  name: string;
  ranges: Ranges;
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{p.name}</h2>
        <Button clear onClick={p.onClose}>
          Done
        </Button>
      </div>
      <TypePicker
        types={CROSSOVER_FILTER_TYPES}
        value={p.slot.filterType}
        disabled={p.disabled}
        onChange={(filterType) => p.onPatch({ filterType })}
      />
      <Fader
        label="Frequency"
        unit="Hz"
        log
        value={p.slot.freqHz}
        min={p.ranges.crossoverFreqHz.min}
        max={p.ranges.crossoverFreqHz.max}
        disabled={p.disabled}
        onCommit={(freqHz) => p.onPatch({ freqHz })}
      />
      <Row name="Active" checked={p.slot.active} disabled={p.disabled} onChange={(active) => p.onPatch({ active })} />
    </>
  );
}

/** Native <select>: 11 filter types is too many for a Segmented control, and
 * the platform picker is the right control on a phone anyway. */
const TypePicker = <T extends string>(p: { types: readonly T[]; value: T; disabled: boolean; onChange: (v: T) => void }) => (
  <label className="flex items-center justify-between gap-3">
    <span className="text-sm">Type</span>
    <select
      className={`${FIELD} !w-48`}
      value={p.value}
      disabled={p.disabled}
      onChange={(e) => p.onChange(e.target.value as T)}
    >
      {p.types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  </label>
);

/** Numeric field committed on blur; keyed by the amp's value so a poll refreshes it. */
function NumField(p: { label: string; value: number; min: number; max: number; disabled: boolean; onCommit: (v: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm">{p.label}</span>
      <input
        key={p.value}
        type="number"
        className={`${FIELD} !w-28 text-right`}
        defaultValue={p.value}
        min={p.min}
        max={p.max}
        step={0.1}
        disabled={p.disabled}
        onBlur={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v) && v !== p.value) p.onCommit(v);
        }}
      />
    </label>
  );
}

export function Presets({ id, write, disabled }: Pick<Props, "id" | "write" | "disabled">) {
  const [presets, setPresets] = useState<PresetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ index: number; name: string } | null>(null);
  // Kept after close so the dialog text doesn't blank during its exit animation.
  const [shown, setShown] = useState<{ index: number; name: string } | null>(null);
  const slot = pending ?? shown;

  const load = () => invoke<PresetsData>("fetch_presets", { deviceId: id }).then(setPresets, (e) => setError(String(e)));
  useEffect(() => {
    void load();
  }, [id]);

  if (error) return <Block strong className="!my-0 bg-red-500/20">{error}</Block>;
  if (!presets)
    return (
      <div className="flex justify-center py-4">
        <Preloader className="size-5" />
      </div>
    );

  return (
    <>
      <div className="flex flex-col gap-2">
        {presets.slots.map((s) => {
          const active = s.name !== "" && s.name === presets.activePresetName;
          return (
            <Button
              key={s.index}
              large
              tonal={active}
              outline={!active}
              disabled={disabled}
              className="!h-auto justify-start py-3 text-left"
              onClick={() => {
                setPending(s);
                setShown(s);
              }}
            >
              <span className="flex flex-col items-start">
                <span>{s.name || "(empty)"}</span>
                <span className="text-xs opacity-60">Slot {s.index}</span>
              </span>
            </Button>
          );
        })}
      </div>
      {/* Recall replaces the whole amp's live settings, so it is always confirmed. */}
      <Dialog
        opened={pending !== null}
        onBackdropClick={() => setPending(null)}
        title="Recall preset?"
        content={`“${slot?.name || "(empty)"}” replaces the amp’s current settings.`}
        buttons={
          <>
            <DialogButton onClick={() => setPending(null)}>Cancel</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                setPending(null);
                if (slot) void write("recall_preset", { slotIndex: slot.index }).then(load);
              }}
            >
              Recall
            </DialogButton>
          </>
        }
      />
    </>
  );
}

export function Settings() {
  const [scheme, setScheme] = useState<Scheme>(savedScheme);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-semibold">Colour scheme</h2>
      <Segmented strong>
        {(["dark", "light", "auto"] as const).map((s) => (
          <SegmentedButton
            key={s}
            active={scheme === s}
            className="capitalize"
            onClick={() => {
              applyScheme(s);
              setScheme(s);
            }}
          >
            {s}
          </SegmentedButton>
        ))}
      </Segmented>
    </div>
  );
}
