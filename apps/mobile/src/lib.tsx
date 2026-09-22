import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { List, ListItem, Toggle } from "konsta/react";

// ponytail: hand-written camelCase subsets of ampcore_core's serialized types
// (DiscoveredDevice, ChannelConfigSnapshot, Telemetry, DevicePresetsSnapshot).
// Move to tauri-specta bindings if mobile's command count keeps growing.
export interface Device {
  id: string;
  name: string;
  brand: string;
  ip: string;
  mac: string;
  firmwareVersion: string;
  analogInputChannels: number;
  digitalInputChannels: number;
  outputChannels: number;
  online: boolean;
}
/** Core's `EqFilterType`/`CrossoverFilterType`, camelCase on the wire. The
 * parametric list is ordered as core declares it; `EQ_FILTER_TYPES` is what
 * the picker renders, `eqFilterCaps()` says which of gain/Q each one has. */
export const EQ_FILTER_TYPES = [
  "peaking",
  "lowShelf",
  "highShelf",
  "allPass1st",
  "allPass2nd",
  "generalLow",
  "generalHigh",
  "butterworthLow",
  "butterworthHigh",
  "besselLow",
  "besselHigh",
] as const;
export type EqFilterType = (typeof EQ_FILTER_TYPES)[number];
export const CROSSOVER_FILTER_TYPES = [
  "butterworth12",
  "bessel12",
  "linkwitzRiley12",
  "butterworth18",
  "butterworth24",
  "bessel24",
  "linkwitzRiley24",
  "butterworth36",
  "butterworth48",
  "bessel48",
  "linkwitzRiley48",
] as const;
export type CrossoverFilterType = (typeof CROSSOVER_FILTER_TYPES)[number];

export interface EqBand {
  filterType: EqFilterType;
  freqHz: number;
  gainDb: number;
  q: number;
  active: boolean;
}
export interface CrossoverSlot {
  filterType: CrossoverFilterType;
  freqHz: number;
  active: boolean;
}
/** HP + 8 parametric bands + LP, per channel per direction. */
export interface ChannelEq {
  hp: CrossoverSlot;
  bands: EqBand[];
  lp: CrossoverSlot;
}
export interface Channel {
  channelIndex: number;
  inputMuted: boolean;
  outputMuted: boolean;
  inputName: string | null;
  outputName: string | null;
  outputVolumeDb: number;
  outputTrimDb: number;
  delayInMs: number;
  delayOutMs: number;
  outputPhaseInverted: boolean;
  inputEq: ChannelEq;
  outputEq: ChannelEq;
  matrixCrosspoints: MatrixCrosspoint[];
  limiter: Limiter;
}
/** One matrix cell: which input feeds this output, and how hot. */
export interface MatrixCrosspoint {
  sourceIndex: number;
  gainDb: number;
  active: boolean;
}
/** Both limiter stages run independently; each is a whole-record write, so the
 * backend merges the fields a patch omits (see `set_limiter`). */
export interface Limiter {
  rms: { enabled: boolean; thresholdVrms: number; attackMs: number; releaseMultiplier: number };
  peak: { enabled: boolean; thresholdVp: number; holdMs: number; releaseMs: number };
}
export interface Snapshot {
  standby: boolean | null;
  standbyLocked: boolean | null;
  rotaryLocked: boolean | null;
  channels: Channel[];
}
export interface Telemetry {
  temperatures: number[];
  outputVoltages: number[];
  outputCurrents: number[];
  outputImpedance: number[];
  outputLevelDb: (number | null)[];
  outputChannelStates: (string | null)[];
  inputDbfs: (number | null)[];
  inputClipping: (boolean | null)[];
  limiters: number[];
  fanVoltage: number | null;
  machineStateDecoded: string | null;
}
/** Subset of core's AmpParamRanges (slider bounds; the UI never hardcodes them). */
export interface Ranges {
  outputVolumeDb: { min: number; max: number };
  outputTrimDb: { min: number; max: number };
  delayInMs: { min: number; max: number };
  delayOutMs: { min: number; max: number };
  crossoverFreqHz: { min: number; max: number };
  eqBandGainDb: { min: number; max: number };
  eqBandQ: { min: number; max: number };
  matrixGainDb: { min: number; max: number };
  rmsLimiterThresholdVrms: { min: number; max: number };
  rmsLimiterAttackMs: { min: number; max: number };
  rmsLimiterReleaseMultiplier: { min: number; max: number };
  peakLimiterThresholdVp: { min: number; max: number };
  peakLimiterHoldMs: { min: number; max: number };
  peakLimiterReleaseMs: { min: number; max: number };
  channelNameMaxLength: number;
}
export interface Presets {
  slots: { index: number; name: string }[];
  activePresetName: string | null;
}
/** Core's `LiveWriteAck`: what one write command put on the wire. An ack proves
 * the amp received the packets, never that the parameter took the value — the
 * next poll is what shows the real state. */
