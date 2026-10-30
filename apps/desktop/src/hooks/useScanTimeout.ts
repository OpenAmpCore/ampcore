import { useCallback, useEffect, useState } from "react";
import { startLiveDriver } from "./useLiveDriver";

/** How long a discovery empty state keeps saying it is scanning before it
 * says nothing answered. Discovery broadcasts once a second
 * (`DISCOVERY_INTERVAL` in `driver.rs`) and an amp that is there replies
 * within milliseconds, so this is some thirty attempts — a measure of the
 * user's patience, not of how long discovery needs. */
export const SCAN_TIMEOUT_MS = 30_000;

/** Times out a discovery empty state: `timedOut` turns true once `searching`
 * has held for `SCAN_TIMEOUT_MS`, and `scanAgain` starts a fresh window.
 *
 * Only the *message* times out. Discovery keeps broadcasting for the rest of
 * the session — it is also what marks amps online and offline — so an amp
 * that answers after the timeout still appears on its own and replaces the
 * "nothing found" state.
 *
 * `scanAgain` calls `live_control_start` and never `live_control_stop` first.
 * On a running driver that is a no-op, and needs to be nothing more: it
 * re-reads the network interfaces on every broadcast, so a newly joined
 * network is picked up without a restart. On a driver whose socket bind
 * failed at startup (port 45454 held by another program) it is what brings
 * discovery back. Stopping first would add nothing and can lose the port:
 * the old driver only releases it once it finishes its current `select!`
 * arm, and a new driver that binds before then fails with `AddrInUse`,
 * leaving discovery and liveness both off.
 *
 * The window restarts whenever `searching` goes false and back to true, so a
 * dialog that stays mounted while closed gets a fresh scan each time it
 * opens, as long as it passes `false` while closed. */
export function useScanTimeout(searching: boolean) {
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => setTimedOut(true), SCAN_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      // Cleared on the way out rather than when the next window starts:
      // resetting from inside the effect would paint one frame of the stale
      // "nothing found" before it ran.
      setTimedOut(false);
    };
  }, [searching, attempt]);

  const scanAgain = useCallback(() => {
    void startLiveDriver();
    setTimedOut(false);
    setAttempt((a) => a + 1);
  }, []);

  return { timedOut: searching && timedOut, scanAgain };
}
