import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  /** Core's decoded FC=0 machine state; `null` when the firmware has no table. */
  machineStateDecoded: string | null;
  online: boolean;
}
/** Core's `EqFilterType`/`CrossoverFilterType`, camelCase on the wire, in
 * core's declaration order. Which of gain/Q each one has is core's call
 * (`useEqFilterCaps`), never a TS table. */
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

/** Display names only — what the picker shows instead of core's identifiers. */
export const FILTER_LABELS: Record<EqFilterType | CrossoverFilterType, string> = {
  peaking: "Peaking",
  lowShelf: "Low shelf",
  highShelf: "High shelf",
  allPass1st: "All-pass 1st order",
  allPass2nd: "All-pass 2nd order",
  generalLow: "Low-pass (Q)",
  generalHigh: "High-pass (Q)",
  butterworthLow: "Butterworth low-pass",
  butterworthHigh: "Butterworth high-pass",
  besselLow: "Bessel low-pass",
  besselHigh: "Bessel high-pass",
  butterworth12: "Butterworth 12 dB/oct",
  bessel12: "Bessel 12 dB/oct",
  linkwitzRiley12: "Linkwitz-Riley 12 dB/oct",
  butterworth18: "Butterworth 18 dB/oct",
  butterworth24: "Butterworth 24 dB/oct",
  bessel24: "Bessel 24 dB/oct",
  linkwitzRiley24: "Linkwitz-Riley 24 dB/oct",
  butterworth36: "Butterworth 36 dB/oct",
  butterworth48: "Butterworth 48 dB/oct",
  bessel48: "Bessel 48 dB/oct",
  linkwitzRiley48: "Linkwitz-Riley 48 dB/oct",
};

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

/** Runs a command against the open amp. Silent on success — the next poll
 * shows the new state; a failure raises the screen's error toast. */
export type Write = (cmd: string, args: Record<string, unknown>) => Promise<void>;

export type Dir = "in" | "out";
/** Outputs are lettered A, B, C… (repo convention; inputs are numbered). */
export const outputLabel = (i: number) => String.fromCharCode(65 + i);
export const channelLabel = (dir: Dir, ch: number) => (dir === "in" ? `${ch + 1}` : outputLabel(ch));

/** How many channels a direction has. Counts come from the amp and are not
 * assumed equal, but every control indexes `config.channels`, so a count
 * can't outrun that array. */
export const channelCount = (dir: Dir, config: Snapshot, d: Device) =>
  Math.min(dir === "in" ? d.analogInputChannels : d.outputChannels, config.channels.length);

/** Decoded AmpChannelState (core) → status. Anything unlisted is neutral.
 * Status colours are fixed, never the accent. */
export type Status = "success" | "warning" | "danger" | "default";
const STATE_STATUS: Record<string, Status> = {
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
export const stateStatus = (s: string | null | undefined): Status => (s ? (STATE_STATUS[s] ?? "default") : "default");
export const isNormal = (s: string | null | undefined) => !s || stateStatus(s) === "success";

/** Konsta Chip colours for a status. */
export const chipColors = (c: Status) => {
  const bg = { success: "bg-green-600", warning: "bg-orange-500", danger: "bg-red-600", default: "" }[c];
  const text = c === "default" ? "" : "text-white";
  return { fillBgIos: bg, fillBgMaterial: bg, fillTextIos: text, fillTextMaterial: text };
};

// ---------------------------------------------------------------------------
// Routes
//   #/                          amps
//   #/settings                  settings
//   #/amp/:id                   Channels tab
//   #/amp/:id/routing|presets|device   the other tabs
//   #/amp/:id/in|out/:ch[/:st]  one channel's detail, optionally on a stage
//
// "Back" means one level up, everywhere: entering an amp, a detail or
// Settings pushes a history entry; switching tab, channel or stage replaces
// the current one. Android's back button (wry maps it to WebView goBack) and
// the navbar's back link both land on history.back(), so the two can't drift.
// ponytail: swap for a router library if nested layouts or guards appear.
export type Tab = "channels" | "routing" | "presets" | "device";
export interface Route {
  id: string | null;
  settings: boolean;
  tab: Tab;
  detail: { dir: Dir; ch: number; stage: string | null } | null;
}

const ROUTE_EVENT = "ampcore:route";
const subscribeRoute = (cb: () => void) => {
  for (const e of ["popstate", "hashchange", ROUTE_EVENT]) addEventListener(e, cb);
  return () => {
    for (const e of ["popstate", "hashchange", ROUTE_EVENT]) removeEventListener(e, cb);
  };
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeRoute, () => location.hash);
  const base: Route = { id: null, settings: hash === "#/settings", tab: "channels", detail: null };
  const m = hash.match(/^#\/amp\/([^/]+)(?:\/(routing|presets|device)|\/(in|out)\/(\d+)(?:\/(\w+))?)?/);
  if (!m) return base;
  const id = decodeURIComponent(m[1]);
  if (m[2]) return { ...base, id, tab: m[2] as Tab };
  if (m[3]) return { ...base, id, detail: { dir: m[3] as Dir, ch: Number(m[4]), stage: m[5] ?? null } };
  return { ...base, id };
}

/** `depth` counts our own pushed entries, so `back` knows whether there is
 * anything of ours behind the current one (a cold start on a deep hash has none). */
function nav(hash: string, replace = false) {
  if (replace) history.replaceState(history.state, "", hash);
  else history.pushState({ depth: ((history.state?.depth as number) ?? 0) + 1 }, "", hash);
  dispatchEvent(new Event(ROUTE_EVENT));
}
const ampHash = (id: string) => `#/amp/${encodeURIComponent(id)}`;

export const openAmp = (id: string) => nav(ampHash(id));
export const openSettings = () => nav("#/settings");
export const goTab = (id: string, tab: Tab) => nav(tab === "channels" ? ampHash(id) : `${ampHash(id)}/${tab}`, true);
export const openDetail = (id: string, dir: Dir, ch: number, stage: string | null = null, replace = false) =>
  nav(`${ampHash(id)}/${dir}/${ch}${stage ? `/${stage}` : ""}`, replace);
/** One level up; `fallback` is where "up" is when nothing of ours is behind. */
export function back(fallback: string) {
  if ((history.state?.depth ?? 0) > 0) history.back();
  else nav(fallback, true);
}
export const upFromAmp = () => back("#/");
export const upFromDetail = (id: string) => back(ampHash(id));

// ---------------------------------------------------------------------------
// Colour scheme: saved in localStorage, applied as the `dark` class on <html>
// (Konsta's dark variant keys off it). index.html applies it before first paint.
// ponytail: "auto" is resolved once, not live-tracked.
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

// ---------------------------------------------------------------------------
// Data hooks

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

/** Which filter types expose gain/Q, resolved by core. Device-independent
 * today, so fetched once like `useRanges`. */
type Caps = Record<string, { supportsGain: boolean; supportsQ: boolean }>;
let eqCaps: Promise<Caps> | undefined;
export function useEqFilterCaps(): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(null);
  useEffect(() => {
    eqCaps ??= invoke<{ filterType: string; supportsGain: boolean; supportsQ: boolean }[]>("amp_eq_filter_capabilities").then((list) =>
      Object.fromEntries(list.map((e) => [e.filterType, { supportsGain: e.supportsGain, supportsQ: e.supportsQ }])),
    );
    eqCaps.then(setCaps, () => setCaps(null));
  }, []);
  return caps;
}