export interface WriteAck {
  packets: number;
  attempts: number;
  elapsedMs: number;
  coalesced: number;
}

/** Runs a command against the open amp; the result shows up as the screen's toast. */
export type Write = (cmd: string, args: Record<string, unknown>) => Promise<void>;

/** Outputs are lettered A, B, C… (repo convention; inputs are numbered). */
export const outputLabel = (i: number) => String.fromCharCode(65 + i);

// Hash routes:
//   #/                        amps
//   #/settings                settings
//   #/amp/:id                 landing (meters, standby, device)
//   #/amp/:id/presets         presets
//   #/amp/:id/in|out/:ch      that channel's signal path
//   #/amp/:id/in|out/:ch/:st  one stage of it
// Writing location.hash pushes WebView history, and wry's WryActivity maps
// Android's back button to canGoBack() → goBack(), so system back walks
// stage → path → landing → amps with no router library.
// ponytail: swap for wouter/react-router if nested layouts or guards appear.
export type Dir = "in" | "out";

/** The signal path itself. A plain table, not a backend call: `CvrUdp` is the
 * only protocol and the order is identical on 1.1.8 and 1.1.9, so a command
 * would return a constant. Everything that genuinely varies per model or
 * firmware already crosses the bridge — channel counts on `Device`, bounds via
 * `amp_ranges`, gain/Q support via `amp_eq_filter_capabilities`, presets via
 * `amp_presets_supported`. Nothing here is a DSP or capability fact.
 *
 * `short` is the strip glyph, `label` the screen title. Input has no source or
 * trim stage because mobile has no command to write either. */
export const PATHS = {
  in: [
    { id: "in", short: "IN", label: "Input" },
    { id: "delay", short: "DLY", label: "Delay" },
    { id: "eq", short: "EQ", label: "Input EQ" },
  ],
  out: [
    { id: "matrix", short: "MTX", label: "Sources" },
    { id: "eq", short: "EQ", label: "Output EQ" },
    { id: "limiter", short: "LIM", label: "Limiter" },
    { id: "delay", short: "DLY", label: "Delay & Polarity" },
    { id: "out", short: "OUT", label: "Output" },
  ],
} as const satisfies Record<Dir, readonly { id: string; short: string; label: string }[]>;

export type StageId = (typeof PATHS)[Dir][number]["id"];
export const stagesFor = (dir: Dir): readonly { id: string; short: string; label: string }[] => PATHS[dir];

const onHash = (cb: () => void) => {
  addEventListener("hashchange", cb);
  return () => removeEventListener("hashchange", cb);
};

export interface Route {
  id: string | null;
  dir: Dir;
  /** `null` on the landing screen — no channel picked yet. */
  ch: number | null;
  /** `null` = the path overview; otherwise the open stage. */
  stage: StageId | null;
  presets: boolean;
  settings: boolean;
}

/** An unknown stage falls back to the path overview rather than a blank
 * screen — same defensive shape the old tab route had. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(onHash, () => location.hash);
  const base: Route = { id: null, dir: "out", ch: null, stage: null, presets: false, settings: hash === "#/settings" };
  const m = hash.match(/^#\/amp\/([^/]+)(?:\/(in|out|presets)(?:\/(\d+)(?:\/(\w+))?)?)?/);
  if (!m) return base;
  const id = decodeURIComponent(m[1]);
  if (m[2] === "presets") return { ...base, id, presets: true, settings: false };
  const dir: Dir = m[2] === "in" ? "in" : "out";
  const ch = m[3] === undefined ? null : Number(m[3]);
  const stage = stagesFor(dir).find((s) => s.id === m[4])?.id ?? null;
  return { id, dir, ch, stage: (stage as StageId | null) ?? null, presets: false, settings: false };
}

const amp = (id: string) => `#/amp/${encodeURIComponent(id)}`;

export function go(id: string | null) {
  location.hash = id ? amp(id) : "#/";
}
export const goPath = (id: string, dir: Dir, ch: number) => {
  location.hash = `${amp(id)}/${dir}/${ch}`;
};
export const goStage = (id: string, dir: Dir, ch: number, stage: string) => {
  location.hash = `${amp(id)}/${dir}/${ch}/${stage}`;
};
export const goPresets = (id: string) => {
  location.hash = `${amp(id)}/presets`;
};
export const goSettings = () => {
  location.hash = "#/settings";
};

/** Colour scheme: saved in localStorage, applied as the `dark` class on <html> (Konsta's dark
 * variant keys off it). index.html applies the saved value before first paint.
 * ponytail: "auto" is resolved once, not live-tracked. */
