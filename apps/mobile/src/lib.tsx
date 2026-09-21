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

// Hash routes: `#/` (amps), `#/amp/:id/:tab` and `#/amp/:id/:tab/eq/:channel`.
// Writing location.hash pushes WebView history, and wry's WryActivity maps
// Android's back button to canGoBack() → goBack(), so system back leaves the
// EQ screen with no router library.
// ponytail: swap for wouter/react-router if nested layouts or guards appear.
// Input before Output: signal-flow order, same as desktop's tab contract.
export const TABS = ["overview", "inputs", "outputs", "presets"] as const;
export type Tab = (typeof TABS)[number];

const onHash = (cb: () => void) => {
  addEventListener("hashchange", cb);
  return () => removeEventListener("hashchange", cb);
};

/** `eqChannel` is set only on the EQ route; the tab picks the chain
 * (inputs → input EQ, outputs → output EQ). */
export function useRoute(): { id: string | null; tab: Tab; eqChannel: number | null; settings: boolean } {
  const hash = useSyncExternalStore(onHash, () => location.hash);
  const m = hash.match(/^#\/amp\/([^/]+)(?:\/(\w+))?(?:\/eq\/(\d+))?/);
  if (!m) return { id: null, tab: "overview", eqChannel: null, settings: hash === "#/settings" };
  return {
    id: decodeURIComponent(m[1]),
    tab: TABS.find((t) => t === m[2]) ?? "overview",
    eqChannel: m[3] === undefined ? null : Number(m[3]),
    settings: false,
  };
}

export function go(id: string | null, tab: Tab = "overview") {
  location.hash = id ? `#/amp/${encodeURIComponent(id)}/${tab}` : "#/";
}

export const goEq = (id: string, tab: Tab, channelIndex: number) => {
  location.hash = `#/amp/${encodeURIComponent(id)}/${tab}/eq/${channelIndex}`;
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
