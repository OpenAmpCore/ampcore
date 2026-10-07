import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type ChannelConfigSnapshot, type Telemetry } from "../lib/bindings";

type Fetched<T> = { status: "ok"; data: T } | { status: "error"; error: unknown };

/** A per-device live snapshot keyed by `DiscoveredDevice.id`: subscribes to
 * `event` first, then seeds from `fetchAll`, so an update landing between
 * the two is never lost. Each backend store (telemetry, FC=27 config, bridge,
 * presets) emits its own event rather than riding the `live_device:updated`
 * full-list broadcast, which would re-send every device's identity on every
 * heartbeat. */
export function useLiveMap<E extends { deviceId: string }, V>(
  event: string,
  fetchAll: () => Promise<Fetched<E[]>>,
  pick: (entry: E) => V,
): [Record<string, V>, Dispatch<SetStateAction<Record<string, V>>>] {
  const [byId, setById] = useState<Record<string, V>>({});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<E>(event, (e) => {
        setById((prev) => ({ ...prev, [e.payload.deviceId]: pick(e.payload) }));
      });
      const initial = await fetchAll();
      if (!cancelled && initial.status === "ok") {
        // Under what the events already delivered: those are newer than this answer.
        const seed = Object.fromEntries(initial.data.map((d) => [d.deviceId, pick(d)]));
        setById((prev) => ({ ...seed, ...prev }));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // `fetchAll`/`pick` are module-level at every call site.
  }, [event]);

  return [byId, setById];
}

/** Heartbeat telemetry, roughly every 2s per polled device. */
export function useLiveTelemetry(): Record<string, Telemetry> {
  return useLiveMap("live_telemetry:updated", commands.liveControlGetTelemetry, (d) => d.telemetry)[0];
}

/** FC=27 (SYNC_DATA) channel config — polled far slower than telemetry (see
 * `live/cvr/driver.rs`'s `CONFIG_POLL_INTERVAL`), since DSP config changes
 * rarely. */
export function useLiveChannelConfig(): Record<string, ChannelConfigSnapshot> {
  return useLiveMap("live_channel_config:updated", commands.liveControlGetChannelConfig, (d) => d.config)[0];
}
