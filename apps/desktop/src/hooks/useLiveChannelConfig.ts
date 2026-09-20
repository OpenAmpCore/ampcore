import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type ChannelConfigSnapshot, type DeviceChannelConfig } from "../lib/bindings";

/** Keyed by `DiscoveredDevice.id`. Mirrors `useLiveTelemetry`'s event-
 * subscribe + initial-fetch pattern — FC=27 (SYNC_DATA) channel config is
 * polled every ~3s per device by the driver (see `live/cvr/driver.rs`'s
 * `CONFIG_POLL_INTERVAL`), far slower than heartbeat telemetry, since DSP
 * config changes rarely at planning time. */
export function useLiveChannelConfig() {
  const [configById, setConfigById] = useState<Record<string, ChannelConfigSnapshot>>({});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DeviceChannelConfig>("live_channel_config:updated", (event) => {
        setConfigById((prev) => ({ ...prev, [event.payload.deviceId]: event.payload.config }));
      });
      const initial = await commands.liveControlGetChannelConfig();
      if (!cancelled && initial.status === "ok") {
        setConfigById(Object.fromEntries(initial.data.map((d) => [d.deviceId, d.config])));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return configById;
}
