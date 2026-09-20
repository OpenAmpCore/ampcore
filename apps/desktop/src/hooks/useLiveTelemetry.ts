import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type DeviceTelemetry, type Telemetry } from "../lib/bindings";

/** Keyed by `DiscoveredDevice.id`. Mirrors `useLiveDevices`'s event-subscribe
 * + initial-fetch pattern, but as a separate hook/event stream — telemetry
 * updates roughly every 2s per device and is deliberately kept out of the
 * `live_device:updated` full-list broadcast (see `LiveEventSink::set_telemetry`
 * in the Rust backend). */
export function useLiveTelemetry() {
  const [telemetryById, setTelemetryById] = useState<Record<string, Telemetry>>({});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DeviceTelemetry>("live_telemetry:updated", (event) => {
        setTelemetryById((prev) => ({ ...prev, [event.payload.deviceId]: event.payload.telemetry }));
      });
      const initial = await commands.liveControlGetTelemetry();
      if (!cancelled && initial.status === "ok") {
        setTelemetryById(Object.fromEntries(initial.data.map((d) => [d.deviceId, d.telemetry])));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return telemetryById;
}
