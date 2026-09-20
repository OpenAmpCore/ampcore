import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Group, Switch, Text } from "@mantine/core";

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
export interface Channel {
  channelIndex: number;
  inputMuted: boolean;
  outputMuted: boolean;
  inputName: string | null;
  outputName: string | null;
}
export interface Snapshot {
  standby: boolean | null;
  standbyLocked: boolean | null;
  channels: Channel[];
}
export interface Telemetry {
  temperatures: number[];
  outputLevelDb: (number | null)[];
  outputChannelStates: (string | null)[];
  inputClipping: (boolean | null)[];
  machineStateDecoded: string | null;
}
export interface Presets {
  slots: { index: number; name: string }[];
  activePresetName: string | null;
}
/** Runs a command against the open amp; a rejection shows up as the screen's error. */
export type Write = (cmd: string, args: Record<string, unknown>) => Promise<void>;

/** Outputs are lettered A, B, C… (repo convention; inputs are numbered). */
export const outputLabel = (i: number) => String.fromCharCode(65 + i);

// Hash routes: `#/` (amps) and `#/amp/:id/:tab`. Writing location.hash pushes
// WebView history, and wry's WryActivity maps Android's back button to
// canGoBack() → goBack(), so system back works with no router library.
// ponytail: swap for wouter/react-router if nested layouts or guards appear.
export const TABS = ["overview", "outputs", "inputs", "presets"] as const;
export type Tab = (typeof TABS)[number];

const onHash = (cb: () => void) => {
  addEventListener("hashchange", cb);
  return () => removeEventListener("hashchange", cb);
};

export function useRoute(): { id: string | null; tab: Tab } {
  const hash = useSyncExternalStore(onHash, () => location.hash);
  const m = hash.match(/^#\/amp\/([^/]+)(?:\/(\w+))?/);
  if (!m) return { id: null, tab: "overview" };
  return { id: decodeURIComponent(m[1]), tab: TABS.find((t) => t === m[2]) ?? "overview" };
}

export function go(id: string | null, tab: Tab = "overview") {
  location.hash = id ? `#/amp/${encodeURIComponent(id)}/${tab}` : "#/";
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

/** A 48px settings-style row: name (+ optional extra) on the left, switch on the right. */
export function Row(p: { name: string; extra?: ReactNode; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <Group justify="space-between" mih={48} wrap="nowrap">
      <Group gap="xs" wrap="nowrap">
        <Text>{p.name}</Text>
        {p.extra}
      </Group>
      <Switch aria-label={p.name} checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </Group>
  );
}