export type Scheme = "dark" | "light" | "auto";
const SCHEME_KEY = "ampcore-color-scheme";
export const savedScheme = (): Scheme => {
  try {
    return (localStorage.getItem(SCHEME_KEY) as Scheme | null) ?? "dark";
  } catch {
    return "dark";
  }
};
export function applyScheme(s: Scheme) {
  try {
    localStorage.setItem(SCHEME_KEY, s);
  } catch {
    // private mode: applies for this session only
  }
  const dark = s === "dark" || (s === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Slider/name bounds from core, fetched once. */
let ranges: Promise<Ranges> | undefined;
export function useRanges(): Ranges | null {
  const [r, setR] = useState<Ranges | null>(null);
  useEffect(() => {
    ranges ??= invoke<Ranges>("amp_ranges");
    ranges.then(setR, () => setR(null));
  }, []);
  return r;
}

/** Which filter types expose gain/Q, resolved by core (never a TS table).
 * Device-independent today, so fetched once like `useRanges`. */
let eqCaps: Promise<Record<string, { supportsGain: boolean; supportsQ: boolean }>> | undefined;
export function useEqFilterCaps() {
  const [caps, setCaps] = useState<Record<string, { supportsGain: boolean; supportsQ: boolean }> | null>(null);
  useEffect(() => {
    eqCaps ??= invoke<{ filterType: string; supportsGain: boolean; supportsQ: boolean }[]>("amp_eq_filter_capabilities").then((list) =>
      Object.fromEntries(list.map((e) => [e.filterType, { supportsGain: e.supportsGain, supportsQ: e.supportsQ }])),
    );
    eqCaps.then(setCaps, () => setCaps(null));
  }, []);
  return caps;
}

/** Discovered amps, sorted by ip (the backend hands over HashMap order, which
 * reshuffles between events). Discovery starts here and runs for the app's lifetime. */
export function useDevices(): Device[] {
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const off = await listen<Device[]>("live_device:updated", (e) => setDevices(e.payload));
      if (cancelled) return off();
      unlisten = off;
      setDevices(await invoke<Device[]>("discovery_list"));
      await invoke("discovery_start"); // idempotent
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return [...devices].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/** Polls one amp (config + heartbeat) while the caller is mounted: subscribes
 * on mount, unsubscribes on unmount. State is the polled one, so a switch
 * reflects a write one poll cycle (~200ms) later. */
export function useAmpLive(id: string) {
  const [config, setConfig] = useState<Snapshot | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  useEffect(() => {
    const token = crypto.randomUUID();
    let offs: (() => void)[] = [];
    let cancelled = false;
    (async () => {
      const l = await Promise.all([
        listen<{ deviceId: string; config: Snapshot }>("live_channel_config:updated", (e) => {
          if (e.payload.deviceId === id) setConfig(e.payload.config);
        }),
        listen<{ deviceId: string; telemetry: Telemetry }>("live_telemetry:updated", (e) => {
          if (e.payload.deviceId === id) setTelemetry(e.payload.telemetry);
        }),
      ]);
      if (cancelled) return l.forEach((f) => f());
      offs = l;
      await invoke("poll_subscribe", { token, deviceIds: [id] });
    })();
    return () => {
      cancelled = true;
      offs.forEach((f) => f());
      void invoke("poll_subscribe", { token, deviceIds: [] });
    };
  }, [id]);
  return { config, telemetry };
}

/** Konsta Chip colours for a status (fixed red/orange/green, not the accent). */
export const chipColors = (c: "success" | "warning" | "danger" | "default") => {
  const bg = { success: "bg-green-500", warning: "bg-orange-500", danger: "bg-red-500", default: "" }[c];
  const text = c === "default" ? "" : "text-white";
  return { fillBgIos: bg, fillBgMaterial: bg, fillTextIos: text, fillTextMaterial: text };
};

/** A settings-style row: name on the left, (optional extra +) toggle on the right. */
export function Row(p: { name: string; extra?: ReactNode; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <List strongIos insetIos className="!my-0">
      <ListItem
        label
        title={p.name}
        after={
          <span className="flex items-center gap-2">
            {p.extra}
            <Toggle checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} />
          </span>
        }
      />
    </List>
  );
}
