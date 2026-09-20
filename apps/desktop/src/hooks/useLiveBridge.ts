import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type DeviceBridge, type DeviceBridgeSnapshot } from "../lib/bindings";

/** Keyed by `DiscoveredDevice.id`. Mirrors `useLivePresets`'s store/listen
 * halves, and additionally *primes* a device the first time it is asked for:
 * `live_control_fetch_bridge` reads every pair and waits, so bridge state is
 * there in tens of ms instead of whenever the driver's bridge tick comes
 * round to each pair. That matters because a project amp's fingerprint is
 * incomplete — and its editor therefore locked — until every pair has been
 * reported (see `data/fingerprint.rs`).
 *
 * After priming, the driver's own tick keeps the snapshot fresh through
 * `live_bridge:updated`.
 *
 * Bridge state deliberately does not ride along on FC=27 — see
 * `live/cvr/bridge.rs` for why reading it out of the sync trailer produces
 * wrong values on 1.1.8. */
export function useLiveBridge(deviceId: string | undefined) {
  const [bridgeById, setBridgeById] = useState<Record<string, DeviceBridgeSnapshot>>({});
  // Device ids already fetched, so remounts and re-renders don't re-ask.
  const primed = useRef(new Set<string>());

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DeviceBridge>("live_bridge:updated", (event) => {
        setBridgeById((prev) => ({ ...prev, [event.payload.deviceId]: event.payload.bridge }));
      });
      const initial = await commands.liveControlGetBridge();
      if (!cancelled && initial.status === "ok") {
        setBridgeById(Object.fromEntries(initial.data.map((d) => [d.deviceId, d.bridge])));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!deviceId || primed.current.has(deviceId)) return;
    primed.current.add(deviceId);
    // Failure is not worth surfacing: the driver's bridge tick still fills
    // the pairs in, just later.
    void commands.liveControlFetchBridge(deviceId).then((result) => {
      if (result.status === "ok") {
        setBridgeById((prev) => ({ ...prev, [result.data.deviceId]: result.data.bridge }));
      } else {
        primed.current.delete(deviceId);
      }
    });
  }, [deviceId]);

  return deviceId ? bridgeById[deviceId] : undefined;
}
