import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type DiscoveredDevice } from "../lib/bindings";

export function useLiveDevices() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DiscoveredDevice[]>("live_device:updated", (event) => {
        setDevices(event.payload);
      });
      const initial = await commands.liveControlListDevices();
      if (!cancelled && initial.status === "ok") setDevices(initial.data);
      if (!cancelled) setReady(true);
    })();

    // Only listens — starting the driver is `useLiveDriver`'s job, so any
    // view can read the device list without that implying it wants network
    // traffic.
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { devices, ready };
}
