import { useEffect } from "react";
import { commands } from "../lib/bindings";

/** Requests the driver's heavy polls (heartbeat, FC=27, FC=50) for
 * `deviceIds` for as long as the calling component is mounted. Devices no
 * consumer has asked for get discovery alone.
 *
 * Any number of components can use this at once — the backend keeps one set
 * per subscription and polls their union, so two views on the same amp never
 * double-poll it and one view unmounting never cuts polling another view
 * still needs.
 *
 * Each effect run mints its own token and clears only that token on cleanup.
 * That makes it independent of invoke ordering: StrictMode's
 * mount→unmount→mount and a selection change A→B both produce *different*
 * tokens, so a clear that lands late can only remove its own stale entry,
 * never the live one. */
export function useLivePolling(deviceIds: string[]) {
  // Keyed on content, not array identity, so callers can pass a fresh array
  // every render without resubscribing on each one.
  const key = [...deviceIds].sort().join("\n");

  useEffect(() => {
    if (key === "") return;
    const ids = key.split("\n");
    const token = crypto.randomUUID();
    void commands.liveControlSetPollSubscription(token, ids);
    return () => {
      void commands.liveControlSetPollSubscription(token, []);
    };
  }, [key]);
}