/** Presets are firmware-gated; core decides (`write_helpers::presets_supported`). */
export function usePresetsSupported(id: string): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    invoke<boolean>("amp_presets_supported", { deviceId: id }).then(setOk, () => setOk(false));
  }, [id]);
  return ok;
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

export interface Live {
  config: Snapshot | null;
  telemetry: Telemetry | null;
}
/** Polls the given amps (config + heartbeat) while mounted, keyed by device
 * id. The amp list passes every online amp, an amp screen just its own.
 * ponytail: every listed amp gets core's full 200ms poll; add a slow
 * list-only rate in core if a large rig loads the network. */
export function useLive(ids: string[]): Record<string, Live> {
  const [live, setLive] = useState<Record<string, Live>>({});
  const key = ids.join("\n");
  useEffect(() => {
    const token = crypto.randomUUID();
    const want = new Set(key ? key.split("\n") : []);
    let offs: (() => void)[] = [];
    let cancelled = false;
    const put = (id: string, patch: Partial<Live>) =>
      want.has(id) && setLive((m) => ({ ...m, [id]: { ...(m[id] ?? { config: null, telemetry: null }), ...patch } }));
    (async () => {
      const l = await Promise.all([
        listen<{ deviceId: string; config: Snapshot }>("live_channel_config:updated", (e) => put(e.payload.deviceId, { config: e.payload.config })),
        listen<{ deviceId: string; telemetry: Telemetry }>("live_telemetry:updated", (e) =>
          put(e.payload.deviceId, { telemetry: e.payload.telemetry }),
        ),
      ]);
      if (cancelled) return l.forEach((f) => f());
      offs = l;
      await invoke("poll_subscribe", { token, deviceIds: [...want] });
    })();
    return () => {
      cancelled = true;
      offs.forEach((f) => f());
      void invoke("poll_subscribe", { token, deviceIds: [] });
    };
  }, [key]);
  return live;
}

export interface ResponsePoint {
  freqHz: number;
  db: number;
}
export type EqStageRef = { kind: "hp" } | { kind: "lp" } | { kind: "band"; bandIndex: number };
/** EQ graph curve from core's `filter_response` (the same math desktop
 * draws). `stage` isolates one HP/band/LP. The last curve stays up while the
 * next is in flight, and a stale reply never overwrites a newer one. */
export function useResponseCurve(eq: ChannelEq | null, stage: EqStageRef | null = null, points = 240): ResponsePoint[] | null {
  const [curve, setCurve] = useState<ResponsePoint[] | null>(null);
  const seq = useRef(0);
  const key = eq ? JSON.stringify([eq, stage]) : null;
  useEffect(() => {
    const mine = ++seq.current;
    if (!eq) return setCurve(null);
    invoke<ResponsePoint[]>("eq_response_curve", { eq, stage, points }).then((c) => mine === seq.current && setCurve(c), () => {});
    // `key` stands in for eq/stage: both are rebuilt every poll.
  }, [key, points]);
  return eq ? curve : null;
}
