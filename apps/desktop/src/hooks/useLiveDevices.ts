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
      let heard = false;
      unlisten = await listen<DiscoveredDevice[]>("live_device:updated", (event) => {
        heard = true;
        setDevices(event.payload);
      });
      const initial = await commands.liveControlListDevices();
      // The list is only the seed. When the driver has just started, its first
      // discovery event can land before this answer does — and the answer is
      // then the older (empty) list. The driver only emits on a change, so
      // overwriting with it would leave this hook without devices for good.
      if (!cancelled && initial.status === "ok" && !heard) setDevices(initial.data);
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
