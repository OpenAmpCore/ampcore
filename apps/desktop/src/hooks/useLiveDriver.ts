import { useEffect } from "react";
import { commands } from "../lib/bindings";

/** Starts the live driver — discovery, plus the machinery the heavy polls run
 * on — the first time any live-aware view mounts. Call it from every surface
 * that needs live data (Live Control today, project mode once offline/online
 * amp fusion exists) rather than from the App root, so nothing goes on the
 * network until one of those views actually opens.
 *
 * Safe to call from as many places as needed: `live_control_start` returns
 * early when the driver is already running. Deliberately never stops it on
 * unmount — discovery keeps running for the rest of the session across view
 * switches instead of restarting from zero. Which devices receive the heavy
 * polls is a separate concern, owned by `useLivePolling`. */
export function useLiveDriver() {
  useEffect(() => {
    void commands.liveControlStart();
  }, []);
}
